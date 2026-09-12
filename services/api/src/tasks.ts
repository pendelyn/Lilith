import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import {
  parseApprovalAction,
  parseApprovalDecision,
  parseApprovalRequest,
  type ApprovalAction,
  type ApprovalRequest,
  parseQuestionAnswer,
  parseQuestionCard,
  parseTaskState,
  type PauseReason,
  type QuestionAnswer,
  type QuestionCard,
  type QuestionOption,
  type SubagentCard,
  type TaskState,
} from "@lilith/contracts";
import { requireOwned, type OwnerContext } from "./auth.ts";

export const MAX_PARALLEL_SUBAGENTS = 3;
export const TASK_MAX_RUNTIME_MS = 15 * 60_000;
export const TASK_MAX_COST_CENTS = 100;
export const COLOR_COMPARE_PROMPT =
  "Vergleiche Testquelle A, B und C und lasse einen Recherche-Unteragenten die gemeinsame Farbe sammeln";
export const RESEARCH_ASSIGNMENT =
  "Collect the shared color from test sources A, B, and C.";
export const HOLD_PROMPT =
  "Halte den Recherche-Unteragenten, bis ich stoppe oder fortsetze";
export const HOLD_ASSIGNMENT = "Hold research until the user stops or resumes.";
export const QUESTION_PROMPT = "Frage mich, ob du kurz oder ausführlich antworten sollst";
export const QUESTION_ASSIGNMENT = "Ask whether the reply should be short or detailed.";
export const QUESTION_TEXT = "Soll das Ergebnis kurz oder ausführlich sein?";
export const QUESTION_OPTIONS: QuestionOption[] = [
  { id: "short", label: "Kurz" },
  { id: "long", label: "Ausführlich" },
];
export const APPROVAL_PROMPT = "Simuliere eine externe Schreibaktion mit Einmalfreigabe";
export const APPROVAL_ASSIGNMENT = "Simulate an external write; wait for one-time approval.";
export const APPROVAL_TTL_MS = 5 * 60_000;
export const TEST_SOURCES = {
  A: ["Rot", "Blau"],
  B: ["Blau", "Grün"],
  C: ["Blau", "Gelb"],
} as const;

const RUNNABLE_STATES = new Set<TaskState>(["waiting", "working", "needs_input"]);
const TERMINAL_STATES = new Set<TaskState>(["completed", "failed"]);

export type Task = {
  id: string;
  ownerId: string;
  parentTaskId?: string;
  role?: "research";
  assignment: string;
  state: TaskState;
  result?: string;
  startedAt?: number;
  costCents: number;
  pauseReason?: PauseReason;
  question?: QuestionCard;
  approval?: ApprovalRequest;
};

export type TaskStore = {
  readonly tasks: Map<string, Task>;
  // Index of pending approvals; the full binding is persisted on its task.
  readonly approvals: Map<string, string>;
  // In-process AbortControllers for in-flight HTTPS; never persisted.
  readonly aborts: Map<string, AbortController>;
  readonly now: () => number;
  readonly persistPath?: string;
};

export function createTaskStore(options?: {
  now?: () => number;
  persistPath?: string;
}): TaskStore {
  const store: TaskStore = {
    tasks: new Map(),
    approvals: new Map(),
    aborts: new Map(),
    now: options?.now ?? Date.now,
    ...(options?.persistPath === undefined ? {} : { persistPath: options.persistPath }),
  };
  if (options?.persistPath !== undefined && persistPresent(options.persistPath)) {
    loadStore(store, options.persistPath);
  }
  return store;
}

export function isColorComparePrompt(message: string): boolean {
  return message.trim() === COLOR_COMPARE_PROMPT;
}

export function isHoldPrompt(message: string): boolean {
  return message.trim() === HOLD_PROMPT;
}

export function isQuestionPrompt(message: string): boolean {
  return message.trim() === QUESTION_PROMPT;
}

export function isApprovalPrompt(message: string): boolean {
  return message.trim() === APPROVAL_PROMPT;
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
    startedAt: store.now(),
    costCents: 0,
  };
  return transact(store, () => commitTask(store, task));
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
  applyLimits(store, owner, parent.id);
  const live = ownedTask(store, owner, parent.id);
  if (!RUNNABLE_STATES.has(live.state)) throw new Error("Task cannot start subagents");
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
    costCents: 0,
  };
  return transact(store, () => commitTask(store, task));
}

