import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  HOLD_ASSIGNMENT,
  MAX_PARALLEL_SUBAGENTS,
  QUESTION_ASSIGNMENT,
  QUESTION_PROMPT,
  QUESTION_TEXT,
  RESEARCH_ASSIGNMENT,
  TASK_MAX_COST_CENTS,
  TASK_MAX_RUNTIME_MS,
  acceptToolResult,
  applyLimits,
  answerTask,
  assertApprovalOpen,
  createParentTask,
  createTaskStore,
  openApproval,
  mockApprovalAction,
  recordCost,
  resumeTask,
  runColorCompare,
  runHeldResearch,
  runQuestionResearch,
  setTaskState,
  sharedColor,
  startSubagent,
  startTool,
  stopTask,
  subagentCard,
  type TaskStore,
} from "./tasks.ts";

const owner = { ownerId: "alpha-owner" };

test("color compare starts one research subagent and returns Blau", () => {
  const store = createTaskStore();
  const run = runColorCompare(store, owner);
  const ids = new Set(run.cards.map((card) => card.id));

  assert.equal(ids.size, 1);
  assert.equal(run.result, "Blau");
  assert.equal(sharedColor(), "Blau");
  assert.deepEqual(
    run.cards.map((card) => card.state),
    ["waiting", "working", "completed"],
  );
  assert.deepEqual(run.cards.at(-1), {
    id: run.cards[0]?.id,
    role: "research",
    assignment: RESEARCH_ASSIGNMENT,
    state: "completed",
    result: "Blau",
  });
  assert.equal(
    [...store.tasks.values()].filter((task) => task.parentTaskId !== undefined).length,
    1,
  );
});

test("a fourth parallel subagent is rejected until one is no longer running", () => {
  const store = createTaskStore();
  const parent = createParentTask(store, owner, "parallel");
  const input = { parentTaskId: parent.id, assignment: "research", role: "research" as const };
  for (let index = 0; index < MAX_PARALLEL_SUBAGENTS; index += 1) {
    startSubagent(store, owner, input);
  }

  assert.throws(() => startSubagent(store, owner, input), /Parallel subagent limit is 3/);
  const active = [...store.tasks.values()].filter((task) => task.parentTaskId !== undefined);
  assert.equal(active.length, 3);

  const paused = active[0];
  if (paused === undefined) throw new Error("expected a running subagent");
  setTaskState(store, owner, paused.id, "paused");
  const next = startSubagent(store, owner, input);
  assert.equal(next.state, "waiting");
});

test("subagents cannot start further subagents", () => {
  const store = createTaskStore();
  const parent = createParentTask(store, owner, "parent");
  const child = startSubagent(store, owner, {
    parentTaskId: parent.id,
    assignment: "research",
    role: "research",
  });

  assert.throws(
    () =>
      startSubagent(store, owner, {
        parentTaskId: child.id,
        assignment: "nested",
        role: "research",
      }),
    /Nested delegation is not allowed/,
  );
  assert.throws(
    () =>
      startSubagent(store, owner, {
        parentTaskId: "missing",
        assignment: "research",
        role: "research",
      }),
    /Parent task not found/,
  );
  assert.equal(
    [...store.tasks.values()].filter((task) => task.parentTaskId === child.id).length,
    0,
  );
});

test("foreign owners cannot start subagents on another owner's task", () => {
  const store = createTaskStore();
  const parent = createParentTask(store, owner, "parent");
  assert.throws(
    () =>
      startSubagent(store, { ownerId: "foreign-owner" }, {
        parentTaskId: parent.id,
        assignment: "research",
        role: "research",
      }),
    /access denied/,
  );
});

