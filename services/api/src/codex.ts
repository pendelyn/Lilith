import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  CODEX_DEVICE_LOGIN_URL,
  parseChatStreamEvent,
  type ChatStreamEvent,
  type ProviderAdapter,
  type ProviderCapabilities,
} from "@lilith/contracts";
import {
  JobCredentialBroker,
  RUNNER_IMAGE,
  RUNNER_WORKSPACES_ROOT,
  startIsolatedJob,
  type IsolatedJobHandle,
} from "./runner.ts";

export const CODEX_CAPABILITIES: ProviderCapabilities = {
  questions: false,
  approvals: false,
  toolEvents: false,
  modelSwitching: false,
};

export const CODEX_ENTRYPOINT = "/usr/local/bin/lilith-codex";
export const CODEX_HOME_IN_JOB = "/tmp/codex-home";
export const CODEX_AUTH_EXPORT = "/tmp/codex-auth-export";
export const CODEX_RUNNER_IMAGE = RUNNER_IMAGE;
export const CODEX_REMOTE_REVOKE = false;
export const CODEX_EGRESS_ALLOWLIST = ["auth.openai.com", "api.openai.com", "chatgpt.com"] as const;

export type DeviceLogin = {
  verificationUrl: typeof CODEX_DEVICE_LOGIN_URL;
  userCode: string;
  finished: Promise<string>;
  abort(): Promise<void>;
};

export type CodexRun = {
  chunks: AsyncIterable<string>;
  abort(): Promise<void>;
  finished: Promise<void>;
  takeRefreshedAuth(): string | undefined;
};

export type CodexHost = {
  readonly capabilities: ProviderCapabilities;
  startLogin(signal?: AbortSignal): Promise<DeviceLogin>;
  loginStatus(authJson: string | undefined): Promise<"connected" | "disconnected">;
  logout(authJson: string | undefined): Promise<void>;
  startRun(input: { message: string; authJson: string }): Promise<CodexRun>;
};

export type CodexSession = {
  run: CodexRun;
  secrets: string[];
  cancel: AbortController;
};

export type CodexStartInput = {
  message: string;
  authJson: string;
};

export function createCodexAdapter(host: CodexHost): ProviderAdapter<CodexSession, CodexStartInput, ChatStreamEvent> {
  return {
    capabilities: host.capabilities,
    async start(input) {
      const authJson = compactChatGptAuth(input.authJson);
      return {
        run: await host.startRun({ message: input.message, authJson }),
        secrets: secretFragments(authJson),
        cancel: new AbortController(),
      };
    },
    stream(session) {
      return chatEventsFromCodex(jsonlLines(session.run.chunks), session.secrets, session.cancel.signal);
    },
    abort(session) {
      session.cancel.abort();
      return session.run.abort();
    },
    async end(session) {
      await session.run.finished.catch(() => undefined);
    },
  };
}

export function permissionProfileToml(codexHome: string = CODEX_HOME_IN_JOB): string {
  return [
    "approval_policy = \"never\"",
    "cli_auth_credentials_store = \"file\"",
    "default_permissions = \"lilith\"",
    "",
    "[features]",
    "network_proxy = true",
    "",
    "[permissions.lilith]",
    "extends = \":workspace\"",
    "",
    "[permissions.lilith.filesystem]",
    "\":minimal\" = \"read\"",
    `"${codexHome}" = "deny"`,
    "\"/run/secrets\" = \"deny\"",
    "",
    "[permissions.lilith.filesystem.\":workspace_roots\"]",
    "\".\" = \"write\"",
    "\"**/*.env\" = \"deny\"",
    "",
    "[permissions.lilith.network]",
    "enabled = false",
    "",
  ].join("\n");
}

export function compactChatGptAuth(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error("Provider secret must be a single line");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Invalid Codex auth");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    !("auth_mode" in parsed) ||
    parsed.auth_mode !== "chatgpt"
  ) {
    throw new Error("Only ChatGPT Codex auth is enabled");
  }
  return JSON.stringify(parsed);
}

export function secretFragments(authJson: string): string[] {
  const compact = compactChatGptAuth(authJson);
  const fragments = [compact, authJson];
  const parsed: unknown = JSON.parse(compact);
  collectStrings(parsed, fragments);
  return [...new Set(fragments.filter((fragment) => fragment.length >= 8))];
}

