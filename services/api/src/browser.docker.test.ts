import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  BROWSER_IMAGE,
  BROWSER_PIDS_LIMIT,
  COOKIE_FIND_TOKEN,
  browserDockerArgs,
  formatBrowserResult,
  runBrowserSession,
} from "./browser.ts";
import {
  closeHostProtocol,
  HOST_BODY,
  HOST_NET_DIR,
  openHostProtocol,
  readHostFd,
  removeTreeNoFollow,
  writeHostFd,
} from "./browser-hostfs.ts";
import { withDockerMutex } from "./docker-test-lock.ts";
import { createRetentionStore, listArtifacts } from "./retention.ts";
import { RUNNER_WORKSPACES_ROOT, runIsolatedJob } from "./runner.ts";
import {
  createParentTask,
  createTaskStore,
  setTaskState,
  startSubagent,
  stopTask,
} from "./tasks.ts";

const docker = process.env.RUN_DOCKER_TESTS === "1";
const owner = { ownerId: "alpha-owner" };
const expectedUid = process.getuid?.() ?? 65532;

function containerNames(all = true): Set<string> {
  const output = execFileSync(
    "docker",
    ["ps", ...(all ? ["--all"] : []), "--filter", "name=lilith-job-", "--format", "{{.Names}}"],
    { encoding: "utf8" },
  );
  return new Set(output.split(/\s+/).filter(Boolean));
}

function pageReadyIn(name: string): boolean {
  try {
    const marker = execFileSync("docker", ["exec", name, "cat", "/workspace/.lilith-browser/ready"], {
      encoding: "utf8",
    });
    return marker.includes("page-ready");
  } catch {
    return false;
  }
}

function chromiumRunningIn(name: string): boolean {
  try {
    const top = execFileSync("docker", ["top", name], { encoding: "utf8" });
    return /chrome-headless-shell|headless_shell/.test(top);
  } catch {
    return false;
  }
}

test(
  "browser docker args keep the sandbox and pin the reviewed Playwright digest",
  { skip: !docker },
  async () => {
    await withDockerMutex(async () => {
    await mkdir(RUNNER_WORKSPACES_ROOT, { recursive: true });
    const workspace = await mkdtemp(join(RUNNER_WORKSPACES_ROOT, "browser-inspect-"));
    const name = `lilith-job-inspect-${Date.now()}`;
    try {
      execFileSync("docker", browserDockerArgs({ workspace, command: ["true"] }, name));
      const inspect = JSON.parse(execFileSync("docker", ["inspect", name], { encoding: "utf8" })) as Array<{
        Config: { User: string; Image: string };
        HostConfig: {
          NetworkMode: string;
          Privileged: boolean;
          CapAdd: string[] | null;
          CapDrop: string[] | null;
          PidsLimit: number;
          Memory: number;
          ReadonlyRootfs: boolean;
          IpcMode: string;
          Binds: string[] | null;
        };
      }>;
      const info = inspect[0];
      assert.ok(info);
      assert.equal(info.Config.User, `${expectedUid}:${expectedUid}`);
      assert.equal(info.HostConfig.NetworkMode, "none");
      assert.equal(info.HostConfig.Privileged, false);
      assert.equal(info.HostConfig.ReadonlyRootfs, true);
      assert.equal(info.HostConfig.PidsLimit, BROWSER_PIDS_LIMIT);
      assert.equal(info.HostConfig.Memory, 512 * 1024 * 1024);
      assert.equal(info.HostConfig.IpcMode === "host", false);
      assert.equal(JSON.stringify(info.HostConfig.CapAdd ?? []), "[]");
      assert.ok((info.HostConfig.CapDrop ?? []).includes("ALL"));
      assert.equal(JSON.stringify(info.HostConfig.Binds ?? []).includes("docker.sock"), false);
      assert.match(info.Config.Image, /playwright/);
      const repo = execFileSync("docker", ["inspect", "--format", "{{index .RepoDigests 0}}", BROWSER_IMAGE.split("@")[0]!], {
        encoding: "utf8",
      });
      assert.match(repo, /sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27/);
    } finally {
      execFileSync("docker", ["rm", "--force", name]);
      await rm(workspace, { recursive: true, force: true });
    }
    });
  },
);

test(
  "real isolated browser opens the cookie fixture, dismisses the dialog, finds, scrolls, and is removed",
  { skip: !docker, timeout: 180_000 },
  async () => {
    await withDockerMutex(async () => {
    const before = containerNames();
    const filesRoot = await mkdtemp(join(tmpdir(), "lilith-browser-shot-"));
    const retention = createRetentionStore({ filesRoot });
    try {
      const store = createTaskStore();
      const parent = createParentTask(store, owner, "cookie-browser");
      const started = startSubagent(store, owner, {
        parentTaskId: parent.id,
        assignment: "cookie-browser",
        role: "research",
      });
      setTaskState(store, owner, started.id, "working");
      const session = await runBrowserSession(
        {
          ops: [
            { op: "open", url: "file:///workspace/cookie.html" },
            { op: "dismissCookies" },
            { op: "find", text: COOKIE_FIND_TOKEN },
            { op: "scroll", dy: 800 },
            { op: "read" },
            { op: "screenshot" },
          ],
          approved: [],
        },
        store,
        owner,
        started.id,
        { retention },
      );
      const result = formatBrowserResult(session);
      assert.match(result, /cookies-accepted/);
      assert.match(result, new RegExp(`Find ${COOKIE_FIND_TOKEN}: yes`));
      assert.match(result, /ScrollY: [1-9]/);
      assert.equal(result.includes("outside-accept"), false);
      assert.equal(result.includes("dialog-ok"), false);
      assert.equal(result.includes("form-ok"), false);
      assert.equal(listArtifacts(retention, owner).some((item) => item.kind === "screenshot"), true);
      const leftover = [...containerNames()].filter((name) => !before.has(name));
      assert.deepEqual(leftover, []);
    } finally {
      await rm(filesRoot, { recursive: true, force: true });
    }
    });
  },
);

