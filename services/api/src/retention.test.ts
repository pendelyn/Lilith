import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACCOUNT_DELETION_NOTICE,
  AUDIT_TTL_MS,
  BACKUP_TTL_MS,
  PROVIDER_SIDE_LIMIT,
  SCREENSHOT_TTL_MS,
  TASK_FILE_TTL_MS,
  parseAccountDeleteRequest,
  parseAccountDeleteResponse,
  parseRetentionKind,
  retentionTtlMs,
} from "@lilith/contracts";
import { test } from "node:test";
import { createHealthServer } from "./health.ts";
import {
  captureExplicitMemory,
  createMemoryStore,
  listMemories,
  type MemoryStore,
} from "./memory.ts";
import {
  CRASH_BACKUP_FILES,
  createRetentionStore,
  deleteAccount,
  finishPendingDeletes,
  listArtifacts,
  putArtifact,
  runExpiryJob,
  type RetentionRecord,
  type RetentionStore,
} from "./retention.ts";
import {
  createParentTask,
  createTaskStore,
  researchAbortSignal,
  type TaskStore,
} from "./tasks.ts";
import { offlineWebResearchDeps } from "./web-research.ts";

const AUTH = { Authorization: "Bearer secret-token" };
const owner = { ownerId: "alpha-owner" };
const other = { ownerId: "other-owner" };

test("retention TTLs match the alpha schedule", () => {
  assert.equal(retentionTtlMs("screenshot"), SCREENSHOT_TTL_MS);
  assert.equal(retentionTtlMs("task_file"), TASK_FILE_TTL_MS);
  assert.equal(retentionTtlMs("audit"), AUDIT_TTL_MS);
  assert.equal(retentionTtlMs("backup"), BACKUP_TTL_MS);
  assert.equal(SCREENSHOT_TTL_MS, 7 * 86_400_000);
  assert.equal(TASK_FILE_TTL_MS, 30 * 86_400_000);
  assert.equal(AUDIT_TTL_MS, 90 * 86_400_000);
  assert.equal(BACKUP_TTL_MS, 30 * 86_400_000);
  assert.throws(() => parseRetentionKind("chat"), /Invalid retention/);
  assert.throws(() => parseRetentionKind("memory"), /Invalid retention/);
  assert.throws(() => parseAccountDeleteRequest({ consent: false }), /Invalid/);
  assert.throws(() => parseAccountDeleteRequest({ consent: true, extra: true }), /Invalid/);
  assert.deepEqual(parseAccountDeleteRequest({ consent: true }), { consent: true });
  assert.deepEqual(parseAccountDeleteResponse({ deleted: true }), { deleted: true });
  assert.match(ACCOUNT_DELETION_NOTICE, /immediately/i);
  assert.match(ACCOUNT_DELETION_NOTICE, /30 days/);
  assert.match(ACCOUNT_DELETION_NOTICE, /90 days/);
  assert.match(ACCOUNT_DELETION_NOTICE, /environment secret/i);
  assert.match(ACCOUNT_DELETION_NOTICE, /does not revoke/i);
  assert.match(PROVIDER_SIDE_LIMIT, /cannot delete/i);
  assert.match(PROVIDER_SIDE_LIMIT, /No model provider is connected/i);
});

