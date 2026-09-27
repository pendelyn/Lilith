export const MAX_ENVELOPE_BYTES = 16 * 1024;
export type RelayLane = "to-runner" | "to-api";

export type MailboxData = {
  capabilityHash: string;
  expiresAt: number;
  toRunner: string | null;
  toApi: string | null;
};

export type RelayMailbox = {
  create(expiresAt: number): Promise<{ id: string; capability: string }>;
  put(id: string, capability: string, lane: RelayLane, body: string): Promise<void>;
  read(id: string, capability: string, lane: RelayLane): Promise<string | null>;
  ack(id: string, capability: string, lane: RelayLane): Promise<void>;
  remove(id: string, capability: string): Promise<void>;
};

export type MailboxStorage = {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  setAlarm?(scheduledTime: number): Promise<void>;
  getAlarm?(): Promise<number | null>;
  deleteAlarm?(): Promise<void>;
};

export type HomeMailboxState = { storage: MailboxStorage };

const MAILBOX_KEY = "mailbox";
const ALARM_KEY = "alarm";

export function createMemoryRelay(adminToken: string, now: () => number = Date.now): RelayMailbox & {
  fetch(request: Request): Promise<Response>;
} {
  if (adminToken.trim() === "") throw new Error("Relay admin token is required");
  const rooms = new Map<string, MailboxData>();
  return {
    fetch(request: Request) {
      return memoryRelayFetch(rooms, adminToken, request, now);
    },
    create(expiresAt: number) {
      return createMailbox(rooms, expiresAt, now);
    },
    async put(id, capability, lane, body) {
      const room = await authedRoom(rooms, id, capability, now);
      writeLane(room, lane, body);
    },
    async read(id, capability, lane) {
      const room = await authedRoom(rooms, id, capability, now);
      return lane === "to-runner" ? room.toRunner : room.toApi;
    },
    async ack(id, capability, lane) {
      const room = await authedRoom(rooms, id, capability, now);
      if (lane === "to-runner") room.toRunner = null;
      else room.toApi = null;
    },
    async remove(id, capability) {
      if (!rooms.has(id)) return;
      await authedRoom(rooms, id, capability, now, true);
      rooms.delete(id);
    },
  };
}

export async function memoryRelayFetch(
  rooms: Map<string, MailboxData>,
  adminToken: string,
  request: Request,
  now: () => number,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/mailboxes" && request.method === "POST") {
    if (!(await tokenMatches(request.headers.get("authorization"), adminToken))) {
      return new Response(null, { status: 401 });
    }
    const body = (await request.json()) as { expiresAt?: unknown };
    if (typeof body.expiresAt !== "number") return new Response(null, { status: 400 });
    const created = await createMailbox(rooms, body.expiresAt, now);
    return Response.json(created);
  }

  const match = /^\/mailboxes\/([^/]+)(?:\/(to-runner|to-api))?$/.exec(url.pathname);
  if (!match?.[1]) return new Response(null, { status: 404 });
  const lane = match[2] as RelayLane | undefined;
  const capability = bearerValue(request.headers.get("authorization"));
  if (request.method === "DELETE" && lane === undefined) {
    if (!rooms.has(match[1])) return new Response(null, { status: 204 });
    try {
      await authedRoom(rooms, match[1], capability, now, true);
    } catch {
      return new Response(null, { status: 401 });
    }
    rooms.delete(match[1]);
    return new Response(null, { status: 204 });
  }
  let room: MailboxData;
  try {
    room = await authedRoom(rooms, match[1], capability, now);
  } catch {
    return new Response(null, { status: 401 });
  }
  if (lane !== "to-runner" && lane !== "to-api") return new Response(null, { status: 404 });
  if (request.method === "PUT") {
    try {
      writeLane(room, lane, await request.text());
    } catch (error) {
      const status = error instanceof Error && error.message === "Relay lane busy" ? 409 : 400;
      return new Response(null, { status });
    }
    return new Response(null, { status: 204 });
  }
  if (request.method === "GET") {
    const value = lane === "to-runner" ? room.toRunner : room.toApi;
    return value === null ? new Response(null, { status: 204 }) : new Response(value, { status: 200 });
  }
  if (request.method === "DELETE") {
    if (lane === "to-runner") room.toRunner = null;
    else room.toApi = null;
    return new Response(null, { status: 204 });
  }
  return new Response(null, { status: 405 });
}

