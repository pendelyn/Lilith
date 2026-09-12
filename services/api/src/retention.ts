import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import {
  parseRetentionKind,
  retentionTtlMs,
  type RetentionKind,
} from "@lilith/contracts";
import { type OwnerContext } from "./auth.ts";
import { deleteOwnerMemories, type MemoryStore } from "./memory.ts";
import { deleteOwnerTasks, type TaskStore } from "./tasks.ts";

const MAX_ARTIFACT_BYTES = 1_048_576;
export const CRASH_BACKUP_FILES = [".lilith-tasks.json.bak", ".lilith-memories.json.bak"] as const;
export type ArtifactLocation = "files" | "jobs" | "backup";

export type RetentionRecord = {
  id: string;
  ownerId: string;
  kind: RetentionKind;
  createdAt: number;
  path?: string;
  location?: ArtifactLocation;
};

export type RetentionStore = {
  readonly records: Map<string, RetentionRecord>;
  readonly pendingOwnerDeletes: Set<string>;
  readonly now: () => number;
  readonly persistPath?: string;
  readonly filesRoot?: string;
  readonly jobsRoot?: string;
  readonly backupDir?: string;
  readonly defaultOwnerId?: string;
};

export type ExpiryResult = {
  deleted: { id: string; kind: RetentionKind }[];
};

export function createRetentionStore(options?: {
  now?: () => number;
  persistPath?: string;
  filesRoot?: string;
  jobsRoot?: string;
  backupDir?: string;
  defaultOwnerId?: string;
}): RetentionStore {
  const store: RetentionStore = {
    records: new Map(),
    pendingOwnerDeletes: new Set(),
    now: options?.now ?? Date.now,
    ...(options?.persistPath === undefined ? {} : { persistPath: options.persistPath }),
    ...(options?.filesRoot === undefined ? {} : { filesRoot: options.filesRoot }),
    ...(options?.jobsRoot === undefined ? {} : { jobsRoot: options.jobsRoot }),
    ...(options?.backupDir === undefined ? {} : { backupDir: options.backupDir }),
    ...(options?.defaultOwnerId === undefined ? {} : { defaultOwnerId: options.defaultOwnerId }),
  };
  if (store.filesRoot !== undefined) {
    mkdirSync(store.filesRoot, { recursive: true, mode: 0o700 });
  }
  if (options?.persistPath !== undefined && persistPresent(options.persistPath)) {
    loadStore(store, options.persistPath);
  }
  return store;
}

// ponytail: P1 browser worker will put screenshot bytes here; P0 already enforces the 7-day TTL.
export function putArtifact(
  store: RetentionStore,
  owner: OwnerContext,
  input: { kind: RetentionKind; body?: string },
): RetentionRecord {
  const kind = parseRetentionKind(input.kind);
  const body = input.body ?? "";
  if (Buffer.byteLength(body) > MAX_ARTIFACT_BYTES) throw new Error("Invalid retention");
  const record = transact(store, () => {
    const id = randomUUID();
    const next: RetentionRecord = {
      id,
      ownerId: owner.ownerId,
      kind,
      createdAt: store.now(),
      ...(kind === "audit" || store.filesRoot === undefined ? {} : { path: `${kind}/${id}` }),
    };
    store.records.set(id, next);
    return { ...next };
  });
  if (record.path !== undefined && store.filesRoot !== undefined) {
    try {
      const dest = artifactFile(store, record.path);
      mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
      writeFileSync(dest, body, { mode: 0o600 });
    } catch (error) {
      try {
        transact(store, () => {
          store.records.delete(record.id);
        });
      } catch {
        // empty record remains until expiry; do not leave bytes outside the root
      }
      throw error;
    }
  }
  return record;
}

export function listArtifacts(store: RetentionStore, owner?: OwnerContext): RetentionRecord[] {
  const items: RetentionRecord[] = [];
  for (const record of store.records.values()) {
    if (owner !== undefined && record.ownerId !== owner.ownerId) continue;
    items.push({ ...record });
  }
  return items;
}

