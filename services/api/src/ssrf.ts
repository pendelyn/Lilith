import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest, Agent as HttpsAgent, type RequestOptions } from "node:https";
import type { IncomingMessage } from "node:http";
import { BlockList, isIP } from "node:net";

export const PUBLIC_HTTPS_TIMEOUT_MS = 10_000;
export const PUBLIC_HTTPS_MAX_BYTES = 256 * 1024;
export const AZURE_WIRE_SERVER_V4 = "168.63.129.16";

export type DnsAddress = { address: string; family: 4 | 6 };

export type LookupAll = (hostname: string) => Promise<DnsAddress[]>;

export type HttpsRequestFn = (
  options: RequestOptions,
  callback: (res: IncomingMessage) => void,
) => ReturnType<typeof httpsRequest>;

export type PublicHttpsGetInput = {
  url: URL;
  hostname: string;
  addresses: readonly string[];
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
};

export type PublicHttpsGetResult = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

export type PublicHttpsGet = (input: PublicHttpsGetInput) => Promise<PublicHttpsGetResult>;

const ALLOWED_MEDIA_TYPES = new Set([
  "text/plain",
  "text/html",
  "text/markdown",
  "text/csv",
  "text/xml",
  "application/json",
  "application/xhtml+xml",
]);

const BLOCKED_HOSTS = new Set(["localhost", "metadata", "metadata.google.internal"]);
const MAPPED_PREFIX = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff];
const TRANSLATED_PREFIX = [0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0, 0];
const COMPATIBLE_PREFIX = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const NAT64_PREFIX = [0, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0];

const v4 = new BlockList();
const v6Blocked = new BlockList();
const v6GlobalUnicast = new BlockList();

function addV4(address: string, prefix: number): void {
  v4.addSubnet(address, prefix, "ipv4");
  v6Blocked.addSubnet(`::ffff:${address}`, 96 + prefix, "ipv6");
}

addV4("0.0.0.0", 8);
addV4("10.0.0.0", 8);
addV4("100.64.0.0", 10);
addV4("127.0.0.0", 8);
addV4("169.254.0.0", 16);
addV4("172.16.0.0", 12);
addV4("192.0.0.0", 24);
addV4("192.0.2.0", 24);
addV4("192.88.99.0", 24);
addV4("192.168.0.0", 16);
addV4("198.18.0.0", 15);
addV4("198.51.100.0", 24);
addV4("203.0.113.0", 24);
addV4("224.0.0.0", 4);
addV4("240.0.0.0", 4);
v4.addAddress(AZURE_WIRE_SERVER_V4, "ipv4");
v6Blocked.addAddress(`::ffff:${AZURE_WIRE_SERVER_V4}`, "ipv6");

// IPv6 global unicast is 2000::/3. Everything else is non-global (loopback, mapped,
// compatible, ULA, link-local, multicast, 5f00::/16 SIDs, discard, …).
v6GlobalUnicast.addSubnet("2000::", 3, "ipv6");

v6Blocked.addAddress("::", "ipv6");
v6Blocked.addAddress("::1", "ipv6");
v6Blocked.addSubnet("::", 96, "ipv6");
v6Blocked.addSubnet("64:ff9b::", 96, "ipv6");
v6Blocked.addSubnet("64:ff9b:1::", 48, "ipv6");
v6Blocked.addSubnet("100::", 64, "ipv6");
v6Blocked.addSubnet("2001::", 23, "ipv6");
v6Blocked.addSubnet("2001:db8::", 32, "ipv6");
v6Blocked.addSubnet("2002::", 16, "ipv6");
// IANA-reserved remainder of 2000::/3 (unicast assignment registry), including
// returned 6bone 3ffe::/16 and documentation 3fff::/20.
v6Blocked.addSubnet("2d00::", 8, "ipv6");
v6Blocked.addSubnet("2e00::", 7, "ipv6");
v6Blocked.addSubnet("3000::", 4, "ipv6");
v6Blocked.addSubnet("5f00::", 16, "ipv6");
v6Blocked.addSubnet("fc00::", 7, "ipv6");
v6Blocked.addSubnet("fe80::", 10, "ipv6");
v6Blocked.addSubnet("ff00::", 8, "ipv6");