export function relayMailboxFromFetch(
  relayUrl: string,
  adminToken: string | null,
  fetchImpl: typeof fetch = fetch,
): RelayMailbox {
  if (!relayUrl.startsWith("https://")) throw new Error("Relay client requires an https URL");
  const base = relayUrl.replace(/\/$/, "");
  return {
    async create(expiresAt: number) {
      if (adminToken === null || adminToken.trim() === "") throw new Error("Relay admin token is required");
      const response = await fetchImpl(`${base}/mailboxes`, {
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ expiresAt }),
      });
      if (!response.ok) throw new Error("Relay mailbox create failed");
      const body = (await response.json()) as { id?: unknown; capability?: unknown };
      if (typeof body.id !== "string" || typeof body.capability !== "string") {
        throw new Error("Relay mailbox create failed");
      }
      return { id: body.id, capability: body.capability };
    },
    async put(id, capability, lane, body) {
      const response = await fetchImpl(`${base}/mailboxes/${id}/${lane}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${capability}` },
        body,
      });
      if (response.status === 409) throw new Error("Relay lane busy");
      if (!response.ok) throw new Error("Relay write failed");
    },
    async read(id, capability, lane) {
      const response = await fetchImpl(`${base}/mailboxes/${id}/${lane}`, {
        headers: { Authorization: `Bearer ${capability}` },
      });
      if (response.status === 204) return null;
      if (!response.ok) throw new Error("Relay read failed");
      return response.text();
    },
    async ack(id, capability, lane) {
      const response = await fetchImpl(`${base}/mailboxes/${id}/${lane}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${capability}` },
      });
      if (!response.ok && response.status !== 404) throw new Error("Relay ack failed");
    },
    async remove(id, capability) {
      const response = await fetchImpl(`${base}/mailboxes/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${capability}` },
      });
      if (!response.ok && response.status !== 404) throw new Error("Relay delete failed");
    },
  };
}

export function createMemoryMailboxStorage(): MailboxStorage {
  const values = new Map<string, unknown>();
  return {
    async get(key) {
      return values.get(key);
    },
    async put(key, value) {
      values.set(key, value);
    },
    async delete(key) {
      return values.delete(key);
    },
    async setAlarm(scheduledTime) {
      values.set(ALARM_KEY, scheduledTime);
    },
    async getAlarm() {
      const value = values.get(ALARM_KEY);
      return typeof value === "number" ? value : null;
    },
    async deleteAlarm() {
      values.delete(ALARM_KEY);
    },
  };
}

export class HomeMailbox {
  ctx: HomeMailboxState;
  #data: MailboxData | null = null;
  #loaded = false;
  #adminToken: string;

  constructor(ctx: HomeMailboxState, env: { RELAY_ADMIN_TOKEN?: string }) {
    this.ctx = ctx;
    this.#adminToken = env.RELAY_ADMIN_TOKEN?.trim() ?? "";
  }

