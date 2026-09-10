import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  dockerArgs,
  JobCredentialBroker,
  parsePinnedImage,
  PROVIDER_EGRESS_HOST,
  RUNNER_IMAGE,
  RUNNER_WORKSPACES_ROOT,
  runIsolatedJob,
  startAllowlistProxy,
  startIsolatedJob,
} from "./runner.ts";

const expectedUid = process.getuid?.() ?? 65532;
const expectedGid = process.getgid?.() ?? 65532;

function containerNames(): Set<string> {
  const output = execFileSync("docker", [
    "ps",
    "--all",
    "--filter",
    "name=lilith-job-",
    "--format",
    "{{.Names}}",
  ], { encoding: "utf8" });
  return new Set(output.split(/\s+/).filter(Boolean));
}

test("Docker jobs use the required isolation controls", async () => {
  await mkdir(RUNNER_WORKSPACES_ROOT, { recursive: true });
  const workspace = await mkdtemp(join(RUNNER_WORKSPACES_ROOT, "unit-"));
  try {
    const args = dockerArgs({ workspace, command: ["true"] }, "lilith-job-test");

    for (const expected of [
      "create",
      "--interactive",
      "--log-driver=none",
      `${expectedUid}:${expectedGid}`,
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--network=none",
      "--pids-limit=64",
      "--cpus=1",
      "--memory=512m",
    ]) {
      assert.ok(args.includes(expected), `missing ${expected}`);
    }
    assert.equal(args.includes("--rm"), false);
    assert.equal(args.includes("/var/run/docker.sock"), false);
    assert.equal(args.includes("host"), false);
    assert.equal(args.includes("bridge"), false);
    assert.throws(
      () => dockerArgs({ workspace: process.cwd(), command: ["true"] }, "lilith-job-test"),
      /dedicated workspace/,
    );
    assert.throws(
      () => dockerArgs({ workspace: tmpdir(), command: ["true"] }, "lilith-job-test"),
      /dedicated workspace/,
    );
    assert.match(args.at(-2) ?? "", /^alpine:3\.22@sha256:[a-f0-9]{64}$/);
    assert.equal(args.at(-2), RUNNER_IMAGE);
    assert.equal(args.at(-1), "true");
    assert.equal(parsePinnedImage(RUNNER_IMAGE), RUNNER_IMAGE);
    assert.throws(() => parsePinnedImage("alpine:3.22"), /digest-pinned/);
    assert.throws(() => parsePinnedImage("ghcr.io/example/codex:latest"), /digest-pinned/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("provider jobs linger for copyOut and use an allowlisted route, not bridge or host", async () => {
  await mkdir(RUNNER_WORKSPACES_ROOT, { recursive: true });
  const workspace = await mkdtemp(join(RUNNER_WORKSPACES_ROOT, "unit-"));
  try {
    const args = dockerArgs(
      {
        workspace,
        command: ["/usr/local/bin/lilith-codex", "exec", "--json", "hi"],
        linger: true,
        seedCodexHome: true,
        network: { allowlist: ["auth.openai.com", "api.openai.com"] },
      },
      "lilith-job-codex",
      { networkName: "lilith-net-lilith-job-codex", proxyPort: 18765 },
    );
    assert.equal(args.includes("--network=none"), false);
    assert.equal(args.includes("bridge"), false);
    assert.equal(args.includes("host"), false);
    assert.equal(args.includes("--network=lilith-net-lilith-job-codex"), true);
    assert.equal(args.includes(`--add-host=${PROVIDER_EGRESS_HOST}:host-gateway`), true);
    assert.equal(args.includes("--env=CODEX_HOME=/tmp/codex-home"), true);
    assert.equal(args.includes("--env=HTTPS_PROXY=http://lilith-egress:18765"), true);
    assert.equal(args.includes("/bin/sh"), true);
    assert.equal(args.some((arg) => arg.includes("sleep infinity")), true);
    assert.equal(args.some((arg) => arg.includes("/workspace/.codex/config.toml")), true);
  assert.equal(args.includes("/usr/local/bin/lilith-codex"), true);
  assert.equal(args.at(-4), "/usr/local/bin/lilith-codex");
    assert.throws(
      () =>
        dockerArgs(
          { workspace, command: ["true"], network: { allowlist: ["api.openai.com"] } },
          "lilith-job-codex",
        ),
      /allowlisted network/,
    );
    assert.throws(
      () =>
        dockerArgs(
          { workspace, command: ["true"], network: { allowlist: ["api.openai.com"] } },
          "lilith-job-codex",
          { networkName: "bridge", proxyPort: 1 },
        ),
      /unrestricted/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("allowlist proxy denies hosts and ports outside the provider list", async () => {
  const proxy = await startAllowlistProxy(["auth.openai.com"]);
  try {
    assert.equal(await proxyResponse(proxy.port, "CONNECT evil.example:443 HTTP/1.1\r\n\r\n"), 403);
    assert.equal(await proxyResponse(proxy.port, "CONNECT auth.openai.com:22 HTTP/1.1\r\n\r\n"), 403);
    assert.equal(await proxyResponse(proxy.port, "GET http://auth.openai.com/ HTTP/1.1\r\n\r\n"), 403);
    await assert.rejects(startAllowlistProxy(["*"]), /invalid/);
    await assert.rejects(startAllowlistProxy(["10.0.0.1"]), /invalid/);
  } finally {
    await proxy.close();
  }
});

test("the credential broker is one-shot and bound to a trusted executable", async () => {
  const broker = new JobCredentialBroker("/bin/agent");
  broker.issue("secret-in-prompt", "secret-token");
  await assert.rejects(
    runIsolatedJob({
      id: "secret-in-prompt",
      workspace: process.cwd(),
      command: ["/bin/agent", "prompt containing secret-token"],
    }, broker),
    /must not appear/,
  );

  broker.issue("wrong-process", "another-secret");
  await assert.rejects(
    runIsolatedJob({ id: "wrong-process", workspace: process.cwd(), command: ["/bin/sh"] }, broker),
    /untrusted executable/,
  );
  broker.issue("one-shot", "single-use-secret");
  assert.equal(broker.take("one-shot", "/bin/agent"), "single-use-secret");
  assert.throws(() => broker.take("one-shot", "/bin/agent"), /no provider secret/);
  assert.throws(() => broker.issue("multiline", "line-one\nline-two"), /single line/);
  assert.throws(() => broker.issue("oversize", "x".repeat(64 * 1024 + 1)), /64 KiB/);
});

test("job timeouts cannot exceed or disable the 15-minute bound", async () => {
  for (const timeoutMs of [0, 900_001]) {
    await assert.rejects(
      runIsolatedJob({ id: `timeout-${timeoutMs}`, workspace: process.cwd(), command: ["true"], timeoutMs }),
      /between 1 ms and 15 minutes/,
    );
  }
});

test(
  "real Docker job is non-root, bounded, redacted, and removed",
  { skip: process.env.RUN_DOCKER_TESTS !== "1" },
  async () => {
    await mkdir(RUNNER_WORKSPACES_ROOT, { recursive: true });
    const workspace = await mkdtemp(join(RUNNER_WORKSPACES_ROOT, "integration-"));
    const containersBefore = containerNames();
    process.env.LILITH_HOST_ONLY = "must-not-enter-container";
    try {
      const logDriverProbe = `lilith-job-log-${randomUUID()}`;
      try {
        execFileSync(
          "docker",
          dockerArgs({ workspace, command: ["true"] }, logDriverProbe),
        );
        assert.equal(
          execFileSync(
            "docker",
            ["inspect", "--format", "{{.HostConfig.LogConfig.Type}}", logDriverProbe],
            { encoding: "utf8" },
          ).trim(),
          "none",
        );
      } finally {
        execFileSync("docker", ["rm", "--force", logDriverProbe]);
      }

      const broker = new JobCredentialBroker("/bin/sh");
      broker.issue("integration", "integration-secret");
      const result = await runIsolatedJob({
        id: "integration",
        workspace,
        timeoutMs: 30_000,
        command: [
          "/bin/sh",
          "-c",
          `read provider_secret; id -u; test ! -e /var/run/docker.sock; test ! -e /host; test -z "\${LILITH_HOST_ONLY:-}"; test "$(cat /sys/fs/cgroup/pids.max)" = 64; set -- $(cat /sys/fs/cgroup/cpu.max); test "$1" = "$2"; grep -Eq '^CapEff:[[:space:]]*0+$' /proc/self/status; grep -Eq '^NoNewPrivs:[[:space:]]*1$' /proc/self/status; if touch /root-probe 2>/dev/null; then exit 17; fi; printf '#!/bin/sh\\nexit 0\\n' >/tmp/probe; chmod +x /tmp/probe; if /tmp/probe 2>/dev/null; then exit 18; fi; printf '%s\\n' "$provider_secret"; cat /sys/fs/cgroup/memory.max`,
        ],
      }, broker);
      assert.equal(result.stdout, `${expectedUid}\n[REDACTED]\n536870912\n`);
      assert.doesNotMatch(result.stdout + result.stderr, /integration-secret/);
      await assert.rejects(
        runIsolatedJob({ id: "timeout", workspace, command: ["sleep", "30"], timeoutMs: 200 }),
        /timed out/,
      );
      const newContainers = [...containerNames()].filter((name) => !containersBefore.has(name));
      assert.deepEqual(newContainers, []);
    } finally {
      delete process.env.LILITH_HOST_ONLY;
      await rm(workspace, { recursive: true, force: true });
    }
  },
);

test(
  "copyOut reads tmpfs auth while a lingered job is still running",
  { skip: process.env.RUN_DOCKER_TESTS !== "1" },
  async () => {
    await mkdir(RUNNER_WORKSPACES_ROOT, { recursive: true });
    const workspace = await mkdtemp(join(RUNNER_WORKSPACES_ROOT, "copyout-"));
    try {
      const handle = await startIsolatedJob({
        id: "copy-out",
        workspace,
        linger: true,
        command: ["/bin/sh", "-c", "printf 'auth-export-secret' >/tmp/codex-auth-export; printf ready\\n"],
        timeoutMs: 20_000,
      });
      try {
        let buf = "";
        for await (const chunk of handle.chunks()) {
          buf += chunk;
          if (buf.includes("ready")) break;
        }
        assert.equal(await handle.copyOut("/tmp/codex-auth-export"), "auth-export-secret");
        handle.abort();
      } finally {
        await handle.close();
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  },
);

function proxyResponse(port: number, request: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("error", reject);
    socket.once("data", (chunk) => {
      const match = /^HTTP\/1\.[01] (\d+)/.exec(chunk.toString("utf8"));
      socket.destroy();
      if (match?.[1] === undefined) reject(new Error("invalid proxy response"));
      else resolve(Number(match[1]));
    });
    socket.end(request);
  });
}
