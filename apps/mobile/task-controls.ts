import type { TaskState } from "@lilith/contracts";

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