  async fetch(request: Request, now: () => number = Date.now): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/internal/init") {
      if (!(await tokenMatches(request.headers.get("authorization"), this.#adminToken))) {
        return new Response(null, { status: 401 });
      }
      if (await this.#load()) return new Response(null, { status: 409 });
      const body = (await request.json()) as { capabilityHash?: unknown; expiresAt?: unknown };
      if (typeof body.capabilityHash !== "string" || typeof body.expiresAt !== "number" || body.expiresAt <= now()) {
        return new Response(null, { status: 400 });
      }
      await this.#store({
        capabilityHash: body.capabilityHash,
        expiresAt: body.expiresAt,
        toRunner: null,
        toApi: null,
      });
      return new Response(null, { status: 204 });
    }
    const data = await this.#load();
    const mailboxDelete = request.method === "DELETE" && url.pathname === "/internal";
    if (!data) return new Response(null, { status: mailboxDelete ? 204 : 401 });
    if (data.expiresAt <= now() && !mailboxDelete) return new Response(null, { status: 401 });
    const rooms = new Map([["self", data]]);
    const forwarded = new Request(new URL(url.pathname.replace(/^\/internal/, "/mailboxes/self"), request.url), request);
    const response = await memoryRelayFetch(rooms, "unused-admin", forwarded, now);
    const next = rooms.get("self") ?? null;
    await this.#store(next);
    return response;
  }

  async alarm(now: () => number = Date.now): Promise<void> {
    const data = await this.#load();
    if (!data || data.expiresAt <= now()) {
      await this.#store(null);
      return;
    }
    await this.ctx.storage.setAlarm?.(data.expiresAt);
  }

  async #load(): Promise<MailboxData | null> {
    if (!this.#loaded) {
      this.#data = parseStoredMailbox(await this.ctx.storage.get(MAILBOX_KEY));
      this.#loaded = true;
    }
    return this.#data;
  }

  async #store(data: MailboxData | null): Promise<void> {
    this.#data = data;
    this.#loaded = true;
    if (data === null) {
      await this.ctx.storage.delete(MAILBOX_KEY);
      await this.ctx.storage.deleteAlarm?.();
      return;
    }
    await this.ctx.storage.put(MAILBOX_KEY, data);
    await this.ctx.storage.setAlarm?.(data.expiresAt);
  }
}

async function createMailbox(
  rooms: Map<string, MailboxData>,
  expiresAt: number,
  now: () => number,
): Promise<{ id: string; capability: string }> {
  if (!Number.isFinite(expiresAt) || expiresAt <= now()) throw new Error("Relay mailbox expiry is invalid");
  const id = crypto.randomUUID();
  const capability = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  rooms.set(id, {
    capabilityHash: await digest(capability),
    expiresAt,
    toRunner: null,
    toApi: null,
  });
  return { id, capability };
}

async function authedRoom(
  rooms: Map<string, MailboxData>,
  id: string,
  capability: string | null,
  now: () => number,
  allowExpired = false,
): Promise<MailboxData> {
  const room = rooms.get(id);
  if (!room || capability === null || (!allowExpired && room.expiresAt <= now())) throw new Error("Relay mailbox denied");
  if (!(await hashMatches(capability, room.capabilityHash))) throw new Error("Relay mailbox denied");
  return room;
}

function writeLane(room: MailboxData, lane: RelayLane, body: string): void {
  if (body.length === 0 || body.length > MAX_ENVELOPE_BYTES) throw new Error("Relay envelope rejected");
  if ((lane === "to-runner" ? room.toRunner : room.toApi) !== null) throw new Error("Relay lane busy");
  if (lane === "to-runner") room.toRunner = body;
  else room.toApi = body;
}

function parseStoredMailbox(value: unknown): MailboxData | null {
  if (!isRecord(value)) return null;
  const { capabilityHash, expiresAt, toRunner, toApi } = value;
  if (typeof capabilityHash !== "string" || typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return null;
  if (toRunner !== null && typeof toRunner !== "string") return null;
  if (toApi !== null && typeof toApi !== "string") return null;
  return { capabilityHash, expiresAt, toRunner, toApi };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bearerValue(header: string | null): string | null {
  if (header === null) return null;
  const [scheme, provided, extra] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !provided || extra !== undefined) return null;
  return provided;
}

export async function tokenMatches(header: string | null, expected: string): Promise<boolean> {
  const provided = bearerValue(header);
  if (provided === null || expected === "") return false;
  return hashMatches(provided, await digest(expected));
}

async function hashMatches(provided: string, expectedHash: string): Promise<boolean> {
  const actual = await digest(provided);
  if (actual.length !== expectedHash.length) return false;
  let diff = 0;
  for (let index = 0; index < actual.length; index += 1) {
    diff |= actual.charCodeAt(index) ^ expectedHash.charCodeAt(index);
  }
  return diff === 0;
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