test(
  "abort kills the browser container and does not complete the job",
  { skip: !docker, timeout: 180_000 },
  async () => {
    await withDockerMutex(async () => {
    const before = containerNames();
    const store = createTaskStore();
    const parent = createParentTask(store, owner, "hang-browser");
    const started = startSubagent(store, owner, {
      parentTaskId: parent.id,
      assignment: "hang-browser",
      role: "research",
    });
    setTaskState(store, owner, started.id, "working");
    const pending = runBrowserSession(
      {
        ops: [{ op: "open", url: "file:///workspace/cookie.html" }, { op: "hang" }],
        approved: [],
      },
      store,
      owner,
      started.id,
      {},
    );
    const startedAt = Date.now();
    let readyName: string | undefined;
    while (Date.now() - startedAt < 90_000) {
      const live = [...containerNames(false)].filter((name) => !before.has(name));
      readyName = live.find((name) => pageReadyIn(name) && chromiumRunningIn(name));
      if (readyName !== undefined) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.ok(readyName, "abort waited for page-ready and a running Chromium process");
    assert.equal(chromiumRunningIn(readyName), true);
    const stopped = stopTask(store, owner, started.id);
    assert.equal(stopped.state, "stopped");
    await assert.rejects(pending, /cancelled|failed|timed out/);
    assert.equal(store.tasks.get(started.id)?.state, "stopped");
    assert.equal(store.tasks.get(started.id)?.result, undefined);
    const leftover = [...containerNames()].filter((name) => !before.has(name));
    assert.deepEqual(leftover, []);
    });
  },
);

test(
  "hostile container symlink or parent junction cannot redirect host protocol reads or writes",
  { skip: !docker, timeout: 180_000 },
  async () => {
    await withDockerMutex(async () => {
      await mkdir(RUNNER_WORKSPACES_ROOT, { recursive: true, mode: 0o700 });
      const workspace = await mkdtemp(join(RUNNER_WORKSPACES_ROOT, "browser-adv-"));
      const sentinelName = `sentinel-${randomUUID()}`;
      const outsideName = `outside-${randomUUID()}`;
      const sentinel = join(RUNNER_WORKSPACES_ROOT, sentinelName);
      const outside = join(RUNNER_WORKSPACES_ROOT, outsideName);
      writeFileSync(sentinel, "UNTOUCHED");
      await mkdir(outside, { recursive: true, mode: 0o700 });
      writeFileSync(join(outside, "secret.txt"), "UNTOUCHED");
      const proto = openHostProtocol(workspace);
      try {
        await runIsolatedJob({
          id: randomUUID(),
          workspace,
          timeoutMs: 15_000,
          command: [
            "/bin/sh",
            "-c",
            `rm -f /workspace/${HOST_NET_DIR}/body && ln -s ../../${sentinelName} /workspace/${HOST_NET_DIR}/body`,
          ],
        });
        writeHostFd(proto.body, "HOST_PAYLOAD");
        writeHostFd(proto.inbox, '{"t":"need","id":"x","url":"https://example.com/","method":"GET"}');
        assert.equal(readFileSync(sentinel, "utf8"), "UNTOUCHED");
        assert.equal(readHostFd(proto.body, 64).toString("utf8"), "HOST_PAYLOAD");
        assert.equal(readHostFd(proto.inbox, 256).toString("utf8").includes("example.com"), true);

        await runIsolatedJob({
          id: randomUUID(),
          workspace,
          timeoutMs: 15_000,
          command: [
            "/bin/sh",
            "-c",
            `rm -rf /workspace/${HOST_NET_DIR} && ln -s ../../${outsideName} /workspace/${HOST_NET_DIR}`,
          ],
        });
        writeHostFd(proto.body, "HOST_AFTER_PARENT");
        writeHostFd(proto.reply, '{"t":"deny","id":"x"}');
        assert.equal(readFileSync(join(outside, "secret.txt"), "utf8"), "UNTOUCHED");
        assert.equal(existsSync(join(outside, HOST_BODY)), false);
        assert.equal(readHostFd(proto.body, 64).toString("utf8"), "HOST_AFTER_PARENT");
      } finally {
        closeHostProtocol(proto);
        removeTreeNoFollow(workspace);
        assert.equal(readFileSync(sentinel, "utf8"), "UNTOUCHED");
        assert.equal(readFileSync(join(outside, "secret.txt"), "utf8"), "UNTOUCHED");
        removeTreeNoFollow(sentinel);
        removeTreeNoFollow(outside);
      }
    });
  },
);

test(
  "file:// cannot read workspace internals",
  { skip: !docker, timeout: 180_000 },
  async () => {
    await withDockerMutex(async () => {
      const store = createTaskStore();
      const parent = createParentTask(store, owner, "file-escape");
      const started = startSubagent(store, owner, {
        parentTaskId: parent.id,
        assignment: "file-escape",
        role: "research",
      });
      setTaskState(store, owner, started.id, "working");
      await assert.rejects(
        runBrowserSession(
          {
            ops: [{ op: "open", url: "file:///workspace/.lilith-browser/session.json" }, { op: "read" }],
            approved: [],
          },
          store,
          owner,
          started.id,
          {},
        ),
      );
    });
  },
);
