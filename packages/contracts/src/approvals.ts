export type ApprovalAction = {
  actionId: string;
  actionClass: "external_effect" | "data_disclosure";
  origin: string;
  operation: string;
  payload: string;
  files: { path: string; content: string }[];
  maxCostCents: number;
};

export type ApprovalRequest = ApprovalAction & {
  id: string;
  taskId: string;
  payloadDigest: string;
  expiresAt: number;
  state: "pending" | "consumed" | "rejected";
};

const ACTION_KEYS = ["actionId", "actionClass", "origin", "operation", "payload", "files", "maxCostCents"];

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid approval");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, max = 400): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    throw new Error("Invalid approval");
  }
  return value;
}

export function parseApprovalAction(value: unknown): ApprovalAction {
  const input = record(value);
  if (Object.keys(input).length !== ACTION_KEYS.length || Object.keys(input).some((key) => !ACTION_KEYS.includes(key))) {
    throw new Error("Invalid approval");
  }
  const origin = text(input.origin);
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error("Invalid approval");
  }
  if (url.protocol !== "https:" || url.origin !== origin) throw new Error("Invalid approval");
  if (input.actionClass !== "external_effect" && input.actionClass !== "data_disclosure") throw new Error("Invalid approval");
  if (!Number.isSafeInteger(input.maxCostCents) || (input.maxCostCents as number) < 0) throw new Error("Invalid approval");
  if (typeof input.payload !== "string" || input.payload.length > 4_000) throw new Error("Invalid approval");
  if (!Array.isArray(input.files) || input.files.length > 10) throw new Error("Invalid approval");
  const files = input.files.map((entry: unknown) => {
    const file = record(entry);
    if (Object.keys(file).length !== 2 || typeof file.content !== "string" || file.content.length > 4_000) {
      throw new Error("Invalid approval");
    }
    return { path: text(file.path), content: file.content };
  });
  return {
    actionId: text(input.actionId),
    actionClass: input.actionClass,
    origin,
    operation: text(input.operation),
    payload: input.payload,
    files,
    maxCostCents: input.maxCostCents as number,
  };
}

export function parseApprovalRequest(value: unknown): ApprovalRequest {
  const input = record(value);
  const extra = ["id", "taskId", "payloadDigest", "expiresAt", "state"];
  if (Object.keys(input).length !== ACTION_KEYS.length + extra.length || Object.keys(input).some((key) => !ACTION_KEYS.includes(key) && !extra.includes(key))) {
    throw new Error("Invalid approval");
  }
  const action = parseApprovalAction(Object.fromEntries(ACTION_KEYS.map((key) => [key, input[key]])));
  if (typeof input.payloadDigest !== "string" || !/^[a-f0-9]{64}$/.test(input.payloadDigest)) throw new Error("Invalid approval");
  if (!Number.isSafeInteger(input.expiresAt) || (input.expiresAt as number) < 0) throw new Error("Invalid approval");
  if (input.state !== "pending" && input.state !== "consumed" && input.state !== "rejected") throw new Error("Invalid approval");
  return {
    ...action,
    id: text(input.id),
    taskId: text(input.taskId),
    payloadDigest: input.payloadDigest,
    expiresAt: input.expiresAt as number,
    state: input.state,
  };
}

export function parseApprovalDecision(value: unknown): { approval: ApprovalRequest; consent: boolean } {
  const input = record(value);
  if (Object.keys(input).length !== 2 || typeof input.consent !== "boolean" || !("approval" in input)) {
    throw new Error("Invalid approval");
  }
  return { approval: parseApprovalRequest(input.approval), consent: input.consent };
}