export function setTaskState(
  store: TaskStore,
  owner: OwnerContext,
  taskId: string,
  state: TaskState,
  result?: string,
): Task {
  applyLimits(store, owner, taskId);
  const current = ownedTask(store, owner, taskId);
  if (!RUNNABLE_STATES.has(current.state)) {
    throw new Error("Task cannot change state");
  }
  return transact(store, () =>
    commitTask(store, {
      ...ownedTask(store, owner, taskId),
      state,
      ...(result === undefined ? {} : { result }),
    }),
  );
}

export function researchAbortSignal(store: TaskStore, taskId: string): AbortSignal {
  const existing = store.aborts.get(taskId);
  if (existing !== undefined && !existing.signal.aborted) return existing.signal;
  const controller = new AbortController();
  store.aborts.set(taskId, controller);
  return controller.signal;
}

export function stopTask(store: TaskStore, owner: OwnerContext, taskId: string): Task {
  ownedTask(store, owner, taskId);
  const stopped = transact(store, () => {
    const current = ownedTask(store, owner, taskId);
    const members = executionSet(store, current);
    const memberIds = new Set(members.map((member) => member.id));
    for (const member of members) {
      if (TERMINAL_STATES.has(member.state)) continue;
      const next: Task = { ...member, state: "stopped" };
      delete next.result;
      delete next.pauseReason;
      store.tasks.set(member.id, next);
    }
    for (const [id, approvedTaskId] of store.approvals) {
      if (memberIds.has(approvedTaskId)) store.approvals.delete(id);
    }
    return { task: ownedTask(store, owner, taskId), memberIds: [...memberIds] };
  });
  for (const id of stopped.memberIds) {
    const controller = store.aborts.get(id);
    if (controller === undefined) continue;
    controller.abort();
    store.aborts.delete(id);
  }
  return stopped.task;
}

export function resumeTask(
  store: TaskStore,
  owner: OwnerContext,
  taskId: string,
  input: { consent: unknown },
): Task {
  const current = ownedTask(store, owner, taskId);
  if (input.consent !== true) throw new Error("Consent is required");
  if (current.state !== "paused") throw new Error("Task is not paused");
  return transact(store, () => {
    const now = store.now();
    for (const member of executionSet(store, current)) {
      if (member.state !== "paused") continue;
      const next: Task = {
        ...member,
        state:
          (member.question !== undefined && member.question.answer === undefined) || member.approval?.state === "pending"
            ? "needs_input"
            : "working",
      };
      delete next.pauseReason;
      delete next.result;
      store.tasks.set(member.id, next);
    }
    const root = ownedTask(store, owner, current.parentTaskId ?? current.id);
    store.tasks.set(root.id, { ...root, startedAt: now, costCents: 0 });
    return applyLimitsUnpersisted(store, owner, taskId);
  });
}

export function startTool(store: TaskStore, owner: OwnerContext, taskId: string): void {
  applyLimits(store, owner, taskId);
  const current = ownedTask(store, owner, taskId);
  if (!RUNNABLE_STATES.has(current.state)) {
    throw new Error("Task cannot start tools");
  }
}

export function acceptToolResult(
  store: TaskStore,
  owner: OwnerContext,
  taskId: string,
  result: string,
): Task {
  applyLimits(store, owner, taskId);
  const current = ownedTask(store, owner, taskId);
  if (!RUNNABLE_STATES.has(current.state)) {
    throw new Error("Task cannot accept results");
  }
  return transact(store, () =>
    commitTask(store, { ...ownedTask(store, owner, taskId), state: "completed", result }),
  );
}

export function openApproval(
  store: TaskStore,
  owner: OwnerContext,
  taskId: string,
  input: ApprovalAction,
): ApprovalRequest {
  applyLimits(store, owner, taskId);
  const current = ownedTask(store, owner, taskId);
  if (!RUNNABLE_STATES.has(current.state)) throw new Error("Task cannot open approvals");
  if (current.question !== undefined || current.approval?.state === "consumed") throw new Error("Approval conflict");
  const action = parseApprovalAction(input);
  const approval = parseApprovalRequest({
    ...action,
    id: randomUUID(),
    taskId,
    payloadDigest: payloadDigest(action),
    expiresAt: store.now() + APPROVAL_TTL_MS,
    state: "pending",
  });
  transact(store, () => {
    if (current.approval !== undefined) store.approvals.delete(current.approval.id);
    store.approvals.set(approval.id, taskId);
    commitTask(store, { ...current, state: "needs_input", approval });
  });
  return structuredClone(approval);
}

