import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { parseHomeRunnerJobStatus, parseRunnerPairingResponse } from "@lilith/contracts";
import { createHealthServer } from "./health.ts";
import {
  claimOutboundRunner,
  createHomeRunner,
  fixtureIsolatedJob,
  FIXTURE_COMMAND,
  loadHomeStateKey,
  loadOutboundRunnerEnv,
  loadRelayConfig,
  rejectUnsafeCommand,
  type HomeRunner,
  runFixtureFromMailbox,
} from "./home-runner.ts";
import { createMemoryMailboxStorage, createMemoryRelay, HomeMailbox, relayMailboxFromFetch, type RelayMailbox } from "./relay-mailbox.ts";
import { localMailboxNamespace, relayWorkerFetch, resetRelayWorkers, restartRelayObjects } from "./relay-worker.ts";
import { main as runOutbound } from "./outbound-runner.ts";
import { dockerArgs, RUNNER_WORKSPACES_ROOT } from "./runner.ts";

const API_TOKEN = "secret-token";
const RELAY_TOKEN = "relay-admin-token";
const OWNER = { ownerId: "alpha-owner" };
const OTHER = { ownerId: "other-owner" };

test("relay config fails closed and stays optional when unset", () => {
  assert.equal(loadRelayConfig({}, API_TOKEN), null);
  assert.throws(() => loadRelayConfig({ LILITH_RELAY_URL: "https://relay.example" }, API_TOKEN), /both required/);
  assert.throws(() => loadRelayConfig({ LILITH_RELAY_TOKEN: RELAY_TOKEN }, API_TOKEN), /both required/);
  assert.throws(
    () => loadRelayConfig({ LILITH_RELAY_URL: "https://relay.example", LILITH_RELAY_TOKEN: API_TOKEN }, API_TOKEN),
    /must not reuse/,
  );
  assert.throws(
    () => loadRelayConfig({ LILITH_RELAY_URL: "http://127.0.0.1:8787", LILITH_RELAY_TOKEN: RELAY_TOKEN }, API_TOKEN),
    /https/,
  );
  assert.throws(() => loadOutboundRunnerEnv({}), /required/);
  assert.throws(
    () =>
      loadOutboundRunnerEnv({
        LILITH_RELAY_URL: "https://relay.example",
        LILITH_MAILBOX_ID: "mailbox",
        LILITH_MAILBOX_CAPABILITY: API_TOKEN,
        LILITH_PAIRING_CODE: "pairing-code-value",
        LOCAL_API_TOKEN: API_TOKEN,
      }),
    /refuses production credentials/,
  );
  assert.throws(
    () =>
      loadOutboundRunnerEnv({
        LILITH_RELAY_URL: "https://relay.example",
        LILITH_MAILBOX_ID: "mailbox",
        LILITH_MAILBOX_CAPABILITY: "capability-value-not-a-token",
        LILITH_PAIRING_CODE: "pairing-code-value",
        OPENAI_API_KEY: "sk-live",
      }),
    /refuses production credentials/,
  );
});

test("home runner routes stay absent until relay config exists", async () => {
  await withServer(null, async (base) => {
    const response = await fetch(`${base}/runners/pairings`, { method: "POST", headers: auth() });
    assert.equal(response.status, 404);
  });
});

test("pairing is one-time, owner-bound, revocable, and does not leak secrets onto the relay", async () => {
  const sent: string[] = [];
  const harness = harnessFor(sent);
  await withServer(harness.home, async (base) => {
    const created = parseRunnerPairingResponse(await readJson(await fetch(`${base}/runners/pairings`, {
      method: "POST",
      headers: auth(),
    })));
    assert.equal(created.relayUrl.startsWith("https://"), true);
    const claimed = await claimOutboundRunner({
      relay: harness.fetchRelay,
      mailboxId: created.mailboxId,
      capability: created.capability,
      pairingCode: created.code,
      pump: () => harness.home.pump(),
    });
    await assert.rejects(
      claimOutboundRunner({
        relay: harness.fetchRelay,
        mailboxId: created.mailboxId,
        capability: created.capability,
        pairingCode: created.code,
        pump: () => harness.home.pump(),
      }),
      /Pairing already used/,
    );
    await assert.rejects(harness.home.dispatch(OTHER, claimed.runnerId, { fixture: "echo-ok" }), /Runner not found/);
    await assert.rejects(harness.home.revoke(OTHER, claimed.runnerId), /Runner not found/);

    const jobResponse = await fetch(`${base}/runners/${claimed.runnerId}/jobs`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ fixture: "echo-ok", command: ["sh", "-c", "id"] }),
    });
    assert.equal(jobResponse.status, 400);

    const calls: IsolatedCall[] = [];
    const queued = await readJson(await fetch(`${base}/runners/${claimed.runnerId}/jobs`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ fixture: "echo-ok" }),
    })) as { id: string };
    await runFixtureFromMailbox({
      relay: harness.fetchRelay,
      mailboxId: created.mailboxId,
      capability: created.capability,
      runnerToken: claimed.runnerToken,
      pump: () => harness.home.pump(),
      runJob: async (job) => {
        calls.push(job);
        return { stdout: `ok ${claimed.runnerToken} ${API_TOKEN}\n`, stderr: "" };
      },
    });
    const status = parseHomeRunnerJobStatus(await readJson(await fetch(`${base}/runners/${claimed.runnerId}/jobs/${queued.id}`, {
      headers: auth(),
    })));
    assert.equal(status.state, "completed");
    assert.equal(status.stdout.includes(claimed.runnerToken), false);
    assert.equal(status.stdout.includes(API_TOKEN), false);
    assert.match(status.stdout, /\[REDACTED\]/);
    assert.equal(claimed.ownerId, OWNER.ownerId);
    assert.equal(sent.join("\n").includes(created.code), false);
    assert.equal(sent.join("\n").includes(claimed.runnerToken), false);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.command, [...FIXTURE_COMMAND]);
    assert.equal(calls[0]?.workspace.includes(`${join(RUNNER_WORKSPACES_ROOT, "home-")}`), true);

    const previous = status.stdout;
    await harness.home.pump();
    const replayed = harness.home.status(OWNER, claimed.runnerId, queued.id);
    assert.equal(replayed.stdout, previous);

    await fetch(`${base}/runners/${claimed.runnerId}/revoke`, { method: "POST", headers: auth() });
    const revoked = await fetch(`${base}/runners/${claimed.runnerId}/jobs`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ fixture: "echo-ok" }),
    });
    assert.equal(revoked.status, 409);
    await assert.rejects(
      runFixtureFromMailbox({
        relay: harness.fetchRelay,
        mailboxId: created.mailboxId,
        capability: created.capability,
        runnerToken: claimed.runnerToken,
        pump: () => harness.home.pump(),
        runJob: async () => ({ stdout: "nope", stderr: "" }),
      }),
      /Relay (read|write) failed|Runner revoked/,
    );
    assert.equal(calls.length, 1);
  });
  const blob = sent.join("\n");
  assert.equal(blob.includes(API_TOKEN), false);
});

