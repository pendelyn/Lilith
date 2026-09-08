import { execFile, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const RUNNER_IMAGE =
  "alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce";
const MAX_TIMEOUT_MS = 15 * 60_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const RUNNER_UID = process.getuid?.() ?? 65532;
const RUNNER_GID = process.getgid?.() ?? 65532;
export const RUNNER_WORKSPACES_ROOT = join(process.cwd(), ".lilith-jobs");

if (RUNNER_UID === 0 || RUNNER_GID === 0) {
  throw new Error("Lilith API and runner must not run as root");
}

export type IsolatedJob = {
  id: string;
  workspace: string;
  command: readonly string[];
  timeoutMs?: number;
};

export type JobResult = {
  stdout: string;
  stderr: string;
};

export class JobCredentialBroker {
  readonly #secrets = new Map<string, string>();
  readonly trustedExecutable: string;

  constructor(trustedExecutable: string) {
    if (!trustedExecutable.startsWith("/")) {
      throw new Error("Credentialed provider executable must be an absolute container path");
    }
    this.trustedExecutable = trustedExecutable;
  }

  issue(jobId: string, secret: string): void {
    if (!jobId || !secret) throw new Error("Job ID and provider secret are required");
    if (/[\r\n]/.test(secret)) throw new Error("Provider secret must be a single line");
    if (Buffer.byteLength(secret) > 64 * 1024) {
      throw new Error("Provider secret must not exceed 64 KiB");
    }
    if (this.#secrets.has(jobId)) throw new Error("Job already has a provider secret");
    this.#secrets.set(jobId, secret);
  }

  take(jobId: string, executable: string): string {
    if (executable !== this.trustedExecutable) {
      throw new Error("Provider secret requested by an untrusted executable");
    }
    const secret = this.#secrets.get(jobId);
    if (!secret) throw new Error("Job has no provider secret");
    this.#secrets.delete(jobId);
    return secret;
  }
}

export function dockerArgs(job: Pick<IsolatedJob, "workspace" | "command">, name: string): string[] {
  const workspaceRoot = realpathSync(RUNNER_WORKSPACES_ROOT);
  const workspace = realpathSync(job.workspace);
  const relation = relative(workspaceRoot, workspace);
  if (
    relation === "" ||
    relation === ".." ||
    relation.startsWith(`..${sep}`) ||
    relation.includes(sep) ||
    isAbsolute(relation)
  ) {
    throw new Error("Job requires one dedicated workspace directly below the runner workspace root");
  }
  if (workspace.includes(",")) throw new Error("Docker mount paths must not contain commas");

  return [
    "create",
    "--name",
    name,
    "--interactive",
    "--log-driver=none",
    "--user",
    `${RUNNER_UID}:${RUNNER_GID}`,
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--network=none",
    "--pids-limit=64",
    "--cpus=1",
    "--memory=512m",
    "--tmpfs",
    `/tmp:rw,noexec,nosuid,size=64m,uid=${RUNNER_UID},gid=${RUNNER_GID}`,
    "--mount",
    `type=bind,src=${workspace},dst=/workspace`,
    "--workdir",
    "/workspace",
    RUNNER_IMAGE,
    ...job.command,
  ];
}

export async function runIsolatedJob(
  job: IsolatedJob,
  credentialBroker?: JobCredentialBroker,
): Promise<JobResult> {
  if (!job.id || job.command.length === 0) throw new Error("Job ID and command are required");
  const secret = credentialBroker?.take(job.id, job.command[0]!);
  if (secret && job.command.some((part) => part.includes(secret))) {
    throw new Error("Provider secret must not appear in the job command or prompt");
  }
  const timeoutMs = job.timeoutMs ?? MAX_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error("Job timeout must be between 1 ms and 15 minutes");
  }

  await mkdir(RUNNER_WORKSPACES_ROOT, { recursive: true, mode: 0o700 });
  const name = `lilith-job-${randomUUID()}`;
  const args = dockerArgs(job, name);
  let createStarted = false;
  let created = false;

  try {
    createStarted = true;
    await execFileAsync("docker", args, {
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
      env: dockerEnvironment(),
    });
    created = true;
    return await startAttached(name, secret, timeoutMs);
  } finally {
    if (createStarted) await removeContainer(name, !created);
  }
}

function startAttached(
  name: string,
  secret: string | undefined,
  timeoutMs: number,
): Promise<JobResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["start", "--attach", "--interactive", name], {
      windowsHide: true,
      env: dockerEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => finish(new Error("Docker job timed out")), timeoutMs);

    function finish(error?: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        child.kill();
        reject(new Error(redact(error.message, secret)));
      } else {
        resolve({ stdout: redact(stdout, secret), stderr: redact(stderr, secret) });
      }
    }

    function append(current: string, chunk: Buffer): string {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next) > MAX_OUTPUT_BYTES) {
        finish(new Error("Docker job output exceeded 1 MiB"));
      }
      return next;
    }

    child.stdin.on("error", (error) => finish(error));
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) =>
      finish(code === 0 ? undefined : new Error(stderr || `Docker job exited with ${code}`)),
    );
    child.stdin.end(secret === undefined ? undefined : `${secret}\n`);
  });
}

async function removeContainer(name: string, retryCreationRace: boolean): Promise<void> {
  const options = {
    encoding: "utf8" as const,
    timeout: 10_000,
    windowsHide: true,
    env: dockerEnvironment(),
  };
  const attempts = retryCreationRace ? 50 : 10;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 100));
    const removed = await execFileAsync("docker", ["rm", "--force", name], options).then(
      () => true,
      () => false,
    );
    if (removed) return;
  }

  const daemonAvailable = await execFileAsync("docker", ["info"], options).then(
    () => true,
    () => false,
  );
  if (!daemonAvailable) throw new Error("Cannot verify isolated job container removal");

  try {
    await execFileAsync("docker", ["inspect", name], options);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/No such (object|container)/i.test(message)) return;
    throw new Error("Cannot verify isolated job container removal");
  }
  throw new Error("Failed to remove isolated job container");
}

function dockerEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "WINDIR",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_CONFIG",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
  ];
  return Object.fromEntries(allowed.flatMap((key) => process.env[key] ? [[key, process.env[key]]] : []));
}

function redact(value: string, secret: string | undefined): string {
  return secret ? value.replaceAll(secret, "[REDACTED]") : value;
}
