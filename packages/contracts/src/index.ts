import { parseApprovalRequest, type ApprovalRequest } from "./approvals.ts";
export { parseApprovalAction, parseApprovalRequest, parseApprovalDecision, type ApprovalAction, type ApprovalRequest } from "./approvals.ts";
export {
  MAX_MEMORY_CONTENT,
  MEMORY_CONFIRM_REPLY,
  MEMORY_ORIGIN,
  MEMORY_REDACTED_USER_TEXT,
  MEMORY_SECRET_REPLY,
  isForbiddenMemoryContent,
  isForbiddenRememberMessage,
  isRememberCommand,
  isSensitiveMemoryContent,
  parseMemoryConfirmRequest,
  parseMemoryConfirmResponse,
  parseMemoryContent,
  parseMemoryItem,
  parseMemoryListResponse,
  parseMemoryPauseRequest,
  parseMemoryRetrieveRequest,
  parseMemoryRetrieveResponse,
  parseMemoryUpdateRequest,
  parseRememberContent,
  type MemoryConfirmRequest,
  type MemoryConfirmResponse,
  type MemoryItem,
  type MemoryListResponse,
  type MemoryOrigin,
  type MemoryPauseRequest,
  type MemoryRetrieveRequest,
  type MemoryRetrieveResponse,
} from "./memory.ts";
export {
  ACCOUNT_DELETION_NOTICE,
  AUDIT_TTL_MS,
  BACKUP_TTL_MS,
  DAY_MS,
  PROVIDER_SIDE_LIMIT,
  RETENTION_KINDS,
  RETENTION_SCHEDULE,
  SCREENSHOT_TTL_MS,
  TASK_FILE_TTL_MS,
  parseAccountDeleteRequest,
  parseAccountDeleteResponse,
  parseRetentionKind,
  retentionTtlMs,
  type AccountDeleteRequest,
  type AccountDeleteResponse,
  type RetentionKind,
} from "./retention.ts";

export type HealthResponse = {
  status: "ok";
};

export function parseHealthResponse(value: unknown): HealthResponse {
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    "status" in value &&
    value.status === "ok"
  ) {
    return { status: "ok" };
  }
  throw new Error("Invalid HealthResponse");
}

export const TASK_STATES = [
  "waiting",
  "working",
  "needs_input",
  "paused",
  "completed",
  "stopped",
  "failed",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const SUBAGENT_ROLES = ["research"] as const;
export type SubagentRole = (typeof SUBAGENT_ROLES)[number];

export const PAUSE_REASONS = ["time", "cost"] as const;
export type PauseReason = (typeof PAUSE_REASONS)[number];

export const MAX_QUESTION_CHARS = 400;

export type QuestionOption = {
  id: string;
  label: string;
};

export type QuestionAnswer = { optionId: string } | { text: string };

export type QuestionCard = {
  id: string;
  taskId: string;
  prompt: string;
  options: QuestionOption[];
  answer?: QuestionAnswer;
};

export type SubagentCard = {
  id: string;
  role: SubagentRole;
  assignment: string;
  state: TaskState;
  result?: string;
  pauseReason?: PauseReason;
  question?: QuestionCard;
  approval?: ApprovalRequest;
};

export type ChatStreamEvent =
  | { type: "delta"; text: string }
  | { type: "done" }
  | ({ type: "subagent" } & SubagentCard);

export function parseChatStreamEvent(value: unknown): ChatStreamEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("type" in value)) {
    throw new Error("Invalid ChatStreamEvent");
  }
  if (value.type === "done" && Object.keys(value).length === 1) return { type: "done" };
  if (
    value.type === "delta" &&
    "text" in value &&
    typeof value.text === "string" &&
    value.text !== "" &&
    Object.keys(value).length === 2
  ) {
    return { type: "delta", text: value.text };
  }
  if (value.type === "subagent") {
    const rest: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key !== "type") rest[key] = entry;
    }
    return { type: "subagent", ...parseSubagentCard(rest) };
  }
  throw new Error("Invalid ChatStreamEvent");
}

export type ProviderCapabilities = {
  questions: boolean;
  approvals: boolean;
  toolEvents: boolean;
  modelSwitching: boolean;
};

export interface ProviderAdapter<Session, Input, Event> {
  readonly capabilities: ProviderCapabilities;
  start(input: Input): Promise<Session>;
  stream(session: Session): AsyncIterable<Event>;
  abort(session: Session): Promise<void>;
  end(session: Session): Promise<void>;
}

export function parseTaskState(value: unknown): TaskState {
  if (typeof value === "string") {
    for (const state of TASK_STATES) {
      if (value === state) return state;
    }
  }
  throw new Error("Invalid TaskState");
}

function boundedQuestionChars(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "" || [...value].length > MAX_QUESTION_CHARS) {
    return undefined;
  }
  return value;
}

export function parseQuestionOption(value: unknown): QuestionOption {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid QuestionOption");
  }
  if (
    Object.keys(value).length !== 2 ||
    !("id" in value) ||
    !("label" in value)
  ) {
    throw new Error("Invalid QuestionOption");
  }
  const id = boundedQuestionChars(value.id);
  const label = boundedQuestionChars(value.label);
  if (id === undefined || label === undefined) throw new Error("Invalid QuestionOption");
  return { id, label };
}