export function redactSecrets(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret !== "") redacted = redacted.replaceAll(secret, "[REDACTED]");
  }
  return redacted;
}

export function parseDeviceLoginPrompt(output: string): {
  verificationUrl: typeof CODEX_DEVICE_LOGIN_URL;
  userCode: string;
} {
  if (output.includes(CODEX_DEVICE_LOGIN_URL) === false) {
    throw new Error("Invalid device login prompt");
  }
  const code = output.match(/\b([A-Z0-9]{3,8}-[A-Z0-9]{3,8})\b/);
  if (code?.[1] === undefined) throw new Error("Invalid device login prompt");
  return { verificationUrl: CODEX_DEVICE_LOGIN_URL, userCode: code[1] };
}

export async function* jsonlLines(chunks: AsyncIterable<string>): AsyncIterable<string> {
  let pending = "";
  for await (const chunk of chunks) {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (line !== "") yield line;
    }
  }
  if (pending !== "") yield pending;
}

export async function* chatEventsFromCodex(
  lines: AsyncIterable<string>,
  secrets: readonly string[] = [],
  signal?: AbortSignal,
): AsyncIterable<ChatStreamEvent> {
  const rawById = new Map<string, string>();
  const emittedById = new Map<string, string>();
  const hold = streamingHoldChars(secrets);
  let completed = false;

  function takeDelta(id: string, redactedFull: string, complete: boolean): ChatStreamEvent | undefined {
    const safe = complete ? redactedFull : redactedFull.slice(0, Math.max(0, redactedFull.length - hold));
    const previous = emittedById.get(id) ?? "";
    const next = safe.startsWith(previous) ? safe.slice(previous.length) : safe;
    if (next === "") return undefined;
    emittedById.set(id, safe);
    return parseChatStreamEvent({ type: "delta", text: next });
  }

  function* flushHeld(): Generator<ChatStreamEvent> {
    for (const [id, raw] of rawById) {
      const event = takeDelta(id, redactSecrets(raw, secrets), true);
      if (event !== undefined) yield event;
    }
  }

  for await (const line of lines) {
    if (signal?.aborted) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error("Invalid Codex event");
    }
    if (typeof value !== "object" || value === null || Array.isArray(value) || !("type" in value) || typeof value.type !== "string") {
      throw new Error("Invalid Codex event");
    }
    if (value.type === "error" || value.type === "turn.failed") {
      throw new Error("Codex turn failed");
    }
    if (value.type === "turn.completed") {
      if (!completed) {
        yield* flushHeld();
        yield parseChatStreamEvent({ type: "done" });
        completed = true;
      }
      return;
    }
    if (value.type === "thread.started" || value.type === "turn.started") continue;
    if (!value.type.startsWith("item.")) continue;
    if (!("item" in value) || typeof value.item !== "object" || value.item === null || Array.isArray(value.item)) {
      continue;
    }
    const item = value.item;
    if (!("id" in item) || typeof item.id !== "string" || item.id === "") continue;
    if (!("type" in item) || item.type !== "agent_message") continue;
    if (!("text" in item) || typeof item.text !== "string" || item.text === "") continue;
    rawById.set(item.id, item.text);
    const event = takeDelta(item.id, redactSecrets(item.text, secrets), value.type === "item.completed");
    if (event !== undefined) yield event;
  }
  if (signal?.aborted) return;
  if (!completed) throw new Error("Codex turn did not complete");
}

export type ScriptedCodexHost = CodexHost & {
  completeLogin(authJson?: string): void;
  failLogin(): void;
  remoteRevoke(): void;
  readonly aborted: boolean;
  readonly activeRuns: number;
};

