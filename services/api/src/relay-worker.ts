import { createMemoryMailboxStorage, HomeMailbox, tokenMatches, type HomeMailboxState } from "./relay-mailbox.ts";

export type RelayNamespace = {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
};

export type RelayWorkerEnv = {
  RELAY_ADMIN_TOKEN?: string;
  MAILBOX?: RelayNamespace;
};

const states = new Map<string, HomeMailboxState>();
const objects = new Map<string, HomeMailbox>();

export function resetRelayWorkers(): void {
  objects.clear();
  states.clear();
}

export function restartRelayObjects(): void {
  objects.clear();
}

export async function relayWorkerFetch(request: Request, env: RelayWorkerEnv, now: () => number = Date.now): Promise<Response> {
  if (!env.RELAY_ADMIN_TOKEN?.trim() || !env.MAILBOX) return new Response(null, { status: 503 });
  const url = new URL(request.url);
  if (url.pathname === "/mailboxes" && request.method === "POST") {
    if (!(await tokenMatches(request.headers.get("authorization"), env.RELAY_ADMIN_TOKEN))) {
      return new Response(null, { status: 401 });
    }
    const body = (await request.json()) as { expiresAt?: unknown };
    if (typeof body.expiresAt !== "number" || body.expiresAt <= now()) return new Response(null, { status: 400 });
    const id = crypto.randomUUID();
    const capabilityBytes = crypto.getRandomValues(new Uint8Array(32));
    let binary = "";
    for (const byte of capabilityBytes) binary += String.fromCharCode(byte);
    const capability = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    const capabilityHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(capability)))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const stub = env.MAILBOX.get(env.MAILBOX.idFromName(id));
    const init = await stub.fetch(
      new Request("https://mailbox.internal/internal/init", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.RELAY_ADMIN_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ capabilityHash, expiresAt: body.expiresAt }),
      }),
    );
    if (!init.ok) return new Response(null, { status: 503 });
    return Response.json({ id, capability });
  }

  const match = /^\/mailboxes\/([^/]+)(\/to-runner|\/to-api)?$/.exec(url.pathname);
  if (!match?.[1]) return new Response(null, { status: 404 });
  const suffix = match[2] ?? "";
  const laneMethod = request.method === "GET" || request.method === "PUT" || request.method === "DELETE";
  if (suffix === "" ? request.method !== "DELETE" : !laneMethod) return new Response(null, { status: 404 });
  const stub = env.MAILBOX.get(env.MAILBOX.idFromName(match[1]));
  const forwarded = new URL(request.url);
  forwarded.pathname = `/internal${suffix}`;
  return stub.fetch(new Request(forwarded, request));
}

export function localMailboxNamespace(adminToken: string): RelayNamespace {
  return {
    idFromName(name: string) {
      return name;
    },
    get(id: unknown) {
      const name = String(id);
      let object = objects.get(name);
      if (!object) {
        let state = states.get(name);
        if (!state) {
          state = { storage: createMemoryMailboxStorage() };
          states.set(name, state);
        }
        object = new HomeMailbox(state, { RELAY_ADMIN_TOKEN: adminToken });
        objects.set(name, object);
      }
      return object;
    },
  };
}