export function assertApprovalOpen(
  store: TaskStore,
  owner: OwnerContext,
  approvalId: string,
): ApprovalRequest {
  const taskId = store.approvals.get(approvalId);
  if (taskId === undefined) throw new Error("Approval not found");
  const task = applyLimits(store, owner, taskId);
  if (!RUNNABLE_STATES.has(task.state)) throw new Error("Approval conflict");
  const approval = task.approval;
  if (approval?.id !== approvalId || approval.state !== "pending") throw new Error("Approval not found");
  if (store.now() >= approval.expiresAt) throw new Error("Approval expired; request new consent");
  return structuredClone(approval);
}

function payloadDigest(action: ApprovalAction): string {
  return createHash("sha256")
    .update(JSON.stringify([action.payload, action.files.map((file) => [file.path, file.content])]))
    .digest("hex");
}

// The caller supplies the actual tool arguments, never arguments taken from the consent POST.
export async function decideApproval(
  store: TaskStore,
  owner: OwnerContext,
  taskId: string,
  input: unknown,
  actualAction: ApprovalAction,
  invoke: (action: ApprovalAction, idempotencyKey: string) => string | Promise<string>,
): Promise<Task> {
  ownedTask(store, owner, taskId);
  const decision = parseApprovalDecision(input);
  const approval = parseApprovalRequest(assertApprovalOpen(store, owner, decision.approval.id));
  const action = parseApprovalAction(actualAction);
  const expected = parseApprovalRequest({ ...approval, ...action, payloadDigest: payloadDigest(action) });
  if (
    approval.taskId !== taskId ||
    JSON.stringify(approval) !== JSON.stringify(decision.approval) ||
    JSON.stringify(approval) !== JSON.stringify(expected)
  ) {
    throw new Error("Approval changed; request new consent");
  }
  const root = rootTask(store, ownedTask(store, owner, taskId));
  if (decision.consent && root.costCents + action.maxCostCents > TASK_MAX_COST_CENTS) {
    throw new Error("Approval exceeds task budget");
  }
  if (
    decision.consent &&
    [...store.tasks.values()].some(
      (task) =>
        task.ownerId === owner.ownerId &&
        task.approval?.actionId === action.actionId &&
        task.approval.state === "consumed",
    )
  ) {
    throw new Error("Action already consumed");
  }
  // ponytail: single-process store. Persist consumption BEFORE dispatch; uncertain outcomes
  // stay consumed after a crash. Multi-process dispatch needs a DB compare-and-set.
  transact(store, () => {
    store.approvals.delete(approval.id);
    const current = ownedTask(store, owner, taskId);
    if (!decision.consent) {
      finishRelatedParent(
        store,
        owner,
        commitTask(store, {
          ...current,
          state: "completed",
          approval: { ...approval, state: "rejected" },
          result: "External action rejected. No call made.",
        }),
      );
      return;
    }
    commitTask(store, {
      ...current,
      state: "working",
      approval: { ...approval, state: "consumed" },
    });
  });
  if (!decision.consent) return ownedTask(store, owner, taskId);
  try {
    const result = await invoke(action, action.actionId);
    return transact(store, () => {
      applyLimitsUnpersisted(store, owner, taskId);
      const current = ownedTask(store, owner, taskId);
      if (!RUNNABLE_STATES.has(current.state)) throw new Error("Task cannot accept results");
      const completed = commitTask(store, { ...current, state: "completed", result });
      finishRelatedParent(store, owner, completed);
      return completed;
    });
  } catch (error) {
    try {
      sealUnsuccessfulDispatch(store, owner, taskId);
    } catch {
      // consume already persisted; a later load fail-closes this dispatch
    }
    throw error;
  }
}

export function mockApprovalAction(actionId: string = randomUUID()): ApprovalAction {
  return {
    actionId,
    actionClass: "external_effect",
    origin: "https://mock.example",
    operation: "POST /notes",
    payload: "Test note: Blau",
    files: [{ path: "test-note.txt", content: "Blau" }],
    maxCostCents: 0,
  };
}

export function mockExternalWrite(_action: ApprovalAction, _idempotencyKey: string): string {
  // No network or filesystem effect: this is the P0 approval fixture, not a live tool.
  return "Mock external write executed once. No external data was sent.";
}

