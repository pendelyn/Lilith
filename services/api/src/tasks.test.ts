import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_PARALLEL_SUBAGENTS,
  RESEARCH_ASSIGNMENT,
  createParentTask,
  createTaskStore,
  runColorCompare,
  setTaskState,
  sharedColor,
  startSubagent,
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
