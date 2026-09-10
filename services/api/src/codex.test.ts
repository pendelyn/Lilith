import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CODEX_DEVICE_LOGIN_URL,
  parseChatStreamEvent,
  parseProviderCapabilities,
  parseProviderConnection,
} from "@lilith/contracts";
import {
  CODEX_CAPABILITIES,
  CODEX_ENTRYPOINT,
  CODEX_EGRESS_ALLOWLIST,
  CODEX_REMOTE_REVOKE,
  CODEX_RUNNER_IMAGE,
  chatEventsFromCodex,
  compactChatGptAuth,
  createCodexAdapter,
  createScriptedCodexHost,
  defaultScriptedAuth,
  parseCodexLoginStatus,
  parseDeviceLoginPrompt,
  permissionProfileToml,
  redactSecrets,
  secretFragments,
  waitForCopiedAuth,
  waitForPrompt,
  writeCodexPermissionProfile,
} from "./codex.ts";

test("Codex capabilities are honest and reject secret fields", () => {
  assert.deepEqual(parseProviderCapabilities(CODEX_CAPABILITIES), {
    questions: false,
    approvals: false,
    toolEvents: false,
    modelSwitching: false,
  });
  assert.throws(
    () => parseProviderCapabilities({ ...CODEX_CAPABILITIES, accessToken: "sk-test-access-secret" }),
    /Invalid/,
  );
  assert.throws(
    () =>
      parseProviderConnection({
        provider: "codex",
        state: "connected",
        capabilities: CODEX_CAPABILITIES,
        authJson: defaultScriptedAuth(),
      }),
    /Invalid/,
  );
});

test("device login prompt exposes only the official URL and user code", () => {
  const parsed = parseDeviceLoginPrompt(
    `Welcome to Codex\nOpen https://auth.openai.com/codex/device\nEnter this one-time code\nABCD-EFGH\n`,
  );
  assert.deepEqual(parsed, { verificationUrl: CODEX_DEVICE_LOGIN_URL, userCode: "ABCD-EFGH" });
  assert.throws(() => parseDeviceLoginPrompt("https://evil.example/codex/device\nABCD-EFGH"), /Invalid/);
});

test("ChatGPT auth is compacted and API-key auth is refused", () => {
  const compact = compactChatGptAuth(defaultScriptedAuth());
  assert.equal(compact.includes("\n"), false);
  assert.equal(JSON.parse(compact).auth_mode, "chatgpt");
  assert.throws(
    () => compactChatGptAuth(JSON.stringify({ auth_mode: "apikey", tokens: { access_token: "sk-api" } })),
    /ChatGPT/,
  );
});