export function runApprovalResearch(store: TaskStore, owner: OwnerContext): { cards: SubagentCard[] } {
  let task = liveAssignedResearch(store, owner, APPROVAL_ASSIGNMENT);
  if (task === undefined) {
    const parent = createParentTask(store, owner, APPROVAL_PROMPT);
    task = startSubagent(store, owner, { parentTaskId: parent.id, role: "research", assignment: APPROVAL_ASSIGNMENT });
  }
  task = applyLimits(store, owner, task.id);
  if (RUNNABLE_STATES.has(task.state) && (task.approval === undefined || (task.approval.state === "pending" && store.now() >= task.approval.expiresAt))) {
    openApproval(store, owner, task.id, mockApprovalAction());
  }
  return { cards: [subagentCard(ownedTask(store, owner, task.id))] };
}

export function recordCost(
  store: TaskStore,
  owner: OwnerContext,
  taskId: string,
  cents: number,
): Task {
  if (!Number.isInteger(cents) || cents < 0) {
    throw new Error("Cost must be a non-negative integer");
  }
  applyLimits(store, owner, taskId);
  const current = ownedTask(store, owner, taskId);
  if (!RUNNABLE_STATES.has(current.state)) {
    throw new Error("Task cannot record cost");
  }
  return transact(store, () => {
    const live = ownedTask(store, owner, taskId);
    const root = ownedTask(store, owner, live.parentTaskId ?? live.id);
    commitTask(store, { ...root, costCents: root.costCents + cents });
    return applyLimitsUnpersisted(store, owner, taskId);
  });
}

export function applyLimits(store: TaskStore, owner: OwnerContext, taskId: string): Task {
  const current = ownedTask(store, owner, taskId);
  const reason = slicePauseReason(store, current);
  if (reason === undefined) return current;
  if (!executionSet(store, current).some((member) => RUNNABLE_STATES.has(member.state))) {
    return current;
  }
  return transact(store, () => applyLimitsUnpersisted(store, owner, taskId));
}

export function listResearchCards(store: TaskStore, owner: OwnerContext): SubagentCard[] {
  const cards: SubagentCard[] = [];
  for (const task of store.tasks.values()) {
    if (task.ownerId !== owner.ownerId || task.role !== "research") continue;
    cards.push(subagentCard(applyLimits(store, owner, task.id)));
  }
  return cards;
}

export function deleteOwnerTasks(store: TaskStore, owner: OwnerContext): void {
  const abortedIds = transact(store, () => {
    const ids: string[] = [];
    for (const task of [...store.tasks.values()]) {
      if (task.ownerId !== owner.ownerId) continue;
      if (task.approval !== undefined) store.approvals.delete(task.approval.id);
      store.tasks.delete(task.id);
      ids.push(task.id);
    }
    return ids;
  });
  for (const id of abortedIds) {
    const controller = store.aborts.get(id);
    if (controller === undefined) continue;
    controller.abort();
    store.aborts.delete(id);
  }
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
    ...(task.result === undefined || task.state === "paused" || task.state === "stopped"
      ? {}
      : { result: task.result }),
    ...(task.state === "paused" && task.pauseReason !== undefined
      ? { pauseReason: task.pauseReason }
      : {}),
    ...(task.question === undefined ? {} : { question: task.question }),
    ...(task.approval === undefined ? {} : { approval: structuredClone(task.approval) }),
  };
}

export function runHeldResearch(
  store: TaskStore,
  owner: OwnerContext,
): { cards: SubagentCard[] } {
  const existing = liveHeldResearch(store, owner);
  if (existing !== undefined) {
    return { cards: [subagentCard(applyLimits(store, owner, existing.id))] };
  }
  const parent = createParentTask(store, owner, HOLD_PROMPT);
  const started = startSubagent(store, owner, {
    parentTaskId: parent.id,
    assignment: HOLD_ASSIGNMENT,
    role: "research",
  });
  return {
    cards: [subagentCard(started), subagentCard(setTaskState(store, owner, started.id, "working"))],
  };
}