export function runExpiryJob(store: RetentionStore): ExpiryResult {
  adoptManagedArtifacts(store);
  const deleted: { id: string; kind: RetentionKind }[] = [];
  const expired: RetentionRecord[] = [];
  for (const record of [...store.records.values()]) {
    let kind: RetentionKind;
    try {
      kind = parseRetentionKind(record.kind);
    } catch {
      continue;
    }
    if (store.now() - record.createdAt < retentionTtlMs(kind)) continue;
    try {
      removeArtifactFiles(store, record);
      expired.push(record);
    } catch {
      // leave the record so a later pass retries this file without stalling other TTLs
    }
  }
  if (expired.length > 0) {
    transact(store, () => {
      for (const record of expired) {
        store.records.delete(record.id);
        deleted.push({ id: record.id, kind: record.kind });
      }
    });
  }
  sweepOrphanFiles(store);
  return { deleted };
}

export function deleteAccount(
  retention: RetentionStore,
  tasks: TaskStore,
  memories: MemoryStore,
  owner: OwnerContext,
): void {
  beginOwnerDelete(retention, owner);
  applyOwnerDelete(retention, tasks, memories, owner);
}

export function finishPendingDeletes(
  retention: RetentionStore,
  tasks: TaskStore,
  memories: MemoryStore,
): void {
  for (const ownerId of [...retention.pendingOwnerDeletes]) {
    applyOwnerDelete(retention, tasks, memories, { ownerId });
  }
}

function beginOwnerDelete(store: RetentionStore, owner: OwnerContext): void {
  transact(store, () => {
    if (store.pendingOwnerDeletes.has(owner.ownerId)) return;
    store.pendingOwnerDeletes.add(owner.ownerId);
    const id = randomUUID();
    store.records.set(id, {
      id,
      ownerId: owner.ownerId,
      kind: "audit",
      createdAt: store.now(),
    });
  });
}

function applyOwnerDelete(
  retention: RetentionStore,
  tasks: TaskStore,
  memories: MemoryStore,
  owner: OwnerContext,
): void {
  adoptManagedArtifacts(retention);
  deleteActiveArtifacts(retention, owner);
  deleteOwnerMemories(memories, owner);
  deleteOwnerTasks(tasks, owner);
  adoptManagedArtifacts(retention);
  transact(retention, () => {
    retention.pendingOwnerDeletes.delete(owner.ownerId);
  });
}

function deleteActiveArtifacts(store: RetentionStore, owner: OwnerContext): void {
  const removed: RetentionRecord[] = [];
  let failed = false;
  for (const record of [...store.records.values()]) {
    if (record.ownerId !== owner.ownerId) continue;
    if (record.kind !== "screenshot" && record.kind !== "task_file") continue;
    try {
      removeArtifactFiles(store, record);
      removed.push(record);
    } catch {
      failed = true;
    }
  }
  if (removed.length > 0) {
    transact(store, () => {
      for (const record of removed) store.records.delete(record.id);
    });
  }
  if (failed) throw new Error("Account deletion incomplete");
}

function adoptManagedArtifacts(store: RetentionStore): void {
  const ownerId = store.defaultOwnerId;
  if (ownerId === undefined) return;
  const added: RetentionRecord[] = [];
  collectJobArtifacts(store, ownerId, added);
  collectBackupArtifacts(store, ownerId, added);
  if (added.length === 0) return;
  transact(store, () => {
    for (const record of added) {
      if (store.records.has(record.id)) continue;
      if (hasManagedPath(store, record.location ?? "files", record.path ?? "")) continue;
      store.records.set(record.id, record);
    }
  });
}

