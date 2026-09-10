import { execFile, spawn } from "node:child_process";
import { createServer, connect, type Server, type Socket } from "node:net";
import { realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const RUNNER_IMAGE =
  "alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce";
const MAX_TIMEOUT_MS = 15 * 60_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const RUNNER_UID = process.getuid?.() ?? 65532;
const RUNNER_GID = process.getgid?.() ?? 65532;
export const RUNNER_WORKSPACES_ROOT = join(process.cwd(), ".lilith-jobs");
export const PROVIDER_EGRESS_HOST = "lilith-egress";

if (RUNNER_UID === 0 || RUNNER_GID === 0) {
  throw new Error("Lilith API and runner must not run as root");
}

export type IsolatedJob = {
  id: string;
  workspace: string;
  command: readonly string[];
  timeoutMs?: number;
  linger?: boolean;
  seedCodexHome?: boolean;
  image?: string;
  network?: "none" | { allowlist: readonly string[] };
};

export type DockerArgWiring = {
  networkName?: string;
  proxyPort?: number;
};

export type IsolatedJobHandle = {
  chunks(): AsyncIterable<string>;
  abort(): void;
  finished: Promise<JobResult>;
  copyOut(containerPath: string): Promise<string>;
  close(): Promise<void>;
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

export function parsePinnedImage(value: string): string {
  if (!/^(?:[a-z0-9._/-]+(?::[a-z0-9._-]+)?)@sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error("Runner image must be digest-pinned");
  }
  return value;
}

export function dockerArgs(
  job: Pick<IsolatedJob, "workspace" | "command"> &
    Partial<Pick<IsolatedJob, "linger" | "seedCodexHome" | "image" | "network">>,
  name: string,
  wiring?: DockerArgWiring,
): string[] {
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
  const image = parsePinnedImage(job.image ?? RUNNER_IMAGE);
  const allowlist = job.network !== undefined && job.network !== "none" ? job.network.allowlist : undefined;
  if (allowlist !== undefined) {
    if (allowlist.length === 0) throw new Error("Provider network allowlist is required");
    if (wiring?.networkName === undefined || wiring.proxyPort === undefined) {
      throw new Error("Provider jobs require an isolated allowlisted network");
    }
    if (wiring.networkName === "bridge" || wiring.networkName === "host" || wiring.networkName === "none") {
      throw new Error("Provider jobs must not use unrestricted Docker networks");
    }
  }

  const wrap = job.linger === true || job.seedCodexHome === true;
  const processArgs = wrap
    ? ["/bin/sh", "-c", lingerScript(job.linger === true), ...job.command]
    : [...job.command];

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
    ...networkArgs(allowlist, wiring),
    "--pids-limit=64",
    "--cpus=1",
    "--memory=512m",
    "--tmpfs",
    `/tmp:rw,noexec,nosuid,size=64m,uid=${RUNNER_UID},gid=${RUNNER_GID}`,
    "--mount",
    `type=bind,src=${workspace},dst=/workspace`,
    "--workdir",
    "/workspace",
    ...providerEnvArgs(wrap, wiring?.proxyPort),
    image,
    ...processArgs,
  ];
}

export async function runIsolatedJob(
  job: IsolatedJob,
  credentialBroker?: JobCredentialBroker,
): Promise<JobResult> {
  const handle = await startIsolatedJob(job, credentialBroker);
  try {
    return await handle.finished;
  } finally {
    await handle.close();
  }
}

export async function startIsolatedJob(
  job: IsolatedJob,
  credentialBroker?: JobCredentialBroker,
): Promise<IsolatedJobHandle> {
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
  let createStarted = false;
  let created = false;
  let closed = false;
  let proxy: AllowlistProxy | undefined;
  let networkName: string | undefined;

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    if (createStarted) await removeContainer(name, !created);
    if (networkName !== undefined) await removeNetwork(networkName);
    await proxy?.close();
  }

  try {
    const wiring = await attachProviderNetwork(job.network, name);
    proxy = wiring.proxy;
    networkName = wiring.networkName;
    const args = dockerArgs(job, name, wiring.docker);
    createStarted = true;
    await execFileAsync("docker", args, {
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
      env: dockerEnvironment(),
    });
    created = true;
  } catch (error) {
    await close();
    const message = error instanceof Error ? error.message : "Docker job failed";
    throw new Error(redact(message, secret));
  }

  const attached = attachContainer(name, secret, timeoutMs);
  return {
    chunks: attached.chunks,
    abort: attached.abort,
    finished: attached.finished,
    async copyOut(containerPath: string) {
      if (closed || containerPath === "" || /[\r\n:]/.test(containerPath)) {
        throw new Error("Cannot export from job container");
      }
      try {
        const { stdout } = await execFileAsync("docker", ["exec", name, "/bin/cat", containerPath], {
          encoding: "utf8",
          timeout: 10_000,
          maxBuffer: 64 * 1024,
          windowsHide: true,
          env: dockerEnvironment(),
        });
        return stdout.replace(/\n$/, "");
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        throw new Error(redact(message, secret) || "Cannot export from job container");
      }
    },
    close,
  };
}