test("stop discards approvals, freezes the root tree, and ignores late results", () => {
  const store = createTaskStore();
  const childId = heldChildId(store);
  const parent = parentOf(store, childId);
  const input = { parentTaskId: parent.id, assignment: "after-stop", role: "research" as const };

  startTool(store, owner, childId);
  const approval = openApproval(store, owner, childId, mockApprovalAction());
  assertApprovalOpen(store, owner, approval.id);
  assert.throws(
    () => assertApprovalOpen(store, { ownerId: "foreign-owner" }, approval.id),
    /access denied/,
  );

  const stopped = stopTask(store, owner, childId);
  assert.equal(stopped.state, "stopped");
  assert.equal("result" in stopped, false);
  assert.deepEqual(subagentCard(stopped), {
    id: childId,
    role: "research",
    assignment: HOLD_ASSIGNMENT,
    state: "stopped",
    approval,
  });
  assert.equal(store.tasks.get(parent.id)?.state, "stopped");
  assert.equal(store.approvals.has(approval.id), false);
  assert.throws(() => assertApprovalOpen(store, owner, approval.id), /not found/);
  assert.throws(() => startTool(store, owner, childId), /cannot start tools/);
  assert.throws(() => startTool(store, owner, parent.id), /cannot start tools/);
  assert.throws(() => openApproval(store, owner, childId, mockApprovalAction()), /cannot open approvals/);
  assert.throws(() => openApproval(store, owner, parent.id, mockApprovalAction()), /cannot open approvals/);
  assert.throws(() => acceptToolResult(store, owner, childId, "Blau"), /cannot accept results/);
  assert.throws(() => setTaskState(store, owner, childId, "working"), /cannot change state/);
  assert.throws(() => setTaskState(store, owner, childId, "completed", "Blau"), /cannot change state/);
  assert.throws(() => setTaskState(store, owner, parent.id, "completed", "Blau"), /cannot change state/);
  assert.throws(() => startSubagent(store, owner, input), /cannot start subagents/);
  assert.equal(store.tasks.get(childId)?.state, "stopped");
  assert.equal(store.tasks.get(parent.id)?.state, "stopped");
  assert.equal("result" in (store.tasks.get(childId) ?? {}), false);
  assert.equal("result" in (store.tasks.get(parent.id) ?? {}), false);
  assert.equal(
    [...store.tasks.values()].filter((task) => task.parentTaskId === parent.id).length,
    1,
  );
});

test("stop does not rewrite a completed color-compare result", () => {
  const store = createTaskStore();
  const run = runColorCompare(store, owner);
  const childId = run.cards[0]?.id;
  if (childId === undefined) throw new Error("expected a research subagent");

  const after = stopTask(store, owner, childId);
  assert.equal(after.state, "completed");
  assert.equal(after.result, "Blau");
});

test("time limit pauses work until explicit consent starts a fresh slice", () => {
  let now = 0;
  const store = createTaskStore({ now: () => now });
  const childId = heldChildId(store);
  const parent = parentOf(store, childId);
  const sibling = startSubagent(store, owner, {
    parentTaskId: parent.id,
    assignment: "sibling",
    role: "research",
  });
  assert.equal(parent.startedAt, 0);
  assert.equal(store.tasks.get(childId)?.startedAt, undefined);
  assert.equal(sibling.startedAt, undefined);
  assert.equal(TASK_MAX_RUNTIME_MS, 15 * 60_000);

  now = TASK_MAX_RUNTIME_MS;
  const paused = applyLimits(store, owner, sibling.id);
  assert.equal(paused.state, "paused");
  assert.equal(paused.pauseReason, "time");
  assert.equal(store.tasks.get(parent.id)?.state, "paused");
  assert.equal(store.tasks.get(childId)?.state, "paused");
  assert.throws(() => startTool(store, owner, sibling.id), /cannot start tools/);
  assert.throws(() => startTool(store, owner, parent.id), /cannot start tools/);
  assert.throws(() => startTool(store, owner, childId), /cannot start tools/);
  assert.throws(() => acceptToolResult(store, owner, childId, "Blau"), /cannot accept results/);
  assert.throws(() => setTaskState(store, owner, sibling.id, "working"), /cannot change state/);
  assert.throws(() => setTaskState(store, owner, sibling.id, "completed", "Blau"), /cannot change state/);
  assert.throws(() => resumeTask(store, owner, childId, { consent: false }), /Consent is required/);
  assert.equal(store.tasks.get(childId)?.state, "paused");
  assert.throws(
    () =>
      startSubagent(store, owner, {
        parentTaskId: parent.id,
        assignment: "after-time",
        role: "research",
      }),
    /cannot start subagents/,
  );

  const resumed = resumeTask(store, owner, childId, { consent: true });
  assert.equal(resumed.state, "working");
  assert.equal("pauseReason" in resumed, false);
  assert.equal(store.tasks.get(childId)?.startedAt, undefined);
  assert.equal(store.tasks.get(parent.id)?.startedAt, TASK_MAX_RUNTIME_MS);
  assert.equal(store.tasks.get(parent.id)?.costCents, 0);
  startTool(store, owner, childId);

  now += TASK_MAX_RUNTIME_MS;
  assert.equal(applyLimits(store, owner, childId).state, "paused");
  assert.equal(store.tasks.get(childId)?.pauseReason, "time");
});