test("expired pairing and a reused API token do not create a runner", async () => {
  let now = 1_000_000;
  const relay = createMemoryRelay(RELAY_TOKEN, () => now);
  const home = createHomeRunner({
    relayUrl: "https://relay.test",
    apiToken: API_TOKEN,
    relayToken: RELAY_TOKEN,
    relay,
    now: () => now,
  });
  const created = await home.createPairing(OWNER);
  now += 5 * 60 * 1000 + 1;
  await home.pump();
  await assert.rejects(
    claimOutboundRunner({
      relay,
      mailboxId: created.mailboxId,
      capability: created.capability,
      pairingCode: created.code,
      pump: () => home.pump(),
    }),
    /Relay write failed|Relay mailbox denied|Pairing expired/,
  );

  const relayForToken = createMemoryRelay(RELAY_TOKEN);
  const fresh = createHomeRunner({
    relayUrl: "https://relay.test",
    apiToken: API_TOKEN,
    relayToken: RELAY_TOKEN,
    relay: relayForToken,
  });
  const pairing = await fresh.createPairing(OWNER);
  await assert.rejects(
    claimOutboundRunner({
      relay: relayForToken,
      mailboxId: pairing.mailboxId,
      capability: pairing.capability,
      pairingCode: pairing.code,
      runnerToken: API_TOKEN,
      pump: () => fresh.pump(),
    }),
    /Pairing already used/,
  );
  await assert.rejects(fresh.dispatch(OWNER, crypto.randomUUID(), { fixture: "echo-ok" }), /Runner not found/);
});