export function runQuestionResearch(
  store: TaskStore,
  owner: OwnerContext,
): { cards: SubagentCard[] } {
  const existing = liveAssignedResearch(store, owner, QUESTION_ASSIGNMENT);
  if (existing !== undefined) {
    const live = applyLimits(store, owner, existing.id);
    if (live.question === undefined && RUNNABLE_STATES.has(live.state)) {
      return { cards: [subagentCard(poseQuestion(store, owner, live.id))] };
    }
    return { cards: [subagentCard(live)] };
  }
  const parent = createParentTask(store, owner, QUESTION_PROMPT);
  const started = startSubagent(store, owner, {
    parentTaskId: parent.id,
    assignment: QUESTION_ASSIGNMENT,
    role: "research",
  });
  const working = setTaskState(store, owner, started.id, "working");
  return {
    cards: [subagentCard(started), subagentCard(working), subagentCard(poseQuestion(store, owner, started.id))],
  };
}

export function answerTask(
  store: TaskStore,
  owner: OwnerContext,
  taskId: string,
  input: unknown,
): Task {
  applyLimits(store, owner, taskId);
  const current = ownedTask(store, owner, taskId);
  if (current.role !== "research" || current.question === undefined) {
    throw new Error("Task not found");
  }
  const answer = parseQuestionAnswer(input);
  if ("optionId" in answer && current.question.options.every((option) => option.id !== answer.optionId)) {
    throw new Error("Invalid QuestionAnswer");
  }
  if (current.question.answer !== undefined) {
    if (answersEqual(current.question.answer, answer)) return current;
    throw new Error("Answer conflict");
  }
  if (current.state !== "needs_input") {
    throw new Error("Task is not waiting for input");
  }
  const result = questionResult(current.question, answer);
  const question: QuestionCard = { ...current.question, answer };
  const parentId = current.parentTaskId;
  return transact(store, () => {
    const completed = commitTask(store, {
      ...ownedTask(store, owner, taskId),
      state: "completed",
      question,
      result,
    });
    if (parentId !== undefined) {
      const parent = ownedTask(store, owner, parentId);
      if (RUNNABLE_STATES.has(parent.state)) {
        commitTask(store, { ...parent, state: "completed", result });
      }
    }
    return completed;
  });
}

function liveHeldResearch(store: TaskStore, owner: OwnerContext): Task | undefined {
  return liveAssignedResearch(store, owner, HOLD_ASSIGNMENT);
}

function liveAssignedResearch(
  store: TaskStore,
  owner: OwnerContext,
  assignment: string,
): Task | undefined {
  for (const task of store.tasks.values()) {
    if (
      task.ownerId === owner.ownerId &&
      task.role === "research" &&
      task.assignment === assignment &&
      task.parentTaskId !== undefined &&
      task.state !== "stopped" &&
      !TERMINAL_STATES.has(task.state)
    ) {
      return task;
    }
  }
  return undefined;
}

function poseQuestion(store: TaskStore, owner: OwnerContext, taskId: string): Task {
  applyLimits(store, owner, taskId);
  const current = ownedTask(store, owner, taskId);
  if (!RUNNABLE_STATES.has(current.state)) throw new Error("Task cannot change state");
  const question: QuestionCard = {
    id: randomUUID(),
    taskId: current.id,
    prompt: QUESTION_TEXT,
    options: QUESTION_OPTIONS,
  };
  return transact(store, () =>
    commitTask(store, { ...ownedTask(store, owner, taskId), state: "needs_input", question }),
  );
}

function answersEqual(left: QuestionAnswer, right: QuestionAnswer): boolean {
  if ("optionId" in left) return "optionId" in right && left.optionId === right.optionId;
  return "text" in right && left.text === right.text;
}

function questionResult(question: QuestionCard, answer: QuestionAnswer): string {
  if ("text" in answer) return answer.text;
  const option = question.options.find((entry) => entry.id === answer.optionId);
  if (option === undefined) throw new Error("Invalid QuestionAnswer");
  return option.label;
}

function ownedTask(store: TaskStore, owner: OwnerContext, taskId: string): Task {
  const task = store.tasks.get(taskId);
  if (task === undefined) throw new Error("Task not found");
  requireOwned(task, owner);
  return task;
}

function commitTask(store: TaskStore, task: Task): Task {
  store.tasks.set(task.id, task);
  return task;
}

function executionSet(store: TaskStore, task: Task): Task[] {
  const rootId = task.parentTaskId ?? task.id;
  const members: Task[] = [];
  for (const candidate of store.tasks.values()) {
    if (candidate.id === rootId || candidate.parentTaskId === rootId) members.push(candidate);
  }
  return members;
}

function rootTask(store: TaskStore, task: Task): Task {
  const root = store.tasks.get(task.parentTaskId ?? task.id);
  if (root === undefined) throw new Error("Task not found");
  return root;
}