test("permission profile denies secrets, env files, and runtime widening", () => {
  const profile = permissionProfileToml();
  assert.match(profile, /approval_policy = "never"/);
  assert.match(profile, /\*\*\/\*\.env" = "deny"/);
  assert.match(profile, /\/tmp\/codex-home" = "deny"/);
  assert.match(profile, /\/run\/secrets" = "deny"/);
  assert.match(profile, /enabled = false/);
  assert.equal(profile.includes("sk-test-access-secret"), false);
  assert.equal(CODEX_ENTRYPOINT.startsWith("/"), true);
  assert.equal(CODEX_REMOTE_REVOKE, false);
  assert.equal(CODEX_EGRESS_ALLOWLIST.includes("auth.openai.com"), true);
  assert.match(CODEX_RUNNER_IMAGE, /@sha256:[a-f0-9]{64}$/);
});

test("JSONL adapter streams agent text, completes only on turn.completed, and redacts secrets", async () => {
  const secret = defaultScriptedAuth();
  const events: ReturnType<typeof parseChatStreamEvent>[] = [];
  async function* lines() {
    yield JSON.stringify({ type: "thread.started", thread_id: "t1" });
    yield JSON.stringify({ type: "turn.started" });
    yield JSON.stringify({
      type: "item.started",
      item: { id: "item-1", type: "command_execution", command: "ls" },
    });
    yield JSON.stringify({
      type: "item.completed",
      item: { id: "item-2", type: "agent_message", text: `Hello ${JSON.parse(secret).tokens.access_token}` },
    });
    yield JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
    });
  }
  for await (const event of chatEventsFromCodex(lines(), secretFragments(secret))) {
    events.push(event);
  }
  assert.deepEqual(events.at(-1), { type: "done" });
  const reply = events.flatMap((event) => (event.type === "delta" ? [event.text] : [])).join("");
  assert.equal(reply, "Hello [REDACTED]");
  assert.equal(JSON.stringify(events).includes("sk-test-access-secret"), false);
});

test("incremental JSONL does not emit secret fragments across item updates", async () => {
  const secret = JSON.parse(defaultScriptedAuth()).tokens.access_token as string;
  const prefix = secret.slice(0, 10);
  const events: string[] = [];
  async function* lines() {
    yield JSON.stringify({ type: "turn.started" });
    yield JSON.stringify({
      type: "item.updated",
      item: { id: "item-1", type: "agent_message", text: `Hi ${prefix}` },
    });
    yield JSON.stringify({
      type: "item.updated",
      item: { id: "item-1", type: "agent_message", text: `Hi ${secret}` },
    });
    yield JSON.stringify({
      type: "item.completed",
      item: { id: "item-1", type: "agent_message", text: `Hi ${secret}` },
    });
    yield JSON.stringify({ type: "turn.completed" });
  }
  for await (const event of chatEventsFromCodex(lines(), secretFragments(defaultScriptedAuth()))) {
    if (event.type === "delta") events.push(event.text);
  }
  const reply = events.join("");
  assert.equal(reply, "Hi [REDACTED]");
  assert.equal(reply.includes(prefix), false);
  assert.equal(JSON.stringify(events).includes(secret), false);
});

test("a failed or truncated Codex turn is not a successful completion", async () => {
  async function* failed() {
    yield JSON.stringify({ type: "turn.started" });
    yield JSON.stringify({ type: "turn.failed" });
  }
  await assert.rejects(async () => {
    for await (const _event of chatEventsFromCodex(failed())) {
      // drain
    }
  }, /failed/);

  async function* truncated() {
    yield JSON.stringify({ type: "turn.started" });
  }
  await assert.rejects(async () => {
    for await (const _event of chatEventsFromCodex(truncated())) {
      // drain
    }
  }, /did not complete/);
});

test("adapter abort stops a scripted run without done", async () => {
  const host = createScriptedCodexHost({
    authJson: defaultScriptedAuth(),
    chunkDelayMs: 40,
    replyText: "Hello from Codex",
  });
  const adapter = createCodexAdapter(host);
  const session = await adapter.start({ message: "Hi", authJson: defaultScriptedAuth() });
  const seen: string[] = [];
  const consume = (async () => {
    for await (const event of adapter.stream(session)) {
      if (event.type === "delta") seen.push(event.text);
      if (event.type === "delta") await adapter.abort(session);
    }
  })();
  await consume;
  await adapter.end(session);
  assert.equal(host.aborted, true);
  assert.equal(seen.join("").includes("Hello from Codex"), true);
  assert.equal(seen.join("").includes("sk-test-access-secret"), false);
  assert.equal(redactSecrets("leak sk-test-access-secret", secretFragments(defaultScriptedAuth())).includes("sk-test"), false);
});

test("scripted remote revoke is distinct from local logout", async () => {
  const host = createScriptedCodexHost({ authJson: defaultScriptedAuth() });
  assert.equal(await host.loginStatus(defaultScriptedAuth()), "connected");
  await host.logout(defaultScriptedAuth());
  assert.equal(await host.loginStatus(defaultScriptedAuth()), "connected");
  host.remoteRevoke();
  assert.equal(await host.loginStatus(defaultScriptedAuth()), "disconnected");
  assert.equal(CODEX_REMOTE_REVOKE, false);
});

test("login status parser treats ChatGPT as connected and does not claim API-key or empty output", () => {
  assert.equal(parseCodexLoginStatus("Logged in using ChatGPT"), "connected");
  assert.equal(parseCodexLoginStatus("Not logged in"), "disconnected");
  assert.equal(parseCodexLoginStatus("Logged in using API key"), "disconnected");
  assert.equal(parseCodexLoginStatus(""), "disconnected");
});

test("permission profile is written into the job workspace", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lilith-codex-profile-"));
  try {
    const path = await writeCodexPermissionProfile(dir);
    assert.equal(path.endsWith("config.toml"), true);
    const body = readFileSync(path, "utf8");
    assert.equal(body, permissionProfileToml());
    assert.match(body, /approval_policy = "never"/);
    assert.equal(body.includes("sk-test"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("device login prompt wait aborts and times out without hanging", async () => {
  await assert.rejects(waitForPrompt(() => "", () => new Promise(() => undefined), 20), /timed out/);
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(waitForPrompt(() => "", () => new Promise(() => undefined), 1_000, ac.signal), /aborted/);
});

test("auth export is polled even when the lingered job emits no further chunks", async () => {
  let attempts = 0;
  const auth = await waitForCopiedAuth(
    async () => {
      attempts += 1;
      return attempts >= 3 ? defaultScriptedAuth() : undefined;
    },
    { intervalMs: 5 },
  );
  assert.equal(auth, compactChatGptAuth(defaultScriptedAuth()));
  assert.equal(attempts >= 3, true);
});

test("auth export polling stops on abort or when attach ends without a file", async () => {
  const ac = new AbortController();
  const pending = waitForCopiedAuth(async () => undefined, {
    signal: ac.signal,
    intervalMs: 20,
    chunksDone: new Promise(() => undefined),
  });
  ac.abort();
  await assert.rejects(pending, /aborted/);
  await assert.rejects(
    waitForCopiedAuth(async () => undefined, { intervalMs: 5, chunksDone: Promise.resolve() }),
    /Cannot export/,
  );
});