test("measurable cost pauses at 100 cents and ignores unmeasured work", () => {
  const under = createTaskStore();
  const underId = heldChildId(under);
  assert.equal(recordCost(under, owner, underId, TASK_MAX_COST_CENTS - 1).state, "working");
  assert.equal(under.tasks.get(underId)?.pauseReason, undefined);

  const exact = createTaskStore();
  const exactId = heldChildId(exact);
  const paused = recordCost(exact, owner, exactId, TASK_MAX_COST_CENTS);
  assert.equal(TASK_MAX_COST_CENTS, 100);
  assert.equal(paused.state, "paused");
  assert.equal(paused.pauseReason, "cost");
  assert.throws(() => startTool(exact, owner, exactId), /cannot start tools/);
  assert.throws(() => acceptToolResult(exact, owner, exactId, "Blau"), /cannot accept results/);
  assert.equal(exact.tasks.get(exactId)?.state, "paused");
  assert.equal("result" in (exact.tasks.get(exactId) ?? {}), false);

  const unmeasured = createTaskStore();
  const unmeasuredId = heldChildId(unmeasured);
  assert.equal(applyLimits(unmeasured, owner, unmeasuredId).state, "working");
  assert.equal(unmeasured.tasks.get(unmeasuredId)?.costCents, 0);
  assert.equal(parentOf(unmeasured, unmeasuredId).costCents, 0);

  const store = createTaskStore();
  const childId = heldChildId(store);
  const parent = parentOf(store, childId);
  assert.equal(recordCost(store, owner, childId, 50).state, "working");
  const split = recordCost(store, owner, parent.id, 50);
  assert.equal(split.state, "paused");
  assert.equal(store.tasks.get(childId)?.state, "paused");
  assert.equal(store.tasks.get(parent.id)?.state, "paused");
  assert.equal(store.tasks.get(childId)?.pauseReason, "cost");
  assert.equal(store.tasks.get(parent.id)?.pauseReason, "cost");
  assert.throws(() => startTool(store, owner, parent.id), /cannot start tools/);
  assert.throws(() => startTool(store, owner, childId), /cannot start tools/);
  assert.throws(
    () =>
      startSubagent(store, owner, {
        parentTaskId: parent.id,
        assignment: "after-cost",
        role: "research",
      }),
    /cannot start subagents/,
  );
  assert.throws(() => acceptToolResult(store, owner, childId, "Blau"), /cannot accept results/);
  assert.throws(() => setTaskState(store, owner, childId, "completed", "Blau"), /cannot change state/);
  assert.equal("result" in (store.tasks.get(childId) ?? {}), false);

  const resumed = resumeTask(store, owner, childId, { consent: true });
  assert.equal(resumed.state, "working");
  assert.equal(store.tasks.get(parent.id)?.state, "working");
  assert.equal(resumed.costCents, 0);
  assert.equal(store.tasks.get(parent.id)?.costCents, 0);
  assert.equal(TASK_MAX_COST_CENTS, 100);
});

