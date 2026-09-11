import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import {
  MAX_MEMORY_CONTENT,
  MEMORY_CONFIRM_REPLY,
  MEMORY_ORIGIN,
  MEMORY_SECRET_REPLY,
  isForbiddenMemoryContent,
  isRememberCommand,
  isSensitiveMemoryContent,
  parseMemoryItem,
  parseRememberContent,
  type MemoryConfirmRequest,
  type MemoryConfirmResponse,
  type MemoryItem,
} from "@lilith/contracts";
import { requireOwned, type OwnerContext } from "./auth.ts";

export const MEMORY_REMEMBER_PROMPT = "Merk dir: Antwortsprache Deutsch";
export const MEMORY_TEST_QUERY = "Welche Antwortsprache soll ich verwenden?";
export { MEMORY_CONFIRM_REPLY, MEMORY_SECRET_REPLY };
export const MEMORY_OFF_REPLY = "Memory is off. Nothing was stored.";
export const MEMORY_PAUSED_REPLY = "Memory is paused. Nothing was stored.";
export const MEMORY_TOO_LONG_REPLY = "That memory is too long. Nothing was stored.";
export const MEMORY_EMPTY_REPLY = "Nothing was stored.";
export const MEMORY_CONFIRM_TTL_MS = 5 * 60_000;

const MIN_TOKEN = 4;
const STOPWORDS = new Set([
  "eine",
  "einen",
  "einer",
  "oder",
  "dass",
  "nicht",
  "kein",
  "keine",
  "merk",
  "merke",
  "welche",
  "welcher",
  "welches",
  "soll",
  "sollen",
  "sollte",
  "this",
  "that",
  "with",
  "from",
  "have",
  "will",
  "would",
  "dein",
  "deine",
  "mein",
  "meine",
]);

export type MemoryRecord = {
  id: string;
  ownerId: string;
  content: string;
  origin: typeof MEMORY_ORIGIN;
  createdAt: number;
  updatedAt: number;
};

export type MemoryPending = {
  ownerId: string;
  content: string;
  contentDigest: string;
  expiresAt: number;
  kind: "capture" | "edit";
  memoryId?: string;
};

export type MemoryStore = {
  readonly memories: Map<string, MemoryRecord>;
  readonly pausedOwnerIds: Set<string>;
  readonly pendingByOwner: Map<string, MemoryPending>;
  readonly now: () => number;
  readonly persistPath?: string;
};

export function createMemoryStore(options?: {
  now?: () => number;
  persistPath?: string;
}): MemoryStore {
  const store: MemoryStore = {
    memories: new Map(),
    pausedOwnerIds: new Set(),
    pendingByOwner: new Map(),
    now: options?.now ?? Date.now,
    ...(options?.persistPath === undefined ? {} : { persistPath: options.persistPath }),
  };
  if (options?.persistPath !== undefined && persistPresent(options.persistPath)) {
    loadStore(store, options.persistPath);
  }
  return store;
}

export function isMemoryPaused(store: MemoryStore, owner: OwnerContext): boolean {
  return store.pausedOwnerIds.has(owner.ownerId);
}

export function listMemories(store: MemoryStore, owner: OwnerContext): MemoryItem[] {
  const items: MemoryItem[] = [];
  for (const memory of store.memories.values()) {
    if (memory.ownerId !== owner.ownerId) continue;
    items.push(publicMemory(memory));
  }
  return items;
}

export function setMemoryPaused(
  store: MemoryStore,
  owner: OwnerContext,
  paused: boolean,
): boolean {
  return transact(store, () => {
    if (paused) store.pausedOwnerIds.add(owner.ownerId);
    else store.pausedOwnerIds.delete(owner.ownerId);
    return paused;
  });
}

export function updateMemory(
  store: MemoryStore,
  owner: OwnerContext,
  memoryId: string,
  content: string,
): MemoryItem {
  ownedMemory(store, owner, memoryId);
  if (isForbiddenMemoryContent(content)) throw new Error("Forbidden memory");
  const next = parseMemoryContentValue(content);
  if (isSensitiveMemoryContent(next)) {
    setPending(store, owner, { kind: "edit", memoryId, content: next });
    throw new Error("Memory confirmation required");
  }
  return transact(store, () => {
    const current = ownedMemory(store, owner, memoryId);
    const updated: MemoryRecord = {
      ...current,
      content: next,
      updatedAt: store.now(),
    };
    store.memories.set(memoryId, updated);
    return publicMemory(updated);
  });
}

export function deleteMemory(store: MemoryStore, owner: OwnerContext, memoryId: string): void {
  ownedMemory(store, owner, memoryId);
  transact(store, () => {
    ownedMemory(store, owner, memoryId);
    store.memories.delete(memoryId);
  });
  const pending = store.pendingByOwner.get(owner.ownerId);
  if (pending?.kind === "edit" && pending.memoryId === memoryId) {
    store.pendingByOwner.delete(owner.ownerId);
  }
}

