export const MAX_MEMORY_CONTENT = 1_000;
export const MEMORY_ORIGIN = "chat" as const;
export type MemoryOrigin = typeof MEMORY_ORIGIN;
export const MEMORY_SECRET_REPLY = "I can't store passwords, tokens, or payment authentication data.";
export const MEMORY_CONFIRM_REPLY = "This looks sensitive. Confirm in the app to store it as a memory.";
export const MEMORY_REDACTED_USER_TEXT = "Merk dir: [redacted]";

export type MemoryItem = {
  id: string;
  content: string;
  origin: MemoryOrigin;
  createdAt: number;
  updatedAt: number;
};

export type MemoryListResponse = {
  memories: MemoryItem[];
  paused: boolean;
};

export type MemoryRetrieveRequest = {
  query: string;
  memoryEnabled: boolean;
};

export type MemoryRetrieveResponse = {
  memories: MemoryItem[];
};

export type MemoryPauseRequest = {
  paused: boolean;
};

export type MemoryConfirmRequest = {
  consent: boolean;
  content: string;
  memoryEnabled: boolean;
};

export type MemoryConfirmResponse = {
  confirmed: boolean;
  memory?: MemoryItem;
};

export function isRememberCommand(message: string): boolean {
  return /^merk\s+dir\b/iu.test(message.trim());
}

export function parseRememberContent(message: string): string | undefined {
  const match = /^merk\s+dir(?:\s*[:：]\s*|\s+)([\s\S]+)$/iu.exec(message.trim());
  const content = match?.[1]?.trim();
  return content === undefined || content === "" ? undefined : content;
}

export function isForbiddenRememberMessage(message: string): boolean {
  const content = parseRememberContent(message);
  return content !== undefined && isForbiddenMemoryContent(content);
}

export function isForbiddenMemoryContent(content: string): boolean {
  // ponytail: labeled password/token/payment-auth plus Luhn. Unlabeled secrets fall through to confirmation.
  if (FORBIDDEN_LABEL.test(content) || TOKEN_PREFIX.test(content)) return true;
  for (const match of content.matchAll(/(?:\d[ \-]?){13,19}/g)) {
    const digits = match[0].replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) return true;
  }
  return false;
}

export function isSensitiveMemoryContent(content: string): boolean {
  if (isForbiddenMemoryContent(content)) return false;
  return (
    SENSITIVE_EMAIL.test(content) ||
    SENSITIVE_PHONE.test(content) ||
    SENSITIVE_IBAN.test(content) ||
    SENSITIVE_LABEL.test(content)
  );
}

export function parseMemoryContent(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid memory");
  const content = value.trim();
  if (content === "" || [...content].length > MAX_MEMORY_CONTENT) {
    throw new Error("Invalid memory");
  }
  if (isForbiddenMemoryContent(content)) throw new Error("Forbidden memory");
  return content;
}

export function parseMemoryItem(value: unknown): MemoryItem {
  const input = record(value, "Invalid memory");
  if (Object.keys(input).length !== 5) throw new Error("Invalid memory");
  const id = text(input.id);
  const content = parseMemoryContent(input.content);
  if (input.origin !== MEMORY_ORIGIN) throw new Error("Invalid memory");
  const createdAt = timestamp(input.createdAt);
  const updatedAt = timestamp(input.updatedAt);
  if (updatedAt < createdAt) throw new Error("Invalid memory");
  return { id, content, origin: MEMORY_ORIGIN, createdAt, updatedAt };
}

export function parseMemoryListResponse(value: unknown): MemoryListResponse {
  const input = record(value, "Invalid MemoryListResponse");
  if (Object.keys(input).length !== 2 || !("memories" in input) || !Array.isArray(input.memories)) {
    throw new Error("Invalid MemoryListResponse");
  }
  if (typeof input.paused !== "boolean") throw new Error("Invalid MemoryListResponse");
  return {
    memories: input.memories.map((entry) => parseMemoryItem(entry)),
    paused: input.paused,
  };
}

export function parseMemoryRetrieveRequest(value: unknown): MemoryRetrieveRequest {
  const input = record(value, "Invalid MemoryRetrieveRequest");
  if (Object.keys(input).length !== 2 || typeof input.memoryEnabled !== "boolean") {
    throw new Error("Invalid MemoryRetrieveRequest");
  }
  if (typeof input.query !== "string" || input.query.trim() === "" || input.query.length > 4_000) {
    throw new Error("Invalid MemoryRetrieveRequest");
  }
  return { query: input.query.trim(), memoryEnabled: input.memoryEnabled };
}

