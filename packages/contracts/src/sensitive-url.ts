export const SENSITIVE_QUERY_KEYS = [
  "password",
  "passwd",
  "pwd",
  "secret",
  "token",
  "access_token",
  "id_token",
  "refresh_token",
  "api_key",
  "apikey",
  "authorization",
  "client_secret",
] as const;

const URL_IN_TEXT = /https?:\/\/[^\s<>"']+/gi;

export function isSensitiveQueryKey(key: string): boolean {
  const normalized = key.trim().toLowerCase();
  return (SENSITIVE_QUERY_KEYS as readonly string[]).includes(normalized);
}

export function redactSensitiveQueryParts(url: URL): void {
  for (const key of [...url.searchParams.keys()]) {
    if (isSensitiveQueryKey(key)) url.searchParams.set(key, "[redacted]");
  }
  if (url.hash === "") return;
  try {
    const params = new URLSearchParams(url.hash.slice(1));
    let changed = false;
    for (const key of [...params.keys()]) {
      if (isSensitiveQueryKey(key)) {
        params.set(key, "[redacted]");
        changed = true;
      }
    }
    if (changed) url.hash = params.toString();
  } catch {
    url.hash = "";
  }
}

export function redactSensitiveUrlsInText(text: string): string {
  return text.replace(URL_IN_TEXT, (raw) => {
    const trimmed = raw.replace(/[.,;:!?)>\]]+$/g, "");
    const suffix = raw.slice(trimmed.length);
    return `${redactOneUrl(trimmed)}${suffix}`;
  });
}

function redactOneUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  const hadUserInfo = url.username !== "" || url.password !== "";
  url.username = "";
  url.password = "";
  const before = `${url.search}${url.hash}`;
  redactSensitiveQueryParts(url);
  if (!hadUserInfo && `${url.search}${url.hash}` === before) return raw;
  return `${url.origin}${url.pathname}${url.search}${url.hash}`;
}
