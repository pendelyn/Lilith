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

export type SubagentCard = {
  id: string;
  role: SubagentRole;
  assignment: string;
  state: TaskState;
  result?: string;
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
    if (key !== "id" && key !== "role" && key !== "assignment" && key !== "state" && key !== "result") {
      throw new Error("Invalid SubagentCard");
    }
  }
  const state = parseTaskState(value.state);
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
    };
  }
  return {
    id: value.id,
    role: "research",
    assignment: value.assignment,
    state,
  };
}

export const ACTION_CLASSES = ["internal", "external_effect", "data_disclosure"] as const;
export type ActionClass = (typeof ACTION_CLASSES)[number];
