import { posix } from "node:path";

export const WORKSPACE_ROOT = "/workspace";
export const COOKIE_FIXTURE_FILE = "cookie.html";
export const COOKIE_FIXTURE_WORKSPACE_PATH = `${WORKSPACE_ROOT}/${COOKIE_FIXTURE_FILE}`;
export const ALLOWED_WORKSPACE_FILES = [COOKIE_FIXTURE_WORKSPACE_PATH] as const;
export const COOKIE_DIALOG_LOCATOR =
  '[role="dialog"], [role="alertdialog"], [id*="cookie" i], [class*="cookie" i]';
export const COOKIE_HAS_RE = "cookie|cookies|datenschutz";
export const COOKIE_NEED_RE =
  "consent|agree|accept|allow|zustimm|akzeptier|einwilligung|privacy|tracking|gdpr";
export const COOKIE_ACCEPT_RE =
  "^(?:accept|agree|zustimmen|akzeptieren|einverstanden)\\b|\\b(?:accept|agree|allow|zustimmen|akzeptieren|einverstanden)\\b.*\\b(?:cookie|cookies|consent|all|alle)\\b|\\b(?:cookie|cookies|consent|all|alle)\\b.*\\b(?:accept|agree|allow|zustimmen|akzeptieren|einverstanden)\\b";
export const COOKIE_BARE_OK_RE = "^(?:ok|okay)$";

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
