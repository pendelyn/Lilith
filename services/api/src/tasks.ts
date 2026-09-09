import { randomUUID } from "node:crypto";
import type { SubagentCard, TaskState } from "@lilith/contracts";
import { requireOwned, type OwnerContext } from "./auth.ts";

export const MAX_PARALLEL_SUBAGENTS = 3;
export const COLOR_COMPARE_PROMPT =
  "Vergleiche Testquelle A, B und C und lasse einen Recherche-Unteragenten die gemeinsame Farbe sammeln";
export const RESEARCH_ASSIGNMENT =
  "Collect the shared color from test sources A, B, and C.";
export const TEST_SOURCES = {
  A: ["Rot", "Blau"],
  B: ["Blau", "Grün"],
  C: ["Blau", "Gelb"],
} as const;

const ACTIVE_SUBAGENT_STATES = new Set<TaskState>(["waiting", "working", "needs_input"]);

export type Task = {
  id: string;
  ownerId: string;
  parentTaskId?: string;
  role?: "research";
  assignment: string;
  state: TaskState;
  result?: string;
};

export type TaskStore = {
  readonly tasks: Map<string, Task>;
};

export function createTaskStore(): TaskStore {
  return { tasks: new Map() };
}

export function isColorComparePrompt(message: string): boolean {
  return message.trim() === COLOR_COMPARE_PROMPT;
}

export function sharedColor(
  sources: Record<string, readonly string[]> = TEST_SOURCES,
): string {
  const lists = Object.values(sources);
  const first = lists[0];
  if (first === undefined) throw new Error("Test sources are required");
  const color = first.find((candidate) => lists.every((list) => list.includes(candidate)));
  if (color === undefined) throw new Error("Test sources have no shared color");
  return color;
}

export function createParentTask(
  store: TaskStore,
  owner: OwnerContext,
  assignment: string,
): Task {
  const task: Task = {
    id: randomUUID(),
    ownerId: owner.ownerId,
    assignment,
    state: "working",
  };
  store.tasks.set(task.id, task);
  return task;
}

export function startSubagent(
  store: TaskStore,
  owner: OwnerContext,
  input: { parentTaskId: string; assignment: string; role: "research" },
): Task {
  const parent = store.tasks.get(input.parentTaskId);
  if (parent === undefined) throw new Error("Parent task not found");
  requireOwned(parent, owner);
  if (parent.parentTaskId !== undefined) {
    throw new Error("Nested delegation is not allowed");
  }
  if (activeSubagentCount(store, owner.ownerId) >= MAX_PARALLEL_SUBAGENTS) {
    throw new Error("Parallel subagent limit is 3");
  }
  const task: Task = {
    id: randomUUID(),
    ownerId: owner.ownerId,
    parentTaskId: input.parentTaskId,
    role: input.role,
    assignment: input.assignment,
    state: "waiting",
  };
  store.tasks.set(task.id, task);
  return task;
}

export function setTaskState(
  store: TaskStore,
  owner: OwnerContext,
  taskId: string,
  state: TaskState,
  result?: string,
): Task {
  const current = store.tasks.get(taskId);
  if (current === undefined) throw new Error("Task not found");
  requireOwned(current, owner);
  const task: Task = {
    ...current,
    state,
    ...(result === undefined ? {} : { result }),
  };
  store.tasks.set(taskId, task);
  return task;
}

export function subagentCard(task: Task): SubagentCard {
  if (task.role !== "research" || task.parentTaskId === undefined) {
    throw new Error("Task is not a research subagent");
  }
  return {
    id: task.id,
    role: "research",
    assignment: task.assignment,
    state: task.state,
    ...(task.result === undefined ? {} : { result: task.result }),
  };
}

export function runColorCompare(
  store: TaskStore,
  owner: OwnerContext,
): { cards: SubagentCard[]; result: string } {
  const parent = createParentTask(store, owner, COLOR_COMPARE_PROMPT);
  const started = startSubagent(store, owner, {
    parentTaskId: parent.id,
    assignment: RESEARCH_ASSIGNMENT,
    role: "research",
  });
  const cards = [subagentCard(started)];
  cards.push(subagentCard(setTaskState(store, owner, started.id, "working")));
  const result = sharedColor();
  cards.push(subagentCard(setTaskState(store, owner, started.id, "completed", result)));
  setTaskState(store, owner, parent.id, "completed", result);
  return { cards, result };
}

function activeSubagentCount(store: TaskStore, ownerId: string): number {
  let count = 0;
  for (const task of store.tasks.values()) {
    if (
      task.ownerId === ownerId &&
      task.parentTaskId !== undefined &&
      ACTIVE_SUBAGENT_STATES.has(task.state)
    ) {
      count += 1;
    }
  }
  return count;
}
