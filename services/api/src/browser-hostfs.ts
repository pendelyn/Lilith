import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join, relative } from "node:path";

export const HOST_NET_DIR = ".lilith-net";
export const HOST_BROWSER_DIR = ".lilith-browser";
export const HOST_INBOX = "inbox";
export const HOST_BODY = "body";
export const HOST_REPLY = "reply";
export const HOST_READY = "ready";
export const HOST_SHOT = "shot.jpg";
export const HOST_RESULT = "result.json";
export const HOST_BODY_CONTAINER_PATH = `/workspace/${HOST_NET_DIR}/${HOST_BODY}`;

const PROTOCOL_NAME = /^[a-zA-Z0-9._-]+$/;

export type HostProtocol = {
  workspaceReal: string;
  netReal: string;
  browserReal: string;
  inbox: number;
  body: number;
  reply: number;
  shot: number;
  result: number;
  ready: number;
};

export function openHostProtocol(workspace: string): HostProtocol {
  const workspaceReal = assertRealDir(workspace);
  const netReal = ensureRealChildDir(workspaceReal, HOST_NET_DIR);
  const browserReal = ensureRealChildDir(workspaceReal, HOST_BROWSER_DIR);
  return {
    workspaceReal,
    netReal,
    browserReal,
    inbox: openExclusiveFile(netReal, HOST_INBOX),
    body: openExclusiveFile(netReal, HOST_BODY),
    reply: openExclusiveFile(netReal, HOST_REPLY),
    shot: openExclusiveFile(browserReal, HOST_SHOT),
    result: openExclusiveFile(browserReal, HOST_RESULT),
    ready: openExclusiveFile(browserReal, HOST_READY),
  };
}

export function closeHostProtocol(proto: HostProtocol): void {
  for (const fd of [proto.inbox, proto.body, proto.reply, proto.shot, proto.result, proto.ready]) {
    try {
      closeSync(fd);
    } catch {
      // already closed
    }
  }
}

export function readHostFd(fd: number, maxBytes: number): Buffer {
  const st = fstatSync(fd);
  if (!st.isFile() || st.size < 0 || st.size > maxBytes) throw new Error("Untrusted protocol file");
  const buf = Buffer.alloc(st.size);
  if (st.size === 0) return buf;
  const n = readSync(fd, buf, 0, buf.length, 0);
  return buf.subarray(0, n);
}

export function writeHostFd(fd: number, data: string | Buffer): void {
  const st = fstatSync(fd);
  if (!st.isFile()) throw new Error("Untrusted protocol file");
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
  ftruncateSync(fd, 0);
  let offset = 0;
  while (offset < buf.length) {
    offset += writeSync(fd, buf, offset, buf.length - offset, offset);
  }
}

export function removeTreeNoFollow(root: string): void {
  let st;
  try {
    st = lstatSync(root);
  } catch (error) {
    if (isNotFound(error)) return;
    // Docker Desktop can plant Linux symlinks whose Windows reparse point
    // rejects lstat. Unlink the name; never recurse through it.
    try {
      unlinkSync(root);
      return;
    } catch (unlinkError) {
      if (isNotFound(unlinkError)) return;
      throw error;
    }
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    unlinkSync(root);
    return;
  }
  for (const name of readdirSync(root)) {
    removeTreeNoFollow(join(root, name));
  }
  rmdirSync(root);
}

function exclusiveFlags(): number {
  // ponytail: Windows libuv exposes no O_NOFOLLOW. Host-owned exclusive files
  // opened before the container starts, then used only via those fds, are the
  // trust boundary. Linux adds O_NOFOLLOW when the constant exists.
  const nofollow = constants.O_NOFOLLOW;
  return constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (typeof nofollow === "number" ? nofollow : 0);
}

function openExclusiveFile(dirReal: string, name: string): number {
  if (!PROTOCOL_NAME.test(name) || name === "." || name === "..") throw new Error("Invalid protocol file");
  assertRealDir(dirReal);
  return openSync(join(dirReal, name), exclusiveFlags(), 0o600);
}

function ensureRealChildDir(parentReal: string, name: string): string {
  if (!PROTOCOL_NAME.test(name)) throw new Error("Untrusted protocol directory");
  const dest = join(parentReal, name);
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  const real = assertRealDir(dest);
  if (relative(parentReal, real) !== name) throw new Error("Untrusted protocol directory");
  return real;
}

function assertRealDir(path: string): string {
  const listing = lstatSync(path);
  if (listing.isSymbolicLink() || !listing.isDirectory()) throw new Error("Untrusted protocol directory");
  return realpathSync(path);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