export function captureExplicitMemory(
  store: MemoryStore,
  owner: OwnerContext,
  message: string,
  memoryEnabled: boolean,
): string | undefined {
  if (!isRememberCommand(message)) return undefined;
  const content = parseRememberContent(message);
  if (content === undefined) return MEMORY_EMPTY_REPLY;
  if (isForbiddenMemoryContent(content)) return MEMORY_SECRET_REPLY;
  if ([...content].length > MAX_MEMORY_CONTENT) return MEMORY_TOO_LONG_REPLY;
  if (!memoryEnabled) return MEMORY_OFF_REPLY;
  if (isMemoryPaused(store, owner)) return MEMORY_PAUSED_REPLY;
  if (isSensitiveMemoryContent(content)) {
    setPending(store, owner, { kind: "capture", content });
    return MEMORY_CONFIRM_REPLY;
  }
  persistCapturedMemory(store, owner, content);
  return `Remembered: ${content}`;
}

export function confirmMemory(
  store: MemoryStore,
  owner: OwnerContext,
  input: MemoryConfirmRequest,
): MemoryConfirmResponse {
  const pending = store.pendingByOwner.get(owner.ownerId);
  if (pending === undefined || pending.ownerId !== owner.ownerId) {
    throw new Error("Memory confirmation not found");
  }
  if (store.now() >= pending.expiresAt) {
    store.pendingByOwner.delete(owner.ownerId);
    throw new Error("Memory confirmation expired");
  }
  if (!digestEquals(memoryContentDigest(input.content), pending.contentDigest)) {
    throw new Error("Memory confirmation changed");
  }
  if (isForbiddenMemoryContent(pending.content)) {
    store.pendingByOwner.delete(owner.ownerId);
    throw new Error("Forbidden memory");
  }
  if (!input.consent) {
    store.pendingByOwner.delete(owner.ownerId);
    return { confirmed: false };
  }
  if (pending.kind === "capture") {
    if (!input.memoryEnabled) throw new Error("Memory is off");
    if (isMemoryPaused(store, owner)) throw new Error("Memory is paused");
    const memory = persistCapturedMemory(store, owner, pending.content);
    store.pendingByOwner.delete(owner.ownerId);
    return { confirmed: true, memory };
  }
  const memoryId = pending.memoryId;
  if (memoryId === undefined) throw new Error("Memory confirmation not found");
  ownedMemory(store, owner, memoryId);
  const next = parseMemoryContentValue(pending.content);
  const memory = transact(store, () => {
    const current = ownedMemory(store, owner, memoryId);
    const updated: MemoryRecord = {
      ...current,
      content: next,
      updatedAt: store.now(),
    };
    store.memories.set(memoryId, updated);
    return publicMemory(updated);
  });
  store.pendingByOwner.delete(owner.ownerId);
  return { confirmed: true, memory };
}

// Provider boundary: only these items may cross to a model. Issue #8 is deactivated;
// HTTP retrieve is the testable boundary. Chat must not invent a live provider path.
export function memoriesForProvider(
  store: MemoryStore,
  owner: OwnerContext,
  input: { query: string; memoryEnabled: boolean },
): MemoryItem[] {
  if (!input.memoryEnabled || isMemoryPaused(store, owner)) return [];
  return selectRelevantMemories(listMemories(store, owner), input.query);
}

export function selectRelevantMemories(memories: MemoryItem[], query: string): MemoryItem[] {
  // ponytail: overlapping tokens of length >= 4. Ceiling: no embeddings; upgrade if live provider retrieval needs it.
  const queryTokens = contentTokens(query);
  if (queryTokens.size === 0) return [];
  const selected: MemoryItem[] = [];
  for (const memory of memories) {
    const tokens = contentTokens(memory.content);
    let relevant = false;
    for (const token of tokens) {
      if (queryTokens.has(token)) {
        relevant = true;
        break;
      }
    }
    if (relevant) selected.push(memory);
    if (selected.length === 10) break;
  }
  return selected;
}

function contentTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const part of text.toLowerCase().normalize("NFKC").split(/[^\p{L}\p{N}]+/u)) {
    if (part.length >= MIN_TOKEN && !STOPWORDS.has(part)) tokens.add(part);
  }
  return tokens;
}

function persistCapturedMemory(
  store: MemoryStore,
  owner: OwnerContext,
  content: string,
): MemoryItem {
  return transact(store, () => {
    const now = store.now();
    const record: MemoryRecord = {
      id: randomUUID(),
      ownerId: owner.ownerId,
      content,
      origin: MEMORY_ORIGIN,
      createdAt: now,
      updatedAt: now,
    };
    store.memories.set(record.id, record);
    return publicMemory(record);
  });
}