function collectJobArtifacts(store: RetentionStore, ownerId: string, added: RetentionRecord[]): void {
  const jobsRoot = store.jobsRoot;
  if (jobsRoot === undefined || !existsSync(jobsRoot)) return;
  for (const dirent of readdirSync(jobsRoot, { withFileTypes: true })) {
    if (hasManagedPath(store, "jobs", dirent.name) || added.some((record) => record.path === dirent.name && record.location === "jobs")) {
      continue;
    }
    try {
      const dest = jobWorkspace(jobsRoot, dirent.name);
      const link = lstatSync(join(jobsRoot, dirent.name));
      if (link.isSymbolicLink() || !statSync(dest).isDirectory()) continue;
      added.push({
        id: randomUUID(),
        ownerId,
        kind: "task_file",
        createdAt: safeTime(statSync(dest).mtimeMs),
        path: dirent.name,
        location: "jobs",
      });
    } catch {
      // escaping symlink or unreadable entry: do not touch it
    }
  }
}

function collectBackupArtifacts(store: RetentionStore, ownerId: string, added: RetentionRecord[]): void {
  const backupDir = store.backupDir;
  if (backupDir === undefined || !existsSync(backupDir)) return;
  for (const name of CRASH_BACKUP_FILES) {
    if (hasManagedPath(store, "backup", name) || added.some((record) => record.path === name && record.location === "backup")) {
      continue;
    }
    try {
      const dest = backupFile(backupDir, name);
      if (!existsSync(dest)) continue;
      if (lstatSync(dest).isSymbolicLink()) continue;
      added.push({
        id: randomUUID(),
        ownerId,
        kind: "backup",
        createdAt: safeTime(statSync(dest).mtimeMs),
        path: name,
        location: "backup",
      });
    } catch {
      // leave an escaping crash copy alone
    }
  }
}

function hasManagedPath(store: RetentionStore, location: ArtifactLocation, path: string): boolean {
  for (const record of store.records.values()) {
    if ((record.location ?? "files") === location && record.path === path) return true;
  }
  return false;
}

function sweepOrphanFiles(store: RetentionStore): void {
  const filesRoot = store.filesRoot;
  if (filesRoot === undefined || !existsSync(filesRoot)) return;
  const referenced = new Set<string>();
  for (const record of store.records.values()) {
    if ((record.location ?? "files") === "files" && record.path !== undefined) referenced.add(record.path);
  }
  let root: string;
  try {
    root = realpathSync(filesRoot);
  } catch {
    return;
  }
  for (const kind of ["screenshot", "task_file", "backup"] as const) {
    const dir = join(root, kind);
    if (!existsSync(dir)) continue;
    try {
      const listing = lstatSync(dir);
      if (listing.isSymbolicLink() || !listing.isDirectory()) continue;
      for (const name of readdirSync(dir)) {
        const rel = `${kind}/${name}`;
        if (referenced.has(rel)) continue;
        removeOrphan(root, join(dir, name));
      }
    } catch {
      // retry next pass
    }
  }
}

function removeOrphan(root: string, dest: string): void {
  try {
    const listing = lstatSync(dest);
    if (listing.isSymbolicLink()) {
      if (!pathUnderRoot(root, dest)) return;
      unlinkSync(dest);
      return;
    }
    const resolved = realpathSync(dest);
    if (!pathUnderRoot(root, resolved)) return;
    if (listing.isDirectory()) rmSync(resolved, { recursive: true, force: true });
    else unlinkSync(resolved);
  } catch {
    // retry next pass
  }
}

function removeArtifactFiles(store: RetentionStore, record: RetentionRecord): void {
  if (record.path === undefined) return;
  const location = record.location ?? "files";
  if (location === "files") {
    if (store.filesRoot === undefined) return;
    removePresent(artifactFile(store, record.path));
    return;
  }
  if (location === "jobs") {
    if (store.jobsRoot === undefined) return;
    removePresent(jobWorkspace(store.jobsRoot, record.path), true);
    return;
  }
  if (store.backupDir === undefined) return;
  removePresent(backupFile(store.backupDir, record.path));
}

function removePresent(dest: string, recursive = false): void {
  if (!existsSync(dest)) return;
  const listing = lstatSync(dest);
  if (listing.isSymbolicLink()) {
    unlinkSync(dest);
    return;
  }
  if (recursive && listing.isDirectory()) {
    rmSync(dest, { recursive: true, force: true });
    return;
  }
  unlinkSync(dest);
}

