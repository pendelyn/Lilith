import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withDockerMutex } from "./docker-test-lock.ts";
import {
  dockerArgs,
  JobCredentialBroker,
  RUNNER_WORKSPACES_ROOT,
  runIsolatedJob,
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
    assert.throws(
      () => dockerArgs({ workspace: process.cwd(), command: ["true"] }, "lilith-job-test"),
      /dedicated workspace/,
    );
    assert.throws(
      () => dockerArgs({ workspace: tmpdir(), command: ["true"] }, "lilith-job-test"),
      /dedicated workspace/,
    );
    assert.match(args.at(-2) ?? "", /^alpine:3\.22@sha256:[a-f0-9]{64}$/);
    assert.equal(args.at(-1), "true");
  } finally {
    await rm(workspace, { recursive: true, force: true });
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

test("already-aborted jobs never start docker", async () => {
  await assert.rejects(
    runIsolatedJob({
      id: "already-aborted",
      workspace: process.cwd(),
      command: ["true"],
      signal: AbortSignal.abort(),
    }),
    /cancelled/,
  );
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
    await withDockerMutex(async () => {
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
    });
  },
);
