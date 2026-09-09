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

export type ChatStreamEvent =
  | { type: "delta"; text: string }
  | { type: "done" };

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

export const ACTION_CLASSES = ["internal", "external_effect", "data_disclosure"] as const;
export type ActionClass = (typeof ACTION_CLASSES)[number];
