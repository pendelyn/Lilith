import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import {
  OPTIONAL_TOOLS,
  toolsForPreset,
  type OptionalTool,
  type ToolAllowResponse,
  type ToolPreset,
} from "@lilith/contracts";
import type { OwnerContext } from "./auth.ts";

export type ToolAllowStore = {
  readonly owners: Map<string, OptionalTool[]>;
  readonly persistPath?: string;
};

export function createToolAllowStore(options?: { persistPath?: string }): ToolAllowStore {
  const store: ToolAllowStore = {
    owners: new Map(),
    ...(options?.persistPath === undefined ? {} : { persistPath: options.persistPath }),
  };
  if (options?.persistPath !== undefined && persistPresent(options.persistPath)) {
    loadStore(store, options.persistPath);
  }
  return store;
}

export function readToolAllow(store: ToolAllowStore, owner: OwnerContext): ToolAllowResponse {
  const tools = store.owners.get(owner.ownerId);
  if (tools === undefined) return { configured: false };
  return { configured: true, tools: [...tools] };
}

export function toolAllowed(store: ToolAllowStore, owner: OwnerContext, tool: OptionalTool): boolean {
  const tools = store.owners.get(owner.ownerId);
  if (tools === undefined) return false;
  return tools.includes(tool);
}

export function replaceToolAllow(
  store: ToolAllowStore,
  owner: OwnerContext,
  tools: readonly OptionalTool[],
): OptionalTool[] {
  const next = canonical(tools);
  return transact(store, () => {
    store.owners.set(owner.ownerId, next);
    return [...next];
  });
}

export function applyToolPreset(store: ToolAllowStore, owner: OwnerContext, preset: ToolPreset): OptionalTool[] {
  return replaceToolAllow(store, owner, toolsForPreset(preset));
}

export function deleteOwnerToolAllow(store: ToolAllowStore, owner: OwnerContext): void {
  if (store.owners.has(owner.ownerId)) {
    transact(store, () => {
      store.owners.delete(owner.ownerId);
    });
  }
  if (store.persistPath !== undefined) discardBak(store.persistPath);
}

function canonical(tools: readonly OptionalTool[]): OptionalTool[] {
  return OPTIONAL_TOOLS.filter((tool) => tools.includes(tool));
}

function snapshotStore(store: ToolAllowStore): Array<[string, OptionalTool[]]> {
  return [...store.owners.entries()].map(([ownerId, tools]) => [ownerId, [...tools]]);
}

function restoreStore(store: ToolAllowStore, snapshot: Array<[string, OptionalTool[]]>): void {
  store.owners.clear();
  for (const [ownerId, tools] of snapshot) store.owners.set(ownerId, [...tools]);
}

function transact<T>(store: ToolAllowStore, fn: () => T): T {
  const snapshot = snapshotStore(store);
  try {
    const result = fn();
    persistStore(store);
    return result;
  } catch (error) {
    restoreStore(store, snapshot);
    throw error;
  }
}

function persistPresent(persistPath: string): boolean {
  return existsSync(persistPath) || existsSync(`${persistPath}.bak`);
}

function persistStore(store: ToolAllowStore): void {
  if (store.persistPath === undefined) return;
  const dest = store.persistPath;
  const tmp = `${dest}.${randomUUID()}.tmp`;
  try {
    writeFileSync(
      tmp,
      JSON.stringify({
        v: 1,
        owners: [...store.owners.entries()].map(([ownerId, tools]) => ({ ownerId, tools })),
      }),
    );
    replacePersistFile(tmp, dest);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // tmp may already have been renamed or never created
    }
    throw error;
  }
  try {
    unlinkSync(tmp);
  } catch {
    // tmp already renamed onto dest
  }
}

function replacePersistFile(tmp: string, dest: string): void {
  try {
    renameSync(tmp, dest);
    return;
  } catch (error) {
    if (!existsSync(dest)) throw error;
  }
  const bak = `${dest}.bak`;
  if (existsSync(bak)) unlinkSync(bak);
  renameSync(dest, bak);
  try {
    renameSync(tmp, dest);
  } catch (error) {
    renameSync(bak, dest);
    throw error;
  }
  try {
    unlinkSync(bak);
  } catch {
    // dest already holds the new snapshot
  }
}

function discardBak(persistPath: string): void {
  try {
    unlinkSync(`${persistPath}.bak`);
  } catch {
    // already gone
  }
}

function loadStore(store: ToolAllowStore, persistPath: string): void {
  // ponytail: a missing primary is a crashed Windows replace; the bak is the previous
  // allow-set and can be broader. Do not promote it. Upgrade: a journal if the last
  // snapshot must survive without ever widening the live set.
  if (!existsSync(persistPath)) {
    discardBak(persistPath);
    return;
  }
  const value: unknown = JSON.parse(readFileSync(persistPath, "utf8"));
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("v" in value) ||
    value.v !== 1 ||
    !("owners" in value) ||
    !Array.isArray(value.owners)
  ) {
    throw new Error("Invalid tool allow store");
  }
  for (const key of Object.keys(value)) {
    if (key !== "v" && key !== "owners") throw new Error("Invalid tool allow store");
  }
  for (const entry of value.owners) {
    const record = parseOwnerRecord(entry);
    if (store.owners.has(record.ownerId)) throw new Error("Invalid tool allow store");
    store.owners.set(record.ownerId, record.tools);
  }
  discardBak(persistPath);
}

function parseOwnerRecord(value: unknown): { ownerId: string; tools: OptionalTool[] } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid tool allow store");
  }
  for (const key of Object.keys(value)) {
    if (key !== "ownerId" && key !== "tools") throw new Error("Invalid tool allow store");
  }
  if (!("ownerId" in value) || typeof value.ownerId !== "string" || value.ownerId === "") {
    throw new Error("Invalid tool allow store");
  }
  if (!("tools" in value) || !Array.isArray(value.tools)) throw new Error("Invalid tool allow store");
  const tools: OptionalTool[] = [];
  for (const tool of value.tools) {
    if (tool !== "webResearch" && tool !== "memory") throw new Error("Invalid tool allow store");
    if (tools.includes(tool)) throw new Error("Invalid tool allow store");
    tools.push(tool);
  }
  return { ownerId: value.ownerId, tools: canonical(tools) };
}