export function stripIpBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

export function canonicalizeHostname(hostname: string): string {
  let host = stripIpBrackets(hostname).trim().toLowerCase();
  while (host.endsWith(".")) host = host.slice(0, -1).trimEnd();
  return host;
}

export function urlHostname(url: URL): string {
  return canonicalizeHostname(url.hostname);
}

export function isBlockedHostname(hostname: string): boolean {
  const host = canonicalizeHostname(hostname);
  if (host === "" || BLOCKED_HOSTS.has(host) || host.endsWith(".localhost")) return true;
  return false;
}

export function isPublicUnicastAddress(address: string): boolean {
  const host = canonicalizeHostname(address);
  const family = isIP(host);
  if (family === 4) return !v4.check(host, "ipv4");
  if (family !== 6) return false;
  const embedded = embeddedIpv4(host);
  if (embedded !== undefined && !isPublicUnicastAddress(embedded)) return false;
  if (v6Blocked.check(host, "ipv6")) return false;
  if (embedded !== undefined) return isIpv4MappedAddress(host);
  return v6GlobalUnicast.check(host, "ipv6");
}

export function parsePublicHttpsUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Blocked destination");
  }
  if (url.protocol !== "https:") throw new Error("Blocked destination");
  if (url.username !== "" || url.password !== "") throw new Error("Blocked destination");
  if (url.port !== "" && url.port !== "443") throw new Error("Blocked destination");
  const hostname = urlHostname(url);
  if (hostname === "") throw new Error("Blocked destination");
  if (isBlockedHostname(hostname)) throw new Error("Blocked destination");
  if (isIP(hostname) !== 0 && !isPublicUnicastAddress(hostname)) {
    throw new Error("Blocked destination");
  }
  return url;
}

export async function defaultLookupAll(hostname: string): Promise<DnsAddress[]> {
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map((record) => ({
    address: record.address,
    family: record.family === 6 ? 6 : 4,
  }));
}

export async function resolvePublicHttps(
  raw: string,
  lookupAll: LookupAll = defaultLookupAll,
  signal?: AbortSignal,
): Promise<{ url: URL; hostname: string; addresses: string[] }> {
  if (signal?.aborted) throw new Error("Web research cancelled");
  const url = parsePublicHttpsUrl(raw);
  const hostname = urlHostname(url);
  const unique: string[] = [];
  const seen = new Set<string>();
  const push = (value: string): void => {
    const address = canonicalizeHostname(value);
    if (isIP(address) === 0) throw new Error("Blocked destination");
    const key = ipCompareKey(address);
    if (seen.has(key)) return;
    seen.add(key);
    unique.push(address);
  };
  if (isIP(hostname) !== 0) {
    push(hostname);
  } else {
    const records = await raceWithDeadline(Promise.resolve(lookupAll(hostname)), signal);
    if (signal?.aborted) throw new Error("Web research cancelled");
    for (const record of records) push(record.address);
  }
  if (signal?.aborted) throw new Error("Web research cancelled");
  if (unique.length === 0) throw new Error("Blocked destination");
  const blocked = unique.filter((address) => !isPublicUnicastAddress(address));
  if (blocked.length > 0) {
    throw new Error(blocked.length < unique.length ? "Mixed DNS answers are blocked" : "Blocked destination");
  }
  return { url, hostname, addresses: unique };
}

async function raceWithDeadline<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) {
    void work.then(undefined, () => undefined);
    throw new Error("Web research cancelled");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (ok: () => void) => {
        if (settled) return;
        settled = true;
        ok();
      };
      const fail = (error: Error) => finish(() => reject(error));
      timer = setTimeout(() => fail(new Error("Web research timed out")), PUBLIC_HTTPS_TIMEOUT_MS);
      onAbort = () => fail(new Error("Web research cancelled"));
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      work.then(
        (value) => finish(() => resolve(value)),
        (error) => fail(error instanceof Error ? error : new Error("Fetch failed")),
      );
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
    void work.then(undefined, () => undefined);
  }
}