function artifactFile(store: RetentionStore, relativePath: string): string {
  const root = store.filesRoot;
  if (root === undefined) throw new Error("Invalid retention");
  assertRelativePath(relativePath);
  const resolvedRoot = realpathSync(root);
  const dest = join(resolvedRoot, ...relativePath.split("/"));
  return containedDest(resolvedRoot, dest);
}

function jobWorkspace(jobsRoot: string, name: string): string {
  assertRelativePath(name);
  if (name.includes("/")) throw new Error("Invalid retention");
  const workspaceRoot = realpathSync(jobsRoot);
  const candidate = join(workspaceRoot, name);
  if (!existsSync(candidate)) return candidate;
  if (lstatSync(candidate).isSymbolicLink()) throw new Error("Invalid retention");
  const workspace = realpathSync(candidate);
  const relation = relative(workspaceRoot, workspace);
  if (
    relation === "" ||
    relation === ".." ||
    relation.startsWith(`..${sep}`) ||
    relation.includes(sep) ||
    isAbsolute(relation)
  ) {
    throw new Error("Invalid retention");
  }
  return workspace;
}

function backupFile(backupDir: string, name: string): string {
  if (!isCrashBackupName(name)) throw new Error("Invalid retention");
  const root = realpathSync(backupDir);
  const dest = join(root, name);
  if (!existsSync(dest)) return dest;
  if (lstatSync(dest).isSymbolicLink()) throw new Error("Invalid retention");
  const resolved = realpathSync(dest);
  if (relative(root, resolved) !== name) throw new Error("Invalid retention");
  return resolved;
}

function isCrashBackupName(name: string): boolean {
  for (const allowed of CRASH_BACKUP_FILES) {
    if (name === allowed) return true;
  }
  return false;
}

function containedDest(root: string, dest: string): string {
  let probe = dest;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) throw new Error("Invalid retention");
    probe = parent;
  }
  const resolvedProbe = realpathSync(probe);
  if (resolvedProbe !== root && !pathUnderRoot(root, resolvedProbe)) {
    throw new Error("Invalid retention");
  }
  if (!existsSync(dest)) {
    if (!pathUnderRoot(root, dest)) throw new Error("Invalid retention");
    return dest;
  }
  if (lstatSync(dest).isSymbolicLink()) throw new Error("Invalid retention");
  const resolvedDest = realpathSync(dest);
  if (!pathUnderRoot(root, resolvedDest)) throw new Error("Invalid retention");
  return resolvedDest;
}

function pathUnderRoot(root: string, dest: string): boolean {
  const relation = relative(root, dest);
  return relation !== "" && relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation);
}

function assertRelativePath(relativePath: string): void {
  if (
    relativePath === "" ||
    isAbsolute(relativePath) ||
    relativePath.includes("..") ||
    relativePath.includes("\\") ||
    relativePath.includes("\0")
  ) {
    throw new Error("Invalid retention");
  }
}

function safeTime(value: number): number {
  const time = Math.trunc(value);
  if (!Number.isSafeInteger(time) || time < 0) return 0;
  return time;
}

function snapshotStore(store: RetentionStore): {
  records: RetentionRecord[];
  pendingOwnerDeletes: string[];
} {
  return {
    records: [...store.records.values()].map((record) => ({ ...record })),
    pendingOwnerDeletes: [...store.pendingOwnerDeletes],
  };
}

function restoreStore(
  store: RetentionStore,
  snapshot: { records: RetentionRecord[]; pendingOwnerDeletes: string[] },
): void {
  store.records.clear();
  store.pendingOwnerDeletes.clear();
  for (const record of snapshot.records) store.records.set(record.id, { ...record });
  for (const ownerId of snapshot.pendingOwnerDeletes) store.pendingOwnerDeletes.add(ownerId);
}