export function createScriptedCodexHost(options?: {
  authJson?: string;
  userCode?: string;
  replyText?: string;
  jsonl?: string[];
  chunkDelayMs?: number;
  loginDelayMs?: number;
}): ScriptedCodexHost {
  const userCode = options?.userCode ?? "ABCD-EFGH";
  const replyText = options?.replyText ?? "Hello from Codex";
  let authJson = options?.authJson;
  let remoteRevoked = false;
  let aborted = false;
  let activeRuns = 0;
  let settleLogin: ((auth: string) => void) | undefined;
  let rejectLogin: ((error: Error) => void) | undefined;

  const host: ScriptedCodexHost = {
    capabilities: CODEX_CAPABILITIES,
    get aborted() {
      return aborted;
    },
    get activeRuns() {
      return activeRuns;
    },
    completeLogin(next = options?.authJson ?? defaultScriptedAuth()) {
      if (settleLogin === undefined) throw new Error("No pending Codex login");
      const compact = compactChatGptAuth(next);
      const settle = settleLogin;
      settleLogin = undefined;
      rejectLogin = undefined;
      authJson = compact;
      settle(compact);
    },
    failLogin() {
      if (rejectLogin === undefined) throw new Error("No pending Codex login");
      const reject = rejectLogin;
      settleLogin = undefined;
      rejectLogin = undefined;
      reject(new Error("Codex login failed"));
    },
    remoteRevoke() {
      remoteRevoked = true;
    },
    async startLogin(signal) {
      if (settleLogin !== undefined) throw new Error("Codex login already pending");
      const markAborted = () => {
        aborted = true;
      };
      signal?.addEventListener("abort", markAborted, { once: true });
      if (options?.loginDelayMs) {
        try {
          await abortableDelay(options.loginDelayMs, signal);
        } catch (error) {
          aborted = true;
          throw error;
        }
      }
      if (signal?.aborted) {
        aborted = true;
        throw new Error("Codex login aborted");
      }
      const finished = new Promise<string>((resolve, reject) => {
        settleLogin = resolve;
        rejectLogin = reject;
      });
      return {
        verificationUrl: CODEX_DEVICE_LOGIN_URL,
        userCode,
        finished,
        async abort() {
          aborted = true;
          rejectLogin?.(new Error("Codex login aborted"));
          settleLogin = undefined;
          rejectLogin = undefined;
        },
      };
    },
    async loginStatus(current) {
      if (current === undefined || remoteRevoked) return "disconnected";
      compactChatGptAuth(current);
      return "connected";
    },
    async logout() {
      authJson = undefined;
      remoteRevoked = false;
    },
    async startRun(input) {
      compactChatGptAuth(input.authJson);
      if (authJson === undefined) throw new Error("Codex is not connected");
      aborted = false;
      activeRuns += 1;
      let settled = false;
      let resolveFinished: () => void = () => undefined;
      let rejectFinished: (error: Error) => void = () => undefined;
      const finished = new Promise<void>((resolve, reject) => {
        resolveFinished = () => {
          if (settled) return;
          settled = true;
          activeRuns -= 1;
          resolve();
        };
        rejectFinished = (error) => {
          if (settled) return;
          settled = true;
          activeRuns -= 1;
          reject(error);
        };
      });
      void finished.catch(() => undefined);
      const lines = options?.jsonl ?? [
        JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
        JSON.stringify({ type: "turn.started" }),
        JSON.stringify({
          type: "item.completed",
          item: { id: "item-1", type: "agent_message", text: replyText },
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
        }),
      ];
      return {
        chunks: (async function* () {
          try {
            for await (const chunk of delayedLines(lines, () => aborted, options?.chunkDelayMs ?? 5)) {
              yield chunk;
            }
          } catch (error) {
            rejectFinished(error instanceof Error ? error : new Error("Codex run failed"));
          } finally {
            if (!aborted) resolveFinished();
          }
        })(),
        async abort() {
          aborted = true;
          resolveFinished();
        },
        finished,
        takeRefreshedAuth() {
          return authJson;
        },
      };
    },
  };
  return host;
}

export function defaultScriptedAuth(): string {
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      access_token: "sk-test-access-secret",
      refresh_token: "sk-test-refresh-secret",
      id_token: "sk-test-id-secret",
    },
    last_refresh: "2026-09-10T00:00:00.000Z",
  });
}

function collectStrings(value: unknown, into: string[]): void {
  if (typeof value === "string") {
    into.push(value);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const entry of Object.values(value)) collectStrings(entry, into);
}

