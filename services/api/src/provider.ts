import { mkdirSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { parseProviderConnection, type ChatStreamEvent, type ProviderConnection } from "@lilith/contracts";
import { requireOwned, type OwnerContext } from "./auth.ts";
import {
  compactChatGptAuth,
  createCodexAdapter,
  createIsolatedCodexHost,
  redactSecrets,
  secretFragments,
  type CodexHost,
  type DeviceLogin,
} from "./codex.ts";

export type ProviderStore = {
  view(owner: OwnerContext): ProviderConnection;
  setup(owner: OwnerContext, signal?: AbortSignal): Promise<ProviderConnection>;
  check(owner: OwnerContext): Promise<ProviderConnection>;
  revoke(owner: OwnerContext): Promise<ProviderConnection>;
  streamChat(owner: OwnerContext, message: string, signal: AbortSignal): AsyncIterable<ChatStreamEvent>;
};

type ConnectionRecord = {
  id: "codex";
  kind: "provider_connection";
  ownerId: string;
  state: "disconnected" | "pending" | "connected";
  verificationUrl?: string;
  userCode?: string;
};

export function createProviderStore(options: {
  ownerId: string;
  persistPath?: string;
  secretPath?: string;
  host?: CodexHost;
}): ProviderStore {
  const host = options.host ?? createIsolatedCodexHost();
  const adapter = createCodexAdapter(host);
  const record: ConnectionRecord = {
    id: "codex",
    kind: "provider_connection",
    ownerId: options.ownerId,
    state: "disconnected",
  };
  let login: DeviceLogin | undefined;
  let lease = Promise.resolve();
  let memorySecret: string | undefined;
  const persistPath = options.persistPath;
  const secretPath = options.secretPath;

  function currentSecret(): string | undefined {
    if (secretPath === undefined) return memorySecret;
    if (!existsSync(secretPath)) return undefined;
    const value = readFileSync(secretPath, "utf8").trim();
    if (value === "") return undefined;
    return compactChatGptAuth(value);
  }

  function saveSecret(value: string): void {
    const compact = compactChatGptAuth(value);
    if (secretPath === undefined) {
      memorySecret = compact;
      return;
    }
    mkdirSync(dirname(secretPath), { recursive: true, mode: 0o700 });
    const tmp = `${secretPath}.${randomUUID()}.tmp`;
    writeFileSync(tmp, compact, { encoding: "utf8", mode: 0o600 });
    replaceFile(tmp, secretPath);
    try {
      chmodSync(secretPath, 0o600);
    } catch {
      // Windows cannot enforce POSIX 0600; Linux runners must.
    }
  }

  function clearSecret(): void {
    memorySecret = undefined;
    if (secretPath === undefined || !existsSync(secretPath)) return;
    unlinkSync(secretPath);
  }

  function acquireLease(): Promise<() => void> {
    let release: () => void = () => undefined;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const wait = lease;
    lease = wait.then(() => mine, () => mine);
    return wait.then(() => release);
  }

  if (persistPath !== undefined && existsSync(persistPath)) {
    loadRecord(record, persistPath);
  }
  if (record.state === "pending") {
    record.state = "disconnected";
    delete record.verificationUrl;
    delete record.userCode;
    persistRecord(record, persistPath);
  }
  if (record.state === "connected" && currentSecret() === undefined) {
    record.state = "disconnected";
    persistRecord(record, persistPath);
  }

  function owned(owner: OwnerContext): ConnectionRecord {
    return requireOwned(record, owner);
  }

  function publish(owner: OwnerContext): ProviderConnection {
    owned(owner);
    const capabilities = host.capabilities;
    if (record.state === "pending") {
      if (record.verificationUrl === undefined || record.userCode === undefined) {
        throw new Error("Invalid ProviderConnection");
      }
      return parseProviderConnection({
        provider: "codex",
        state: "pending",
        capabilities,
        verificationUrl: record.verificationUrl,
        userCode: record.userCode,
      });
    }
    const state = record.state === "connected" && currentSecret() !== undefined ? "connected" : "disconnected";
    return parseProviderConnection({ provider: "codex", state, capabilities });
  }

  return {
    view: publish,
    async setup(owner, signal) {
      owned(owner);
      if (record.state !== "disconnected") throw new Error("Provider already connected");
      const started = await host.startLogin(signal);
      if (signal?.aborted) {
        await started.abort().catch(() => undefined);
        throw new Error("Codex login aborted");
      }
      const onAbort = () => {
        void started.abort();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      login = started;
      record.state = "pending";
      record.verificationUrl = started.verificationUrl;
      record.userCode = started.userCode;
      persistRecord(record, persistPath);
      void started.finished.then(
        (authJson) => {
          signal?.removeEventListener("abort", onAbort);
          if (login !== started) return;
          saveSecret(authJson);
          record.state = "connected";
          delete record.verificationUrl;
          delete record.userCode;
          login = undefined;
          persistRecord(record, persistPath);
        },
        () => {
          signal?.removeEventListener("abort", onAbort);
          if (login !== started) return;
          record.state = "disconnected";
          delete record.verificationUrl;
          delete record.userCode;
          login = undefined;
          persistRecord(record, persistPath);
        },
      );
      return publish(owner);
    },
    async check(owner) {
      owned(owner);
      await Promise.resolve();
      if (record.state === "pending" && login !== undefined) {
        return publish(owner);
      }
      const authJson = currentSecret();
      const status = await host.loginStatus(authJson);
      if (status === "connected" && authJson !== undefined) {
        record.state = "connected";
        delete record.verificationUrl;
        delete record.userCode;
      } else {
        record.state = "disconnected";
        delete record.verificationUrl;
        delete record.userCode;
        if (status === "disconnected") clearSecret();
      }
      persistRecord(record, persistPath);
      return publish(owner);
    },
    async revoke(owner) {
      owned(owner);
      const authJson = currentSecret();
      if (login !== undefined) {
        await login.abort().catch(() => undefined);
        login = undefined;
      }
      await host.logout(authJson).catch(() => undefined);
      clearSecret();
      record.state = "disconnected";
      delete record.verificationUrl;
      delete record.userCode;
      persistRecord(record, persistPath);
      return publish(owner);
    },
    async *streamChat(owner, message, signal) {
      owned(owner);
      const authJson = currentSecret();
      if (authJson === undefined || record.state !== "connected") {
        throw new Error("Codex is not connected");
      }
      const secrets = secretFragments(authJson);
      const release = await acquireLease();
      try {
        const session = await adapter.start({ message, authJson });
        try {
          for await (const event of adapter.stream(session)) {
            if (signal.aborted) return;
            yield event.type === "delta"
              ? { type: "delta" as const, text: redactSecrets(event.text, secrets) }
              : event;
          }
          if (!signal.aborted) {
            await adapter.end(session);
            const refreshed = session.run.takeRefreshedAuth();
            if (refreshed !== undefined) saveSecret(refreshed);
          }
        } catch (error) {
          if (signal.aborted) return;
          const messageText = error instanceof Error ? error.message : "Codex run failed";
          throw new Error(redactSecrets(messageText, secrets));
        } finally {
          await adapter.abort(session).catch(() => undefined);
          await adapter.end(session);
        }
      } finally {
        release();
      }
    },
  };
}

function persistRecord(record: ConnectionRecord, persistPath: string | undefined): void {
  if (persistPath === undefined) return;
  mkdirSync(dirname(persistPath), { recursive: true, mode: 0o700 });
  const tmp = `${persistPath}.${randomUUID()}.tmp`;
  writeFileSync(
    tmp,
    JSON.stringify({
      v: 1,
      ownerId: record.ownerId,
      state: record.state,
      ...(record.verificationUrl === undefined ? {} : { verificationUrl: record.verificationUrl }),
      ...(record.userCode === undefined ? {} : { userCode: record.userCode }),
    }),
  );
  replaceFile(tmp, persistPath);
}

function loadRecord(record: ConnectionRecord, persistPath: string): void {
  const value: unknown = JSON.parse(readFileSync(persistPath, "utf8"));
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("v" in value) ||
    value.v !== 1 ||
    !("ownerId" in value) ||
    typeof value.ownerId !== "string" ||
    value.ownerId === "" ||
    !("state" in value) ||
    (value.state !== "disconnected" && value.state !== "pending" && value.state !== "connected")
  ) {
    throw new Error("Invalid provider store");
  }
  if (value.ownerId !== record.ownerId) throw new Error("Invalid provider store");
  record.state = value.state;
  if ("verificationUrl" in value && typeof value.verificationUrl === "string") {
    record.verificationUrl = value.verificationUrl;
  }
  if ("userCode" in value && typeof value.userCode === "string") {
    record.userCode = value.userCode;
  }
}

function replaceFile(tmp: string, dest: string): void {
  try {
    renameSync(tmp, dest);
    return;
  } catch (error) {
    if (!existsSync(dest)) throw error;
  }
  unlinkSync(dest);
  renameSync(tmp, dest);
}
