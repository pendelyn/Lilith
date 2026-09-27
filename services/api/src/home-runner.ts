import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import {
  HOME_RUNNER_FIXTURE,
  parseHomeRunnerJobRequest,
  parseHomeRunnerJobStatus,
  parseRunnerPairingResponse,
} from "@lilith/contracts";
import type { OwnerContext } from "./auth.ts";
import type { RelayMailbox } from "./relay-mailbox.ts";
import { RUNNER_WORKSPACES_ROOT, runIsolatedJob, type IsolatedJob, type JobResult } from "./runner.ts";

export const PAIRING_TTL_MS = 5 * 60 * 1000;
export const RUNNER_TTL_MS = 24 * 60 * 60 * 1000;
export const FIXTURE_COMMAND = ["/bin/echo", "lilith-fixture-ok"] as const;

type Pairing = {
  id: string;
  ownerId: string;
  code: string;
  mailboxId: string;
  capability: string;
  expiresAt: number;
  consumed: boolean;
};

type RunnerRecord = {
  id: string;
  ownerId: string;
  token: string;
  mailboxId: string;
  capability: string;
  expiresAt: number;
  revoked: boolean;
};

type JobRecord = {
  id: string;
  runnerId: string;
  ownerId: string;
  state: "queued" | "completed" | "failed";
  stdout: string;
  stderr: string;
  settled: boolean;
};

export type HomeRunner = {
  relayUrl: string;
  pump(): Promise<void>;
  createPairing(owner: OwnerContext): Promise<ReturnType<typeof parseRunnerPairingResponse>>;
  revoke(owner: OwnerContext, runnerId: string): Promise<void>;
  revokeOwner(owner: OwnerContext): Promise<void>;
  dispatch(owner: OwnerContext, runnerId: string, body: unknown): Promise<{ id: string }>;
  status(owner: OwnerContext, runnerId: string, jobId: string): ReturnType<typeof parseHomeRunnerJobStatus>;
};

export function loadRelayConfig(
  env: NodeJS.Dict<string | undefined>,
  apiToken: string,
): { url: string; token: string } | null {
  const url = env.LILITH_RELAY_URL?.trim() ?? "";
  const token = env.LILITH_RELAY_TOKEN?.trim() ?? "";
  if (url === "" && token === "") return null;
  if (url === "" || token === "") throw new Error("LILITH_RELAY_URL and LILITH_RELAY_TOKEN are both required");
  if (token === apiToken) throw new Error("LILITH_RELAY_TOKEN must not reuse LOCAL_API_TOKEN");
  if (!url.startsWith("https://")) throw new Error("LILITH_RELAY_URL must be https");
  return { url, token };
}

export function loadHomeStateKey(
  env: NodeJS.Dict<string | undefined>,
  apiToken: string,
  relayToken: string,
): Buffer | null {
  const raw = env.LILITH_HOME_STATE_KEY?.trim() ?? "";
  if (raw === "") return null;
  if (raw === apiToken || (relayToken !== "" && raw === relayToken)) {
    throw new Error("LILITH_HOME_STATE_KEY must be a distinct server-held key");
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) throw new Error("LILITH_HOME_STATE_KEY must be 32 bytes");
  const key = Buffer.from(raw, "base64url");
  if (key.length !== 32) throw new Error("LILITH_HOME_STATE_KEY must be 32 bytes");
  return key;
}

export function fixtureIsolatedJob(id: string, workspace: string): IsolatedJob {
  return { id, workspace, command: [...FIXTURE_COMMAND], timeoutMs: 60_000 };
}

