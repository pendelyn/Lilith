import { posix } from "node:path";
import {
  MAX_BROWSER_URL_CHARS,
  SENSITIVE_QUERY_KEYS,
  isSensitiveQueryKey,
  redactSensitiveQueryParts,
} from "@lilith/contracts";

export { SENSITIVE_QUERY_KEYS, isSensitiveQueryKey };

export const WORKSPACE_ROOT = "/workspace";
export const COOKIE_FIXTURE_FILE = "cookie.html";
export const SENSITIVE_FIXTURE_FILE = "sensitive.html";
export const COOKIE_FIXTURE_WORKSPACE_PATH = `${WORKSPACE_ROOT}/${COOKIE_FIXTURE_FILE}`;
export const SENSITIVE_FIXTURE_WORKSPACE_PATH = `${WORKSPACE_ROOT}/${SENSITIVE_FIXTURE_FILE}`;
export const ALLOWED_WORKSPACE_FILES = [
  COOKIE_FIXTURE_WORKSPACE_PATH,
  SENSITIVE_FIXTURE_WORKSPACE_PATH,
] as const;
export const COOKIE_DIALOG_LOCATOR =
  '[role="dialog"], [role="alertdialog"], [id*="cookie" i], [class*="cookie" i]';
export const COOKIE_HAS_RE = "cookie|cookies|datenschutz";
export const COOKIE_NEED_RE =
  "consent|agree|accept|allow|zustimm|akzeptier|einwilligung|privacy|tracking|gdpr";
export const COOKIE_ACCEPT_RE =
  "^(?:accept|agree|zustimmen|akzeptieren|einverstanden)\\b|\\b(?:accept|agree|allow|zustimmen|akzeptieren|einverstanden)\\b.*\\b(?:cookie|cookies|consent|all|alle)\\b|\\b(?:cookie|cookies|consent|all|alle)\\b.*\\b(?:accept|agree|allow|zustimmen|akzeptieren|einverstanden)\\b";
export const COOKIE_BARE_OK_RE = "^(?:ok|okay)$";

export const SENSITIVE_AUTOCOMPLETE = [
  "current-password",
  "new-password",
  "password",
  "cc-number",
  "cc-csc",
  "cc-exp",
  "cc-exp-month",
  "cc-exp-year",
  "one-time-code",
] as const;

// ponytail: fixed safe surface, not OCR. Named form controls plus
// canvas/video/iframe which can paint arbitrary pixels. Free HTML text stays.
export const SENSITIVE_INPUT_SELECTOR = [
  'input[type="password"]',
  ...SENSITIVE_AUTOCOMPLETE.flatMap((value) => [
    `input[autocomplete="${value}" i]`,
    `textarea[autocomplete="${value}" i]`,
  ]),
  ...SENSITIVE_QUERY_KEYS.flatMap((key) => [`input[name="${key}" i]`, `textarea[name="${key}" i]`]),
].join(", ");
export const UNSAFE_PIXEL_SELECTOR = "canvas, video, iframe";
export const MASKED_INPUT_VALUE = "••••••••";

export type CookieButton = {
  name: string;
  inCookieDialog: boolean;
};

export function isCookieDialogText(text: string): boolean {
  return new RegExp(COOKIE_HAS_RE, "i").test(text) && new RegExp(COOKIE_NEED_RE, "i").test(text);
}

export function isCookieAcceptName(name: string): boolean {
  return new RegExp(COOKIE_ACCEPT_RE, "i").test(name.trim());
}

export function pickCookieAcceptButton(buttons: readonly CookieButton[]): number | undefined {
  let okFallback: number | undefined;
  for (const [index, button] of buttons.entries()) {
    if (!button.inCookieDialog) continue;
    if (isCookieAcceptName(button.name)) return index;
    if (okFallback === undefined && new RegExp(COOKIE_BARE_OK_RE, "i").test(button.name.trim())) {
      okFallback = index;
    }
  }
  return okFallback;
}

export function workspaceFilePath(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "file:") return undefined;
  if (url.username !== "" || url.password !== "") return undefined;
  if (url.hostname !== "" && url.hostname !== "localhost") return undefined;
  const path = decodeURIComponent(url.pathname);
  if (!path.startsWith("/")) return undefined;
  const normalized = posix.normalize(path);
  if (!(ALLOWED_WORKSPACE_FILES as readonly string[]).includes(normalized)) return undefined;
  return normalized;
}

export function canonicalHttpsHref(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error("Blocked destination");
  return `${url.origin}${url.pathname}${url.search}`;
}

export function isSensitiveFormControl(input: {
  type?: string;
  autocomplete?: string;
  name?: string;
}): boolean {
  const type = (input.type ?? "").trim().toLowerCase();
  if (type === "password") return true;
  const autocomplete = (input.autocomplete ?? "").trim().toLowerCase();
  if ((SENSITIVE_AUTOCOMPLETE as readonly string[]).includes(autocomplete)) return true;
  return isSensitiveQueryKey(input.name ?? "");
}

export function redactSensitiveUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol === "file:") {
    const path = workspaceFilePath(raw);
    return path === undefined ? undefined : `file://${path}`;
  }
  if (url.protocol !== "https:") return undefined;
  url.username = "";
  url.password = "";
  if (url.port !== "" && url.port !== "443") return undefined;
  redactSensitiveQueryParts(url);
  return `${url.origin}${url.pathname}${url.search}${url.hash}`;
}

export function sanitizeBrowserUrl(raw: string): string | undefined {
  const href = redactSensitiveUrl(raw);
  if (href === undefined) return undefined;
  return [...href].length > MAX_BROWSER_URL_CHARS ? href.slice(0, MAX_BROWSER_URL_CHARS) : href;
}

export function assertPublicUrlProjection(raw: string): string {
  const preview = redactSensitiveUrl(raw);
  if (preview === undefined) throw new Error("Blocked destination");
  let original: URL;
  let shown: URL;
  try {
    original = new URL(raw);
    shown = new URL(preview);
  } catch {
    throw new Error("Blocked destination");
  }
  for (const [key, value] of original.searchParams) {
    if (!isSensitiveQueryKey(key) || value === "") continue;
    if (shown.searchParams.get(key) === value) throw new Error("Blocked destination");
  }
  if (original.hash !== "") {
    try {
      const originalHash = new URLSearchParams(original.hash.slice(1));
      const shownHash = new URLSearchParams(shown.hash.slice(1));
      for (const [key, value] of originalHash) {
        if (!isSensitiveQueryKey(key) || value === "") continue;
        if (shownHash.get(key) === value) throw new Error("Blocked destination");
      }
    } catch (error) {
      if (error instanceof Error && error.message === "Blocked destination") throw error;
    }
  }
  return preview;
}