function setPending(
  store: MemoryStore,
  owner: OwnerContext,
  pending: { kind: "capture"; content: string } | { kind: "edit"; memoryId: string; content: string },
): void {
  store.pendingByOwner.set(owner.ownerId, {
    ownerId: owner.ownerId,
    content: pending.content,
    contentDigest: memoryContentDigest(pending.content),
    expiresAt: store.now() + MEMORY_CONFIRM_TTL_MS,
    kind: pending.kind,
    ...(pending.kind === "edit" ? { memoryId: pending.memoryId } : {}),
  });
}

export function memoryContentDigest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function digestEquals(leftHex: string, rightHex: string): boolean {
  const left = Buffer.from(leftHex, "hex");
  const right = Buffer.from(rightHex, "hex");
  return left.length === right.length && left.length === 32 && timingSafeEqual(left, right);
}

function parseMemoryContentValue(content: string): string {
  const trimmed = content.trim();
  if (trimmed === "" || [...trimmed].length > MAX_MEMORY_CONTENT) {
    throw new Error("Invalid memory");
  }
  return trimmed;
}

function publicMemory(memory: MemoryRecord): MemoryItem {
  return parseMemoryItem({
    id: memory.id,
    content: memory.content,
    origin: memory.origin,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
  });
}

function ownedMemory(store: MemoryStore, owner: OwnerContext, memoryId: string): MemoryRecord {
  const memory = store.memories.get(memoryId);
  if (memory === undefined) throw new Error("Memory not found");
  requireOwned(memory, owner);
  return memory;
}

function snapshotStore(store: MemoryStore): {
  memories: MemoryRecord[];
  pausedOwnerIds: string[];
} {
  return {
    memories: [...store.memories.values()].map((memory) => ({ ...memory })),
    pausedOwnerIds: [...store.pausedOwnerIds],
  };
}

function restoreStore(
  store: MemoryStore,
  snapshot: { memories: MemoryRecord[]; pausedOwnerIds: string[] },
): void {
  store.memories.clear();
  store.pausedOwnerIds.clear();
  for (const memory of snapshot.memories) store.memories.set(memory.id, { ...memory });
  for (const ownerId of snapshot.pausedOwnerIds) store.pausedOwnerIds.add(ownerId);
}

function transact<T>(store: MemoryStore, fn: () => T): T {
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

function persistStore(store: MemoryStore): void {
  if (store.persistPath === undefined) return;
  const dest = store.persistPath;
  const tmp = `${dest}.${randomUUID()}.tmp`;
  try {
    writeFileSync(
      tmp,
      JSON.stringify({
        v: 1,
        memories: [...store.memories.values()],
        pausedOwnerIds: [...store.pausedOwnerIds],
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

function loadStore(store: MemoryStore, persistPath: string): void {
  const bak = `${persistPath}.bak`;
  if (!existsSync(persistPath) && existsSync(bak)) {
    renameSync(bak, persistPath);
  }
  const value: unknown = JSON.parse(readFileSync(persistPath, "utf8"));
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("v" in value) ||
    value.v !== 1 ||
    !("memories" in value) ||
    !Array.isArray(value.memories) ||
    !("pausedOwnerIds" in value) ||
    !Array.isArray(value.pausedOwnerIds)
  ) {
    throw new Error("Invalid memory store");
  }
  for (const key of Object.keys(value)) {
    if (key !== "v" && key !== "memories" && key !== "pausedOwnerIds") {
      throw new Error("Invalid memory store");
    }
  }
  for (const ownerId of value.pausedOwnerIds) {
    if (typeof ownerId !== "string" || ownerId === "") throw new Error("Invalid memory store");
    store.pausedOwnerIds.add(ownerId);
  }
  for (const entry of value.memories) {
    const memory = parsePersistedMemory(entry);
    store.memories.set(memory.id, memory);
  }
}

function parsePersistedMemory(value: unknown): MemoryRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid memory store");
  }
  for (const key of Object.keys(value)) {
    if (
      key !== "id" &&
      key !== "ownerId" &&
      key !== "content" &&
      key !== "origin" &&
      key !== "createdAt" &&
      key !== "updatedAt"
    ) {
      throw new Error("Invalid memory store");
    }
  }
  if (
    !("ownerId" in value) ||
    typeof value.ownerId !== "string" ||
    value.ownerId === ""
  ) {
    throw new Error("Invalid memory store");
  }
  const item = parseMemoryItem({
    id: "id" in value ? value.id : undefined,
    content: "content" in value ? value.content : undefined,
    origin: "origin" in value ? value.origin : undefined,
    createdAt: "createdAt" in value ? value.createdAt : undefined,
    updatedAt: "updatedAt" in value ? value.updatedAt : undefined,
  });
  return { ...item, ownerId: value.ownerId };
}
