import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseApprovalAction, parseApprovalDecision, parseSubagentCard, type ApprovalAction } from "@lilith/contracts";
import {
  APPROVAL_TTL_MS, TASK_MAX_RUNTIME_MS, acceptToolResult, applyLimits, createParentTask, createTaskStore,
  decideApproval, mockApprovalAction, openApproval, recordCost, resumeTask, runApprovalResearch,
  setTaskState, stopTask, type TaskStore,
} from "./tasks.ts";

const owner = { ownerId: "owner" };
function fixture(store: TaskStore = createTaskStore()) {
  const card = runApprovalResearch(store, owner).cards[0]!;
  assert.ok(card.approval);
  return { store, card, approval: card.approval, action: mockApprovalAction(card.approval.actionId) };
}

test("approval preview contains the exact action, data, files, digest, cost and expiry", () => {
  const { card, approval, action } = fixture(createTaskStore({ now: () => 100 }));
  assert.deepEqual(parseSubagentCard(card), card);
  assert.equal(approval.expiresAt, 100 + APPROVAL_TTL_MS);
  assert.match(approval.payloadDigest, /^[a-f0-9]{64}$/);
  for (const [key, value] of Object.entries(action)) assert.deepEqual(approval[key as keyof ApprovalAction], value);
  assert.equal(approval.state, "pending");
});