function attachContainer(
  name: string,
  secret: string | undefined,
  timeoutMs: number,
): {
  chunks(): AsyncIterable<string>;
  abort(): void;
  finished: Promise<JobResult>;
} {
  const child = spawn("docker", ["start", "--attach", "--interactive", name], {
    windowsHide: true,
    env: dockerEnvironment(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let settled = false;
  const pending: (string | null)[] = [];
  const waiters: ((chunk: string | null) => void)[] = [];
  let resolveFinished: (result: JobResult) => void = () => undefined;
  let rejectFinished: (error: Error) => void = () => undefined;
  const finished = new Promise<JobResult>((resolve, reject) => {
    resolveFinished = resolve;
    rejectFinished = reject;
  });
  const timer = setTimeout(() => finish(new Error("Docker job timed out")), timeoutMs);

  function emit(chunk: string | null) {
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter(chunk);
    else pending.push(chunk);
  }

  function finish(error?: Error) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) child.kill();
    emit(null);
    if (error) rejectFinished(new Error(redact(error.message, secret)));
    else resolveFinished({ stdout: redact(stdout, secret), stderr: redact(stderr, secret) });
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
    emit(chunk.toString("utf8"));
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = append(stderr, chunk);
  });
  child.on("error", (error) => finish(error));
  child.on("close", (code) =>
    finish(code === 0 ? undefined : new Error(stderr || `Docker job exited with ${code}`)),
  );
  child.stdin.end(secret === undefined ? undefined : `${secret}\n`);

  return {
    async *chunks() {
      while (true) {
        const chunk =
          pending.length > 0 ? pending.shift()! : await new Promise<string | null>((resolve) => waiters.push(resolve));
        if (chunk === null) return;
        yield chunk;
      }
    },
    abort() {
      finish(new Error("Docker job aborted"));
    },
    finished,
  };
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

function lingerScript(linger: boolean): string {
  const halt = linger ? "sleep infinity; " : "";
  return `mkdir -p /tmp/codex-home; if [ -f /workspace/.codex/config.toml ]; then cp /workspace/.codex/config.toml /tmp/codex-home/config.toml; fi; "$0" "$@"; e=$?; ${halt}exit $e`;
}

function networkArgs(
  allowlist: readonly string[] | undefined,
  wiring: DockerArgWiring | undefined,
): string[] {
  if (allowlist === undefined) return ["--network=none"];
  return [
    `--network=${wiring!.networkName}`,
    `--add-host=${PROVIDER_EGRESS_HOST}:host-gateway`,
  ];
}

function providerEnvArgs(wrap: boolean, proxyPort: number | undefined): string[] {
  const env = wrap ? ["--env=CODEX_HOME=/tmp/codex-home"] : [];
  if (proxyPort === undefined) return env;
  const proxy = `http://${PROVIDER_EGRESS_HOST}:${proxyPort}`;
  return [
    ...env,
    `--env=HTTP_PROXY=${proxy}`,
    `--env=HTTPS_PROXY=${proxy}`,
    `--env=http_proxy=${proxy}`,
    `--env=https_proxy=${proxy}`,
    `--env=ALL_PROXY=${proxy}`,
  ];
}

type AllowlistProxy = {
  port: number;
  close(): Promise<void>;
};

export async function startAllowlistProxy(allowlist: readonly string[]): Promise<AllowlistProxy> {
  const allowed = new Set(allowlist.map((host) => host.toLowerCase()));
  if (allowed.size === 0) throw new Error("Provider network allowlist is required");
  for (const host of allowed) {
    if (
      /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(host)
    ) {
      throw new Error("Provider network allowlist is invalid");
    }
  }

  const server = createServer((client) => {
    client.once("data", (chunk) => handleConnect(client, chunk, allowed));
    client.on("error", () => client.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Provider egress proxy failed to listen");
  }
  return {
    port: address.port,
    close: () => closeServer(server),
  };
}

function handleConnect(client: Socket, chunk: Buffer, allowed: ReadonlySet<string>): void {
  const [requestLine] = chunk.toString("utf8").split("\r\n", 1);
  const match = /^CONNECT\s+([^:\s]+):(\d+)\s+HTTP\/1\.[01]$/i.exec(requestLine ?? "");
  const host = match?.[1]?.toLowerCase();
  const port = match?.[2] === "443" || match?.[2] === "80" ? Number(match[2]) : undefined;
  if (host === undefined || port === undefined || allowed.has(host) === false) {
    client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return;
  }
  const remote = connect(port, host);
  remote.once("connect", () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    client.pipe(remote);
    remote.pipe(client);
  });
  remote.on("error", () => {
    client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
  });
  client.on("close", () => remote.destroy());
}

async function attachProviderNetwork(
  network: IsolatedJob["network"],
  jobName: string,
): Promise<{ proxy?: AllowlistProxy; networkName?: string; docker?: DockerArgWiring }> {
  if (network === undefined || network === "none") return {};
  const proxy = await startAllowlistProxy(network.allowlist);
  const networkName = `lilith-net-${jobName}`;
  try {
    await execFileAsync(
      "docker",
      [
        "network",
        "create",
        "--driver=bridge",
        "--opt",
        "com.docker.network.bridge.enable_ip_masquerade=false",
        networkName,
      ],
      { encoding: "utf8", timeout: 15_000, windowsHide: true, env: dockerEnvironment() },
    );
  } catch (error) {
    await proxy.close();
    const message = error instanceof Error ? error.message : "Provider network create failed";
    throw new Error(message);
  }
  return { proxy, networkName, docker: { networkName, proxyPort: proxy.port } };
}

async function removeNetwork(name: string): Promise<void> {
  await execFileAsync("docker", ["network", "rm", name], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
    env: dockerEnvironment(),
  }).then(
    () => undefined,
    () => undefined,
  );
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
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