async function* delayedLines(
  lines: string[],
  aborted: () => boolean,
  delayMs: number,
): AsyncIterable<string> {
  for (const line of lines) {
    if (aborted()) return;
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (aborted()) return;
    yield `${line}\n`;
  }
}

export function createIsolatedCodexHost(): CodexHost {
  return {
    capabilities: CODEX_CAPABILITIES,
    async startLogin(signal) {
      const job = await prepareWorkspace();
      const handle = await startIsolatedJob({
        id: job.id,
        workspace: job.workspace,
        linger: true,
        seedCodexHome: true,
        image: CODEX_RUNNER_IMAGE,
        network: { allowlist: CODEX_EGRESS_ALLOWLIST },
        command: [CODEX_ENTRYPOINT, "login", "--device-auth"],
      }).catch(async (error) => {
        await job.cleanup();
        throw error;
      });
      let buf = "";
      let notify: (() => void) | undefined;
      const drain = (async () => {
        for await (const chunk of handle.chunks()) {
          buf += chunk;
          notify?.();
        }
      })();
      const consume = (async () => {
        try {
          return await waitForCopiedAuth(() => tryCopyAuth(handle), {
            intervalMs: 250,
            chunksDone: drain,
          });
        } finally {
          handle.abort();
          await drain.catch(() => undefined);
          await handle.close();
          await job.cleanup();
        }
      })();
      void consume.catch(() => undefined);
      try {
        const prompt = await waitForPrompt(
          () => buf,
          () => {
            notify = undefined;
            return new Promise<void>((resolve) => {
              notify = resolve;
            });
          },
          15_000,
          signal,
        );
        return {
          ...prompt,
          finished: consume,
          async abort() {
            handle.abort();
            await consume.catch(() => undefined);
          },
        };
      } catch (error) {
        handle.abort();
        await consume.catch(() => undefined);
        throw error;
      }
    },
    async loginStatus(authJson) {
      if (authJson === undefined) return "disconnected";
      let compact: string;
      try {
        compact = compactChatGptAuth(authJson);
      } catch {
        return "disconnected";
      }
      const output = await runShortCodexJob(["login", "status"], compact, "none");
      return parseCodexLoginStatus(output);
    },
    async logout(authJson) {
      if (authJson === undefined) return;
      try {
        await runShortCodexJob(["logout"], compactChatGptAuth(authJson), "none");
      } catch {
        // Local store wipe still happens in revoke(). Codex logout is not remote token revocation.
      }
    },
    async startRun(input) {
      const authJson = compactChatGptAuth(input.authJson);
      const secrets = secretFragments(authJson);
      if (secrets.some((secret) => input.message.includes(secret))) {
        throw new Error("Provider secret must not appear in the job command or prompt");
      }
      const job = await prepareWorkspace();
      const broker = new JobCredentialBroker(CODEX_ENTRYPOINT);
      broker.issue(job.id, authJson);
      const handle = await startIsolatedJob(
        {
          id: job.id,
          workspace: job.workspace,
          linger: true,
          seedCodexHome: true,
          image: CODEX_RUNNER_IMAGE,
          network: { allowlist: CODEX_EGRESS_ALLOWLIST },
          command: [CODEX_ENTRYPOINT, "exec", "--json", "--ephemeral", "--skip-git-repo-check", input.message],
        },
        broker,
      ).catch(async (error) => {
        await job.cleanup();
        throw error;
      });
      let refreshed: string | undefined;
      let settled: Promise<void> | undefined;
      const finish = () => {
        settled ??= (async () => {
          try {
            refreshed = await tryCopyAuth(handle);
          } finally {
            handle.abort();
            await handle.close();
            await job.cleanup();
          }
        })();
        return settled;
      };
      return {
        chunks: handle.chunks(),
        async abort() {
          handle.abort();
          await finish();
        },
        finished: lazyPromise(finish),
        takeRefreshedAuth() {
          return refreshed;
        },
      };
    },
  };
}

export async function writeCodexPermissionProfile(workspace: string): Promise<string> {
  const dir = join(workspace, ".codex");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "config.toml");
  await writeFile(path, permissionProfileToml(), { encoding: "utf8", mode: 0o600 });
  return path;
}