test("rejection calls nothing; concurrent consent dispatches exactly once with the action idempotency key", async () => {
  for (const consent of [false, true]) {
    const { store, approval, action } = fixture();
    let calls = 0;
    const invoke = async (actual: ApprovalAction, key: string) => {
      calls++;
      assert.deepEqual(actual, action);
      assert.equal(key, action.actionId);
      await new Promise((resolve) => setImmediate(resolve));
      return "mock result";
    };
    const input = { approval, consent };
    const results = await Promise.allSettled([
      decideApproval(store, owner, approval.taskId, input, action, invoke),
      decideApproval(store, owner, approval.taskId, input, action, invoke),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(calls, consent ? 1 : 0);
    const task = store.tasks.get(approval.taskId);
    assert.equal(task?.approval?.state, consent ? "consumed" : "rejected");
    assert.equal(task?.state, "completed");
    assert.equal(store.tasks.get(task?.parentTaskId ?? "")?.state, "completed");
    assert.equal(store.approvals.size, 0);
  }
});

test("every changed binding and every changed actual tool argument needs new consent", async () => {
  const { store, approval, action } = fixture();
  let calls = 0;
  const invoke = () => { calls++; return "bad"; };
  const changes = {
    id: "another-approval", taskId: "another-task", actionId: "another-action",
    actionClass: "data_disclosure", origin: "https://changed.example", operation: "GET /notes",
    payload: "private data", files: [{ path: "different.txt", content: "private file" }],
    payloadDigest: "0".repeat(64), maxCostCents: 1, expiresAt: approval.expiresAt + 1, state: "consumed",
  };
  for (const [key, value] of Object.entries(changes)) {
    await assert.rejects(decideApproval(store, owner, approval.taskId, { consent: true, approval: { ...approval, [key]: value } }, action, invoke));
    if (key in action) {
      await assert.rejects(decideApproval(store, owner, approval.taskId, { consent: true, approval }, { ...action, [key]: value }, invoke));
    }
  }
  // Digest binds file contents even when the filename stays the same.
  await assert.rejects(decideApproval(store, owner, approval.taskId, { consent: true, approval }, { ...action, files: [{ ...action.files[0]!, content: "changed" }] }, invoke));
  assert.equal(calls, 0);
  assert.equal(store.tasks.get(approval.taskId)?.approval?.state, "pending");
  const changed = { ...action, payload: "reviewed new data" };
  const fresh = openApproval(store, owner, approval.taskId, changed);
  assert.notEqual(fresh.id, approval.id);
  await decideApproval(store, owner, approval.taskId, { approval: fresh, consent: true }, changed, invoke);
  assert.equal(calls, 1);
});

test("expiry is enforced at the boundary; a new preview is required", async () => {
  let now = 0;
  const { store, approval, action } = fixture(createTaskStore({ now: () => now }));
  now = APPROVAL_TTL_MS;
  let calls = 0;
  await assert.rejects(decideApproval(store, owner, approval.taskId, { approval, consent: true }, action, () => { calls++; return "bad"; }), /expired/);
  assert.equal(calls, 0);
  const fresh = runApprovalResearch(store, owner).cards[0]!.approval!;
  assert.equal(fresh.taskId, approval.taskId);
  assert.notEqual(fresh.id, approval.id);
  assert.equal(fresh.expiresAt, now + APPROVAL_TTL_MS);
});

test("owner, stopped task, paused task and cost limits gate the dispatch", async () => {
  for (const reason of ["owner", "stop", "pause", "budget", "time"] as const) {
    let now = 0;
    const { store, approval, action } = fixture(createTaskStore({ now: () => now }));
    if (reason === "stop") stopTask(store, owner, approval.taskId);
    if (reason === "pause") setTaskState(store, owner, approval.taskId, "paused");
    if (reason === "budget") recordCost(store, owner, approval.taskId, 100);
    if (reason === "time") now = TASK_MAX_RUNTIME_MS;
    let calls = 0;
    await assert.rejects(decideApproval(store, reason === "owner" ? { ownerId: "foreign" } : owner, approval.taskId, { approval, consent: true }, action, () => { calls++; return "bad"; }));
    assert.equal(calls, 0);
  }
  const { store, approval, action } = fixture();
  const costly = { ...action, maxCostCents: 101 };
  const fresh = openApproval(store, owner, approval.taskId, costly);
  await assert.rejects(decideApproval(store, owner, approval.taskId, { approval: fresh, consent: true }, costly, () => "bad"), /budget/);
});

test("data disclosure requires explicit approval too", async () => {
  const { store, approval, action } = fixture();
  const disclosure: ApprovalAction = { ...action, actionClass: "data_disclosure", operation: "GET /search", payload: "private search term" };
  const fresh = openApproval(store, owner, approval.taskId, disclosure);
  let calls = 0;
  await decideApproval(store, owner, approval.taskId, { approval: fresh, consent: true }, disclosure, () => { calls++; return "result"; });
  assert.equal(calls, 1);
});

test("restart preserves pending bindings and consumed actions never replay, including uncertain outcomes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lilith-approvals-"));
  const persistPath = join(dir, "state.json");
  try {
    const { store, approval, action } = fixture(createTaskStore({ persistPath }));
    setTaskState(store, owner, approval.taskId, "paused");
    const reloaded = createTaskStore({ persistPath });
    resumeTask(reloaded, owner, approval.taskId, { consent: true });
    let calls = 0;
    await assert.rejects(decideApproval(reloaded, owner, approval.taskId, { approval, consent: true }, action, () => {
      calls++;
      const disk = createTaskStore({ persistPath });
      assert.equal(disk.tasks.get(approval.taskId)?.approval?.state, "consumed");
      throw new Error("unknown external outcome");
    }), /unknown external outcome/);
    assert.equal(reloaded.tasks.get(approval.taskId)?.state, "failed");
    assert.equal(reloaded.tasks.get(approval.taskId)?.result, undefined);
    const after = createTaskStore({ persistPath });
    assert.equal(after.tasks.get(approval.taskId)?.state, "failed");
    assert.throws(() => acceptToolResult(after, owner, approval.taskId, "late success"), /cannot accept results/);
    await assert.rejects(decideApproval(after, owner, approval.taskId, { approval, consent: true }, action, () => { calls++; return "bad"; }));
    assert.equal(calls, 1);
    // A second approval cannot replay the same consumed action ID on another task.
    const second = createParentTask(after, owner, "duplicate action");
    const duplicate = openApproval(after, owner, second.id, action);
    await assert.rejects(decideApproval(after, owner, duplicate.taskId, { approval: duplicate, consent: true }, action, () => { calls++; return "bad"; }), /already consumed/);
    assert.equal(calls, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("failed persistence performs no call and leaves approval pending", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lilith-approval-fail-"));
  const persistPath = join(dir, "state.json");
  const { store, approval, action } = fixture(createTaskStore({ persistPath }));
  const before = readFileSync(persistPath, "utf8");
  assert.ok(before.includes(approval.id));
  rmSync(dir, { recursive: true, force: true });
  let calls = 0;
  await assert.rejects(decideApproval(store, owner, approval.taskId, { approval, consent: true }, action, () => { calls++; return "bad"; }));
  assert.equal(calls, 0);
  assert.equal(store.tasks.get(approval.taskId)?.approval?.state, "pending");
  assert.equal(store.approvals.has(approval.id), true);
});

test("paused consumed-without-result reloads as failed and cannot become a late success", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lilith-paused-consumed-"));
  try {
    const persistPath = join(dir, "crash.json");
    const { store, approval, action } = fixture(createTaskStore({ persistPath }));
    const child = store.tasks.get(approval.taskId);
    const parent = store.tasks.get(child?.parentTaskId ?? "");
    assert.ok(child?.approval);
    assert.ok(parent);
    writeFileSync(persistPath, JSON.stringify({
      v: 1,
      tasks: [
        { ...parent, state: "paused", pauseReason: "time" },
        { ...child, state: "paused", pauseReason: "time", approval: { ...child.approval, state: "consumed" } },
      ],
    }));
    const reloaded = createTaskStore({ persistPath });
    assert.equal(reloaded.tasks.get(child.id)?.state, "failed");
    assert.equal(reloaded.tasks.get(parent.id)?.state, "failed");
    assert.equal("pauseReason" in (reloaded.tasks.get(child.id) ?? {}), false);
    assert.equal("pauseReason" in (reloaded.tasks.get(parent.id) ?? {}), false);
    assert.equal(reloaded.tasks.get(child.id)?.approval?.state, "consumed");
    assert.equal(reloaded.tasks.get(child.id)?.result, undefined);
    assert.throws(() => resumeTask(reloaded, owner, child.id, { consent: true }), /not paused/);
    assert.throws(() => acceptToolResult(reloaded, owner, child.id, "late success"), /cannot accept results/);
    await assert.rejects(decideApproval(reloaded, owner, child.id, { approval, consent: true }, action, () => "bad"));
    stopTask(reloaded, owner, child.id);
    const afterPersist = createTaskStore({ persistPath });
    assert.equal(afterPersist.tasks.get(child.id)?.state, "failed");
    assert.equal(afterPersist.tasks.get(parent.id)?.state, "failed");
    assert.equal("pauseReason" in (afterPersist.tasks.get(child.id) ?? {}), false);

    writeFileSync(persistPath, JSON.stringify({
      v: 1,
      tasks: [
        { ...parent, state: "stopped" },
        { ...child, state: "stopped", approval: { ...child.approval, state: "consumed" } },
      ],
    }));
    const stopped = createTaskStore({ persistPath });
    assert.equal(stopped.tasks.get(child.id)?.state, "stopped");
    assert.equal(stopped.tasks.get(parent.id)?.state, "stopped");
    assert.throws(() => acceptToolResult(stopped, owner, child.id, "late success"), /cannot accept results/);
    await assert.rejects(decideApproval(stopped, owner, child.id, { approval, consent: true }, action, () => "bad"));

    let now = 0;
    const livePath = join(dir, "live.json");
    const live = fixture(createTaskStore({ persistPath: livePath, now: () => now }));
    await assert.rejects(decideApproval(live.store, owner, live.approval.taskId, {
      approval: live.approval,
      consent: true,
    }, live.action, async () => {
      now = TASK_MAX_RUNTIME_MS;
      applyLimits(live.store, owner, live.approval.taskId);
      assert.equal(live.store.tasks.get(live.approval.taskId)?.state, "paused");
      return "late success";
    }), /cannot accept results/);
    const liveChild = live.store.tasks.get(live.approval.taskId);
    assert.equal(liveChild?.state, "failed");
    assert.equal("pauseReason" in (liveChild ?? {}), false);
    assert.equal(live.store.tasks.get(liveChild?.parentTaskId ?? "")?.state, "failed");
    assert.equal("pauseReason" in (live.store.tasks.get(liveChild?.parentTaskId ?? "") ?? {}), false);
    const liveReload = createTaskStore({ persistPath: livePath });
    assert.equal(liveReload.tasks.get(live.approval.taskId)?.state, "failed");
    assert.equal("pauseReason" in (liveReload.tasks.get(live.approval.taskId) ?? {}), false);
    assert.throws(() => resumeTask(liveReload, owner, live.approval.taskId, { consent: true }), /not paused/);
    assert.throws(() => acceptToolResult(liveReload, owner, live.approval.taskId, "late success"), /cannot accept results/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("stop during dispatch prevents a late successful result without allowing replay", async () => {
  const { store, approval, action } = fixture();
  await assert.rejects(decideApproval(store, owner, approval.taskId, { approval, consent: true }, action, () => {
    stopTask(store, owner, approval.taskId);
    return "late result";
  }), /cannot accept results/);
  assert.equal(store.tasks.get(approval.taskId)?.state, "stopped");
  assert.equal(store.tasks.get(approval.taskId)?.result, undefined);
  assert.equal(store.tasks.get(approval.taskId)?.approval?.state, "consumed");
});

test("approval trust boundaries reject malformed or unbound input", () => {
  const { approval, action } = fixture();
  for (const input of [null, {}, { consent: true }, { approval, consent: "yes" }, { approval, consent: true, extra: 1 }]) {
    assert.throws(() => parseApprovalDecision(input));
  }
  for (const changed of [
    { actionClass: "internal" }, { origin: "https://mock.example/hidden" }, { origin: "http://mock.example" },
    { origin: "not-a-url" },
    { maxCostCents: -1 }, { maxCostCents: NaN }, { maxCostCents: Infinity }, { maxCostCents: 0.5 },
    { files: [{ path: "a", content: "b", extra: 1 }] }, { payload: "x".repeat(4001) }, { extra: true },
  ]) assert.throws(() => parseApprovalAction({ ...action, ...changed }));
});
