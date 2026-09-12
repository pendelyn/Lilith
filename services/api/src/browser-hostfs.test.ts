import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  closeHostProtocol,
  HOST_BODY,
  HOST_INBOX,
  HOST_NET_DIR,
  HOST_REPLY,
  openHostProtocol,
  readHostFd,
  removeTreeNoFollow,
  writeHostFd,
} from "./browser-hostfs.ts";

test("host protocol writes stay on host-owned fds when the path is replaced with a junction", () => {
  const root = mkdtempSync(join(tmpdir(), "lilith-hostfs-"));
  const workspace = join(root, "ws");
  const outside = join(root, "outside");
  mkdirSync(workspace);
  mkdirSync(outside);
  const sentinel = join(outside, "secret.txt");
  writeFileSync(sentinel, "UNTOUCHED");
  const proto = openHostProtocol(workspace);
  try {
    writeHostFd(proto.body, "page-bytes");
    assert.equal(readHostFd(proto.body, 64).toString("utf8"), "page-bytes");
    unlinkProtocolNames(workspace);
    rmdirSync(join(workspace, HOST_NET_DIR));
    assert.equal(tryDirLink(outside, join(workspace, HOST_NET_DIR)), true);
    writeHostFd(proto.body, "still-host-owned");
    writeHostFd(proto.inbox, '{"t":"need","id":"1"}');
    writeHostFd(proto.reply, '{"t":"ok","id":"1"}');
    assert.equal(readFileSync(sentinel, "utf8"), "UNTOUCHED");
    assert.equal(readHostFd(proto.body, 64).toString("utf8"), "still-host-owned");
    assert.equal(existsSync(join(outside, HOST_BODY)), false);
    assert.equal(existsSync(join(outside, HOST_INBOX)), false);
    assert.equal(existsSync(join(outside, HOST_REPLY)), false);
  } finally {
    closeHostProtocol(proto);
    removeTreeNoFollow(workspace);
    assert.equal(readFileSync(sentinel, "utf8"), "UNTOUCHED");
    removeTreeNoFollow(root);
  }
});

test("openHostProtocol refuses a net directory that is already a junction", () => {
  const root = mkdtempSync(join(tmpdir(), "lilith-hostfs-parent-"));
  const workspace = join(root, "ws");
  const outside = join(root, "outside");
  mkdirSync(workspace);
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "UNTOUCHED");
  assert.equal(tryDirLink(outside, join(workspace, HOST_NET_DIR)), true);
  assert.throws(() => openHostProtocol(workspace), /Untrusted protocol directory/);
  assert.equal(readFileSync(join(outside, "secret.txt"), "utf8"), "UNTOUCHED");
  assert.equal(existsSync(join(outside, HOST_BODY)), false);
  removeTreeNoFollow(root);
});

test("removeTreeNoFollow unlinks a planted junction and does not delete the sentinel", () => {
  const root = mkdtempSync(join(tmpdir(), "lilith-hostfs-rm-"));
  const workspace = join(root, "ws");
  const outside = join(root, "outside");
  mkdirSync(workspace);
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "UNTOUCHED");
  assert.equal(tryDirLink(outside, join(workspace, HOST_NET_DIR)), true);
  removeTreeNoFollow(workspace);
  assert.equal(existsSync(workspace), false);
  assert.equal(readFileSync(join(outside, "secret.txt"), "utf8"), "UNTOUCHED");
  removeTreeNoFollow(root);
});

test("host protocol fds win a race that swaps the net dir for a junction", () => {
  const root = mkdtempSync(join(tmpdir(), "lilith-hostfs-race-"));
  const workspace = join(root, "ws");
  const outside = join(root, "outside");
  mkdirSync(workspace);
  mkdirSync(outside);
  const sentinel = join(outside, "secret.txt");
  writeFileSync(sentinel, "UNTOUCHED");
  const proto = openHostProtocol(workspace);
  const attacker = setInterval(() => {
    try {
      unlinkProtocolNames(workspace);
      rmdirSync(join(workspace, HOST_NET_DIR));
    } catch {
      // directory not empty or already replaced
    }
    tryDirLink(outside, join(workspace, HOST_NET_DIR));
  }, 1);
  try {
    for (let i = 0; i < 80; i += 1) {
      writeHostFd(proto.body, `round-${i}`);
      writeHostFd(proto.inbox, `need-${i}`);
      writeHostFd(proto.reply, `reply-${i}`);
      assert.equal(readFileSync(sentinel, "utf8"), "UNTOUCHED");
    }
    assert.match(readHostFd(proto.body, 64).toString("utf8"), /^round-\d+$/);
    assert.equal(readFileSync(sentinel, "utf8"), "UNTOUCHED");
    assert.equal(readdirSync(outside).includes(HOST_BODY), false);
  } finally {
    clearInterval(attacker);
    closeHostProtocol(proto);
    removeTreeNoFollow(workspace);
    assert.equal(readFileSync(sentinel, "utf8"), "UNTOUCHED");
    removeTreeNoFollow(root);
  }
});

test("host-owned ready file is readable through the kept fd", async () => {
  await mkdir(join(tmpdir(), "lilith-hostfs-async"), { recursive: true });
  const workspace = await mkdtemp(join(tmpdir(), "lilith-hostfs-async-"));
  const proto = openHostProtocol(workspace);
  try {
    writeHostFd(proto.ready, "page-ready\n");
    assert.equal(readHostFd(proto.ready, 32).toString("utf8"), "page-ready\n");
  } finally {
    closeHostProtocol(proto);
    removeTreeNoFollow(workspace);
  }
});

function unlinkProtocolNames(workspace: string): void {
  for (const name of [HOST_BODY, HOST_INBOX, HOST_REPLY]) {
    try {
      unlinkSync(join(workspace, HOST_NET_DIR, name));
    } catch {
      // already gone
    }
  }
}

function tryDirLink(target: string, path: string): boolean {
  try {
    symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  }
}