export function ipCompareKey(address: string): string {
  const host = canonicalizeHostname(address);
  return embeddedIpv4(host) ?? host;
}

export function addressInPinSet(remote: string, addresses: readonly string[]): boolean {
  const key = ipCompareKey(remote);
  return addresses.some((address) => ipCompareKey(address) === key);
}

export function assertAllowedContentType(value: string | undefined): void {
  if (value === undefined || value.trim() === "") throw new Error("Blocked content type");
  const parts = value.split(";").map((part) => part.trim().toLowerCase());
  const media = parts[0];
  if (media === undefined || !ALLOWED_MEDIA_TYPES.has(media)) throw new Error("Blocked content type");
  for (const part of parts.slice(1)) {
    if (!part.startsWith("charset=")) continue;
    const charset = part.slice("charset=".length).replaceAll('"', "");
    if (charset !== "utf-8" && charset !== "us-ascii") throw new Error("Blocked content type");
  }
}

export async function pinnedHttpsGet(
  input: PublicHttpsGetInput,
  requestImpl: HttpsRequestFn = httpsRequest,
): Promise<PublicHttpsGetResult> {
  if (input.signal?.aborted) throw new Error("Web research cancelled");
  const pinned = input.addresses[0];
  if (pinned === undefined || isIP(pinned) === 0 || !isPublicUnicastAddress(pinned)) {
    throw new Error("Blocked destination");
  }
  const family = isIP(pinned) as 4 | 6;
  const agent = new HttpsAgent({
    keepAlive: false,
    lookup(hostname, options, callback) {
      if (options.all === true) {
        callback(null, [{ address: pinned, family }]);
        return;
      }
      callback(null, pinned, family);
    },
  });
  const servername = isIP(input.hostname) === 0 ? input.hostname : undefined;
  const headers: Record<string, string> = {
    Host: input.url.host,
    Accept: "text/plain, text/html, text/markdown, text/csv, text/xml, application/json, application/xhtml+xml",
    "Accept-Encoding": "identity",
    Connection: "close",
    "User-Agent": "Lilith-public-web-research/0.1",
    ...input.headers,
  };
  if (input.body !== undefined) {
    headers["Content-Type"] = "text/plain; charset=utf-8";
    headers["Content-Length"] = String(Buffer.byteLength(input.body));
  }

  return await new Promise((resolve, reject) => {
    let settled = false;
    let sent = false;
    const chunks: Buffer[] = [];
    let received = 0;
    let req: ReturnType<typeof httpsRequest>;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      input.signal?.removeEventListener("abort", onAbort);
      req.destroy();
      agent.destroy();
      reject(error);
    };
    const onAbort = () => fail(new Error("Web research cancelled"));
    const sendIfPinned = (remote: string | undefined) => {
      if (settled || sent) return;
      if (remote === undefined || !isPublicUnicastAddress(remote) || !addressInPinSet(remote, input.addresses)) {
        fail(new Error("Pinned address mismatch"));
        return;
      }
      sent = true;
      if (input.body !== undefined) req.write(input.body);
      req.end();
    };
    req = requestImpl(
      {
        agent,
        hostname: input.hostname,
        port: 443,
        path: `${input.url.pathname}${input.url.search}`,
        method: input.method,
        servername,
        rejectUnauthorized: true,
        timeout: PUBLIC_HTTPS_TIMEOUT_MS,
        headers,
      },
      (res) => {
        const remote = res.socket?.remoteAddress;
        if (remote === undefined || !isPublicUnicastAddress(remote) || !addressInPinSet(remote, input.addresses)) {
          fail(new Error("Pinned address mismatch"));
          return;
        }
        const encoding = header(res.headers["content-encoding"]);
        if (encoding !== undefined && encoding !== "identity") {
          fail(new Error("Blocked content type"));
          return;
        }
        try {
          assertAllowedContentType(header(res.headers["content-type"]));
        } catch (error) {
          fail(error instanceof Error ? error : new Error("Blocked content type"));
          return;
        }
        const declared = Number(res.headers["content-length"]);
        if (Number.isFinite(declared) && declared > PUBLIC_HTTPS_MAX_BYTES) {
          fail(new Error("Response too large"));
          return;
        }
        res.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > PUBLIC_HTTPS_MAX_BYTES) {
            fail(new Error("Response too large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (settled) return;
          settled = true;
          input.signal?.removeEventListener("abort", onAbort);
          agent.destroy();
          const headers: Record<string, string> = {};
          for (const [name, value] of Object.entries(res.headers)) {
            if (typeof value === "string") headers[name.toLowerCase()] = value;
            else if (Array.isArray(value) && value[0] !== undefined) headers[name.toLowerCase()] = value.join(", ");
          }
          resolve({
            status: res.statusCode ?? 0,
            headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        res.on("error", (error) => fail(error instanceof Error ? error : new Error("Fetch failed")));
      },
    );
    input.signal?.addEventListener("abort", onAbort, { once: true });
    req.on("socket", (socket) => {
      const trySend = () => sendIfPinned(socket.remoteAddress);
      if (socket.connecting) socket.once("connect", trySend);
      else trySend();
      socket.once("secureConnect", trySend);
    });
    req.on("timeout", () => fail(new Error("Web research timed out")));
    req.on("error", (error) => fail(error instanceof Error ? error : new Error("Fetch failed")));
    if (input.signal?.aborted) fail(new Error("Web research cancelled"));
  });
}

function header(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}

function isIpv4MappedAddress(address: string): boolean {
  const bytes = ipv6Bytes(address);
  return bytes !== undefined && isPrefix(bytes, MAPPED_PREFIX);
}

function embeddedIpv4(address: string): string | undefined {
  const bytes = ipv6Bytes(address);
  if (bytes === undefined) return undefined;
  if (isPrefix(bytes, MAPPED_PREFIX) || isPrefix(bytes, TRANSLATED_PREFIX) || isPrefix(bytes, COMPATIBLE_PREFIX)) {
    return v4From(bytes, 12);
  }
  if (isPrefix(bytes, NAT64_PREFIX)) return v4From(bytes, 12);
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return v4From(bytes, 2);
  return undefined;
}

function v4From(bytes: number[], offset: number): string {
  return `${bytes[offset]}.${bytes[offset + 1]}.${bytes[offset + 2]}.${bytes[offset + 3]}`;
}

function isPrefix(bytes: number[], prefix: number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function ipv6Bytes(address: string): number[] | undefined {
  const host = canonicalizeHostname(address);
  if (isIP(host) !== 6) return undefined;
  const dotted = host.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  const raw = dotted === null ? host : dotted[1] + v4ToHex(dotted[2]!);
  const halves = raw.split("::");
  if (halves.length > 2) return undefined;
  const decode = (part: string): number[] => {
    if (part === "") return [];
    return part.split(":").map((word) => Number.parseInt(word, 16));
  };
  const head = decode(halves[0] ?? "");
  const tail = halves.length === 2 ? decode(halves[1] ?? "") : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return undefined;
  const words = halves.length === 2 ? [...head, ...Array<number>(missing).fill(0), ...tail] : head;
  if (words.length !== 8 || words.some((word) => !Number.isInteger(word) || word < 0 || word > 0xffff)) {
    return undefined;
  }
  const bytes: number[] = [];
  for (const word of words) {
    bytes.push((word >> 8) & 255, word & 255);
  }
  return bytes;
}

function v4ToHex(value: string): string {
  const parts = value.split(".").map((part) => Number(part));
  const hi = ((parts[0]! << 8) | parts[1]!).toString(16);
  const lo = ((parts[2]! << 8) | parts[3]!).toString(16);
  return `${hi}:${lo}`;
}