export function parseQuestionAnswer(value: unknown): QuestionAnswer {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid QuestionAnswer");
  }
  const keys = Object.keys(value);
  if (keys.length !== 1) throw new Error("Invalid QuestionAnswer");
  if ("optionId" in value) {
    const optionId = boundedQuestionChars(value.optionId);
    if (optionId === undefined) throw new Error("Invalid QuestionAnswer");
    return { optionId };
  }
  if ("text" in value) {
    if (typeof value.text !== "string") throw new Error("Invalid QuestionAnswer");
    const text = value.text.trim();
    if (text === "" || [...text].length > MAX_QUESTION_CHARS) {
      throw new Error("Invalid QuestionAnswer");
    }
    return { text };
  }
  throw new Error("Invalid QuestionAnswer");
}

export function parseQuestionCard(value: unknown): QuestionCard {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid QuestionCard");
  }
  for (const key of Object.keys(value)) {
    if (key !== "id" && key !== "taskId" && key !== "prompt" && key !== "options" && key !== "answer") {
      throw new Error("Invalid QuestionCard");
    }
  }
  const id = "id" in value ? boundedQuestionChars(value.id) : undefined;
  const taskId = "taskId" in value ? boundedQuestionChars(value.taskId) : undefined;
  const prompt = "prompt" in value ? boundedQuestionChars(value.prompt) : undefined;
  if (id === undefined || taskId === undefined || prompt === undefined) {
    throw new Error("Invalid QuestionCard");
  }
  if (!("options" in value) || !Array.isArray(value.options) || value.options.length < 2 || value.options.length > 4) {
    throw new Error("Invalid QuestionCard");
  }
  const options = value.options.map((entry) => parseQuestionOption(entry));
  const optionIds = options.map((option) => option.id);
  if (new Set(optionIds).size !== optionIds.length) throw new Error("Invalid QuestionCard");
  const answer = "answer" in value ? parseQuestionAnswer(value.answer) : undefined;
  if (answer !== undefined && "optionId" in answer && !optionIds.includes(answer.optionId)) {
    throw new Error("Invalid QuestionCard");
  }
  return {
    id,
    taskId,
    prompt,
    options,
    ...(answer === undefined ? {} : { answer }),
  };
}

export function parseSubagentCard(value: unknown): SubagentCard {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid SubagentCard");
  }
  if (
    !("id" in value) ||
    typeof value.id !== "string" ||
    value.id === "" ||
    !("role" in value) ||
    value.role !== "research" ||
    !("assignment" in value) ||
    typeof value.assignment !== "string" ||
    value.assignment === "" ||
    !("state" in value)
  ) {
    throw new Error("Invalid SubagentCard");
  }
  for (const key of Object.keys(value)) {
    if (
      key !== "id" &&
      key !== "role" &&
      key !== "assignment" &&
      key !== "state" &&
      key !== "result" &&
      key !== "pauseReason" &&
      key !== "question" &&
      key !== "approval"
    ) {
      throw new Error("Invalid SubagentCard");
    }
  }
  const state = parseTaskState(value.state);
  if (
    (state === "paused" || state === "stopped") &&
    "result" in value
  ) {
    throw new Error("Invalid SubagentCard");
  }
  const pauseReason = parsePauseReason(value, state);
  const question = "question" in value ? parseQuestionCard(value.question) : undefined;
  if (question !== undefined && question.taskId !== value.id) {
    throw new Error("Invalid SubagentCard");
  }
  const approval = "approval" in value ? parseApprovalRequest(value.approval) : undefined;
  if (approval !== undefined && (approval.taskId !== value.id || question !== undefined)) {
    throw new Error("Invalid SubagentCard");
  }
  if (state === "needs_input" && !((question !== undefined && question.answer === undefined) || approval?.state === "pending")) {
    throw new Error("Invalid SubagentCard");
  }
  if (state === "completed" && question !== undefined && question.answer === undefined) {
    throw new Error("Invalid SubagentCard");
  }
  const extra = {
    ...(pauseReason === undefined ? {} : { pauseReason }),
    ...(question === undefined ? {} : { question }),
    ...(approval === undefined ? {} : { approval }),
  };
  if ("result" in value) {
    if (typeof value.result !== "string" || value.result === "") {
      throw new Error("Invalid SubagentCard");
    }
    return {
      id: value.id,
      role: "research",
      assignment: value.assignment,
      state,
      result: value.result,
      ...extra,
    };
  }
  return {
    id: value.id,
    role: "research",
    assignment: value.assignment,
    state,
    ...extra,
  };
}

function parsePauseReason(value: object, state: TaskState): PauseReason | undefined {
  if (!("pauseReason" in value)) return undefined;
  if (state !== "paused" || (value.pauseReason !== "time" && value.pauseReason !== "cost")) {
    throw new Error("Invalid SubagentCard");
  }
  return value.pauseReason;
}

export type TaskListResponse = {
  tasks: SubagentCard[];
};

export function parseTaskListResponse(value: unknown): TaskListResponse {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !("tasks" in value) ||
    !Array.isArray(value.tasks)
  ) {
    throw new Error("Invalid TaskListResponse");
  }
  return { tasks: value.tasks.map((entry) => parseSubagentCard(entry)) };
}

export type ResumeRequest = {
  consent: true;
};

export function parseResumeRequest(value: unknown): ResumeRequest {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !("consent" in value) ||
    value.consent !== true
  ) {
    throw new Error("Invalid ResumeRequest");
  }
  return { consent: true };
}

export const ACTION_CLASSES = ["internal", "external_effect", "data_disclosure"] as const;
export type ActionClass = (typeof ACTION_CLASSES)[number];
