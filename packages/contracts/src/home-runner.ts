export const HOME_RUNNER_FIXTURE = "echo-ok" as const;

export type RunnerPairingResponse = {
  pairingId: string;
  code: string;
  expiresAt: number;
  mailboxId: string;
  capability: string;
  relayUrl: string;
};

export type HomeRunnerJobStatus = {
  id: string;
  runnerId: string;
  state: "queued" | "completed" | "failed";
  stdout: string;
  stderr: string;
};

export function parseRunnerPairingResponse(value: unknown): RunnerPairingResponse {
  if (!isRecord(value) || Object.keys(value).length !== 6) {
    throw new Error("Invalid RunnerPairingResponse");
  }
  const { pairingId, code, expiresAt, mailboxId, capability, relayUrl } = value;
  if (
    !isId(pairingId) ||
    typeof code !== "string" ||
    code.length < 32 ||
    typeof expiresAt !== "number" ||
    !Number.isFinite(expiresAt) ||
    !isId(mailboxId) ||
    typeof capability !== "string" ||
    capability.length < 32 ||
    typeof relayUrl !== "string" ||
    !relayUrl.startsWith("https://")
  ) {
    throw new Error("Invalid RunnerPairingResponse");
  }
  return { pairingId, code, expiresAt, mailboxId, capability, relayUrl };
}

export function parseHomeRunnerJobRequest(value: unknown): { fixture: typeof HOME_RUNNER_FIXTURE } {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !("fixture" in value)) {
    throw new Error("Invalid HomeRunnerJobRequest");
  }
  if (value.fixture !== HOME_RUNNER_FIXTURE) throw new Error("Invalid HomeRunnerJobRequest");
  return { fixture: HOME_RUNNER_FIXTURE };
}

export function parseHomeRunnerJobStatus(value: unknown): HomeRunnerJobStatus {
  if (!isRecord(value) || Object.keys(value).length !== 5) {
    throw new Error("Invalid HomeRunnerJobStatus");
  }
  const { id, runnerId, state, stdout, stderr } = value;
  if (
    !isId(id) ||
    !isId(runnerId) ||
    (state !== "queued" && state !== "completed" && state !== "failed") ||
    typeof stdout !== "string" ||
    typeof stderr !== "string"
  ) {
    throw new Error("Invalid HomeRunnerJobStatus");
  }
  return { id, runnerId, state, stdout, stderr };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
