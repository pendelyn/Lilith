import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CODEX_DEVICE_LOGIN_URL, parseProviderConnection } from "@lilith/contracts";
import { CODEX_CAPABILITIES, createScriptedCodexHost, defaultScriptedAuth } from "./codex.ts";
import { createProviderStore } from "./provider.ts";

const owner = { ownerId: "alpha-owner" };

test("setup, check, and revoke never put secrets in the public connection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lilith-provider-"));
  const persistPath = join(dir, "provider.json");
  const secretPath = join(dir, "codex-auth.json");
  try {
    const host = createScriptedCodexHost();
    const store = createProviderStore({ ownerId: owner.ownerId, persistPath, secretPath, host });
    const pending = await store.setup(owner);
    assert.equal(pending.state, "pending");
    assert.equal(pending.verificationUrl, CODEX_DEVICE_LOGIN_URL);
    assert.equal(pending.userCode, "ABCD-EFGH");
    assert.equal(JSON.stringify(pending).includes("sk-test"), false);

    host.completeLogin(defaultScriptedAuth());
    const connected = await store.check(owner);
    assert.equal(connected.state, "connected");
    assert.deepEqual(connected.capabilities, CODEX_CAPABILITIES);
    assert.equal("verificationUrl" in connected, false);
    assert.equal(JSON.stringify(connected).includes("sk-test-access-secret"), false);
    assert.equal(readFileSync(persistPath, "utf8").includes("sk-test"), false);
    assert.equal(readFileSync(secretPath, "utf8").includes("sk-test-access-secret"), true);
    assert.equal(readFileSync(secretPath, "utf8").includes("\n"), false);

    const revoked = await store.revoke(owner);
    assert.equal(revoked.state, "disconnected");
    assert.deepEqual(parseProviderConnection(revoked).capabilities, CODEX_CAPABILITIES);
    const checked = await store.check(owner);
    assert.equal(checked.state, "disconnected");
    assert.equal(readFileSync(persistPath, "utf8").includes("sk-test"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check follows remote revoke without treating local logout as provider revocation", async () => {
  const host = createScriptedCodexHost();
  const store = createProviderStore({ ownerId: owner.ownerId, host });
  await store.setup(owner);
  host.completeLogin();
  assert.equal((await store.check(owner)).state, "connected");
  host.remoteRevoke();
  assert.equal((await store.check(owner)).state, "disconnected");
});

test("chat streams through the Codex adapter and serializes the auth lease", async () => {
  const host = createScriptedCodexHost({
    authJson: defaultScriptedAuth(),
    chunkDelayMs: 20,
    replyText: `Hello ${JSON.parse(defaultScriptedAuth()).tokens.access_token}`,
  });
  const store = createProviderStore({ ownerId: owner.ownerId, host });
  await store.setup(owner);
  host.completeLogin();
  assert.equal((await store.check(owner)).state, "connected");

  async function drain() {
    const text: string[] = [];
    let done = false;
    for await (const event of store.streamChat(owner, "Hello", new AbortController().signal)) {
      if (event.type === "delta") text.push(event.text);
      if (event.type === "done") done = true;
    }
    return { text: text.join(""), done };
  }

  const first = await drain();
  assert.equal(first.done, true);
  assert.equal(first.text, "Hello [REDACTED]");

  const samples: number[] = [];
  const timer = setInterval(() => samples.push(host.activeRuns), 5);
  try {
    const results = await Promise.all([drain(), drain(), drain()]);
    assert.equal(results.every((result) => result.done), true);
  } finally {
    clearInterval(timer);
  }
  assert.equal(Math.max(0, ...samples, host.activeRuns), 1);
});

test("aborting chat does not complete the turn", async () => {
  const host = createScriptedCodexHost({
    authJson: defaultScriptedAuth(),
    chunkDelayMs: 80,
    replyText: "Hello from Codex",
  });
  const store = createProviderStore({ ownerId: owner.ownerId, host });
  await store.setup(owner);
  host.completeLogin();
  await store.check(owner);
  const ac = new AbortController();
  const seen: string[] = [];
  const run = (async () => {
    for await (const event of store.streamChat(owner, "Hello", ac.signal)) {
      if (event.type === "delta") {
        seen.push(event.text);
        ac.abort();
      }
      if (event.type === "done") seen.push("done");
    }
  })();
  await run;
  assert.equal(host.aborted, true);
  assert.equal(seen.includes("done"), false);
});

test("foreign owners cannot inspect the provider connection", async () => {
  const store = createProviderStore({ ownerId: owner.ownerId, host: createScriptedCodexHost() });
  assert.throws(() => store.view({ ownerId: "foreign-owner" }), /access denied/);
});