test("expiry deletes artifacts at TTL boundaries and never chats or memories", () => {
  const dir = mkdtempSync(join(tmpdir(), "lilith-retention-"));
  try {
    let now = 1_000;
    const filesRoot = join(dir, "files");
    const store = createRetentionStore({ now: () => now, persistPath: join(dir, "state.json"), filesRoot });
    const tasks = createTaskStore();
    const memories = createMemoryStore();
    const chatPath = join(dir, "chat.json");
    writeFileSync(chatPath, JSON.stringify([{ id: "c1", text: "hello" }]));
    captureExplicitMemory(memories, owner, "Merk dir: Antwortsprache Deutsch", true);
    const task = createParentTask(tasks, owner, "keep this task");
    const screenshot = putArtifact(store, owner, { kind: "screenshot", body: "shot" });
    const taskFile = putArtifact(store, owner, { kind: "task_file", body: "tmp" });
    const audit = putArtifact(store, owner, { kind: "audit" });
    const backup = putArtifact(store, owner, { kind: "backup", body: JSON.stringify({ memory: "Antwortsprache Deutsch" }) });
    const foreign = putArtifact(store, other, { kind: "task_file", body: "foreign" });
    now = 2_000;
    const freshShot = putArtifact(store, owner, { kind: "screenshot", body: "fresh" });
    store.records.set("chat-1", {
      id: "chat-1",
      ownerId: owner.ownerId,
      kind: "chat",
      createdAt: 0,
    } as unknown as RetentionRecord);
    store.records.set("memory-1", {
      id: "memory-1",
      ownerId: owner.ownerId,
      kind: "memory",
      createdAt: 0,
    } as unknown as RetentionRecord);

    now = screenshot.createdAt + SCREENSHOT_TTL_MS - 1;
    assert.deepEqual(runExpiryJob(store).deleted, []);
    assert.equal(existsSync(join(filesRoot, screenshot.path ?? "")), true);

    now = screenshot.createdAt + SCREENSHOT_TTL_MS;
    let deleted = runExpiryJob(store);
    assert.deepEqual(
      deleted.deleted.map((entry) => entry.id),
      [screenshot.id],
    );
    assert.equal(existsSync(join(filesRoot, screenshot.path ?? "")), false);
    assert.equal(existsSync(join(filesRoot, freshShot.path ?? "")), true);

    now = taskFile.createdAt + TASK_FILE_TTL_MS;
    deleted = runExpiryJob(store);
    const deletedIds = new Set(deleted.deleted.map((entry) => entry.id));
    assert.equal(deletedIds.has(taskFile.id), true);
    assert.equal(deletedIds.has(backup.id), true);
    assert.equal(deletedIds.has(foreign.id), true);
    assert.equal(deletedIds.has(freshShot.id), true);
    assert.equal(existsSync(join(filesRoot, taskFile.path ?? "")), false);
    assert.equal(existsSync(join(filesRoot, backup.path ?? "")), false);
    assert.equal(existsSync(join(filesRoot, foreign.path ?? "")), false);
    assert.equal(existsSync(join(filesRoot, freshShot.path ?? "")), false);

    now = audit.createdAt + AUDIT_TTL_MS - 1;
    assert.equal(runExpiryJob(store).deleted.length, 0);
    now = audit.createdAt + AUDIT_TTL_MS;
    deleted = runExpiryJob(store);
    assert.deepEqual(deleted.deleted.map((entry) => entry.kind), ["audit"]);

    assert.equal(store.records.has("chat-1"), true);
    assert.equal(store.records.has("memory-1"), true);
    assert.equal(existsSync(chatPath), true);
    assert.equal(readFileSync(chatPath, "utf8").includes("hello"), true);
    assert.equal(listMemories(memories, owner).length, 1);
    assert.equal(listMemories(memories, owner)[0]?.content, "Antwortsprache Deutsch");
    assert.equal(tasks.tasks.get(task.id)?.assignment, "keep this task");
    assert.equal(store.records.has(freshShot.id), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("account deletion removes active data immediately and leaves backups until 30 days", () => {
  const dir = mkdtempSync(join(tmpdir(), "lilith-account-"));
  try {
    let now = 5_000;
    const filesRoot = join(dir, "files");
    const tasksPath = join(dir, ".lilith-tasks.json");
    const memoriesPath = join(dir, ".lilith-memories.json");
    const retention = createRetentionStore({ now: () => now, persistPath: join(dir, "state.json"), filesRoot });
    const tasks = createTaskStore({ persistPath: tasksPath });
    const memories = createMemoryStore({ persistPath: memoriesPath });
    captureExplicitMemory(memories, owner, "Merk dir: Antwortsprache Deutsch", true);
    captureExplicitMemory(memories, other, "Merk dir: Keep foreign", true);
    const task = createParentTask(tasks, owner, "owner task");
    const foreignTask = createParentTask(tasks, other, "foreign task");
    const screenshot = putArtifact(retention, owner, { kind: "screenshot", body: "shot" });
    const taskFile = putArtifact(retention, owner, { kind: "task_file", body: "tmp" });
    const backup = putArtifact(retention, owner, { kind: "backup", body: "snap" });
    const foreignBackup = putArtifact(retention, other, { kind: "backup", body: "other" });

    deleteAccount(retention, tasks, memories, owner);

    assert.deepEqual(listMemories(memories, owner), []);
    assert.equal(listMemories(memories, other).length, 1);
    assert.equal(tasks.tasks.has(task.id), false);
    assert.equal(tasks.tasks.get(foreignTask.id)?.assignment, "foreign task");
    assert.equal(retention.records.has(screenshot.id), false);
    assert.equal(retention.records.has(taskFile.id), false);
    assert.equal(existsSync(join(filesRoot, screenshot.path ?? "")), false);
    assert.equal(existsSync(join(filesRoot, taskFile.path ?? "")), false);
    assert.equal(retention.records.has(backup.id), true);
    assert.equal(existsSync(join(filesRoot, backup.path ?? "")), true);
    assert.equal(retention.records.has(foreignBackup.id), true);
    const audit = listArtifacts(retention, owner).filter((record) => record.kind === "audit");
    assert.equal(audit.length, 1);
    assert.equal(retention.pendingOwnerDeletes.size, 0);

    const reloadedTasks = createTaskStore({ persistPath: tasksPath });
    const reloadedMemories = createMemoryStore({ persistPath: memoriesPath });
    const reloadedRetention = createRetentionStore({ now: () => now, persistPath: join(dir, "state.json"), filesRoot });
    assert.equal(reloadedTasks.tasks.has(task.id), false);
    assert.equal(reloadedTasks.tasks.get(foreignTask.id)?.assignment, "foreign task");
    assert.deepEqual(listMemories(reloadedMemories, owner), []);
    assert.equal(listMemories(reloadedMemories, other)[0]?.content, "Keep foreign");
    assert.equal(reloadedRetention.records.has(backup.id), true);
    assert.equal(reloadedRetention.pendingOwnerDeletes.size, 0);

    now = backup.createdAt + BACKUP_TTL_MS - 1;
    assert.equal(runExpiryJob(retention).deleted.some((entry) => entry.id === backup.id), false);
    now = backup.createdAt + BACKUP_TTL_MS;
    const deleted = runExpiryJob(retention);
    assert.equal(deleted.deleted.some((entry) => entry.id === backup.id), true);
    assert.equal(retention.records.has(backup.id), false);
    assert.equal(existsSync(join(filesRoot, backup.path ?? "")), false);
    assert.equal(retention.records.has(audit[0]?.id ?? ""), true);
    assert.equal(listMemories(memories, other)[0]?.content, "Keep foreign");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("retention persists, restores, and rolls back on persist failure", () => {
  const dir = mkdtempSync(join(tmpdir(), "lilith-retention-persist-"));
  try {
    const persistPath = join(dir, "state.json");
    const filesRoot = join(dir, "files");
    const store = createRetentionStore({ persistPath, filesRoot, now: () => 10 });
    const record = putArtifact(store, owner, { kind: "task_file", body: "keep" });
    const disk = readFileSync(persistPath);
    (store as { persistPath?: string }).persistPath = join(persistPath, "blocked.json");
    assert.throws(() => putArtifact(store, owner, { kind: "screenshot", body: "nope" }));
    assert.equal(store.records.has(record.id), true);
    assert.equal(store.records.size, 1);
    assert.deepEqual(readFileSync(persistPath), disk);

    const reloaded = createRetentionStore({ persistPath, filesRoot });
    assert.equal(reloaded.records.get(record.id)?.kind, "task_file");
    assert.equal(existsSync(join(filesRoot, record.path ?? "")), true);

    writeFileSync(
      persistPath,
      JSON.stringify({
        v: 1,
        records: [{ id: "x", ownerId: "alpha-owner", kind: "task_file", createdAt: 1, path: "../secret" }],
      }),
    );
    assert.throws(() => createRetentionStore({ persistPath, filesRoot }), /Invalid retention/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("POST /account/delete wipes owner data and requires consent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lilith-account-http-"));
  try {
    const retention = createRetentionStore({ filesRoot: join(dir, "files") });
    const tasks = createTaskStore();
    const memories = createMemoryStore();
    captureExplicitMemory(memories, owner, "Merk dir: Antwortsprache Deutsch", true);
    createParentTask(tasks, owner, "owner task");
    const backup = putArtifact(retention, owner, { kind: "backup", body: "snap" });
    putArtifact(retention, owner, { kind: "screenshot", body: "shot" });

    await withServer(async (base) => {
      assert.equal((await fetch(`${base}/account/delete`)).status, 401);
      assert.equal((await fetch(`${base}/account/delete`, { method: "GET", headers: AUTH })).status, 405);
      const denied = await fetch(`${base}/account/delete`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ consent: false }),
      });
      assert.equal(denied.status, 400);
      assert.equal(listMemories(memories, owner).length, 1);
      const allowed = await fetch(`${base}/account/delete`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ consent: true }),
      });
      assert.equal(allowed.status, 200);
      assert.deepEqual(parseAccountDeleteResponse(await allowed.json()), { deleted: true });
      assert.deepEqual(listMemories(memories, owner), []);
      assert.equal([...tasks.tasks.values()].filter((task) => task.ownerId === owner.ownerId).length, 0);
      assert.equal(retention.records.has(backup.id), true);
      assert.equal(listArtifacts(retention, owner).some((record) => record.kind === "screenshot"), false);
      assert.equal(listArtifacts(retention, owner).some((record) => record.kind === "audit"), true);
    }, tasks, memories, retention);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("expiry adopts runner workspaces and crash backups without touching live chats, tasks, or memories", () => {
  const dir = mkdtempSync(join(tmpdir(), "lilith-retention-adopt-"));
  try {
    const jobsRoot = join(dir, ".lilith-jobs");
    const filesRoot = join(dir, "files");
    mkdirSync(jobsRoot, { recursive: true, mode: 0o700 });
    const workspace = mkdtempSync(join(jobsRoot, "unit-"));
    writeFileSync(join(workspace, "output.txt"), "temporary task output");
    const tasksPath = join(dir, ".lilith-tasks.json");
    const memoriesPath = join(dir, ".lilith-memories.json");
    const chatPath = join(dir, "chat.json");
    const tasks = createTaskStore({ persistPath: tasksPath });
    const memories = createMemoryStore({ persistPath: memoriesPath });
    captureExplicitMemory(memories, owner, "Merk dir: Antwortsprache Deutsch", true);
    const task = createParentTask(tasks, owner, "keep this task");
    writeFileSync(chatPath, JSON.stringify([{ id: "c1", text: "hello" }]));
    writeFileSync(join(dir, CRASH_BACKUP_FILES[0]), JSON.stringify({ v: 1, tasks: [{ leaked: true }] }));
    writeFileSync(join(dir, CRASH_BACKUP_FILES[1]), JSON.stringify({ v: 1, memories: [{ leaked: true }] }));
    const aged = new Date(Date.now() - TASK_FILE_TTL_MS - 2_000);
    utimesSync(workspace, aged, aged);
    utimesSync(join(dir, CRASH_BACKUP_FILES[0]), aged, aged);
    utimesSync(join(dir, CRASH_BACKUP_FILES[1]), aged, aged);

    const retention = createRetentionStore({
      now: Date.now,
      persistPath: join(dir, "state.json"),
      filesRoot,
      jobsRoot,
      backupDir: dir,
      defaultOwnerId: owner.ownerId,
    });
    const deleted = runExpiryJob(retention);
    const deletedKinds = deleted.deleted.map((entry) => entry.kind).sort();
    assert.deepEqual(deletedKinds, ["backup", "backup", "task_file"]);
    assert.equal(existsSync(workspace), false);
    assert.equal(existsSync(join(dir, CRASH_BACKUP_FILES[0])), false);
    assert.equal(existsSync(join(dir, CRASH_BACKUP_FILES[1])), false);
    assert.equal(existsSync(tasksPath), true);
    assert.equal(existsSync(memoriesPath), true);
    assert.equal(readFileSync(chatPath, "utf8").includes("hello"), true);
    const reloadedTasks = createTaskStore({ persistPath: tasksPath });
    const reloadedMemories = createMemoryStore({ persistPath: memoriesPath });
    assert.equal(reloadedTasks.tasks.get(task.id)?.assignment, "keep this task");
    assert.equal(listMemories(reloadedMemories, owner)[0]?.content, "Antwortsprache Deutsch");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("account deletion tombstone finishes after persist failure and restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "lilith-account-restart-"));
  try {
    const jobsRoot = join(dir, ".lilith-jobs");
    mkdirSync(jobsRoot, { recursive: true, mode: 0o700 });
    const workspace = mkdtempSync(join(jobsRoot, "unit-"));
    writeFileSync(join(workspace, "scratch.txt"), "job output");
    const tasksPath = join(dir, ".lilith-tasks.json");
    const memoriesPath = join(dir, ".lilith-memories.json");
    const tasks = createTaskStore({ persistPath: tasksPath });
    const memories = createMemoryStore({ persistPath: memoriesPath });
    captureExplicitMemory(memories, owner, "Merk dir: Antwortsprache Deutsch", true);
    const task = createParentTask(tasks, owner, "owner task");
    const signal = researchAbortSignal(tasks, task.id);
    const retention = createRetentionStore({
      persistPath: join(dir, "state.json"),
      filesRoot: join(dir, "files"),
      jobsRoot,
      backupDir: dir,
      defaultOwnerId: owner.ownerId,
    });
    putArtifact(retention, owner, { kind: "screenshot", body: "shot" });

    (tasks as { persistPath?: string }).persistPath = join(tasksPath, "blocked.json");
    assert.throws(() => deleteAccount(retention, tasks, memories, owner));
    assert.equal(signal.aborted, false);
    assert.equal(tasks.tasks.has(task.id), true);
    assert.equal(retention.pendingOwnerDeletes.has(owner.ownerId), true);
    assert.equal(existsSync(workspace), false);
    assert.deepEqual(listMemories(memories, owner), []);

    const resurrectedTasks = createTaskStore({ persistPath: tasksPath });
    const resurrectedMemories = createMemoryStore({ persistPath: memoriesPath });
    assert.equal(resurrectedTasks.tasks.has(task.id), true);
    assert.deepEqual(listMemories(resurrectedMemories, owner), []);
    const pending = createRetentionStore({
      persistPath: join(dir, "state.json"),
      filesRoot: join(dir, "files"),
      jobsRoot,
      backupDir: dir,
      defaultOwnerId: owner.ownerId,
    });
    assert.equal(pending.pendingOwnerDeletes.has(owner.ownerId), true);

    (tasks as { persistPath?: string }).persistPath = tasksPath;
    finishPendingDeletes(retention, tasks, memories);
    assert.equal(signal.aborted, true);
    assert.equal(tasks.tasks.has(task.id), false);
    assert.equal(retention.pendingOwnerDeletes.has(owner.ownerId), false);
    const wipedTasks = createTaskStore({ persistPath: tasksPath });
    const wipedMemories = createMemoryStore({ persistPath: memoriesPath });
    const wipedRetention = createRetentionStore({
      persistPath: join(dir, "state.json"),
      filesRoot: join(dir, "files"),
      jobsRoot,
      backupDir: dir,
      defaultOwnerId: owner.ownerId,
    });
    assert.equal(wipedTasks.tasks.size, 0);
    assert.deepEqual(listMemories(wipedMemories, owner), []);
    assert.equal(wipedRetention.pendingOwnerDeletes.size, 0);
    assert.equal(listArtifacts(wipedRetention, owner).some((record) => record.kind === "audit"), true);
    assert.equal(listArtifacts(wipedRetention, owner).some((record) => record.kind === "screenshot"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pending delete fails closed for HTTP owner ops and restart until explicit retry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lilith-account-pending-http-"));
  try {
    const tasksPath = join(dir, ".lilith-tasks.json");
    const memoriesPath = join(dir, ".lilith-memories.json");
    const persistPath = join(dir, "state.json");
    const filesRoot = join(dir, "files");
    const tasks = createTaskStore({ persistPath: tasksPath });
    const memories = createMemoryStore({ persistPath: memoriesPath });
    captureExplicitMemory(memories, owner, "Merk dir: Antwortsprache Deutsch", true);
    const task = createParentTask(tasks, owner, "owner task");
    const retention = createRetentionStore({ persistPath, filesRoot, defaultOwnerId: owner.ownerId });

    (tasks as { persistPath?: string }).persistPath = join(tasksPath, "blocked.json");
    await withServer(async (base) => {
      const failed = await fetch(`${base}/account/delete`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ consent: true }),
      });
      assert.equal(failed.status, 500);
      assert.equal(await failed.text(), "");
      assert.equal(retention.pendingOwnerDeletes.has(owner.ownerId), true);
      assert.deepEqual(listMemories(memories, owner), []);
      assert.equal(tasks.tasks.has(task.id), true);
      assert.throws(() => finishPendingDeletes(retention, tasks, memories));
      assert.equal(retention.pendingOwnerDeletes.has(owner.ownerId), true);

      const health = await fetch(`${base}/health`, { headers: AUTH });
      assert.equal(health.status, 200);
      assert.equal(await health.text(), '{"status":"ok"}');

      const chat = await fetch(`${base}/chat`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Merk dir: New after failed delete", memoryEnabled: true }),
      });
      assert.equal(chat.status, 409);
      assert.equal(await chat.text(), "");
      const listedMemories = await fetch(`${base}/memories`, { headers: AUTH });
      assert.equal(listedMemories.status, 409);
      assert.equal(await listedMemories.text(), "");
      const listedTasks = await fetch(`${base}/tasks`, { headers: AUTH });
      assert.equal(listedTasks.status, 409);
      assert.equal(await listedTasks.text(), "");
      const stopped = await fetch(`${base}/tasks/${task.id}/stop`, { method: "POST", headers: AUTH });
      assert.equal(stopped.status, 409);
      assert.equal(
        listMemories(memories, owner).some((item) => item.content.includes("New after failed delete")),
        false,
      );
      assert.equal(tasks.tasks.has(task.id), true);

      const denied = await fetch(`${base}/account/delete`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ consent: false }),
      });
      assert.equal(denied.status, 400);
      const retryBlocked = await fetch(`${base}/account/delete`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ consent: true }),
      });
      assert.equal(retryBlocked.status, 500);
      assert.equal(retention.pendingOwnerDeletes.has(owner.ownerId), true);
    }, tasks, memories, retention);

    const resurrectedTasks = createTaskStore({ persistPath: tasksPath });
    const resurrectedMemories = createMemoryStore({ persistPath: memoriesPath });
    const pending = createRetentionStore({ persistPath, filesRoot, defaultOwnerId: owner.ownerId });
    assert.equal(pending.pendingOwnerDeletes.has(owner.ownerId), true);
    assert.equal(resurrectedTasks.tasks.has(task.id), true);
    assert.deepEqual(listMemories(resurrectedMemories, owner), []);
    assert.equal(
      listMemories(resurrectedMemories, owner).some((item) => item.content.includes("New after failed delete")),
      false,
    );

    await withServer(async (base) => {
      const health = await fetch(`${base}/health`, { headers: AUTH });
      assert.equal(health.status, 200);
      const chat = await fetch(`${base}/chat`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Merk dir: New after failed delete", memoryEnabled: true }),
      });
      assert.equal(chat.status, 409);
      assert.equal((await fetch(`${base}/memories`, { headers: AUTH })).status, 409);
      assert.equal((await fetch(`${base}/tasks`, { headers: AUTH })).status, 409);
      const unauth = await fetch(`${base}/account/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ consent: true }),
      });
      assert.equal(unauth.status, 401);
      const retried = await fetch(`${base}/account/delete`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ consent: true }),
      });
      assert.equal(retried.status, 200);
      assert.deepEqual(parseAccountDeleteResponse(await retried.json()), { deleted: true });
      assert.equal(pending.pendingOwnerDeletes.size, 0);
      assert.equal(resurrectedTasks.tasks.has(task.id), false);
      assert.deepEqual(listMemories(resurrectedMemories, owner), []);
      const openMemories = await fetch(`${base}/memories`, { headers: AUTH });
      assert.equal(openMemories.status, 200);
      assert.equal((await fetch(`${base}/tasks`, { headers: AUTH })).status, 200);
    }, resurrectedTasks, resurrectedMemories, pending);

    (tasks as { persistPath?: string }).persistPath = tasksPath;
    finishPendingDeletes(retention, tasks, memories);
    assert.equal(retention.pendingOwnerDeletes.size, 0);
    assert.equal(
      listMemories(memories, owner).some((item) => item.content.includes("New after failed delete")),
      false,
    );
    assert.equal(tasks.tasks.has(task.id), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("orphan files are swept and a bad path does not stall other TTLs", () => {
  const dir = mkdtempSync(join(tmpdir(), "lilith-retention-sweep-"));
  try {
    let now = 1_000;
    const filesRoot = join(dir, "files");
    const store = createRetentionStore({ now: () => now, persistPath: join(dir, "state.json"), filesRoot });
    const screenshot = putArtifact(store, owner, { kind: "screenshot", body: "shot" });
    const taskFile = putArtifact(store, owner, { kind: "task_file", body: "tmp" });
    mkdirSync(join(filesRoot, "screenshot"), { recursive: true });
    writeFileSync(join(filesRoot, "screenshot", "orphan"), "leaked");

    now = screenshot.createdAt + SCREENSHOT_TTL_MS;
    const outside = join(dir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "secret");
    const kindDir = join(filesRoot, "task_file");
    rmSync(join(filesRoot, taskFile.path ?? ""), { force: true });
    rmSync(kindDir, { recursive: true, force: true });
    const linked = tryDirLink(outside, kindDir);
    const deleted = runExpiryJob(store);
    assert.equal(deleted.deleted.some((entry) => entry.id === screenshot.id), true);
    assert.equal(existsSync(join(filesRoot, screenshot.path ?? "")), false);
    assert.equal(existsSync(join(filesRoot, "screenshot", "orphan")), false);
    assert.equal(readFileSync(join(outside, "secret.txt"), "utf8"), "secret");
    if (linked) {
      assert.equal(store.records.has(taskFile.id), true);
      now = taskFile.createdAt + TASK_FILE_TTL_MS;
      unlinkSync(kindDir);
      mkdirSync(kindDir, { recursive: true, mode: 0o700 });
      assert.equal(runExpiryJob(store).deleted.some((entry) => entry.id === taskFile.id), true);
      assert.equal(store.records.has(taskFile.id), false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("artifact writes refuse a kind directory that escapes the retention root", () => {
  const dir = mkdtempSync(join(tmpdir(), "lilith-retention-link-"));
  try {
    const filesRoot = join(dir, "files");
    const store = createRetentionStore({ persistPath: join(dir, "state.json"), filesRoot });
    const outside = join(dir, "outside");
    mkdirSync(outside);
    const kindDir = join(filesRoot, "screenshot");
    mkdirSync(kindDir, { recursive: true });
    rmSync(kindDir, { recursive: true, force: true });
    if (!tryDirLink(outside, kindDir)) return;
    assert.throws(() => putArtifact(store, owner, { kind: "screenshot", body: "shot" }), /Invalid retention/);
    assert.equal(readdirSafe(outside).length, 0);
    assert.equal(store.records.size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tryDirLink(target: string, path: string): boolean {
  try {
    symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  }
}

function readdirSafe(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

async function withServer(
  run: (base: string) => Promise<void>,
  store: TaskStore,
  memories: MemoryStore,
  retention: RetentionStore,
): Promise<void> {
  const server = createHealthServer(
    { token: "secret-token", ownerId: "alpha-owner" },
    store,
    memories,
    offlineWebResearchDeps(),
    retention,
  );
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address");
  }
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