function slicePauseReason(store: TaskStore, task: Task): PauseReason | undefined {
  const root = rootTask(store, task);
  if (root.startedAt !== undefined && store.now() - root.startedAt >= TASK_MAX_RUNTIME_MS) return "time";
  if (root.costCents >= TASK_MAX_COST_CENTS) return "cost";
  return undefined;
}

function pauseTree(store: TaskStore, task: Task, reason: PauseReason): void {
  for (const member of executionSet(store, task)) {
    if (!RUNNABLE_STATES.has(member.state)) continue;
    const next: Task = { ...member, state: "paused", pauseReason: reason };
    delete next.result;
    store.tasks.set(member.id, next);
  }
}

function applyLimitsUnpersisted(store: TaskStore, owner: OwnerContext, taskId: string): Task {
  const current = ownedTask(store, owner, taskId);
  const reason = slicePauseReason(store, current);
  if (reason !== undefined) pauseTree(store, current, reason);
  return ownedTask(store, owner, taskId);
}

function finishRelatedParent(store: TaskStore, owner: OwnerContext, child: Task): void {
  if (child.parentTaskId === undefined) return;
  const parent = ownedTask(store, owner, child.parentTaskId);
  if (!RUNNABLE_STATES.has(parent.state)) return;
  const next: Task = { ...parent, state: child.state };
  if (child.state === "completed" && child.result !== undefined) next.result = child.result;
  else delete next.result;
  commitTask(store, next);
}

function preservedDispatchState(state: TaskState): boolean {
  return state === "stopped" || TERMINAL_STATES.has(state);
}

function failedConsumedTask(task: Task): Task {
  const failed: Task = { ...task, state: "failed" };
  delete failed.result;
  delete failed.pauseReason;
  return failed;
}

function sealUnsuccessfulDispatch(store: TaskStore, owner: OwnerContext, taskId: string): void {
  const current = store.tasks.get(taskId);
  if (current === undefined || current.approval?.state !== "consumed") return;
  requireOwned(current, owner);
  if (preservedDispatchState(current.state)) return;
  transact(store, () => {
    const live = ownedTask(store, owner, taskId);
    if (preservedDispatchState(live.state) || live.approval?.state !== "consumed") {
      return;
    }
    commitTask(store, failedConsumedTask(live));
    if (live.parentTaskId === undefined) return;
    const parent = ownedTask(store, owner, live.parentTaskId);
    if (preservedDispatchState(parent.state)) return;
    commitTask(store, failedConsumedTask(parent));
  });
}

function failClosedConsumedDispatch(store: TaskStore, task: Task): void {
  if (task.approval?.state !== "consumed" || preservedDispatchState(task.state) || task.result !== undefined) {
    return;
  }
  store.tasks.set(task.id, failedConsumedTask(task));
  if (task.parentTaskId === undefined) return;
  const parent = store.tasks.get(task.parentTaskId);
  if (parent === undefined || preservedDispatchState(parent.state)) return;
  store.tasks.set(parent.id, failedConsumedTask(parent));
}

function snapshotStore(store: TaskStore): { tasks: Task[]; approvals: [string, string][] } {
  return {
    tasks: [...store.tasks.values()].map((task) => ({ ...task })),
    approvals: [...store.approvals.entries()],
  };
}

function restoreStore(
  store: TaskStore,
  snapshot: { tasks: Task[]; approvals: [string, string][] },
): void {
  store.tasks.clear();
  store.approvals.clear();
  for (const task of snapshot.tasks) store.tasks.set(task.id, { ...task });
  for (const [id, taskId] of snapshot.approvals) store.approvals.set(id, taskId);
}

