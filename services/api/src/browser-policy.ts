import { createHash } from "node:crypto";
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
export const FORM_FIXTURE_FILE = "form.html";
export const FORM_NOTE_ID = "note";
export const COOKIE_FIXTURE_WORKSPACE_PATH = `${WORKSPACE_ROOT}/${COOKIE_FIXTURE_FILE}`;
export const SENSITIVE_FIXTURE_WORKSPACE_PATH = `${WORKSPACE_ROOT}/${SENSITIVE_FIXTURE_FILE}`;
export const FORM_FIXTURE_WORKSPACE_PATH = `${WORKSPACE_ROOT}/${FORM_FIXTURE_FILE}`;
export const ALLOWED_WORKSPACE_FILES = [
  COOKIE_FIXTURE_WORKSPACE_PATH,
  SENSITIVE_FIXTURE_WORKSPACE_PATH,
  FORM_FIXTURE_WORKSPACE_PATH,
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

export const BROWSER_EFFECTS = ["submit", "upload", "message", "purchase", "ambiguous"] as const;
export type BrowserEffect = (typeof BROWSER_EFFECTS)[number];
export type FormEffect = "text" | BrowserEffect;

const PURCHASE_RE = /\b(?:buy|purchase|checkout|kaufen|bezahlen|bestellen)\b/i;
const MESSAGE_RE = /\b(?:message|nachricht|reply|comment|kommentar)\b/i;
const TEXT_INPUT_TYPES = new Set(["", "text", "search", "email", "tel", "url", "number"]);

export type RawFormNode = {
  id: string;
  tag: string;
  type: string;
  name: string;
  label: string;
  value: string;
  action: string;
};

export type FormControlSnapshot = {
  id: string;
  effect: FormEffect;
  name: string;
  label: string;
  value: string;
  action: string;
};

export function classifyFormNode(node: RawFormNode): FormControlSnapshot | undefined {
  const tag = node.tag.trim().toLowerCase();
  const type = node.type.trim().toLowerCase();
  const id = node.id.trim();
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) return undefined;
  const effect = formEffect(tag, type, node.label);
  if (effect === undefined) return undefined;
  return {
    id,
    effect,
    name: node.name.trim(),
    label: node.label.trim(),
    value: effect === "text" ? node.value : "",
    action: node.action.trim(),
  };
}

export function formControlsFromNodes(nodes: readonly RawFormNode[]): FormControlSnapshot[] {
  const controls: FormControlSnapshot[] = [];
  for (const node of nodes) {
    const classified = classifyFormNode(node);
    if (classified !== undefined) controls.push(classified);
  }
  controls.sort((left, right) => left.id.localeCompare(right.id));
  return controls;
}

export function canonicalFormControls(controls: readonly FormControlSnapshot[]): string {
  return JSON.stringify(
    controls.map((control) => ({
      action: control.action,
      effect: control.effect,
      id: control.id,
      label: control.label,
      name: control.name,
      value: control.value,
    })),
  );
}

export function formDomDigest(controls: readonly FormControlSnapshot[]): string {
  return createHash("sha256").update(canonicalFormControls(controls)).digest("hex");
}

export function parseFormNodes(html: string): RawFormNode[] {
  const nodes: RawFormNode[] = [];
  const re = /<(input|button|textarea)\b([^>]*)>(?:([^<]*)<\/\1>)?/gi;
  for (const match of html.matchAll(re)) {
    const tag = match[1]?.toLowerCase() ?? "";
    const attrs = match[2] ?? "";
    const inner = (match[3] ?? "").trim();
    nodes.push({
      id: attr(attrs, "id"),
      tag,
      type: attr(attrs, "type").toLowerCase(),
      name: attr(attrs, "name"),
      label: attr(attrs, "aria-label") || inner,
      value: attr(attrs, "value"),
      action: attr(attrs, "data-action"),
    });
  }
  return nodes;
}

function formEffect(tag: string, type: string, label: string): FormEffect | undefined {
  if (tag === "input" && type === "file") return "upload";
  if ((tag === "button" && (type === "" || type === "submit")) || (tag === "input" && type === "submit")) {
    return "submit";
  }
  if (PURCHASE_RE.test(label)) return "purchase";
  if (MESSAGE_RE.test(label)) return "message";
  if (tag === "textarea" || (tag === "input" && TEXT_INPUT_TYPES.has(type))) return "text";
  if (tag === "button" || type === "button") return "ambiguous";
  return undefined;
}

function attr(source: string, name: string): string {
  const match = new RegExp(`\\b${name}="([^"]*)"`, "i").exec(source);
  return match?.[1] ?? "";
}