function transact<T>(store: RetentionStore, fn: () => T): T {
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

function persistStore(store: RetentionStore): void {
  if (store.persistPath === undefined) return;
  const dest = store.persistPath;
  const tmp = `${dest}.${randomUUID()}.tmp`;
  try {
    writeFileSync(
      tmp,
      JSON.stringify({
        v: 1,
        records: [...store.records.values()].filter((record) => {
          try {
            parseRetentionKind(record.kind);
            return true;
          } catch {
            return false;
          }
        }),
        pendingOwnerDeletes: [...store.pendingOwnerDeletes],
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

function loadStore(store: RetentionStore, persistPath: string): void {
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
    !("records" in value) ||
    !Array.isArray(value.records)
  ) {
    throw new Error("Invalid retention store");
  }
  for (const key of Object.keys(value)) {
    if (key !== "v" && key !== "records" && key !== "pendingOwnerDeletes") {
      throw new Error("Invalid retention store");
    }
  }
  if ("pendingOwnerDeletes" in value) {
    if (!Array.isArray(value.pendingOwnerDeletes)) throw new Error("Invalid retention store");
    for (const ownerId of value.pendingOwnerDeletes) {
      if (typeof ownerId !== "string" || ownerId === "") throw new Error("Invalid retention store");
      store.pendingOwnerDeletes.add(ownerId);
    }
  }
  for (const entry of value.records) {
    const record = parsePersistedRecord(entry);
    assertStoredPath(store, record);
    store.records.set(record.id, record);
  }
}

function assertStoredPath(store: RetentionStore, record: RetentionRecord): void {
  if (record.path === undefined) return;
  const location = record.location ?? "files";
  if (location === "files") {
    artifactFile(store, record.path);
    return;
  }
  if (location === "jobs") {
    if (store.jobsRoot === undefined) throw new Error("Invalid retention");
    jobWorkspace(store.jobsRoot, record.path);
    return;
  }
  if (store.backupDir === undefined) throw new Error("Invalid retention");
  backupFile(store.backupDir, record.path);
}

function parsePersistedRecord(value: unknown): RetentionRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid retention store");
  }
  for (const key of Object.keys(value)) {
    if (
      key !== "id" &&
      key !== "ownerId" &&
      key !== "kind" &&
      key !== "createdAt" &&
      key !== "path" &&
      key !== "location"
    ) {
      throw new Error("Invalid retention store");
    }
  }
  if (
    !("id" in value) ||
    typeof value.id !== "string" ||
    value.id === "" ||
    !("ownerId" in value) ||
    typeof value.ownerId !== "string" ||
    value.ownerId === "" ||
    !("kind" in value) ||
    !("createdAt" in value) ||
    typeof value.createdAt !== "number" ||
    !Number.isSafeInteger(value.createdAt) ||
    value.createdAt < 0
  ) {
    throw new Error("Invalid retention store");
  }
  const kind = parseRetentionKind(value.kind);
  const path =
    "path" in value && typeof value.path === "string" && value.path !== "" ? value.path : undefined;
  if ("path" in value && path === undefined) throw new Error("Invalid retention store");
  const location = parseLocation("location" in value ? value.location : undefined);
  if (kind === "audit" && (path !== undefined || location !== undefined)) {
    throw new Error("Invalid retention store");
  }
  if (location === "jobs" && (kind !== "task_file" || path === undefined || path.includes("/"))) {
    throw new Error("Invalid retention store");
  }
  if (location === "backup" && (kind !== "backup" || path === undefined || !isCrashBackupName(path))) {
    throw new Error("Invalid retention store");
  }
  return {
    id: value.id,
    ownerId: value.ownerId,
    kind,
    createdAt: value.createdAt,
    ...(path === undefined ? {} : { path }),
    ...(location === undefined ? {} : { location }),
  };
}

function parseLocation(value: unknown): ArtifactLocation | undefined {
  if (value === undefined) return undefined;
  if (value === "files") return undefined;
  if (value === "jobs" || value === "backup") return value;
  throw new Error("Invalid retention store");
}