function transact<T>(store: TaskStore, fn: () => T): T {
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

function activeSubagentCount(store: TaskStore, ownerId: string): number {
  let count = 0;
  for (const task of store.tasks.values()) {
    if (task.ownerId === ownerId && task.parentTaskId !== undefined && RUNNABLE_STATES.has(task.state)) {
      count += 1;
    }
  }
  return count;
}

function persistPresent(persistPath: string): boolean {
  return existsSync(persistPath) || existsSync(`${persistPath}.bak`);
}

function persistStore(store: TaskStore): void {
  if (store.persistPath === undefined) return;
  const dest = store.persistPath;
  const tmp = `${dest}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({
      v: 1,
      tasks: [...store.tasks.values()],
    }));
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

function loadStore(store: TaskStore, persistPath: string): void {
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
    !("tasks" in value) ||
    !Array.isArray(value.tasks)
  ) {
    throw new Error("Invalid task store");
  }
  for (const key of Object.keys(value)) {
    if (key !== "v" && key !== "tasks" && key !== "approvals") {
      throw new Error("Invalid task store");
    }
  }
  // Legacy top-level approval stubs are ignored; only full task bindings are restored.
  for (const entry of value.tasks) {
    const task = parsePersistedTask(entry);
    store.tasks.set(task.id, task);
    if (task.approval?.state === "pending" && (RUNNABLE_STATES.has(task.state) || task.state === "paused")) {
      store.approvals.set(task.approval.id, task.id);
    }
  }
  for (const task of [...store.tasks.values()]) failClosedConsumedDispatch(store, task);
}

function parsePersistedTask(value: unknown): Task {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid task store");
  }
  for (const key of Object.keys(value)) {
    if (
      key !== "id" &&
      key !== "ownerId" &&
      key !== "parentTaskId" &&
      key !== "role" &&
      key !== "assignment" &&
      key !== "state" &&
      key !== "result" &&
      key !== "startedAt" &&
      key !== "costCents" &&
      key !== "pauseReason" &&
      key !== "question" &&
      key !== "approval"
    ) {
      throw new Error("Invalid task store");
    }
  }
  if (
    !("id" in value) ||
    typeof value.id !== "string" ||
    value.id === "" ||
    !("ownerId" in value) ||
    typeof value.ownerId !== "string" ||
    value.ownerId === "" ||
    !("assignment" in value) ||
    typeof value.assignment !== "string" ||
    value.assignment === "" ||
    !("state" in value) ||
    !("costCents" in value) ||
    typeof value.costCents !== "number" ||
    !Number.isInteger(value.costCents) ||
    value.costCents < 0
  ) {
    throw new Error("Invalid task store");
  }
  const state = parseTaskState(value.state);
  const parentTaskId =
    "parentTaskId" in value && typeof value.parentTaskId === "string" && value.parentTaskId !== ""
      ? value.parentTaskId
      : undefined;
  if ("parentTaskId" in value && parentTaskId === undefined) throw new Error("Invalid task store");
  const role = "role" in value && value.role === "research" ? "research" as const : undefined;
  if ("role" in value && role === undefined) throw new Error("Invalid task store");
  const result =
    "result" in value && typeof value.result === "string" && value.result !== ""
      ? value.result
      : undefined;
  if ("result" in value && result === undefined) throw new Error("Invalid task store");
  const startedAt =
    "startedAt" in value && typeof value.startedAt === "number" && Number.isInteger(value.startedAt)
      ? value.startedAt
      : undefined;
  if ("startedAt" in value && startedAt === undefined) throw new Error("Invalid task store");
  const pauseReason =
    "pauseReason" in value && (value.pauseReason === "time" || value.pauseReason === "cost")
      ? value.pauseReason
      : undefined;
  if ("pauseReason" in value && (pauseReason === undefined || state !== "paused")) {
    throw new Error("Invalid task store");
  }
  let question: QuestionCard | undefined;
  if ("question" in value) {
    try {
      question = parseQuestionCard(value.question);
    } catch {
      throw new Error("Invalid task store");
    }
    if (question.taskId !== value.id) throw new Error("Invalid task store");
    if (state === "needs_input" && question.answer !== undefined) throw new Error("Invalid task store");
    if (state === "completed" && question.answer === undefined) throw new Error("Invalid task store");
  }
  const approval = "approval" in value ? parseApprovalRequest(value.approval) : undefined;
  if (approval !== undefined && (approval.taskId !== value.id || question !== undefined || payloadDigest(approval) !== approval.payloadDigest)) throw new Error("Invalid task store");
  if (state === "needs_input" && question === undefined && approval?.state !== "pending") throw new Error("Invalid task store");
  return {
    id: value.id,
    ownerId: value.ownerId,
    assignment: value.assignment,
    state,
    costCents: value.costCents,
    ...(parentTaskId === undefined ? {} : { parentTaskId }),
    ...(role === undefined ? {} : { role }),
    ...(result === undefined ? {} : { result }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(pauseReason === undefined ? {} : { pauseReason }),
    ...(question === undefined ? {} : { question }),
    ...(approval === undefined ? {} : { approval }),
  };
}