test("fixture jobs keep cloud-runner isolation and reject unsafe commands", async () => {
  assert.throws(() => rejectUnsafeCommand({ type: "job", fixture: "echo-ok", command: ["sh", "-c", "id"] }), /Unsafe command/);
  assert.throws(() => rejectUnsafeCommand({ fixture: "echo-ok", command: ["rm", "-rf", "/"] }), /Unsafe command/);
  const workspace = await mkdtemp(join(RUNNER_WORKSPACES_ROOT, "home-unit-"));
  try {
    const args = dockerArgs(fixtureIsolatedJob("fixture-job", workspace), "lilith-job-home");
    assert.equal(args.includes("--network=none"), true);
    assert.equal(args.includes("--cap-drop=ALL"), true);
    assert.equal(args.includes("/var/run/docker.sock"), false);
    assert.deepEqual(args.slice(-FIXTURE_COMMAND.length), [...FIXTURE_COMMAND]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("outbound runner prints the owner runner id before the deferred job", async () => {
  const memory = createMemoryRelay(RELAY_TOKEN);
  const home = createHomeRunner({
    relayUrl: "https://relay.test",
    apiToken: API_TOKEN,
    relayToken: RELAY_TOKEN,
    relay: memory,
  });
  const created = await home.createPairing(OWNER);
  const lines: string[] = [];
  let releaseJob = (): void => undefined;
  const jobReleased = new Promise<void>((resolve) => {
    releaseJob = resolve;
  });
  const running = runOutbound(
    {
      LILITH_RELAY_URL: "https://relay.test",
      LILITH_MAILBOX_ID: created.mailboxId,
      LILITH_MAILBOX_CAPABILITY: created.capability,
      LILITH_PAIRING_CODE: created.code,
    },
    {
      relay: memory,
      write: (line) => {
        lines.push(line);
      },
      pump: () => home.pump(),
      pollMs: 1,
      sleep: async () => {
        if (lines.length === 0) return;
        await jobReleased;
      },
      runJob: async () => ({ stdout: "ok", stderr: "" }),
    },
  );
  const started = Date.now();
  while (lines.length === 0) {
    if (Date.now() - started > 2_000) throw new Error("runner id was not printed before the job");
    await new Promise((resolve) => setImmediate(resolve));
  }
  const line = lines[0] ?? "";
  const printed = JSON.parse(line) as { runnerId?: unknown; ownerId?: unknown };
  assert.deepEqual(Object.keys(printed).sort(), ["ownerId", "runnerId"]);
  assert.equal(printed.ownerId, OWNER.ownerId);
  assert.match(String(printed.runnerId), /^[0-9a-f-]{36}$/i);
  assert.equal(line.includes(created.capability), false);
  assert.equal(line.includes(created.code), false);
  assert.equal(line.includes(created.mailboxId), false);
  assert.equal(/token|capability|pairing/i.test(line), false);
  const queued = await home.dispatch(OWNER, String(printed.runnerId), { fixture: "echo-ok" });
  releaseJob();
  const finished = await running;
  assert.equal(finished.runnerId, printed.runnerId);
  assert.equal(finished.ownerId, OWNER.ownerId);
  assert.equal(lines.length, 1);
  assert.equal(home.status(OWNER, finished.runnerId, queued.id).state, "completed");
});

test("outbound runner uses https fetch only", () => {
  for (const name of ["home-runner.ts", "outbound-runner.ts"]) {
    const source = readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
    assert.equal(source.includes("createServer"), false);
    assert.equal(source.includes(".listen("), false);
  }
  assert.throws(() => relayMailboxFromFetch("http://10.0.0.8:9", null), /https/);
});

test("worker mailbox fails closed without config and rejects a bad capability", async () => {
  resetRelayWorkers();
  const missing = await relayWorkerFetch(new Request("https://relay.test/mailboxes", { method: "POST" }), {});
  assert.equal(missing.status, 503);
  const env = { RELAY_ADMIN_TOKEN: RELAY_TOKEN, MAILBOX: localMailboxNamespace(RELAY_TOKEN) };
  const createdResponse = await relayWorkerFetch(
    new Request("https://relay.test/mailboxes", {
      method: "POST",
      headers: { Authorization: `Bearer ${RELAY_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ expiresAt: Date.now() + 60_000 }),
    }),
    env,
  );
  assert.equal(createdResponse.status, 200);
  const created = (await createdResponse.json()) as { id: string; capability: string };
  const denied = await relayWorkerFetch(
    new Request(`https://relay.test/mailboxes/${created.id}/to-runner`, {
      method: "PUT",
      headers: { Authorization: "Bearer not-the-capability" },
      body: "ciphertext",
    }),
    env,
  );
  assert.equal(denied.status, 401);
  const accepted = await relayWorkerFetch(
    new Request(`https://relay.test/mailboxes/${created.id}/to-runner`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${created.capability}` },
      body: "ciphertext",
    }),
    env,
  );
  assert.equal(accepted.status, 204);
  const rebind = await relayWorkerFetch(
    new Request(`https://relay.test/mailboxes/${created.id}/init`, {
      method: "POST",
      headers: { Authorization: `Bearer ${RELAY_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ capabilityHash: "attacker", expiresAt: Date.now() + 60_000 }),
    }),
    env,
  );
  assert.equal(rebind.status, 404);
  const kept = await relayWorkerFetch(
    new Request(`https://relay.test/mailboxes/${created.id}/to-runner`, {
      headers: { Authorization: `Bearer ${created.capability}` },
    }),
    env,
  );
  assert.equal(kept.status, 200);
  assert.equal(await kept.text(), "ciphertext");
  restartRelayObjects();
  const afterRestart = await relayWorkerFetch(
    new Request(`https://relay.test/mailboxes/${created.id}/to-runner`, {
      headers: { Authorization: `Bearer ${created.capability}` },
    }),
    env,
  );
  assert.equal(afterRestart.status, 200);
  assert.equal(await afterRestart.text(), "ciphertext");
  const storage = createMemoryMailboxStorage();
  const mailboxEnv = { RELAY_ADMIN_TOKEN: RELAY_TOKEN };
  const first = new HomeMailbox({ storage }, mailboxEnv);
  const init = await first.fetch(
    new Request("https://mailbox.internal/internal/init", {
      method: "POST",
      headers: { Authorization: `Bearer ${RELAY_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ capabilityHash: "abc", expiresAt: Date.now() + 60_000 }),
    }),
  );
  assert.equal(init.status, 204);
  const unbound = await new HomeMailbox({ storage }, mailboxEnv).fetch(
    new Request("https://mailbox.internal/internal/init", {
      method: "POST",
      body: JSON.stringify({ capabilityHash: "attacker", expiresAt: Date.now() + 60_000 }),
    }),
  );
  assert.equal(unbound.status, 401);
  const rebound = await new HomeMailbox({ storage }, mailboxEnv).fetch(
    new Request("https://mailbox.internal/internal/init", {
      method: "POST",
      headers: { Authorization: `Bearer ${RELAY_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ capabilityHash: "attacker", expiresAt: Date.now() + 60_000 }),
    }),
  );
  assert.equal(rebound.status, 409);
});

test("claim polls across the API interval and returns the owner-scoped runner", async () => {
  let now = 1_000_000;
  const relay = createMemoryRelay(RELAY_TOKEN, () => now);
  const home = createHomeRunner({
    relayUrl: "https://relay.test",
    apiToken: API_TOKEN,
    relayToken: RELAY_TOKEN,
    relay,
    now: () => now,
  });
  const created = await home.createPairing(OWNER);
  let pumps = 0;
  const claimed = await claimOutboundRunner({
    relay,
    mailboxId: created.mailboxId,
    capability: created.capability,
    pairingCode: created.code,
    now: () => now,
    pollMs: 2_000,
    sleep: async (ms) => {
      now += ms;
    },
    pump: async () => {
      pumps += 1;
      if (pumps >= 2) await home.pump();
    },
  });
  assert.equal(pumps >= 2, true);
  assert.equal(claimed.ownerId, OWNER.ownerId);
  assert.match(claimed.runnerId, /^[0-9a-f-]{36}$/i);
});

test("unclaimed pairing revoke drops the mailbox before anyone claims it", async () => {
  const relay = createMemoryRelay(RELAY_TOKEN);
  const home = createHomeRunner({
    relayUrl: "https://relay.test",
    apiToken: API_TOKEN,
    relayToken: RELAY_TOKEN,
    relay,
  });
  const created = await home.createPairing(OWNER);
  await assert.rejects(home.revoke(OTHER, created.pairingId), /Runner not found/);
  await home.revoke(OWNER, created.pairingId);
  await assert.rejects(
    claimOutboundRunner({
      relay,
      mailboxId: created.mailboxId,
      capability: created.capability,
      pairingCode: created.code,
      pump: () => home.pump(),
    }),
    /Relay write failed|Relay mailbox denied|Pairing expired/,
  );
});

test("one outstanding job survives a mismatch and an ack failure", async () => {
  const relay = createMemoryRelay(RELAY_TOKEN);
  let failAck = false;
  const wrapped = {
    create: relay.create.bind(relay),
    put: relay.put.bind(relay),
    read: relay.read.bind(relay),
    ack: async (id: string, capability: string, lane: "to-runner" | "to-api") => {
      if (failAck && lane === "to-api") throw new Error("ack failed");
      await relay.ack(id, capability, lane);
    },
    remove: relay.remove.bind(relay),
  };
  const home = createHomeRunner({
    relayUrl: "https://relay.test",
    apiToken: API_TOKEN,
    relayToken: RELAY_TOKEN,
    relay: wrapped,
  });
  const created = await home.createPairing(OWNER);
  const claimed = await claimOutboundRunner({
    relay: wrapped,
    mailboxId: created.mailboxId,
    capability: created.capability,
    pairingCode: created.code,
    pump: () => home.pump(),
  });
  const first = await home.dispatch(OWNER, claimed.runnerId, { fixture: "echo-ok" });
  await assert.rejects(home.dispatch(OWNER, claimed.runnerId, { fixture: "echo-ok" }), /Runner busy/);
  await relay.put(created.mailboxId, created.capability, "to-api", "not-a-result");
  await home.pump();
  assert.equal(home.status(OWNER, claimed.runnerId, first.id).state, "queued");
  assert.equal(await relay.read(created.mailboxId, created.capability, "to-api"), "not-a-result");
  await relay.ack(created.mailboxId, created.capability, "to-api");
  failAck = true;
  await assert.rejects(
    runFixtureFromMailbox({
      relay: wrapped,
      mailboxId: created.mailboxId,
      capability: created.capability,
      runnerToken: claimed.runnerToken,
      pump: () => home.pump(),
      runJob: async () => ({ stdout: "lilith-fixture-ok\n", stderr: "" }),
    }),
    /ack failed/,
  );
  assert.equal(home.status(OWNER, claimed.runnerId, first.id).state, "completed");
  assert.notEqual(await relay.read(created.mailboxId, created.capability, "to-api"), null);
  failAck = false;
  await home.pump();
  assert.equal(await relay.read(created.mailboxId, created.capability, "to-api"), null);
});

test("claimed revoke fails closed when mailbox delete fails", async () => {
  const memory = createMemoryRelay(RELAY_TOKEN);
  const relay = {
    create: memory.create.bind(memory),
    put: memory.put.bind(memory),
    read: memory.read.bind(memory),
    ack: memory.ack.bind(memory),
    remove: async () => {
      throw new Error("Relay delete failed");
    },
  };
  const home = createHomeRunner({
    relayUrl: "https://relay.test",
    apiToken: API_TOKEN,
    relayToken: RELAY_TOKEN,
    relay,
  });
  await withServer(home, async (base) => {
    const created = parseRunnerPairingResponse(await readJson(await fetch(`${base}/runners/pairings`, {
      method: "POST",
      headers: auth(),
    })));
    const claimed = await claimOutboundRunner({
      relay,
      mailboxId: created.mailboxId,
      capability: created.capability,
      pairingCode: created.code,
      pump: () => home.pump(),
    });
    const queued = await readJson(await fetch(`${base}/runners/${claimed.runnerId}/jobs`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ fixture: "echo-ok" }),
    })) as { id: string };
    const response = await fetch(`${base}/runners/${claimed.runnerId}/revoke`, { method: "POST", headers: auth() });
    assert.equal(response.status, 500);
    let runs = 0;
    await runFixtureFromMailbox({
      relay,
      mailboxId: created.mailboxId,
      capability: created.capability,
      runnerToken: claimed.runnerToken,
      pump: () => home.pump(),
      runJob: async () => {
        runs += 1;
        return { stdout: "lilith-fixture-ok\n", stderr: "" };
      },
    });
    assert.equal(runs, 1);
    assert.equal(home.status(OWNER, claimed.runnerId, queued.id).state, "completed");
  });
});

test("fixture runs once when the process crashes after consume and before the result is posted", async () => {
  const memory = createMemoryRelay(RELAY_TOKEN);
  let failResult = false;
  const relay = {
    create: memory.create.bind(memory),
    put: async (id: string, capability: string, lane: "to-runner" | "to-api", body: string) => {
      if (failResult && lane === "to-api") throw new Error("crash before result");
      await memory.put(id, capability, lane, body);
    },
    read: memory.read.bind(memory),
    ack: memory.ack.bind(memory),
    remove: memory.remove.bind(memory),
  };
  const home = createHomeRunner({
    relayUrl: "https://relay.test",
    apiToken: API_TOKEN,
    relayToken: RELAY_TOKEN,
    relay,
  });
  const created = await home.createPairing(OWNER);
  const claimed = await claimOutboundRunner({
    relay,
    mailboxId: created.mailboxId,
    capability: created.capability,
    pairingCode: created.code,
    pump: () => home.pump(),
  });
  await home.dispatch(OWNER, claimed.runnerId, { fixture: "echo-ok" });
  failResult = true;
  const calls: string[] = [];
  await assert.rejects(
    runFixtureFromMailbox({
      relay,
      mailboxId: created.mailboxId,
      capability: created.capability,
      runnerToken: claimed.runnerToken,
      pump: () => home.pump(),
      runJob: async (job) => {
        calls.push(job.command.join(" "));
        return { stdout: "lilith-fixture-ok\n", stderr: "" };
      },
    }),
    /crash before result/,
  );
  assert.equal(await memory.read(created.mailboxId, created.capability, "to-runner"), null);
  failResult = false;
  await assert.rejects(
    runFixtureFromMailbox({
      relay,
      mailboxId: created.mailboxId,
      capability: created.capability,
      runnerToken: claimed.runnerToken,
      deadline: 0,
      now: () => 1,
      pump: () => home.pump(),
      runJob: async (job) => {
        calls.push(job.command.join(" "));
        return { stdout: "again\n", stderr: "" };
      },
    }),
    /Runner revoked/,
  );
  assert.deepEqual(calls, [FIXTURE_COMMAND.join(" ")]);
});

test("account delete drops owner runners and fails closed when mailbox delete fails", async () => {
  const relay = createMemoryRelay(RELAY_TOKEN);
  const home = createHomeRunner({
    relayUrl: "https://relay.test",
    apiToken: API_TOKEN,
    relayToken: RELAY_TOKEN,
    relay,
  });
  await withServer(home, async (base) => {
    const claimedPairing = parseRunnerPairingResponse(await readJson(await fetch(`${base}/runners/pairings`, {
      method: "POST",
      headers: auth(),
    })));
    const claimed = await claimOutboundRunner({
      relay,
      mailboxId: claimedPairing.mailboxId,
      capability: claimedPairing.capability,
      pairingCode: claimedPairing.code,
      pump: () => home.pump(),
    });
    const openPairing = parseRunnerPairingResponse(await readJson(await fetch(`${base}/runners/pairings`, {
      method: "POST",
      headers: auth(),
    })));
    const deleted = await fetch(`${base}/account/delete`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ consent: true }),
    });
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), { deleted: true });
    const revoked = await fetch(`${base}/runners/${claimed.runnerId}/jobs`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ fixture: "echo-ok" }),
    });
    assert.equal(revoked.status, 409);
    await assert.rejects(relay.read(claimedPairing.mailboxId, claimedPairing.capability, "to-runner"), /Relay mailbox denied/);
    await assert.rejects(relay.read(openPairing.mailboxId, openPairing.capability, "to-runner"), /Relay mailbox denied/);
    await assert.rejects(
      claimOutboundRunner({
        relay,
        mailboxId: openPairing.mailboxId,
        capability: openPairing.capability,
        pairingCode: openPairing.code,
        pump: () => home.pump(),
      }),
      /Relay write failed|Relay mailbox denied/,
    );
  });

  let removes = 0;
  const memory = createMemoryRelay(RELAY_TOKEN);
  const failing = {
    create: memory.create.bind(memory),
    put: memory.put.bind(memory),
    read: memory.read.bind(memory),
    ack: memory.ack.bind(memory),
    remove: async (): Promise<void> => {
      removes += 1;
      throw new Error("Relay delete failed");
    },
  };
  const stuck = createHomeRunner({
    relayUrl: "https://relay.test",
    apiToken: API_TOKEN,
    relayToken: RELAY_TOKEN,
    relay: failing,
  });
  await withServer(stuck, async (base) => {
    const created = parseRunnerPairingResponse(await readJson(await fetch(`${base}/runners/pairings`, {
      method: "POST",
      headers: auth(),
    })));
    const failed = await fetch(`${base}/account/delete`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ consent: true }),
    });
    assert.equal(failed.status, 500);
    assert.equal((await failed.text()).includes("deleted"), false);
    assert.equal(removes, 1);
    const claimed = await claimOutboundRunner({
      relay: failing,
      mailboxId: created.mailboxId,
      capability: created.capability,
      pairingCode: created.code,
      pump: () => stuck.pump(),
    });
    assert.equal(claimed.ownerId, OWNER.ownerId);
    const queued = await fetch(`${base}/runners/${claimed.runnerId}/jobs`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ fixture: "echo-ok" }),
    });
    assert.equal(queued.status, 201);
  });
});