export function createHomeRunner(options: {
  relayUrl: string;
  apiToken: string;
  relayToken: string;
  relay: RelayMailbox;
  now?: () => number;
  statePath?: string;
  stateKey?: Buffer;
}): HomeRunner {
  if (!options.relayUrl.startsWith("https://")) throw new Error("LILITH_RELAY_URL must be https");
  if (options.relayToken === "" || options.relayToken === options.apiToken) {
    throw new Error("LILITH_RELAY_TOKEN must not reuse LOCAL_API_TOKEN");
  }
  const now = options.now ?? Date.now;
  const relay = options.relay;
  const statePath = options.statePath;
  const stateKey = options.stateKey;
  if (statePath !== undefined && stateKey === undefined) throw new Error("Home runner state key is required");
  if (statePath === undefined && stateKey !== undefined) throw new Error("Home runner state path is required");
  const pairings = new Map<string, Pairing>();
  const runners = new Map<string, RunnerRecord>();
  const jobs = new Map<string, JobRecord>();
  if (statePath !== undefined && stateKey !== undefined) loadHomeState(statePath, stateKey, pairings, runners, jobs);
  const deleting = new Set<string>();

  function commit(apply: () => void): void {
    const snap = snapshotHome(pairings, runners, jobs);
    apply();
    if (statePath === undefined || stateKey === undefined) return;
    try {
      writeHomeState(statePath, stateKey, pairings, runners, jobs);
    } catch (error) {
      restoreHome(snap, pairings, runners, jobs);
      throw error;
    }
  }
  const pendingCreates = new Map<string, Set<Promise<void>>>();
  let pumpTail: Promise<void> = Promise.resolve();

  function pump(): Promise<void> {
    const run = pumpTail.then(runPump);
    pumpTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function joinPump(): Promise<void> {
    // Await the current pump only. Calling pump() here deadlocks when the caller is that pump.
    for (;;) {
      const inflight = pumpTail;
      await inflight;
      if (inflight === pumpTail) return;
    }
  }

  async function runPump(): Promise<void> {
    for (const pairing of pairings.values()) {
      if (deleting.has(pairing.ownerId)) continue;
      await ingestPairing(pairing);
    }
    for (const runner of runners.values()) {
      if (deleting.has(runner.ownerId)) continue;
      await expireRunner(runner);
    }
    for (const job of jobs.values()) {
      if (deleting.has(job.ownerId)) continue;
      await ingestJob(job);
    }
  }

  async function expireRunner(runner: RunnerRecord): Promise<void> {
    if (runner.revoked || runner.capability === "" || runner.expiresAt > now()) return;
    try {
      await relay.remove(runner.mailboxId, runner.capability);
    } catch {
      return;
    }
    const mailboxId = runner.mailboxId;
    commit(() => {
      runner.revoked = true;
      runner.token = "";
      runner.capability = "";
      for (const pairing of pairings.values()) {
        if (pairing.mailboxId !== mailboxId) continue;
        pairing.consumed = true;
        pairing.code = "";
        pairing.capability = "";
      }
      for (const job of jobs.values()) {
        if (job.runnerId !== runner.id || job.settled) continue;
        job.state = "failed";
        job.settled = true;
        job.stderr = "Runner unavailable";
      }
    });
  }

  async function ingestPairing(pairing: Pairing): Promise<void> {
    if (deleting.has(pairing.ownerId)) return;
    const runner = [...runners.values()].find((item) => item.mailboxId === pairing.mailboxId);
    if (pairing.consumed) {
      await rejectLateClaim(pairing, runner);
      return;
    }
    if (pairing.expiresAt <= now()) {
      try {
        await relay.remove(pairing.mailboxId, pairing.capability);
      } catch {
        return;
      }
      commit(() => {
        pairing.consumed = true;
        pairing.code = "";
        pairing.capability = "";
      });
      return;
    }
    const body = await relay.read(pairing.mailboxId, pairing.capability, "to-api");
    if (body === null || deleting.has(pairing.ownerId)) return;
    let claim: unknown;
    try {
      claim = open(pairing.code, body);
    } catch {
      return;
    }
    if (deleting.has(pairing.ownerId)) return;
    if (!isClaim(claim) || forbiddenToken(claim.runnerToken, pairing.code)) {
      commit(() => {
        pairing.consumed = true;
        pairing.code = "";
      });
      await rejectEnvelope(pairing);
      return;
    }
    if (deleting.has(pairing.ownerId)) return;
    const created: RunnerRecord = {
      id: randomUUID(),
      ownerId: pairing.ownerId,
      token: claim.runnerToken,
      mailboxId: pairing.mailboxId,
      capability: pairing.capability,
      expiresAt: now() + RUNNER_TTL_MS,
      revoked: false,
    };
    await relay.put(
      pairing.mailboxId,
      pairing.capability,
      "to-runner",
      seal(created.token, {
        type: "paired",
        runnerId: created.id,
        ownerId: created.ownerId,
        expiresAt: created.expiresAt,
      }),
    );
    if (deleting.has(pairing.ownerId) || pairing.consumed) return;
    commit(() => {
      runners.set(created.id, created);
      pairing.consumed = true;
      pairing.code = "";
    });
    await relay.ack(pairing.mailboxId, pairing.capability, "to-api");
  }

  async function rejectLateClaim(pairing: Pairing, runner: RunnerRecord | undefined): Promise<void> {
    const body = await relay.read(pairing.mailboxId, pairing.capability, "to-api").catch(() => null);
    if (body === null || (runner !== undefined && opensAsResult(runner.token, body))) return;
    const pending =
      runner !== undefined && [...jobs.values()].some((job) => job.runnerId === runner.id && !job.settled);
    if (pending) return;
    await rejectEnvelope(pairing);
  }

  async function rejectEnvelope(pairing: Pairing): Promise<void> {
    const queued = await relay.read(pairing.mailboxId, pairing.capability, "to-runner").catch(() => null);
    if (queued === null) {
      await relay.put(pairing.mailboxId, pairing.capability, "to-runner", REJECTED).catch(() => undefined);
    }
    await relay.ack(pairing.mailboxId, pairing.capability, "to-api").catch(() => undefined);
  }

  async function ingestJob(job: JobRecord): Promise<void> {
    const runner = runners.get(job.runnerId);
    if (!runner || runner.revoked || runner.token === "" || runner.expiresAt <= now()) {
      if (!job.settled) {
        commit(() => {
          job.state = "failed";
          job.settled = true;
          job.stderr = "Runner unavailable";
        });
      }
      return;
    }
    const body = await relay.read(runner.mailboxId, runner.capability, "to-api").catch(() => null);
    if (body === null) return;
    let result: unknown;
    try {
      result = open(runner.token, body);
    } catch {
      return;
    }
    if (!isResult(result) || result.jobId !== job.id || result.runnerId !== runner.id || result.ownerId !== runner.ownerId) {
      return;
    }
    if (!job.settled) {
      const secrets = [options.apiToken, options.relayToken, runner.token, runner.capability];
      const stdout = redact(result.stdout, secrets);
      const stderr = redact(result.stderr, secrets);
      const state = result.ok ? "completed" : "failed";
      commit(() => {
        job.stdout = stdout;
        job.stderr = stderr;
        job.state = state;
        job.settled = true;
      });
    }
    await relay.ack(runner.mailboxId, runner.capability, "to-api");
  }

  async function revokeOne(owner: OwnerContext, runnerId: string): Promise<void> {
    const pairing = pairings.get(runnerId);
    if (pairing) {
      if (pairing.ownerId !== owner.ownerId) throw new Error("Runner not found");
      const claimed = [...runners.values()].find((item) => item.mailboxId === pairing.mailboxId);
      if (!claimed) {
        if (pairing.capability === "") {
          if (pairing.consumed) return;
          throw new Error("Relay delete failed");
        }
        await relay.remove(pairing.mailboxId, pairing.capability);
        commit(() => {
          pairing.consumed = true;
          pairing.code = "";
          pairing.capability = "";
        });
        return;
      }
    }
    const runner = requireRunner(runners, owner, runnerId);
    if (runner.capability === "") {
      if (runner.revoked) return;
      throw new Error("Relay delete failed");
    }
    await relay.remove(runner.mailboxId, runner.capability);
    const mailboxId = runner.mailboxId;
    commit(() => {
      runner.revoked = true;
      runner.token = "";
      runner.capability = "";
      for (const pairing of pairings.values()) {
        if (pairing.mailboxId !== mailboxId) continue;
        pairing.consumed = true;
        pairing.code = "";
        pairing.capability = "";
      }
      for (const job of jobs.values()) {
        if (job.runnerId !== runner.id || job.settled) continue;
        job.state = "failed";
        job.settled = true;
        job.stderr = "Runner revoked";
      }
    });
  }

  function forbiddenToken(token: string, pairingCode: string): boolean {
    return token === options.apiToken || token === options.relayToken || token === pairingCode || token.length < 32;
  }

  return {
    relayUrl: options.relayUrl,
    pump,
    async createPairing(owner) {
      if (deleting.has(owner.ownerId)) throw new Error("Runner revoked");
      const expiresAt = now() + PAIRING_TTL_MS;
      const task = relay.create(now() + RUNNER_TTL_MS).then((mailbox) => {
        const pairing: Pairing = {
          id: randomUUID(),
          ownerId: owner.ownerId,
          code: randomBytes(32).toString("base64url"),
          mailboxId: mailbox.id,
          capability: mailbox.capability,
          expiresAt,
          consumed: false,
        };
        commit(() => {
          pairings.set(pairing.id, pairing);
        });
        return pairing;
      });
      trackCreate(pendingCreates, owner.ownerId, task);
      const pairing = await task;
      if (deleting.has(owner.ownerId)) throw new Error("Runner revoked");
      return parseRunnerPairingResponse({
        pairingId: pairing.id,
        code: pairing.code,
        expiresAt,
        mailboxId: pairing.mailboxId,
        capability: pairing.capability,
        relayUrl: options.relayUrl,
      });
    },
    async revoke(owner, runnerId) {
      await joinPump();
      await revokeOne(owner, runnerId);
    },
    async revokeOwner(owner) {
      deleting.add(owner.ownerId);
      const pending = pendingCreates.get(owner.ownerId);
      if (pending !== undefined && pending.size > 0) await Promise.all([...pending]);
      await joinPump();
      try {
        const runnerIds = [...runners.values()].filter((item) => item.ownerId === owner.ownerId && !item.revoked).map((item) => item.id);
        for (const id of runnerIds) await revokeOne(owner, id);
        const pairingIds = [...pairings.values()].filter((item) => item.ownerId === owner.ownerId && !item.consumed).map((item) => item.id);
        for (const id of pairingIds) await revokeOne(owner, id);
        commit(() => {
          for (const runner of runners.values()) {
            if (runner.ownerId !== owner.ownerId) continue;
            runner.token = "";
            runner.capability = "";
            runner.revoked = true;
          }
          for (const pairing of pairings.values()) {
            if (pairing.ownerId !== owner.ownerId) continue;
            pairing.code = "";
            pairing.capability = "";
            pairing.consumed = true;
          }
        });
      } catch (error) {
        deleting.delete(owner.ownerId);
        throw error;
      }
    },
    async dispatch(owner, runnerId, body) {
      if (deleting.has(owner.ownerId)) throw new Error("Runner revoked");
      const request = parseHomeRunnerJobRequest(body);
      if (request.fixture !== HOME_RUNNER_FIXTURE) throw new Error("Unknown fixture");
      const runner = requireRunner(runners, owner, runnerId);
      if (runner.revoked || runner.expiresAt <= now()) throw new Error("Runner revoked");
      if ([...jobs.values()].some((item) => item.runnerId === runner.id && !item.settled)) {
        throw new Error("Runner busy");
      }
      const job: JobRecord = {
        id: randomUUID(),
        runnerId: runner.id,
        ownerId: runner.ownerId,
        state: "queued",
        stdout: "",
        stderr: "",
        settled: false,
      };
      try {
        await relay.put(
          runner.mailboxId,
          runner.capability,
          "to-runner",
          seal(runner.token, {
            type: "job",
            jobId: job.id,
            runnerId: runner.id,
            ownerId: runner.ownerId,
            fixture: HOME_RUNNER_FIXTURE,
          }),
        );
      } catch (error) {
        if (error instanceof Error && error.message === "Relay lane busy") throw new Error("Runner busy");
        throw error;
      }
      if (deleting.has(owner.ownerId) || runner.revoked) throw new Error("Runner revoked");
      commit(() => {
        jobs.set(job.id, job);
      });
      return { id: job.id };
    },
    status(owner, runnerId, jobId) {
      requireRunner(runners, owner, runnerId);
      const job = jobs.get(jobId);
      if (!job || job.ownerId !== owner.ownerId || job.runnerId !== runnerId) throw new Error("Runner not found");
      return parseHomeRunnerJobStatus({
        id: job.id,
        runnerId: job.runnerId,
        state: job.state,
        stdout: job.stdout,
        stderr: job.stderr,
      });
    },
  };
}

export async function routeHomeRunner(
  req: IncomingMessage,
  res: ServerResponse,
  owner: OwnerContext,
  home: HomeRunner,
  pathname: string,
): Promise<void> {
  try {
    if (pathname === "/runners/pairings") {
      if (req.method !== "POST") {
        res.writeHead(405, { Allow: "POST" });
        res.end();
        return;
      }
      assertEmpty(await readBody(req));
      writeJson(res, 201, await home.createPairing(owner));
      return;
    }
    const revoke = /^\/runners\/([^/]+)\/revoke$/.exec(pathname);
    if (revoke?.[1]) {
      if (req.method !== "POST") {
        res.writeHead(405, { Allow: "POST" });
        res.end();
        return;
      }
      assertEmpty(await readBody(req));
      await home.revoke(owner, decodeURIComponent(revoke[1]));
      res.writeHead(204);
      res.end();
      return;
    }
    const jobs = /^\/runners\/([^/]+)\/jobs$/.exec(pathname);
    if (jobs?.[1]) {
      if (req.method !== "POST") {
        res.writeHead(405, { Allow: "POST" });
        res.end();
        return;
      }
      const created = await home.dispatch(owner, decodeURIComponent(jobs[1]), await readBody(req));
      writeJson(res, 201, created);
      return;
    }
    const status = /^\/runners\/([^/]+)\/jobs\/([^/]+)$/.exec(pathname);
    if (status?.[1] && status[2]) {
      if (req.method !== "GET") {
        res.writeHead(405, { Allow: "GET" });
        res.end();
        return;
      }
      await home.pump();
      writeJson(res, 200, home.status(owner, decodeURIComponent(status[1]), decodeURIComponent(status[2])));
      return;
    }
    res.writeHead(404);
    res.end();
  } catch (error) {
    if (res.headersSent) return;
    res.writeHead(statusFor(error));
    res.end();
  }
}

export function isHomeRunnerPath(pathname: string): boolean {
  return pathname === "/runners/pairings" || pathname.startsWith("/runners/");
}

export type OutboundEnv = {
  relayUrl: string;
  mailboxId: string;
  capability: string;
  pairingCode: string;
};

export function loadOutboundRunnerEnv(env: NodeJS.Dict<string | undefined>): OutboundEnv {
  const relayUrl = env.LILITH_RELAY_URL?.trim() ?? "";
  const mailboxId = env.LILITH_MAILBOX_ID?.trim() ?? "";
  const capability = env.LILITH_MAILBOX_CAPABILITY?.trim() ?? "";
  const pairingCode = env.LILITH_PAIRING_CODE?.trim() ?? "";
  if (relayUrl === "" || mailboxId === "" || capability === "" || pairingCode === "") {
    throw new Error("Home runner relay, mailbox, capability, and pairing code are required");
  }
  if (!relayUrl.startsWith("https://")) throw new Error("LILITH_RELAY_URL must be https");
  if (productionCredential(env) !== null) throw new Error("Home runner refuses production credentials");
  return { relayUrl, mailboxId, capability, pairingCode };
}

const PRODUCTION_CREDENTIALS = ["LOCAL_API_TOKEN", "LILITH_RELAY_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"] as const;

function productionCredential(env: NodeJS.Dict<string | undefined>): string | null {
  for (const name of PRODUCTION_CREDENTIALS) {
    if ((env[name]?.trim() ?? "") !== "") return name;
  }
  return null;
}

export async function claimOutboundRunner(options: {
  relay: RelayMailbox;
  mailboxId: string;
  capability: string;
  pairingCode: string;
  pump?: () => Promise<void>;
  forbidden?: readonly string[];
  runnerToken?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
}): Promise<{ runnerId: string; runnerToken: string; ownerId: string; expiresAt: number }> {
  const runnerToken = options.runnerToken ?? randomBytes(32).toString("base64url");
  if (options.forbidden?.includes(runnerToken) || runnerToken === options.pairingCode) {
    throw new Error("Home runner must not reuse LOCAL_API_TOKEN");
  }
  await options.relay.put(
    options.mailboxId,
    options.capability,
    "to-api",
    seal(options.pairingCode, { type: "claim", runnerToken }),
  );
  const clock = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const deadline = clock() + PAIRING_TTL_MS;
  for (;;) {
    await options.pump?.();
    const ack = await options.relay.read(options.mailboxId, options.capability, "to-runner");
    if (ack === REJECTED) {
      await options.relay.ack(options.mailboxId, options.capability, "to-runner");
      throw new Error("Pairing already used");
    }
    if (ack !== null) {
      const opened = open(runnerToken, ack);
      if (
        !isRecord(opened) ||
        opened.type !== "paired" ||
        typeof opened.runnerId !== "string" ||
        opened.runnerId === "" ||
        typeof opened.ownerId !== "string" ||
        opened.ownerId === "" ||
        typeof opened.expiresAt !== "number" ||
        opened.expiresAt <= clock()
      ) {
        throw new Error("Pairing rejected");
      }
      await options.relay.ack(options.mailboxId, options.capability, "to-runner");
      return {
        runnerId: opened.runnerId,
        runnerToken,
        ownerId: opened.ownerId,
        expiresAt: opened.expiresAt,
      };
    }
    if (clock() >= deadline) throw new Error("Pairing expired");
    await sleep(options.pollMs ?? RELAY_POLL_MS);
  }
}

export async function runFixtureFromMailbox(options: {
  relay: RelayMailbox;
  mailboxId: string;
  capability: string;
  runnerToken: string;
  pump?: () => Promise<void>;
  runJob?: (job: IsolatedJob) => Promise<JobResult>;
  deadline?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
}): Promise<void> {
  const clock = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const deadline = options.deadline ?? clock() + RUNNER_TTL_MS;
  let envelope: string | null = null;
  for (;;) {
    await options.pump?.();
    if (clock() >= deadline) throw new Error("Runner revoked");
    envelope = await options.relay.read(options.mailboxId, options.capability, "to-runner");
    if (envelope === REJECTED) throw new Error("Runner revoked");
    if (envelope !== null) break;
    await sleep(options.pollMs ?? RELAY_POLL_MS);
  }
  const job = open(options.runnerToken, envelope);
  rejectUnsafeCommand(job);
  // ponytail: consume the envelope before the fixture so a crash cannot run it twice. Ceiling: a crash after this ack and before the result is posted leaves the API job queued. Upgrade: persist the result and retry the post without re-running.
  await options.relay.ack(options.mailboxId, options.capability, "to-runner");
  const workspace = join(RUNNER_WORKSPACES_ROOT, `home-${randomUUID()}`);
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  const secrets = [options.runnerToken, options.capability];
  let stdout = "";
  let stderr = "";
  let ok = false;
  try {
    const result = await (options.runJob ?? runIsolatedJob)(fixtureIsolatedJob(job.jobId, workspace));
    stdout = redact(result.stdout, secrets);
    stderr = redact(result.stderr, secrets);
    ok = true;
  } catch (error) {
    stderr = redact(error instanceof Error ? error.message : "Fixture failed", secrets);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
  await options.relay.put(
    options.mailboxId,
    options.capability,
    "to-api",
    seal(options.runnerToken, {
      type: "result",
      jobId: job.jobId,
      runnerId: job.runnerId,
      ownerId: job.ownerId,
      ok,
      stdout,
      stderr,
    }),
  );
  await options.pump?.();
}

const RELAY_POLL_MS = 2_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const REJECTED = "{\"type\":\"rejected\"}";

function trackCreate(pendingCreates: Map<string, Set<Promise<void>>>, ownerId: string, task: Promise<unknown>): void {
  let pending = pendingCreates.get(ownerId);
  if (pending === undefined) {
    pending = new Set();
    pendingCreates.set(ownerId, pending);
  }
  const settled = task.then(
    () => undefined,
    () => undefined,
  );
  pending.add(settled);
  void settled.finally(() => {
    pending.delete(settled);
    if (pending.size === 0) pendingCreates.delete(ownerId);
  });
}

function requireRunner(runners: Map<string, RunnerRecord>, owner: OwnerContext, runnerId: string): RunnerRecord {
  const runner = runners.get(runnerId);
  if (!runner || runner.ownerId !== owner.ownerId) throw new Error("Runner not found");
  return runner;
}

function isClaim(value: unknown): value is { type: "claim"; runnerToken: string } {
  return isRecord(value) && value.type === "claim" && typeof value.runnerToken === "string" && Object.keys(value).length === 2;
}

export function rejectUnsafeCommand(value: unknown): asserts value is {
  type: "job";
  jobId: string;
  runnerId: string;
  ownerId: string;
  fixture: typeof HOME_RUNNER_FIXTURE;
} {
  if (!isJob(value)) throw new Error("Unsafe command");
}

function isJob(value: unknown): value is { type: "job"; jobId: string; runnerId: string; ownerId: string; fixture: typeof HOME_RUNNER_FIXTURE } {
  if (!isRecord(value) || "command" in value || Object.keys(value).length !== 5) return false;
  return (
    value.type === "job" &&
    typeof value.jobId === "string" &&
    typeof value.runnerId === "string" &&
    typeof value.ownerId === "string" &&
    value.fixture === HOME_RUNNER_FIXTURE
  );
}

function isResult(value: unknown): value is {
  jobId: string;
  runnerId: string;
  ownerId: string;
  ok: boolean;
  stdout: string;
  stderr: string;
} {
  return (
    isRecord(value) &&
    value.type === "result" &&
    typeof value.jobId === "string" &&
    typeof value.runnerId === "string" &&
    typeof value.ownerId === "string" &&
    typeof value.ok === "boolean" &&
    typeof value.stdout === "string" &&
    typeof value.stderr === "string"
  );
}

function opensAsResult(token: string, body: string): boolean {
  try {
    return isResult(open(token, body));
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type HomeSnapshot = {
  pairings: [string, Pairing][];
  runners: [string, RunnerRecord][];
  jobs: [string, JobRecord][];
};

function snapshotHome(
  pairings: Map<string, Pairing>,
  runners: Map<string, RunnerRecord>,
  jobs: Map<string, JobRecord>,
): HomeSnapshot {
  return {
    pairings: [...pairings].map(([id, pairing]) => [id, { ...pairing }]),
    runners: [...runners].map(([id, runner]) => [id, { ...runner }]),
    jobs: [...jobs].map(([id, job]) => [id, { ...job }]),
  };
}

function restoreHome(
  snap: HomeSnapshot,
  pairings: Map<string, Pairing>,
  runners: Map<string, RunnerRecord>,
  jobs: Map<string, JobRecord>,
): void {
  pairings.clear();
  runners.clear();
  jobs.clear();
  for (const [id, pairing] of snap.pairings) pairings.set(id, pairing);
  for (const [id, runner] of snap.runners) runners.set(id, runner);
  for (const [id, job] of snap.jobs) jobs.set(id, job);
}

function loadHomeState(
  statePath: string,
  stateKey: Buffer,
  pairings: Map<string, Pairing>,
  runners: Map<string, RunnerRecord>,
  jobs: Map<string, JobRecord>,
): void {
  const bak = `${statePath}.bak`;
  if (!existsSync(statePath) && existsSync(bak)) renameSync(bak, statePath);
  if (!existsSync(statePath)) return;
  try {
    const payload = openHomeState(stateKey, JSON.parse(readFileSync(statePath, "utf8")));
    for (const pairing of payload.pairings) pairings.set(pairing.id, pairing);
    for (const runner of payload.runners) runners.set(runner.id, runner);
    for (const job of payload.jobs) jobs.set(job.id, job);
  } catch (error) {
    if (error instanceof Error && error.message === "Home runner state is unreadable") throw error;
    throw new Error("Home runner state is unreadable");
  }
}

function writeHomeState(
  statePath: string,
  stateKey: Buffer,
  pairings: Map<string, Pairing>,
  runners: Map<string, RunnerRecord>,
  jobs: Map<string, JobRecord>,
): void {
  const body = JSON.stringify(
    sealHomeState(stateKey, {
      v: 1,
      pairings: [...pairings.values()],
      runners: [...runners.values()],
      jobs: [...jobs.values()],
    }),
  );
  const tmp = `${statePath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, body, { mode: 0o600 });
    replaceHomeStateFile(tmp, statePath);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // tmp may already have been renamed or never created
    }
    throw error;
  }
  try {
    unlinkSync(tmp);
  } catch {
    // tmp already renamed onto dest
  }
}

function replaceHomeStateFile(tmp: string, dest: string): void {
  try {
    renameSync(tmp, dest);
    return;
  } catch (error) {
    if (!existsSync(dest)) throw error;
  }
  const bak = `${dest}.bak`;
  if (existsSync(bak)) unlinkSync(bak);
  renameSync(dest, bak);
  try {
    renameSync(tmp, dest);
  } catch (error) {
    renameSync(bak, dest);
    throw error;
  }
  try {
    unlinkSync(bak);
  } catch {
    // dest already holds the new snapshot
  }
}

function sealHomeState(key: Buffer, value: unknown): { v: 1; iv: string; tag: string; data: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(HOME_STATE_AAD);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return { v: 1, iv: iv.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), data: data.toString("base64url") };
}

function openHomeState(key: Buffer, envelope: unknown): { pairings: Pairing[]; runners: RunnerRecord[]; jobs: JobRecord[] } {
  if (!isRecord(envelope) || envelope.v !== 1) throw new Error("Home runner state is unreadable");
  for (const field of Object.keys(envelope)) {
    if (field !== "v" && field !== "iv" && field !== "tag" && field !== "data") {
      throw new Error("Home runner state is unreadable");
    }
  }
  if (typeof envelope.iv !== "string" || typeof envelope.tag !== "string" || typeof envelope.data !== "string") {
    throw new Error("Home runner state is unreadable");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64url"));
  decipher.setAAD(HOME_STATE_AAD);
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
  const raw = Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64url")), decipher.final()]).toString("utf8");
  return parseHomePayload(JSON.parse(raw));
}

function parseHomePayload(value: unknown): { pairings: Pairing[]; runners: RunnerRecord[]; jobs: JobRecord[] } {
  if (!isRecord(value) || value.v !== 1) throw new Error("Home runner state is unreadable");
  for (const field of Object.keys(value)) {
    if (field !== "v" && field !== "pairings" && field !== "runners" && field !== "jobs") {
      throw new Error("Home runner state is unreadable");
    }
  }
  if (!Array.isArray(value.pairings) || !Array.isArray(value.runners) || !Array.isArray(value.jobs)) {
    throw new Error("Home runner state is unreadable");
  }
  return {
    pairings: value.pairings.map(parsePairing),
    runners: value.runners.map(parseRunner),
    jobs: value.jobs.map(parseJob),
  };
}

function parsePairing(value: unknown): Pairing {
  if (!isRecord(value)) throw new Error("Home runner state is unreadable");
  for (const field of Object.keys(value)) {
    if (!["id", "ownerId", "code", "mailboxId", "capability", "expiresAt", "consumed"].includes(field)) {
      throw new Error("Home runner state is unreadable");
    }
  }
  if (
    typeof value.id !== "string" ||
    value.id === "" ||
    typeof value.ownerId !== "string" ||
    value.ownerId === "" ||
    typeof value.code !== "string" ||
    typeof value.mailboxId !== "string" ||
    value.mailboxId === "" ||
    typeof value.capability !== "string" ||
    typeof value.expiresAt !== "number" ||
    !Number.isFinite(value.expiresAt) ||
    typeof value.consumed !== "boolean"
  ) {
    throw new Error("Home runner state is unreadable");
  }
  return {
    id: value.id,
    ownerId: value.ownerId,
    code: value.code,
    mailboxId: value.mailboxId,
    capability: value.capability,
    expiresAt: value.expiresAt,
    consumed: value.consumed,
  };
}

function parseRunner(value: unknown): RunnerRecord {
  if (!isRecord(value)) throw new Error("Home runner state is unreadable");
  for (const field of Object.keys(value)) {
    if (!["id", "ownerId", "token", "mailboxId", "capability", "expiresAt", "revoked"].includes(field)) {
      throw new Error("Home runner state is unreadable");
    }
  }
  if (
    typeof value.id !== "string" ||
    value.id === "" ||
    typeof value.ownerId !== "string" ||
    value.ownerId === "" ||
    typeof value.token !== "string" ||
    typeof value.mailboxId !== "string" ||
    value.mailboxId === "" ||
    typeof value.capability !== "string" ||
    typeof value.expiresAt !== "number" ||
    !Number.isFinite(value.expiresAt) ||
    typeof value.revoked !== "boolean"
  ) {
    throw new Error("Home runner state is unreadable");
  }
  return {
    id: value.id,
    ownerId: value.ownerId,
    token: value.token,
    mailboxId: value.mailboxId,
    capability: value.capability,
    expiresAt: value.expiresAt,
    revoked: value.revoked,
  };
}

function parseJob(value: unknown): JobRecord {
  if (!isRecord(value)) throw new Error("Home runner state is unreadable");
  for (const field of Object.keys(value)) {
    if (!["id", "runnerId", "ownerId", "state", "stdout", "stderr", "settled"].includes(field)) {
      throw new Error("Home runner state is unreadable");
    }
  }
  if (
    typeof value.id !== "string" ||
    value.id === "" ||
    typeof value.runnerId !== "string" ||
    value.runnerId === "" ||
    typeof value.ownerId !== "string" ||
    value.ownerId === "" ||
    (value.state !== "queued" && value.state !== "completed" && value.state !== "failed") ||
    typeof value.stdout !== "string" ||
    typeof value.stderr !== "string" ||
    typeof value.settled !== "boolean"
  ) {
    throw new Error("Home runner state is unreadable");
  }
  return {
    id: value.id,
    runnerId: value.runnerId,
    ownerId: value.ownerId,
    state: value.state,
    stdout: value.stdout,
    stderr: value.stderr,
    settled: value.settled,
  };
}

const HOME_STATE_AAD = Buffer.from("lilith-home-runner-v1");

function seal(secret: string, value: unknown): string {
  const key = createHash("sha256").update(secret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
}

function open(secret: string, blob: string): unknown {
  const raw = Buffer.from(blob, "base64url");
  if (raw.length < 29) throw new Error("Relay envelope rejected");
  const decipher = createDecipheriv("aes-256-gcm", createHash("sha256").update(secret).digest(), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8"));
}

function redact(value: string, secrets: readonly string[]): string {
  let out = value;
  for (const secret of secrets) {
    if (secret.length >= 8) out = out.replaceAll(secret, "[REDACTED]");
  }
  return out;
}

function assertEmpty(value: unknown): void {
  if (value !== undefined && (!isRecord(value) || Object.keys(value).length !== 0)) {
    throw new Error("Invalid pairing request");
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  req.setEncoding("utf8");
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 8_192) throw new Error("Request too large");
  }
  if (raw.trim() === "") return undefined;
  return JSON.parse(raw);
}

function writeJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

function statusFor(error: unknown): number {
  const message = error instanceof Error ? error.message : "";
  if (message === "Runner not found" || message === "Resource access denied") return 404;
  if (
    message === "Invalid HomeRunnerJobRequest" ||
    message === "Invalid pairing request" ||
    message === "Unsafe command" ||
    message === "Unknown fixture" ||
    message === "Request too large" ||
    error instanceof SyntaxError
  ) {
    return 400;
  }
  if (
    message === "Runner revoked" ||
    message === "Runner busy" ||
    message === "Pairing already used" ||
    message === "Pairing expired"
  ) {
    return 409;
  }
  return 500;
}