export function parseMemoryRetrieveResponse(value: unknown): MemoryRetrieveResponse {
  const input = record(value, "Invalid MemoryRetrieveResponse");
  if (Object.keys(input).length !== 1 || !("memories" in input) || !Array.isArray(input.memories)) {
    throw new Error("Invalid MemoryRetrieveResponse");
  }
  return { memories: input.memories.map((entry) => parseMemoryItem(entry)) };
}

export function parseMemoryPauseRequest(value: unknown): MemoryPauseRequest {
  const input = record(value, "Invalid MemoryPauseRequest");
  if (Object.keys(input).length !== 1 || typeof input.paused !== "boolean") {
    throw new Error("Invalid MemoryPauseRequest");
  }
  return { paused: input.paused };
}

export function parseMemoryConfirmRequest(value: unknown): MemoryConfirmRequest {
  const input = record(value, "Invalid memory");
  if (
    Object.keys(input).length !== 3 ||
    typeof input.consent !== "boolean" ||
    typeof input.memoryEnabled !== "boolean" ||
    typeof input.content !== "string"
  ) {
    throw new Error("Invalid memory");
  }
  const content = input.content.trim();
  if (content === "" || [...content].length > MAX_MEMORY_CONTENT) {
    throw new Error("Invalid memory");
  }
  return { consent: input.consent, content, memoryEnabled: input.memoryEnabled };
}

export function parseMemoryConfirmResponse(value: unknown): MemoryConfirmResponse {
  const input = record(value, "Invalid MemoryConfirmResponse");
  if (typeof input.confirmed !== "boolean") throw new Error("Invalid MemoryConfirmResponse");
  if (input.confirmed) {
    if (Object.keys(input).length !== 2 || !("memory" in input)) {
      throw new Error("Invalid MemoryConfirmResponse");
    }
    return { confirmed: true, memory: parseMemoryItem(input.memory) };
  }
  if (Object.keys(input).length !== 1) throw new Error("Invalid MemoryConfirmResponse");
  return { confirmed: false };
}

export function parseMemoryUpdateRequest(value: unknown): { content: string } {
  const input = record(value, "Invalid memory");
  if (Object.keys(input).length !== 1) throw new Error("Invalid memory");
  return { content: parseMemoryContent(input.content) };
}

const FORBIDDEN_LABEL =
  /\bpasswords?\b|\bpassw(?:ort|örter|oerter)\b|\bkennw(?:ort|örter|oerter)\b|\bgeheimzahl(?:en)?\b|\bpasswd\b|\bpwd\b|\bpassphrases?\b|\btokens?\b|\bapi[_-]?keys?\b|\bbearer\b|\bjwts?\b|\bsecret[_-]?keys?\b|\baccess[_-]?tokens?\b|\brefresh[_-]?tokens?\b|\b(credit|debit)\s*cards?\b|\bkreditkarten?\b|\bkartennummern?\b|\bcard\s*numbers?\b|\b(cvv|cvc|csc|cvc2)\d*\b|\b3-?d\s*secure\b|\b(?:one[ -]?time\s+(?:passwords?|passw(?:ort|örter|oerter))|otps?)\b|\b(?:payment|karten)[ -]?pins?\b|\bzahlungs[ -]?pins?\b/iu;
const TOKEN_PREFIX = /\b(?:sk-[a-z0-9]|ghp_|gho_|github_pat_|xox[baprs]-)/i;
const SENSITIVE_EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const SENSITIVE_PHONE = /(?:\+|00)\d{6,15}|\b0\d[\d\s/-]{6,}\d\b/;
const SENSITIVE_IBAN = /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/i;
const SENSITIVE_LABEL =
  /\b(?:e-?mails?|telefon(?:nummer)?n?|handynummern?|phone(?:\s*numbers?)?|ibans?|adressen?|addresses?|straßen?|strassen?|wohnort|postleitzahlen?|plz|gesundheit(?:sdaten)?|diagnosen?|krankheiten?|medikamente?n?|krankenversicher\w*|sozialversicher\w*|personalausweis(?:e|es)?|passnummern?|steuer(?:[- ]?id|ident\w*|nummern?)|geburts(?:datum|tage?)|birthday|social[- ]security|ssn|patient(?:en(?:daten)?)?|arztbrief(?:e|es)?|blutgruppe)\b/iu;

function record(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== "string" || value === "") throw new Error("Invalid memory");
  return value;
}

function timestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Invalid memory");
  }
  return value;
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = Number(digits[i]);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}
