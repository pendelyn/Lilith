import assert from "node:assert/strict";
import { test } from "node:test";
import {
  approvalConsentHint,
  approvalExpiryHint,
  consumedApprovalLabel,
  isStoppableState,
  isTaskDecisionDisabled,
  isTaskStopDisabled,
} from "./task-controls.ts";

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

test("executed browser actions are not described as reversible", () => {
  const browser = {
    state: "consumed" as const,
    actionClass: "external_effect" as const,
    payload: JSON.stringify({ tool: "browser-effect", effect: "submit" }),
  };
  const mock = {
    state: "consumed" as const,
    actionClass: "external_effect" as const,
    payload: "Test note: Blau",
  };
  const executed = consumedApprovalLabel(browser, "completed");
  assert.equal(executed, "Executed. This cannot be undone.");
  assert.equal(/\bundo\b|\brevert\b|rückgängig/i.test(executed), false);
  assert.equal(consumedApprovalLabel(browser, "failed"), "Consumed — cannot run again.");
  assert.equal(consumedApprovalLabel(mock, "completed"), "Consumed — cannot run again.");
  assert.equal(consumedApprovalLabel({ ...browser, state: "pending" }, "needs_input"), "pending");
  const hint = approvalConsentHint(browser, true);
  assert.equal(hint, "Runs this browser action once. It cannot be undone.");
  assert.equal(/\bundo\b|\brevert\b|rückgängig/i.test(hint), false);
  assert.equal(approvalConsentHint(browser, false), "Makes no call.");
  assert.equal(approvalConsentHint(mock, true), "Runs the mocked write once. Nothing is sent externally.");
  assert.equal(
    approvalExpiryHint(browser),
    "If expired, send the browser action again for a new preview.",
  );
  assert.equal(
    approvalExpiryHint({ actionClass: "data_disclosure", payload: "{}" }),
    "If expired, send the same HTTPS URL again for a new disclosure preview.",
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
