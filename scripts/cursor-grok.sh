#!/usr/bin/env bash
# Linux entry for the Cursor Grok worker. Default mode is read-only ask.
# The prompt is read from stdin and is not placed on the command line.
# agent mode runs only on a git branch named issue/<number>-...
# Native Linux keeps the CLI sandbox setting. Do not force it off here;
# the Windows wrapper does that only because that sandbox does not exist there.
set -euo pipefail

die() {
  printf '%s\n' "$1" >&2
  exit "${2:-1}"
}

usage() {
  cat >&2 <<'EOF'
Usage: cursor-grok.sh [--mode ask|plan|agent] [--workspace PATH] [--worktree] [--heartbeat-seconds N]

Read the prompt from stdin. Default mode is ask (read-only).
agent mode is allowed only on a git branch named issue/<number>-...
EOF
}

mode=ask
workspace=$PWD
worktree=0
heartbeat=20

while [[ $# -gt 0 ]]; do
  case $1 in
    --mode)
      [[ $# -ge 2 ]] || die 'missing value for --mode' 2
      mode=$2
      shift 2
      ;;
    --workspace)
      [[ $# -ge 2 ]] || die 'missing value for --workspace' 2
      workspace=$2
      shift 2
      ;;
    --worktree)
      worktree=1
      shift
      ;;
    --heartbeat-seconds)
      [[ $# -ge 2 ]] || die 'missing value for --heartbeat-seconds' 2
      heartbeat=$2
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      die "unknown argument: $1" 2
      ;;
  esac
done

case $mode in
  ask|plan|agent) ;;
  *) die 'Mode must be ask, plan, or agent.' 2 ;;
esac

if [[ ! $heartbeat =~ ^[0-9]+$ ]] || [[ $((10#$heartbeat)) -lt 1 ]]; then
  die 'HeartbeatSeconds must be at least 1.' 2
fi

if [[ ! -d $workspace ]]; then
  die "Workspace is not a directory: $workspace" 2
fi
# The child cwd is the workspace, so a relative --workspace would be resolved
# again from inside it. `cd -- -` is OLDPWD; CDPATH would pick a different tree.
workspace_in=$workspace
cd_target=$workspace
if [[ $cd_target == - ]]; then
  cd_target=./-
fi
workspace=$(CDPATH= cd -- "$cd_target" && pwd) || die "Workspace is not a directory: $workspace_in" 2

if [[ -n ${CURSOR_GROK_AGENT:-} ]]; then
  agent=$CURSOR_GROK_AGENT
else
  agent=/home/coder/.local/bin/agent
fi
if [[ $agent != /* ]]; then
  agent=$PWD/$agent
fi
if [[ ! -f $agent || ! -x $agent ]]; then
  die 'Cursor CLI not found. Install it from https://cursor.com/docs/cli/installation.' 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  die 'python3 is required to run cursor-grok.sh' 1
fi

saved_umask=$(umask)
umask 077
td=$(mktemp -d "${TMPDIR:-/tmp}/cursor-grok.XXXXXX")
trap 'rm -rf "$td"' EXIT
cat > "$td/prompt"
chmod 600 "$td/prompt"
umask "$saved_umask"
if ! grep -q '[^[:space:]]' "$td/prompt"; then
  die 'Prompt is empty. Pass it on stdin.' 2
fi

if [[ $mode == agent ]]; then
  # A parent GIT_DIR/GIT_WORK_TREE names some other checkout. Drop them for the
  # guard and the child, or agent mode can be aimed at a branch we did not check.
  unset GIT_DIR GIT_WORK_TREE
  git_err=0
  branch=$(git -C "$workspace" -c alias.branch= branch --show-current 2>/dev/null) || git_err=$?
  branch=${branch//$'\r'/}
  branch="${branch#"${branch%%[![:space:]]*}"}"
  branch="${branch%"${branch##*[![:space:]]}"}"
  if [[ $git_err -ne 0 || ! $branch =~ ^issue/[0-9]+- ]]; then
    die 'Writing Grok runs require an issue/<number>-... branch.' 1
  fi
fi

cli=(
  -p
  --output-format stream-json
  --trust
  --model grok-4.7-xhigh
)
if [[ $mode == agent ]]; then
  cli+=(--force)
else
  cli+=(--mode "$mode")
fi
if [[ $worktree -eq 1 ]]; then
  cli+=(--worktree)
fi
cli+=(--workspace "$workspace")

# exec replaces this shell. The supervisor unlinks the prompt file before launch.
# A failed exec exits the shell before the next line; execfail makes it return.
shopt -s execfail
set +e
exec python3 - "$td" "$workspace" "$agent" "$heartbeat" "${cli[@]}" <<'PY'
import json
import os
import selectors
import shutil
import signal
import subprocess
import sys
import time

# ponytail: cancel and failure signal only this child session.
# A grandchild that calls setsid leaves the group; the print CLI does not.
TOKEN = __import__("re").compile(r"[A-Za-z0-9_.-]{1,64}")
state = {"child": None, "aborted": None}


def signal_group(pid, sig):
    if pid is None or pid <= 1:
        return
    try:
        os.killpg(pid, sig)
    except ProcessLookupError:
        pass


def on_signal(signum, _frame):
    state["aborted"] = 128 + signum
    child = state["child"]
    if child is not None and child.poll() is None:
        signal_group(child.pid, signum)


def cleanup():
    child = state["child"]
    if child is None or child.poll() is not None:
        return
    signal_group(child.pid, signal.SIGTERM)
    try:
        child.wait(timeout=1)
    except subprocess.TimeoutExpired:
        signal_group(child.pid, signal.SIGKILL)
        try:
            child.wait(timeout=1)
        except subprocess.TimeoutExpired:
            pass


def split_lines(buf, final):
    lines = []
    while True:
        cut = buf.find(b"\n")
        if cut < 0:
            break
        line = buf[:cut]
        if line.endswith(b"\r"):
            line = line[:-1]
        lines.append(line)
        buf = buf[cut + 1 :]
    if final:
        if buf.endswith(b"\r"):
            buf = buf[:-1]
        if buf:
            lines.append(buf)
        buf = b""
    return lines, buf


def parse_event(line):
    try:
        obj = json.loads(line.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(obj, dict):
        return None
    return obj


def event_kind(obj):
    if obj is None:
        return "output"
    kind = obj.get("type")
    sub = obj.get("subtype")
    if not isinstance(kind, str) or TOKEN.fullmatch(kind) is None:
        return "output"
    if isinstance(sub, str) and TOKEN.fullmatch(sub) is not None:
        return kind + "/" + sub
    return kind


def emit_progress(kind):
    sys.stderr.buffer.write(b"cursor-grok: " + kind.encode("ascii") + b"\n")
    sys.stderr.buffer.flush()


def run():
    td = sys.argv[1]
    workspace = sys.argv[2]
    agent = sys.argv[3]
    heartbeat = int(sys.argv[4])
    cli = sys.argv[5:]
    prompt_path = os.path.join(td, "prompt")
    prompt_f = open(prompt_path, "rb")
    try:
        os.unlink(prompt_path)
        child = subprocess.Popen(
            [agent, *cli],
            cwd=workspace,
            stdin=prompt_f,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
    finally:
        prompt_f.close()
    state["child"] = child
    if state["aborted"] is not None:
        cleanup()
        return state["aborted"]

    out_raw = child.stdout.detach()
    err_raw = child.stderr.detach()
    sel = selectors.DefaultSelector()
    sel.register(out_raw, selectors.EVENT_READ, "out")
    sel.register(err_raw, selectors.EVENT_READ, "err")
    # select() retries on EINTR, so a child that ignores SIGTERM would block
    # until the heartbeat before cleanup escalates to SIGKILL.
    wake_r, wake_w = os.pipe()
    os.set_blocking(wake_r, False)
    os.set_blocking(wake_w, False)
    signal.set_wakeup_fd(wake_w)
    sel.register(wake_r, selectors.EVENT_READ, "wake")
    open_streams = 2
    out_buf = b""
    err_buf = b""
    result = None
    result_error = False
    start = time.monotonic()
    last_beat = start

    def beat():
        nonlocal last_beat
        elapsed = int(time.monotonic() - start)
        sys.stderr.buffer.write(f"cursor-grok: waiting {elapsed}s\n".encode("ascii"))
        sys.stderr.buffer.flush()
        last_beat = time.monotonic()

    def take(which, chunk, final):
        nonlocal out_buf, err_buf, result, result_error
        if which == "out":
            out_buf += chunk
            lines, out_buf = split_lines(out_buf, final)
            for line in lines:
                if not line:
                    continue
                obj = parse_event(line)
                if obj is not None and obj.get("type") == "result":
                    result = line
                    # Documented stream-json result: is_error is a boolean.
                    result_error = obj.get("is_error") is True
                    continue
                emit_progress(event_kind(obj))
        else:
            err_buf += chunk
            lines, err_buf = split_lines(err_buf, final)
            for line in lines:
                if not line:
                    continue
                sys.stderr.buffer.write(line + b"\n")
                sys.stderr.buffer.flush()

    while open_streams:
        if state["aborted"] is not None:
            cleanup()
            return state["aborted"]
        remain = heartbeat - (time.monotonic() - last_beat)
        if remain <= 0:
            beat()
            continue
        try:
            events = sel.select(remain)
        except InterruptedError:
            continue
        if state["aborted"] is not None:
            cleanup()
            return state["aborted"]
        if not events:
            beat()
            continue
        for key, _mask in events:
            if key.data == "wake":
                try:
                    while os.read(key.fd, 65536):
                        pass
                except BlockingIOError:
                    pass
                continue
            try:
                chunk = os.read(key.fd, 65536)
            except OSError:
                chunk = b""
            if chunk == b"":
                take(key.data, b"", True)
                try:
                    sel.unregister(key.fileobj)
                except Exception:
                    pass
                open_streams -= 1
            else:
                take(key.data, chunk, False)

    if state["aborted"] is not None:
        cleanup()
        return state["aborted"]
    rc = child.wait()
    if rc < 0:
        rc = 128 + (-rc)
    if state["aborted"] is not None:
        return state["aborted"]
    if result is not None:
        sys.stdout.buffer.write(result + b"\n")
        sys.stdout.buffer.flush()
        # Child status wins. is_error with exit 0 is still a failed run.
        if rc == 0 and result_error:
            return 1
        return rc
    sys.stderr.buffer.write(b"cursor-grok: no result event\n")
    sys.stderr.buffer.flush()
    return rc if rc != 0 else 1


signal.signal(signal.SIGTERM, on_signal)
signal.signal(signal.SIGINT, on_signal)
signal.signal(signal.SIGHUP, on_signal)
status = 1
td = sys.argv[1] if len(sys.argv) > 1 else ""
try:
    status = run()
except Exception as exc:
    sys.stderr.write(f"cursor-grok: {exc}\n")
    status = 1
finally:
    cleanup()
    if td:
        shutil.rmtree(td, ignore_errors=True)
raise SystemExit(status)
PY
set -e
die 'failed to start cursor-grok supervisor' 1