export function parseCodexLoginStatus(output: string): "connected" | "disconnected" {
  const text = output.toLowerCase();
  if (text.includes("not logged in") || text.includes("logged out") || text.includes("api key")) {
    return "disconnected";
  }
  return text.includes("chatgpt") ? "connected" : "disconnected";
}

export async function waitForCopiedAuth(
  copy: () => Promise<string | undefined>,
  options: {
    signal?: AbortSignal;
    intervalMs?: number;
    chunksDone?: Promise<unknown>;
  } = {},
): Promise<string> {
  const intervalMs = options.intervalMs ?? 250;
  const chunksDone = options.chunksDone;
  let done = false;
  void chunksDone?.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  const idle = chunksDone ?? new Promise<void>(() => undefined);
  while (true) {
    if (options.signal?.aborted) throw new Error("Codex login aborted");
    let exported: string | undefined;
    try {
      exported = await copy();
    } catch {
      exported = undefined;
    }
    if (exported) return exported;
    if (done) throw new Error("Cannot export from job container");
    await Promise.race([
      abortableDelay(intervalMs, options.signal).catch(() => undefined),
      idle,
    ]);
  }
}

export async function waitForPrompt(
  buffer: () => string,
  wait: () => Promise<void>,
  timeoutMs = 15_000,
  signal?: AbortSignal,
): Promise<{ verificationUrl: typeof CODEX_DEVICE_LOGIN_URL; userCode: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Codex login aborted");
    try {
      return parseDeviceLoginPrompt(buffer());
    } catch {
      await Promise.race([
        wait(),
        new Promise<void>((resolve) => setTimeout(resolve, 50)),
        abortEvent(signal),
      ]);
    }
  }
  throw new Error("Device login prompt timed out");
}

async function prepareWorkspace(): Promise<{ id: string; workspace: string; cleanup: () => Promise<void> }> {
  const id = randomUUID();
  const workspace = join(RUNNER_WORKSPACES_ROOT, `codex-${id}`);
  await mkdir(RUNNER_WORKSPACES_ROOT, { recursive: true, mode: 0o700 });
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  await writeCodexPermissionProfile(workspace);
  return {
    id,
    workspace,
    async cleanup() {
      await rm(workspace, { recursive: true, force: true });
    },
  };
}

async function runShortCodexJob(
  args: string[],
  authJson: string,
  network: "none",
): Promise<string> {
  const job = await prepareWorkspace();
  const broker = new JobCredentialBroker(CODEX_ENTRYPOINT);
  broker.issue(job.id, authJson);
  const handle = await startIsolatedJob(
    {
      id: job.id,
      workspace: job.workspace,
      seedCodexHome: true,
      image: CODEX_RUNNER_IMAGE,
      network,
      command: [CODEX_ENTRYPOINT, ...args],
    },
    broker,
  ).catch(async (error) => {
    await job.cleanup();
    throw error;
  });
  try {
    let out = "";
    for await (const chunk of handle.chunks()) out += chunk;
    await handle.finished;
    return out;
  } finally {
    handle.abort();
    await handle.close();
    await job.cleanup();
  }
}

async function tryCopyAuth(handle: IsolatedJobHandle): Promise<string | undefined> {
  try {
    return compactChatGptAuth(await handle.copyOut(CODEX_AUTH_EXPORT));
  } catch {
    return undefined;
  }
}

function streamingHoldChars(secrets: readonly string[]): number {
  let longest = 0;
  for (const secret of secrets) {
    if (secret.length >= 8 && secret.startsWith("{") === false) longest = Math.max(longest, secret.length);
  }
  return longest === 0 ? 0 : longest - 1;
}

function lazyPromise(start: () => Promise<void>): Promise<void> {
  let running: Promise<void> | undefined;
  const run = () => (running ??= start());
  return {
    then: (onFulfilled, onRejected) => run().then(onFulfilled, onRejected),
    catch: (onRejected) => run().catch(onRejected),
    finally: (onFinally) => run().finally(onFinally),
    [Symbol.toStringTag]: "Promise",
  } as Promise<void>;
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Codex login aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Codex login aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortEvent(signal?: AbortSignal): Promise<void> {
  if (signal === undefined) return new Promise(() => undefined);
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}
