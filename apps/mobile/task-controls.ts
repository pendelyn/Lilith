import type { ApprovalRequest, TaskState } from "@lilith/contracts";

export type PendingTaskControl = {
  taskId: string;
  action: "stop" | "decision";
} | null;

export function isStoppableState(state: TaskState): boolean {
  return state === "waiting" || state === "working" || state === "needs_input" || state === "paused";
}

export function isTaskStopDisabled(input: {
  canControl: boolean;
  state: TaskState;
  pending: PendingTaskControl;
  cardId: string;
}): boolean {
  if (!input.canControl || !isStoppableState(input.state)) return true;
  return input.pending?.action === "stop" && input.pending.taskId === input.cardId;
}

export function isTaskDecisionDisabled(input: {
  canControl: boolean;
  pending: PendingTaskControl;
  state?: TaskState;
  expired?: boolean;
}): boolean {
  if (!input.canControl || input.pending !== null) return true;
  if (input.state !== undefined && input.state !== "needs_input") return true;
  return input.expired === true;
}

export function isBrowserEffectPayload(payload: string): boolean {
  return payload.includes('"tool":"browser-effect"');
}

export function consumedApprovalLabel(
  approval: Pick<ApprovalRequest, "state" | "actionClass" | "payload">,
  taskState: TaskState,
): string {
  if (
    approval.state === "consumed" &&
    taskState === "completed" &&
    approval.actionClass === "external_effect" &&
    isBrowserEffectPayload(approval.payload)
  ) {
    return "Executed. This cannot be undone.";
  }
  if (approval.state === "consumed") return "Consumed — cannot run again.";
  return approval.state;
}

export function approvalConsentHint(
  approval: Pick<ApprovalRequest, "actionClass" | "payload">,
  consent: boolean,
): string {
  if (!consent) return "Makes no call.";
  if (approval.actionClass === "data_disclosure") return "Sends the bound request once after consent.";
  if (isBrowserEffectPayload(approval.payload)) return "Runs this browser action once. It cannot be undone.";
  return "Runs the mocked write once. Nothing is sent externally.";
}

export function approvalExpiryHint(approval: Pick<ApprovalRequest, "actionClass" | "payload">): string {
  if (approval.actionClass === "data_disclosure") {
    return "If expired, send the same HTTPS URL again for a new disclosure preview.";
  }
  if (isBrowserEffectPayload(approval.payload)) {
    return "If expired, send the browser action again for a new preview.";
  }
  return "If expired, send the simulation prompt again for a new preview.";
}