test("account delete blocks pairing and claim while mailbox removal is in flight", async () => {
  const memory = createMemoryRelay(RELAY_TOKEN);
  let releaseRemove: () => void = () => undefined;
  const removeHeld = new Promise<void>((resolve) => {
    releaseRemove = resolve;
  });
  let holding = true;
  let markEntered: () => void = () => undefined;
  const removeStarted = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const relay = {
    create: memory.create.bind(memory),
    put: memory.put.bind(memory),
    read: memory.read.bind(memory),
    ack: memory.ack.bind(memory),
    remove: async (id: string, capability: string) => {
      if (holding) {
        holding = false;
        markEntered();
        await removeHeld;
      }
      await memory.remove(id, capability);
    },
  };
  const home = createHomeRunner({
    relayUrl: "https://relay.test",
    apiToken: API_TOKEN,
    relayToken: RELAY_TOKEN,
    relay,
  });
  await withServer(home, async (base) => {
    const openPairing = parseRunnerPairingResponse(await readJson(await fetch(`${base}/runners/pairings`, {
      method: "POST",
      headers: auth(),
    })));
    const deleting = fetch(`${base}/account/delete`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ consent: true }),
    });
    await removeStarted;
    await assert.rejects(home.createPairing(OWNER), /Runner revoked/);
    const claim = claimOutboundRunner({
      relay,
      mailboxId: openPairing.mailboxId,
      capability: openPairing.capability,
      pairingCode: openPairing.code,
      pump: () => home.pump(),
      pollMs: 1,
      sleep: async () => {
        releaseRemove();
      },
    });
    const [deleted, claimed] = await Promise.allSettled([deleting, claim]);
    assert.equal(deleted.status, "fulfilled");
    if (deleted.status === "fulfilled") {
      assert.equal(deleted.value.status, 200);
      assert.deepEqual(await deleted.value.json(), { deleted: true });
    }
    assert.equal(claimed.status, "rejected");
    if (claimed.status === "rejected") {
      assert.match(String(claimed.reason), /Relay write failed|Relay mailbox denied|Pairing expired|Pairing already used/);
    }
    await assert.rejects(relay.read(openPairing.mailboxId, openPairing.capability, "to-runner"), /Relay mailbox denied/);
  });
});

test("account delete waits for an in-flight create and keeps the account when cleanup fails", async () => {
  const memory = createMemoryRelay(RELAY_TOKEN);
  let releaseCreate: () => void = () => undefined;
  const createHeld = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  let enteredCreate: () => void = () => undefined;
  const createStarted = new Promise<void>((resolve) => {
    enteredCreate = resolve;
  });
  let releaseRemove: () => void = () => undefined;
  const removeHeld = new Promise<void>((resolve) => {
    releaseRemove = resolve;
  });
  let enteredRemove: () => void = () => undefined;
  const removeStarted = new Promise<void>((resolve) => {
    enteredRemove = resolve;
  });
  let failCleanup = true;
  let mailboxId = "";
  let capability = "";
  const relay = {
    create: async (expiresAt: number) => {
      enteredCreate();
      await createHeld;
      const created = await memory.create(expiresAt);
      mailboxId = created.id;
      capability = created.capability;
      return created;
    },
    put: memory.put.bind(memory),
    read: memory.read.bind(memory),
    ack: memory.ack.bind(memory),
    remove: async (id: string, mailboxCapability: string) => {
      enteredRemove();
      await removeHeld;
      if (failCleanup) throw new Error("Relay delete failed");
      await memory.remove(id, mailboxCapability);
    },
  };
  const home = createHomeRunner({
    relayUrl: "https://relay.test",
    apiToken: API_TOKEN,
    relayToken: RELAY_TOKEN,
    relay,
  });
  const revokeOwner = home.revokeOwner.bind(home);
  let markRevoke: () => void = () => undefined;
  const revokeStarted = new Promise<void>((resolve) => {
    markRevoke = resolve;
  });
  home.revokeOwner = (owner) => {
    markRevoke();
    return revokeOwner(owner);
  };
  await withServer(home, async (base) => {
    const pairing = home.createPairing(OWNER);
    const rejected = assert.rejects(pairing, /Runner revoked/);
    await createStarted;
    const deleting = fetch(`${base}/account/delete`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ consent: true }),
    });
    await revokeStarted;
    releaseCreate();
    await removeStarted;
    releaseRemove();
    const failed = await deleting;
    assert.equal(failed.status, 500);
    assert.equal((await failed.text()).includes("deleted"), false);
    await rejected;
    const orphanId = mailboxId;
    const orphanCapability = capability;
    assert.equal(await memory.read(orphanId, orphanCapability, "to-api"), null);
    const intact = await fetch(`${base}/runners/pairings`, { method: "POST", headers: auth() });
    assert.equal(intact.status, 201);
    failCleanup = false;
    const deleted = await fetch(`${base}/account/delete`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ consent: true }),
    });
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), { deleted: true });
    await assert.rejects(memory.read(orphanId, orphanCapability, "to-api"), /Relay mailbox denied/);
    await assert.rejects(memory.read(mailboxId, capability, "to-runner"), /Relay mailbox denied/);
  });
});

