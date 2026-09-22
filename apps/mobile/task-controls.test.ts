import assert from "node:assert/strict";
import { test } from "node:test";
import { isStoppableState, isTaskDecisionDisabled, isTaskStopDisabled } from "./task-controls.ts";

test("Stop stays enabled during the 90s approve/decision pending window", () => {
  const pending = { taskId: "browser-1", action: "decision" as const };
  assert.equal(isStoppableState("working"), true);
  assert.equal(
    isTaskStopDisabled({
      canControl: true,
      state: "working",
      pending,
      cardId: "browser-1",
    }),
    false,
  );
  assert.equal(
    isTaskDecisionDisabled({
      canControl: true,
      pending,
      state: "needs_input",
    }),
    true,
  );
  assert.equal(
    isTaskStopDisabled({
      canControl: true,
      state: "needs_input",
      pending,
      cardId: "browser-1",
    }),
    false,
  );
});

test("duplicate Approve stays locked while Stop is in flight; Stop locks only itself", () => {
  const stopping = { taskId: "browser-1", action: "stop" as const };
  assert.equal(
    isTaskStopDisabled({ canControl: true, state: "working", pending: stopping, cardId: "browser-1" }),
    true,
  );
  assert.equal(
    isTaskStopDisabled({ canControl: true, state: "working", pending: stopping, cardId: "other" }),
    false,
  );
  assert.equal(isTaskDecisionDisabled({ canControl: true, pending: stopping, state: "needs_input" }), true);
  assert.equal(isTaskDecisionDisabled({ canControl: true, pending: null, state: "needs_input" }), false);
  assert.equal(isTaskDecisionDisabled({ canControl: false, pending: null, state: "needs_input" }), true);
  assert.equal(
    isTaskStopDisabled({ canControl: false, state: "working", pending: null, cardId: "browser-1" }),
    true,
  );
  assert.equal(isTaskDecisionDisabled({ canControl: true, pending: null, state: "working" }), true);
});