test("persisted approval tasks reload without running tools and can pause later", () => {
  const dir = mkdtempSync(join(tmpdir(), "lilith-tasks-"));
  const persistPath = join(dir, "state.json");
  let now = 0;
  try {
    const first = createTaskStore({ persistPath, now: () => now });
    const childId = heldChildId(first);
    const parent = parentOf(first, childId);
    startTool(first, owner, childId);
    const approval = openApproval(first, owner, childId, mockApprovalAction());
    assertApprovalOpen(first, owner, approval.id);
    const persisted = JSON.parse(readFileSync(persistPath, "utf8")) as { approvals?: unknown };
    assert.equal("approvals" in persisted, false);

    const reloaded = createTaskStore({ persistPath, now: () => now });
    const restored = reloaded.tasks.get(childId);
    assert.equal(restored?.state, "needs_input");
    assert.equal(restored?.startedAt, undefined);
    assert.equal(reloaded.tasks.get(parent.id)?.startedAt, 0);
    assert.equal(reloaded.approvals.size, 1);
    assert.deepEqual(assertApprovalOpen(reloaded, owner, approval.id), approval);
    assertApprovalOpen(first, owner, approval.id);
    assert.equal(
      [...reloaded.tasks.values()].some((task) => task.state === "completed"),
      false,
    );

    writeFileSync(
      persistPath,
      JSON.stringify({
        ...persisted,
        approvals: [{ id: approval.id, ownerId: owner.ownerId, taskId: childId, state: "open" }],
      }),
    );
    const fromOld = createTaskStore({ persistPath, now: () => now });
    assert.equal(fromOld.tasks.get(childId)?.state, "needs_input");
    assert.equal(fromOld.approvals.size, 1);
    assert.deepEqual(assertApprovalOpen(fromOld, owner, approval.id), approval);

    now = TASK_MAX_RUNTIME_MS;
    assert.equal(applyLimits(reloaded, owner, childId).state, "paused");
    assert.equal(reloaded.tasks.get(childId)?.state, "paused");
    assert.equal(reloaded.tasks.get(childId)?.pauseReason, "time");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("foreign owners cannot stop or resume another owner's task", () => {
  const store = createTaskStore();
  const childId = heldChildId(store);
  const foreign = { ownerId: "foreign-owner" };

  assert.throws(() => stopTask(store, foreign, childId), /access denied/);
  assert.equal(store.tasks.get(childId)?.state, "working");
  setTaskState(store, owner, childId, "paused");
  assert.throws(() => resumeTask(store, foreign, childId, { consent: true }), /access denied/);
  assert.equal(store.tasks.get(childId)?.state, "paused");
});

test("held research reuses the owner's live execution for the same assignment", () => {
  const live = createTaskStore();
  const first = runHeldResearch(live, owner);
  const childId = first.cards.at(-1)?.id;
  if (childId === undefined) throw new Error("expected a working subagent");
  const parentId = live.tasks.get(childId)?.parentTaskId;
  const second = runHeldResearch(live, owner);
  assert.deepEqual(
    second.cards.map((card) => ({ id: card.id, state: card.state })),
    [{ id: childId, state: "working" }],
  );
  assert.equal(
    [...live.tasks.values()].filter((task) => task.parentTaskId !== undefined).length,
    1,
  );
  assert.equal(
    [...live.tasks.values()].filter((task) => task.parentTaskId === undefined).length,
    1,
  );
  assert.equal(live.tasks.get(childId)?.parentTaskId, parentId);
  assert.equal(live.tasks.get(childId)?.state, "working");

  const pausedStore = createTaskStore();
  const pausedId = heldChildId(pausedStore);
  recordCost(pausedStore, owner, pausedId, TASK_MAX_COST_CENTS);
  assert.equal(pausedStore.tasks.get(pausedId)?.state, "paused");
  const paused = runHeldResearch(pausedStore, owner);
  assert.deepEqual(paused.cards, [
    {
      id: pausedId,
      role: "research",
      assignment: HOLD_ASSIGNMENT,
      state: "paused",
      pauseReason: "cost",
    },
  ]);
  assert.equal(pausedStore.tasks.get(pausedId)?.state, "paused");
  assert.equal(pausedStore.tasks.get(pausedId)?.pauseReason, "cost");
  assert.equal(
    [...pausedStore.tasks.values()].filter((task) => task.parentTaskId === undefined).length,
    1,
  );

  const stoppedStore = createTaskStore();
  const firstId = heldChildId(stoppedStore);
  stopTask(stoppedStore, owner, firstId);
  const afterStop = runHeldResearch(stoppedStore, owner);
  const secondId = afterStop.cards.at(-1)?.id;
  if (secondId === undefined) throw new Error("expected a new working subagent");
  assert.notEqual(secondId, firstId);
  assert.equal(afterStop.cards.at(-1)?.state, "working");
  assert.equal(stoppedStore.tasks.get(firstId)?.state, "stopped");
  assert.equal(stoppedStore.tasks.get(secondId)?.state, "working");
  assert.equal(
    [...stoppedStore.tasks.values()].filter((task) => task.parentTaskId === undefined).length,
    2,
  );
  assert.notEqual(
    stoppedStore.tasks.get(firstId)?.parentTaskId,
    stoppedStore.tasks.get(secondId)?.parentTaskId,
  );

  const owners = createTaskStore();
  const ownerId = heldChildId(owners);
  const foreign = runHeldResearch(owners, { ownerId: "foreign-owner" });
  const foreignId = foreign.cards.at(-1)?.id;
  if (foreignId === undefined) throw new Error("expected a foreign subagent");
  assert.notEqual(foreignId, ownerId);
  assert.equal(owners.tasks.get(ownerId)?.state, "working");
  assert.equal(owners.tasks.get(foreignId)?.state, "working");
  assert.equal(
    [...owners.tasks.values()].filter((task) => task.parentTaskId === undefined).length,
    2,
  );

  const assign = createTaskStore();
  const otherParent = createParentTask(assign, owner, "other");
  const other = startSubagent(assign, owner, {
    parentTaskId: otherParent.id,
    assignment: RESEARCH_ASSIGNMENT,
    role: "research",
  });
  setTaskState(assign, owner, other.id, "working");
  const heldId = heldChildId(assign);
  assert.notEqual(heldId, other.id);
  assert.equal(assign.tasks.get(other.id)?.state, "working");
  assert.equal(assign.tasks.get(heldId)?.assignment, HOLD_ASSIGNMENT);
  assert.equal(
    [...assign.tasks.values()].filter((task) => task.parentTaskId !== undefined).length,
    2,
  );
});

test("question fixture writes one answer onto the same task id", () => {
  const store = createTaskStore();
  const first = runQuestionResearch(store, owner);
  const childId = first.cards.at(-1)?.id;
  const questionId = first.cards.at(-1)?.question?.id;
  if (childId === undefined || questionId === undefined) throw new Error("expected a question subagent");
  const parent = parentOf(store, childId);

  assert.deepEqual(
    first.cards.map((card) => card.state),
    ["waiting", "working", "needs_input"],
  );
  assert.equal(first.cards.at(-1)?.question?.prompt, QUESTION_TEXT);
  assert.deepEqual(
    first.cards.at(-1)?.question?.options.map((option) => option.label),
    ["Kurz", "Ausführlich"],
  );
  assert.equal("answer" in (first.cards.at(-1)?.question ?? {}), false);

  const reused = runQuestionResearch(store, owner);
  assert.deepEqual(
    reused.cards.map((card) => ({ id: card.id, questionId: card.question?.id, state: card.state })),
    [{ id: childId, questionId, state: "needs_input" }],
  );

  const answered = answerTask(store, owner, childId, { optionId: "short" });
  assert.equal(answered.id, childId);
  assert.equal(answered.state, "completed");
  assert.equal(answered.result, "Kurz");
  assert.deepEqual(answered.question?.answer, { optionId: "short" });
  assert.equal(store.tasks.get(parent.id)?.state, "completed");
  assert.equal(store.tasks.get(parent.id)?.result, "Kurz");

  const snapshot = JSON.stringify(store.tasks.get(childId));
  const duplicate = answerTask(store, owner, childId, { optionId: "short" });
  assert.equal(duplicate.state, "completed");
  assert.equal(JSON.stringify(store.tasks.get(childId)), snapshot);
  assert.throws(() => answerTask(store, owner, childId, { optionId: "long" }), /Answer conflict/);
  assert.throws(() => answerTask(store, owner, childId, { text: "Kurz" }), /Answer conflict/);
  assert.deepEqual(store.tasks.get(childId)?.question?.answer, { optionId: "short" });

  const textStore = createTaskStore();
  const textId = questionChildId(textStore);
  const textAnswer = answerTask(textStore, owner, textId, { text: "  Nur Stichpunkte  " });
  assert.equal(textAnswer.id, textId);
  assert.equal(textAnswer.state, "completed");
  assert.equal(textAnswer.result, "Nur Stichpunkte");
  assert.deepEqual(textAnswer.question?.answer, { text: "Nur Stichpunkte" });
});

test("question reuse poses on a live same-assignment task that has no question", () => {
  const waitingStore = createTaskStore();
  const waitingParent = createParentTask(waitingStore, owner, QUESTION_PROMPT);
  const waiting = startSubagent(waitingStore, owner, {
    parentTaskId: waitingParent.id,
    assignment: QUESTION_ASSIGNMENT,
    role: "research",
  });
  const waitingRetry = runQuestionResearch(waitingStore, owner);
  assert.equal(waitingRetry.cards.at(-1)?.id, waiting.id);
  assert.equal(waitingRetry.cards.at(-1)?.state, "needs_input");
  assert.deepEqual(
    waitingRetry.cards.at(-1)?.question?.options.map((option) => option.label),
    ["Kurz", "Ausführlich"],
  );
  assert.equal(
    [...waitingStore.tasks.values()].filter((task) => task.parentTaskId !== undefined).length,
    1,
  );

  const dir = mkdtempSync(join(tmpdir(), "lilith-question-heal-"));
  const persistPath = join(dir, "state.json");
  try {
    const first = createTaskStore({ persistPath });
    const parent = createParentTask(first, owner, QUESTION_PROMPT);
    const child = startSubagent(first, owner, {
      parentTaskId: parent.id,
      assignment: QUESTION_ASSIGNMENT,
      role: "research",
    });
    setTaskState(first, owner, child.id, "working");
    assert.equal(first.tasks.get(child.id)?.state, "working");
    assert.equal("question" in (first.tasks.get(child.id) ?? {}), false);

    const reloaded = createTaskStore({ persistPath });
    assert.equal(reloaded.tasks.get(child.id)?.state, "working");
    assert.equal("question" in (reloaded.tasks.get(child.id) ?? {}), false);
    const disk = readFileSync(persistPath);

    (reloaded as { persistPath?: string }).persistPath = join(persistPath, "blocked.json");
    assert.throws(() => runQuestionResearch(reloaded, owner));
    assert.equal(reloaded.tasks.get(child.id)?.state, "working");
    assert.equal("question" in (reloaded.tasks.get(child.id) ?? {}), false);
    assert.deepEqual(readFileSync(persistPath), disk);

    (reloaded as { persistPath?: string }).persistPath = persistPath;
    const retry = runQuestionResearch(reloaded, owner);
    const posed = retry.cards.at(-1);
    const questionId = posed?.question?.id;
    if (posed === undefined || questionId === undefined) throw new Error("expected a question subagent");
    assert.equal(retry.cards.length, 1);
    assert.equal(posed.id, child.id);
    assert.equal(posed.state, "needs_input");
    assert.equal(posed.question?.prompt, QUESTION_TEXT);
    assert.deepEqual(
      posed.question?.options.map((option) => option.label),
      ["Kurz", "Ausführlich"],
    );
    assert.equal("answer" in (posed.question ?? {}), false);
    assert.equal(reloaded.tasks.get(child.id)?.parentTaskId, parent.id);
    assert.equal(
      [...reloaded.tasks.values()].filter((task) => task.parentTaskId !== undefined).length,
      1,
    );
    assert.equal(
      [...reloaded.tasks.values()].filter((task) => task.parentTaskId === undefined).length,
      1,
    );

    const reused = runQuestionResearch(reloaded, owner);
    assert.deepEqual(
      reused.cards.map((card) => ({ id: card.id, questionId: card.question?.id, state: card.state })),
      [{ id: child.id, questionId, state: "needs_input" }],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("question stop, pause, and foreign owners stay closed", () => {
  const stoppedStore = createTaskStore();
  const stoppedId = questionChildId(stoppedStore);
  const questionId = stoppedStore.tasks.get(stoppedId)?.question?.id;
  stopTask(stoppedStore, owner, stoppedId);
  assert.equal(stoppedStore.tasks.get(stoppedId)?.state, "stopped");
  assert.equal("result" in (stoppedStore.tasks.get(stoppedId) ?? {}), false);
  assert.equal(stoppedStore.tasks.get(stoppedId)?.question?.id, questionId);
  assert.throws(() => answerTask(stoppedStore, owner, stoppedId, { optionId: "short" }), /not waiting/);
  assert.throws(() => startTool(stoppedStore, owner, stoppedId), /cannot start tools/);
  assert.throws(() => acceptToolResult(stoppedStore, owner, stoppedId, "Kurz"), /cannot accept results/);
  const afterStop = runQuestionResearch(stoppedStore, owner);
  assert.notEqual(afterStop.cards.at(-1)?.id, stoppedId);

  let now = 0;
  const pausedStore = createTaskStore({ now: () => now });
  const pausedId = questionChildId(pausedStore);
  now = TASK_MAX_RUNTIME_MS;
  assert.equal(applyLimits(pausedStore, owner, pausedId).state, "paused");
  assert.throws(() => answerTask(pausedStore, owner, pausedId, { optionId: "short" }), /not waiting/);
  const resumed = resumeTask(pausedStore, owner, pausedId, { consent: true });
  assert.equal(resumed.state, "needs_input");
  assert.equal(pausedStore.tasks.get(pausedId)?.question?.answer, undefined);
  const afterResume = answerTask(pausedStore, owner, pausedId, { optionId: "short" });
  assert.equal(afterResume.id, pausedId);
  assert.equal(afterResume.state, "completed");
  assert.equal(afterResume.result, "Kurz");

  const foreignStore = createTaskStore();
  const foreignId = questionChildId(foreignStore);
  assert.throws(
    () => answerTask(foreignStore, { ownerId: "foreign-owner" }, foreignId, { optionId: "short" }),
    /access denied/,
  );
  assert.equal(foreignStore.tasks.get(foreignId)?.state, "needs_input");
  assert.throws(() => answerTask(foreignStore, owner, foreignId, { optionId: "nope" }), /Invalid QuestionAnswer/);
  assert.throws(
    () => answerTask(foreignStore, owner, foreignId, { optionId: "short", text: "x" }),
    /Invalid QuestionAnswer/,
  );
});

test("question persist reloads unanswered and answered without running work", () => {
  const dir = mkdtempSync(join(tmpdir(), "lilith-question-"));
  const persistPath = join(dir, "state.json");
  try {
    const first = createTaskStore({ persistPath });
    const childId = questionChildId(first);
    const questionId = first.tasks.get(childId)?.question?.id;
    const parentId = first.tasks.get(childId)?.parentTaskId;
    assert.equal(first.tasks.get(childId)?.state, "needs_input");

    const unanswered = createTaskStore({ persistPath });
    assert.equal(unanswered.tasks.get(childId)?.state, "needs_input");
    assert.equal(unanswered.tasks.get(childId)?.question?.id, questionId);
    assert.equal("answer" in (unanswered.tasks.get(childId)?.question ?? {}), false);
    assert.equal(
      [...unanswered.tasks.values()].some((task) => task.state === "working" && task.id === childId),
      false,
    );

    const answered = answerTask(unanswered, owner, childId, { optionId: "short" });
    assert.equal(answered.state, "completed");

    const reloaded = createTaskStore({ persistPath });
    assert.equal(reloaded.tasks.get(childId)?.state, "completed");
    assert.equal(reloaded.tasks.get(childId)?.result, "Kurz");
    assert.deepEqual(reloaded.tasks.get(childId)?.question?.answer, { optionId: "short" });
    assert.equal(reloaded.tasks.get(parentId ?? "")?.state, "completed");
    assert.equal(
      [...reloaded.tasks.values()].some((task) => task.state === "working"),
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("persistence failure preserves disk and in-memory state", () => {
  const dir = mkdtempSync(join(tmpdir(), "lilith-tasks-fail-"));
  const persistPath = join(dir, "state.json");
  try {
    const store = createTaskStore({ persistPath });
    const childId = heldChildId(store);
    const parent = parentOf(store, childId);
    const approval = openApproval(store, owner, childId, mockApprovalAction());
    assertApprovalOpen(store, owner, approval.id);
    const disk = readFileSync(persistPath);
    const childState = store.tasks.get(childId)?.state;
    const parentState = store.tasks.get(parent.id)?.state;

    (store as { persistPath?: string }).persistPath = join(persistPath, "blocked.json");
    assert.throws(() => stopTask(store, owner, childId));
    assert.equal(store.tasks.get(childId)?.state, childState);
    assert.equal(store.tasks.get(parent.id)?.state, parentState);
    assertApprovalOpen(store, owner, approval.id);
    assert.equal(store.approvals.get(approval.id), childId);
    assert.deepEqual(readFileSync(persistPath), disk);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function heldChildId(store: TaskStore): string {
  const childId = runHeldResearch(store, owner).cards.at(-1)?.id;
  if (childId === undefined) throw new Error("expected a working subagent");
  return childId;
}

function questionChildId(store: TaskStore): string {
  const childId = runQuestionResearch(store, owner).cards.at(-1)?.id;
  if (childId === undefined) throw new Error("expected a question subagent");
  return childId;
}

function parentOf(store: TaskStore, childId: string) {
  const parentId = store.tasks.get(childId)?.parentTaskId;
  if (parentId === undefined) throw new Error("expected a parent task");
  const parent = store.tasks.get(parentId);
  if (parent === undefined) throw new Error("expected a parent task");
  return parent;
}
