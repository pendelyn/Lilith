import { SCREENSHOT_TTL_MS } from "@lilith/contracts";

export type ShotCacheEntry = {
  uri: string;
  expiresAt: number;
};

export function screenshotExpired(createdAt: number, now: number): boolean {
  return now - createdAt >= SCREENSHOT_TTL_MS;
}

export function shouldFetchScreenshot(
  step: { screenshotId?: string; at: number },
  now: number,
): boolean {
  return step.screenshotId !== undefined && !screenshotExpired(step.at, now);
}

export function shotStillVisible(
  entry: ShotCacheEntry | undefined,
  createdAt: number,
  now: number,
): boolean {
  return entry !== undefined && !screenshotExpired(createdAt, now) && entry.expiresAt > now;
}

export function pruneShotCache(
  cache: Record<string, ShotCacheEntry>,
  now: number,
): Record<string, ShotCacheEntry> {
  const next: Record<string, ShotCacheEntry> = {};
  for (const [id, entry] of Object.entries(cache)) {
    if (entry.expiresAt > now) next[id] = entry;
  }
  return next;
}

export function nextScreenshotExpiryDelayMs(
  steps: readonly { screenshotId?: string; at: number }[],
  cache: Record<string, ShotCacheEntry>,
  now: number,
): number | undefined {
  let nearest = Number.POSITIVE_INFINITY;
  for (const step of steps) {
    if (step.screenshotId === undefined || screenshotExpired(step.at, now)) continue;
    const expiresAt = step.at + SCREENSHOT_TTL_MS;
    if (expiresAt < nearest) nearest = expiresAt;
  }
  for (const entry of Object.values(cache)) {
    if (entry.expiresAt > now && entry.expiresAt < nearest) nearest = entry.expiresAt;
  }
  if (!Number.isFinite(nearest) || nearest <= now) return undefined;
  return nearest - now;
}

export function rememberShot(
  cache: Record<string, ShotCacheEntry>,
  id: string,
  uri: string,
  createdAt: number,
  now: number,
): Record<string, ShotCacheEntry> {
  if (screenshotExpired(createdAt, now) || uri.startsWith("http:") || uri.includes("token=")) {
    return pruneShotCache(cache, now);
  }
  return { ...pruneShotCache(cache, now), [id]: { uri, expiresAt: createdAt + SCREENSHOT_TTL_MS } };
}

export function jpegBytesToDataUri(bytes: Uint8Array): string {
  if (bytes.byteLength < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error("Invalid screenshot");
  }
  return `data:image/jpeg;base64,${bytesToBase64(bytes)}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    const triple = (a << 16) | (b << 8) | c;
    out += alphabet[(triple >> 18) & 63];
    out += alphabet[(triple >> 12) & 63];
    out += i + 1 < bytes.length ? alphabet[(triple >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? alphabet[triple & 63] : "=";
  }
  return out;
}

export function persistedChatHasScreenshotBytes(raw: string): boolean {
  return raw.includes("data:image/");
}
