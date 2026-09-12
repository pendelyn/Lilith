export const DAY_MS = 86_400_000;
export const SCREENSHOT_TTL_MS = 7 * DAY_MS;
export const TASK_FILE_TTL_MS = 30 * DAY_MS;
export const AUDIT_TTL_MS = 90 * DAY_MS;
export const BACKUP_TTL_MS = 30 * DAY_MS;

export const RETENTION_KINDS = ["screenshot", "task_file", "audit", "backup"] as const;
export type RetentionKind = (typeof RETENTION_KINDS)[number];

export const PROVIDER_SIDE_LIMIT =
  "No model provider is connected. Copies stored by a provider you connect later follow that provider's own retention rules. Lilith cannot delete or expire those copies.";

export const ACCOUNT_DELETION_NOTICE =
  "Deleting your account removes chats, tasks, and memories immediately. Screenshots and temporary task files are also removed immediately. Backups expire within 30 days and are not deleted immediately. Security audit records are kept until they expire after 90 days. The local API token is a server environment secret, not an account password; deletion does not revoke or rotate it.";

export const RETENTION_SCHEDULE = [
  "Screenshots expire after 7 days.",
  "Temporary task files expire after 30 days.",
  "Security audit records expire after 90 days.",
  "Backups expire after 30 days.",
  "Chats, tasks, and memories stay until you delete them. Automated expiry never deletes them.",
] as const;

export type AccountDeleteRequest = {
  consent: true;
};

export type AccountDeleteResponse = {
  deleted: true;
};

export function parseRetentionKind(value: unknown): RetentionKind {
  if (typeof value === "string") {
    for (const kind of RETENTION_KINDS) {
      if (value === kind) return kind;
    }
  }
  throw new Error("Invalid retention");
}

export function retentionTtlMs(kind: RetentionKind): number {
  if (kind === "screenshot") return SCREENSHOT_TTL_MS;
  if (kind === "task_file") return TASK_FILE_TTL_MS;
  if (kind === "audit") return AUDIT_TTL_MS;
  return BACKUP_TTL_MS;
}

export function parseAccountDeleteRequest(value: unknown): AccountDeleteRequest {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !("consent" in value) ||
    value.consent !== true
  ) {
    throw new Error("Invalid AccountDeleteRequest");
  }
  return { consent: true };
}

export function parseAccountDeleteResponse(value: unknown): AccountDeleteResponse {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !("deleted" in value) ||
    value.deleted !== true
  ) {
    throw new Error("Invalid AccountDeleteResponse");
  }
  return { deleted: true };
}