test("deferred pairing put cannot commit a runner after account delete", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lilith-home-claim-race-"));
  const statePath = join(dir, ".lilith-home-runner.json");
  const stateKey = randomBytes(32);
  const memory = createMemoryRelay(RELAY_TOKEN);
  const runnerToken = randomBytes(32).toString("base64url");
  let runnerId = "";
  let releasePut: () => void = () => undefined;
  const putHeld = new Promise<void>((resolve) => {
    releasePut = resolve;
  });
  let markPut: () => void = () => undefined;
  const putStarted = new Promise<void>((resolve) => {
    markPut = resolve;
  });
  let holdPut = true;
  const relay = {
    create: memory.create.bind(memory),
    put: async (id: string, capability: string, lane: "to-runner" | "to-api", body: string) => {
      if (holdPut && lane === "to-runner") {
        holdPut = false;
        runnerId = openPaired(runnerToken, body).runnerId;
        markPut();
        await putHeld;
      }
      await memory.put(id, capability, lane, body);
    },
    read: memory.read.bind(memory),
    ack: memory.ack.bind(memory),
    remove: memory.remove.bind(memory),
  };
  const home = persistedHome(relay, statePath, stateKey);
  const revokeOwner = home.revokeOwner.bind(home);
  let markRevoke: () => void = () => undefined;
  const revokeStarted = new Promise<void>((resolve) => {
    markRevoke = resolve;
  });
  home.revokeOwner = (owner) => {
    const pending = revokeOwner(owner);
    markRevoke();
    return pending;
  };
  try {
    await withServer(home, async (base) => {
      const created = parseRunnerPairingResponse(await readJson(await fetch(`${base}/runners/pairings`, {
        method: "POST",
        headers: auth(),
      })));
      const claim = claimOutboundRunner({
        relay,
        mailboxId: created.mailboxId,
        capability: created.capability,
        pairingCode: created.code,
        runnerToken,
        pump: () => home.pump(),
        pollMs: 1,
        sleep: async () => undefined,
      });
      await putStarted;
      const deleting = fetch(`${base}/account/delete`, {
        method: "POST",
        headers: { ...auth(), "Content-Type": "application/json" },
        body: JSON.stringify({ consent: true }),
      });
      await revokeStarted;
      releasePut();
      const [deleted] = await Promise.allSettled([deleting, claim]);
      assert.equal(runnerId === "", false);
      assert.equal(deleted.status, "fulfilled");
      if (deleted.status === "fulfilled") {
        assert.equal(deleted.value.status, 200);
        assert.deepEqual(await deleted.value.json(), { deleted: true });
      }
      await assert.rejects(memory.read(created.mailboxId, created.capability, "to-runner"), /Relay mailbox denied/);
      const restarted = persistedHome(memory, statePath, stateKey);
      await assert.rejects(restarted.dispatch(OWNER, runnerId, { fixture: "echo-ok" }), /Runner not found/);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("failed account delete during a deferred pairing put retries without an active runner", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lilith-home-claim-retry-"));
  const statePath = join(dir, ".lilith-home-runner.json");
  const stateKey = randomBytes(32);
  const memory = createMemoryRelay(RELAY_TOKEN);
  const runnerToken = randomBytes(32).toString("base64url");
  let runnerId = "";
  let releasePut: () => void = () => undefined;
  const putHeld = new Promise<void>((resolve) => {
    releasePut = resolve;
  });
  let markPut: () => void = () => undefined;
  const putStarted = new Promise<void>((resolve) => {
    markPut = resolve;
  });
  let holdPut = true;
  let failRemove = true;
  const relay = {
    create: memory.create.bind(memory),
    put: async (id: string, capability: string, lane: "to-runner" | "to-api", body: string) => {
      if (holdPut && lane === "to-runner") {
        holdPut = false;
        runnerId = openPaired(runnerToken, body).runnerId;
        markPut();
        await putHeld;
      }
      await memory.put(id, capability, lane, body);
    },
    read: memory.read.bind(memory),
    ack: memory.ack.bind(memory),
    remove: async (id: string, capability: string) => {
      if (failRemove) throw new Error("Relay delete failed");
      await memory.remove(id, capability);
    },
  };
  const home = persistedHome(relay, statePath, stateKey);
  const revokeOwner = home.revokeOwner.bind(home);
  let markRevoke: () => void = () => undefined;
  const revokeStarted = new Promise<void>((resolve) => {
    markRevoke = resolve;
  });
  home.revokeOwner = (owner) => {
    const pending = revokeOwner(owner);
    markRevoke();
    return pending;
  };
  try {
    const created = await home.createPairing(OWNER);
    const claim = claimOutboundRunner({
      relay,
      mailboxId: created.mailboxId,
      capability: created.capability,
      pairingCode: created.code,
      runnerToken,
      pump: () => home.pump(),
      pollMs: 1,
      sleep: async () => undefined,
    });
    await putStarted;
    const failed = home.revokeOwner(OWNER);
    await revokeStarted;
    releasePut();
    await assert.rejects(failed, /Relay delete failed/);
    await Promise.allSettled([claim]);
    assert.equal(runnerId === "", false);
    await assert.rejects(home.dispatch(OWNER, runnerId, { fixture: "echo-ok" }), /Runner not found/);
    await memory.read(created.mailboxId, created.capability, "to-api");
    failRemove = false;
    await home.revokeOwner(OWNER);
    await assert.rejects(memory.read(created.mailboxId, created.capability, "to-runner"), /Relay mailbox denied/);
    const restarted = persistedHome(memory, statePath, stateKey);
    await assert.rejects(restarted.dispatch(OWNER, runnerId, { fixture: "echo-ok" }), /Runner not found/);
    await assert.rejects(home.dispatch(OWNER, runnerId, { fixture: "echo-ok" }), /Runner not found|Runner revoked/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("expired mailbox delete removes ciphertext and an expired runner fails closed", async () => {
  let now = 1_000_000;
  const memory = createMemoryRelay(RELAY_TOKEN, () => now);
  const home = createHomeRunner({
    relayUrl: "https://relay.test",
    apiToken: API_TOKEN,
    relayToken: RELAY_TOKEN,
    relay: memory,
    now: () => now,
  });
  const created = await home.createPairing(OWNER);
  const claimed = await claimOutboundRunner({
    relay: memory,
    mailboxId: created.mailboxId,
    capability: created.capability,
    pairingCode: created.code,
    pump: () => home.pump(),
    now: () => now,
    pollMs: 1,
    sleep: async () => undefined,
  });
  now += 24 * 60 * 60 * 1000 + 1;
  const expiredRead = await memory.fetch(new Request(`https://relay.test/mailboxes/${created.mailboxId}/to-runner`, {
    headers: { Authorization: `Bearer ${created.capability}` },
  }));
  assert.equal(expiredRead.status, 401);
  const expiredWrite = await memory.fetch(new Request(`https://relay.test/mailboxes/${created.mailboxId}/to-api`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${created.capability}` },
    body: "more",
  }));
  assert.equal(expiredWrite.status, 401);
  const wrongDelete = await memory.fetch(new Request(`https://relay.test/mailboxes/${created.mailboxId}`, {
    method: "DELETE",
    headers: { Authorization: "Bearer wrong-capability" },
  }));
  assert.equal(wrongDelete.status, 401);
  await assert.rejects(home.dispatch(OWNER, claimed.runnerId, { fixture: "echo-ok" }), /Runner revoked/);
  let runs = 0;
  await assert.rejects(
    runFixtureFromMailbox({
      relay: memory,
      mailboxId: created.mailboxId,
      capability: created.capability,
      runnerToken: claimed.runnerToken,
      deadline: claimed.expiresAt,
      now: () => now,
      pollMs: 1,
      sleep: async () => undefined,
      runJob: async () => {
        runs += 1;
        return { stdout: "lilith-fixture-ok\n", stderr: "" };
      },
    }),
    /Runner revoked/,
  );
  assert.equal(runs, 0);
  await home.revoke(OWNER, claimed.runnerId);
  const removed = await memory.fetch(new Request(`https://relay.test/mailboxes/${created.mailboxId}`, {
    method: "DELETE",
    headers: { Authorization: "Bearer wrong-capability" },
  }));
  assert.equal(removed.status, 204);
  await memory.remove(created.mailboxId, created.capability);
  const again = await memory.fetch(new Request(`https://relay.test/mailboxes/${created.mailboxId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${created.capability}` },
  }));
  assert.equal(again.status, 204);

  const capability = "expired-mailbox-capability";
  const capabilityHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(capability)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const storage = createMemoryMailboxStorage();
  const mailboxEnv = { RELAY_ADMIN_TOKEN: RELAY_TOKEN };
  let storedNow = 10_000;
  const room = () => new HomeMailbox({ storage }, mailboxEnv);
  const init = await room().fetch(new Request("https://mailbox.internal/internal/init", {
    method: "POST",
    headers: { Authorization: `Bearer ${RELAY_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ capabilityHash, expiresAt: storedNow + 1_000 }),
  }), () => storedNow);
  assert.equal(init.status, 204);
  const put = await room().fetch(new Request("https://mailbox.internal/internal/to-runner", {
    method: "PUT",
    headers: { Authorization: `Bearer ${capability}` },
    body: "ciphertext",
  }), () => storedNow);
  assert.equal(put.status, 204);
  const restarted = await room().fetch(new Request("https://mailbox.internal/internal/to-runner", {
    headers: { Authorization: `Bearer ${capability}` },
  }), () => storedNow);
  assert.equal(restarted.status, 200);
  assert.equal(await restarted.text(), "ciphertext");
  storedNow += 1_001;
  const deniedRead = await room().fetch(new Request("https://mailbox.internal/internal/to-runner", {
    headers: { Authorization: `Bearer ${capability}` },
  }), () => storedNow);
  assert.equal(deniedRead.status, 401);
  const deniedAck = await room().fetch(new Request("https://mailbox.internal/internal/to-runner", {
    method: "DELETE",
    headers: { Authorization: `Bearer ${capability}` },
  }), () => storedNow);
  assert.equal(deniedAck.status, 401);
  const deniedDelete = await new HomeMailbox({ storage }, mailboxEnv).fetch(new Request("https://mailbox.internal/internal", {
    method: "DELETE",
    headers: { Authorization: "Bearer wrong-capability" },
  }), () => storedNow);
  assert.equal(deniedDelete.status, 401);
  assert.equal(await storage.get("mailbox") !== undefined, true);
  const deleted = await new HomeMailbox({ storage }, mailboxEnv).fetch(new Request("https://mailbox.internal/internal", {
    method: "DELETE",
    headers: { Authorization: `Bearer ${capability}` },
  }), () => storedNow);
  assert.equal(deleted.status, 204);
  assert.equal(await storage.get("mailbox"), undefined);
  const repeat = await new HomeMailbox({ storage }, mailboxEnv).fetch(new Request("https://mailbox.internal/internal", {
    method: "DELETE",
    headers: { Authorization: `Bearer ${capability}` },
  }), () => storedNow);
  assert.equal(repeat.status, 204);
});

test("expired pairing retries a failed mailbox delete and does not keep the capability", async () => {
  let now = 1_000_000;
  let removes = 0;
  const memory = createMemoryRelay(RELAY_TOKEN, () => now);
  const relay = {
    create: memory.create.bind(memory),
    put: memory.put.bind(memory),
    read: memory.read.bind(memory),
    ack: memory.ack.bind(memory),
    remove: async (id: string, capability: string) => {
      removes += 1;
      if (removes === 1) throw new Error("Relay delete failed");
      await memory.remove(id, capability);
    },
  };
  const home = createHomeRunner({
    relayUrl: "https://relay.test",
    apiToken: API_TOKEN,
    relayToken: RELAY_TOKEN,
    relay,
    now: () => now,
  });
  const created = await home.createPairing(OWNER);
  now += 5 * 60 * 1000 + 1;
  await home.pump();
  assert.equal(removes, 1);
  const readAfterFailure = await memory.read(created.mailboxId, created.capability, "to-api");
  assert.equal(readAfterFailure, null);
  await home.pump();
  assert.equal(removes, 2);
  await assert.rejects(memory.read(created.mailboxId, created.capability, "to-api"), /Relay mailbox denied/);
  await assert.rejects(
    claimOutboundRunner({
      relay,
      mailboxId: created.mailboxId,
      capability: created.capability,
      pairingCode: created.code,
      pump: () => home.pump(),
      now: () => now,
      pollMs: 1,
      sleep: async () => undefined,
    }),
    /Relay write failed|Relay mailbox denied|Pairing expired/,
  );
});

test("node entry and outbound cli start without importing cloudflare workers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lilith-node-entry-"));
  const child = spawn(process.execPath, [join(import.meta.dirname, "index.ts")], {
    cwd: dir,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      LOCAL_API_TOKEN: API_TOKEN,
      ALPHA_OWNER_ID: OWNER.ownerId,
      HOST: "127.0.0.1",
      PORT: "0",
    },
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(output || "API startup timed out")), 8_000);
      child.stdout.on("data", () => {
        if (!output.includes("API listening")) return;
        clearTimeout(timer);
        resolve();
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`API exited ${code}: ${output}`));
      });
    });
    assert.match(output, /API listening on http:\/\/127\.0\.0\.1:0/);
    assert.equal(/cloudflare:workers|ERR_UNKNOWN_BUILTIN_MODULE/.test(output), false);
  } finally {
    const exited = new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve(undefined);
      else child.on("exit", () => resolve(undefined));
    });
    child.kill();
    await exited;
    await rm(dir, { recursive: true, force: true });
  }

  const cliDir = await mkdtemp(join(tmpdir(), "lilith-outbound-"));
  const cli = spawn(process.execPath, [join(import.meta.dirname, "outbound-runner.ts")], {
    cwd: cliDir,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
  });
  let cliOut = "";
  cli.stdout.on("data", (chunk: Buffer) => {
    cliOut += chunk.toString();
  });
  cli.stderr.on("data", (chunk: Buffer) => {
    cliOut += chunk.toString();
  });
  try {
    const code = await new Promise<number | null>((resolve) => {
      cli.on("exit", (status) => resolve(status));
    });
    assert.equal(code, 1);
    assert.match(cliOut, /Home runner relay, mailbox, capability, and pairing code are required/);
    assert.equal(/cloudflare:workers|ERR_UNKNOWN_BUILTIN_MODULE/.test(cliOut), false);
  } finally {
    await rm(cliDir, { recursive: true, force: true });
  }
});

test("overlapping pumps pair once", async () => {
  const memory = createMemoryRelay(RELAY_TOKEN);
  let runnerPuts = 0;
  let holdFirstRead = true;
  let releaseFirst: () => void = () => undefined;
  const firstReadHeld = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const relay = {
    create: memory.create.bind(memory),
    put: async (id: string, capability: string, lane: "to-runner" | "to-api", body: string) => {
      if (lane === "to-runner") runnerPuts += 1;
      await memory.put(id, capability, lane, body);
    },
    read: async (id: string, capability: string, lane: "to-runner" | "to-api") => {
      if (holdFirstRead && lane === "to-api") {
        holdFirstRead = false;
        await firstReadHeld;
      }
      return memory.read(id, capability, lane);
    },
    ack: memory.ack.bind(memory),
    remove: memory.remove.bind(memory),
  };
  const home = createHomeRunner({
    relayUrl: "https://relay.test",
    apiToken: API_TOKEN,
    relayToken: RELAY_TOKEN,
    relay,
  });
  const created = await home.createPairing(OWNER);
  const claimed = await claimOutboundRunner({
    relay,
    mailboxId: created.mailboxId,
    capability: created.capability,
    pairingCode: created.code,
    pump: async () => {
      const both = Promise.all([home.pump(), home.pump()]);
      await new Promise((resolve) => setImmediate(resolve));
      releaseFirst();
      await both;
    },
  });
  assert.equal(claimed.ownerId, OWNER.ownerId);
  assert.equal(runnerPuts, 1);
});

test("blank home runner persistence config is skipped", () => {
  assert.equal(loadHomeStateKey({}, API_TOKEN, ""), null);
  assert.equal(loadHomeStateKey({ LILITH_HOME_STATE_KEY: "   " }, API_TOKEN, ""), null);
  assert.equal(loadRelayConfig({}, API_TOKEN), null);
  assert.throws(
    () => loadHomeStateKey({ LILITH_HOME_STATE_KEY: API_TOKEN }, API_TOKEN, RELAY_TOKEN),
    /distinct server-held key/,
  );
  assert.throws(
    () => loadHomeStateKey({ LILITH_HOME_STATE_KEY: RELAY_TOKEN }, API_TOKEN, RELAY_TOKEN),
    /distinct server-held key/,
  );
  assert.throws(() => loadHomeStateKey({ LILITH_HOME_STATE_KEY: "short" }, API_TOKEN, ""), /32 bytes/);
});

test("restart keeps owner revoke and account delete able to remove the mailbox", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lilith-home-state-"));
  const statePath = join(dir, ".lilith-home-runner.json");
  const stateKey = randomBytes(32);
  const memory = createMemoryRelay(RELAY_TOKEN);
  try {
    const first = persistedHome(memory, statePath, stateKey);
    const created = await first.createPairing(OWNER);
    const claimed = await claimOutboundRunner({
      relay: memory,
      mailboxId: created.mailboxId,
      capability: created.capability,
      pairingCode: created.code,
      pump: () => first.pump(),
      pollMs: 1,
      sleep: async () => undefined,
    });
    const queued = await first.dispatch(OWNER, claimed.runnerId, { fixture: "echo-ok" });
    const disk = readFileSync(statePath, "utf8");
    assert.equal(disk.includes(created.code), false);
    assert.equal(disk.includes(created.capability), false);
    assert.equal(disk.includes(claimed.runnerToken), false);
    assert.equal(disk.includes(API_TOKEN), false);
    assert.equal(disk.includes(RELAY_TOKEN), false);
    if (process.platform !== "win32") assert.equal(statSync(statePath).mode & 0o777, 0o600);
    const restarted = persistedHome(memory, statePath, stateKey);
    assert.equal(restarted.status(OWNER, claimed.runnerId, queued.id).state, "queued");
    await assert.rejects(restarted.revoke(OTHER, claimed.runnerId), /Runner not found/);
    await restarted.revoke(OWNER, claimed.runnerId);
    await assert.rejects(memory.read(created.mailboxId, created.capability, "to-runner"), /Relay mailbox denied/);
    const again = persistedHome(memory, statePath, stateKey);
    const open = await again.createPairing(OWNER);
    const deletedHome = persistedHome(memory, statePath, stateKey);
    await withServer(deletedHome, async (base) => {
      const deleted = await fetch(`${base}/account/delete`, {
        method: "POST",
        headers: { ...auth(), "Content-Type": "application/json" },
        body: JSON.stringify({ consent: true }),
      });
      assert.equal(deleted.status, 200);
      assert.deepEqual(await deleted.json(), { deleted: true });
    });
    await assert.rejects(memory.read(open.mailboxId, open.capability, "to-runner"), /Relay mailbox denied/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("wrong key and corrupt home runner state fail closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lilith-home-state-bad-"));
  const statePath = join(dir, ".lilith-home-runner.json");
  const stateKey = randomBytes(32);
  const memory = createMemoryRelay(RELAY_TOKEN);
  try {
    const home = persistedHome(memory, statePath, stateKey);
    await home.createPairing(OWNER);
    const disk = readFileSync(statePath);
    assert.throws(
      () => persistedHome(memory, statePath, randomBytes(32)),
      /Home runner state is unreadable/,
    );
    assert.deepEqual(readFileSync(statePath), disk);
    writeFileSync(statePath, "{not-json");
    assert.throws(() => persistedHome(memory, statePath, stateKey), /Home runner state is unreadable/);
    assert.equal(readFileSync(statePath, "utf8"), "{not-json");
    assert.throws(() => createHomeRunner({
      relayUrl: "https://relay.test",
      apiToken: API_TOKEN,
      relayToken: RELAY_TOKEN,
      relay: memory,
      statePath,
    }), /Home runner state key is required/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mailbox alarm purges ciphertext after a durable object restart", async () => {
  const capability = "alarm-mailbox-capability";
  const capabilityHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(capability)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const storage = createMemoryMailboxStorage();
  const mailboxEnv = { RELAY_ADMIN_TOKEN: RELAY_TOKEN };
  let now = 5_000;
  const expiresAt = now + 1_000;
  const room = () => new HomeMailbox({ storage }, mailboxEnv);
  const init = await room().fetch(new Request("https://mailbox.internal/internal/init", {
    method: "POST",
    headers: { Authorization: `Bearer ${RELAY_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ capabilityHash, expiresAt }),
  }), () => now);
  assert.equal(init.status, 204);
  assert.equal(await storage.getAlarm?.(), expiresAt);
  const put = await room().fetch(new Request("https://mailbox.internal/internal/to-runner", {
    method: "PUT",
    headers: { Authorization: `Bearer ${capability}` },
    body: "ciphertext-at-rest",
  }), () => now);
  assert.equal(put.status, 204);
  await room().alarm(() => now);
  assert.equal(await storage.get("mailbox") !== undefined, true);
  const early = await room().fetch(new Request("https://mailbox.internal/internal/to-runner", {
    headers: { Authorization: `Bearer ${capability}` },
  }), () => now);
  assert.equal(await early.text(), "ciphertext-at-rest");
  now = expiresAt;
  const restarted = room();
  await restarted.alarm(() => now);
  assert.equal(await storage.get("mailbox"), undefined);
  assert.equal(await storage.getAlarm?.(), null);
  const denied = await room().fetch(new Request("https://mailbox.internal/internal/to-runner", {
    headers: { Authorization: `Bearer ${capability}` },
  }), () => now);
  assert.equal(denied.status, 401);
  const deleted = await room().fetch(new Request("https://mailbox.internal/internal", {
    method: "DELETE",
    headers: { Authorization: `Bearer ${capability}` },
  }), () => now);
  assert.equal(deleted.status, 204);
  const env = { RELAY_ADMIN_TOKEN: RELAY_TOKEN, MAILBOX: localMailboxNamespace(RELAY_TOKEN) };
  const bypass = await relayWorkerFetch(new Request("https://relay.test/mailboxes/alarm-target/alarm", { method: "DELETE" }), env);
  assert.equal(bypass.status, 404);
});

test("expired claimed runner retries mailbox delete", async () => {
  let now = 1_000_000;
  let removes = 0;
  const memory = createMemoryRelay(RELAY_TOKEN, () => now);
  const relay = {
    create: memory.create.bind(memory),
    put: memory.put.bind(memory),
    read: memory.read.bind(memory),
    ack: memory.ack.bind(memory),
    remove: async (id: string, capability: string) => {
      removes += 1;
      if (removes === 1) throw new Error("Relay delete failed");
      await memory.remove(id, capability);
    },
  };
  const home = createHomeRunner({
    relayUrl: "https://relay.test",
    apiToken: API_TOKEN,
    relayToken: RELAY_TOKEN,
    relay,
    now: () => now,
  });
  const created = await home.createPairing(OWNER);
  const claimed = await claimOutboundRunner({
    relay,
    mailboxId: created.mailboxId,
    capability: created.capability,
    pairingCode: created.code,
    pump: () => home.pump(),
    now: () => now,
    pollMs: 1,
    sleep: async () => undefined,
  });
  const queued = await home.dispatch(OWNER, claimed.runnerId, { fixture: "echo-ok" });
  now += 24 * 60 * 60 * 1000 + 1;
  await home.pump();
  assert.equal(removes, 1);
  assert.equal(home.status(OWNER, claimed.runnerId, queued.id).state, "failed");
  const stillThere = await memory.fetch(new Request(`https://relay.test/mailboxes/${created.mailboxId}`, {
    method: "DELETE",
    headers: { Authorization: "Bearer wrong-capability" },
  }));
  assert.equal(stillThere.status, 401);
  await home.pump();
  assert.equal(removes, 2);
  const gone = await memory.fetch(new Request(`https://relay.test/mailboxes/${created.mailboxId}`, {
    method: "DELETE",
    headers: { Authorization: "Bearer wrong-capability" },
  }));
  assert.equal(gone.status, 204);
});

test("relay without a state key fails closed before listen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lilith-home-key-"));
  const child = spawn(process.execPath, [join(import.meta.dirname, "index.ts")], {
    cwd: dir,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      LOCAL_API_TOKEN: API_TOKEN,
      ALPHA_OWNER_ID: OWNER.ownerId,
      HOST: "127.0.0.1",
      PORT: "0",
      LILITH_RELAY_URL: "https://relay.example",
      LILITH_RELAY_TOKEN: RELAY_TOKEN,
    },
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(output || "API startup timed out")), 8_000);
      child.on("exit", (status) => {
        clearTimeout(timer);
        resolve(status);
      });
    });
    assert.equal(code, 1);
    assert.match(output, /LILITH_HOME_STATE_KEY is required/);
    assert.equal(output.includes("API listening"), false);
  } finally {
    child.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

test("wrangler dry-run bundles the sqlite durable object", async () => {
  const out = await mkdtemp(join(tmpdir(), "lilith-relay-"));
  const exec = promisify(execFile);
  try {
    const { stdout, stderr } = await exec(
      process.execPath,
      [join(import.meta.dirname, "..", "..", "..", "node_modules", "wrangler", "bin", "wrangler.js"), "deploy", "--dry-run", "--outdir", out],
      {
        cwd: join(import.meta.dirname, ".."),
        env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "true" },
      },
    );
    const output = `${stdout}\n${stderr}`;
    assert.match(output, /--dry-run|Dry run|dry run/i);
    assert.equal(/Uploaded|Deployed|Published/i.test(output), false);
    const mailboxSource = readFileSync(join(import.meta.dirname, "relay-mailbox.ts"), "utf8");
    const objectSource = readFileSync(join(import.meta.dirname, "relay-object.ts"), "utf8");
    assert.equal(mailboxSource.includes('from "cloudflare:workers"'), false);
    assert.equal(objectSource.includes('from "cloudflare:workers"'), true);
    assert.equal(objectSource.includes("export class HomeMailbox"), true);
    assert.equal(objectSource.includes("alarm("), true);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

type IsolatedCall = { command: readonly string[]; workspace: string };

function persistedHome(
  relay: RelayMailbox,
  statePath: string,
  stateKey: Buffer,
): HomeRunner {
  return createHomeRunner({
    relayUrl: "https://relay.test",
    apiToken: API_TOKEN,
    relayToken: RELAY_TOKEN,
    relay,
    statePath,
    stateKey,
  });
}

function openPaired(secret: string, blob: string): { runnerId: string } {
  const raw = Buffer.from(blob, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", createHash("sha256").update(secret).digest(), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  const opened = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8")) as { runnerId?: unknown };
  if (typeof opened.runnerId !== "string" || opened.runnerId === "") throw new Error("Paired envelope missing runner id");
  return { runnerId: opened.runnerId };
}

function auth(): { Authorization: string } {
  return { Authorization: `Bearer ${API_TOKEN}` };
}

function harnessFor(sent: string[]) {
  const memory = createMemoryRelay(RELAY_TOKEN);
  const relay = {
    create: memory.create.bind(memory),
    put: async (id: string, capability: string, lane: "to-runner" | "to-api", body: string) => {
      sent.push(body);
      await memory.put(id, capability, lane, body);
    },
    read: memory.read.bind(memory),
    ack: memory.ack.bind(memory),
    remove: memory.remove.bind(memory),
  };
  const home = createHomeRunner({
    relayUrl: "https://relay.test",
    apiToken: API_TOKEN,
    relayToken: RELAY_TOKEN,
    relay,
  });
  const fetchRelay = relayMailboxFromFetch("https://relay.test", null, async (input, init) => {
    const url = String(input);
    assert.equal(url.startsWith("https://relay.test/"), true);
    const headers = new Headers(init?.headers);
    const authorization = headers.get("authorization");
    assert.equal(authorization === `Bearer ${API_TOKEN}`, false);
    assert.equal(authorization === `Bearer ${RELAY_TOKEN}`, false);
    if (typeof init?.body === "string") sent.push(init.body);
    return memory.fetch(new Request(url, init));
  });
  return { home, fetchRelay };
}

async function readJson(response: Response): Promise<unknown> {
  assert.equal(response.ok, true);
  return response.json();
}

async function withServer(home: HomeRunner | null, run: (base: string) => Promise<void>): Promise<void> {
  const server = createHealthServer({ token: API_TOKEN, ownerId: OWNER.ownerId }, undefined, undefined, {}, undefined, undefined, home);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a TCP address");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
