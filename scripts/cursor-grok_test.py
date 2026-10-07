#!/usr/bin/env python3
"""Focused checks for scripts/cursor-grok.sh. Fake CLI only; no network."""

import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import traceback
from pathlib import Path

WRAPPER = Path(__file__).resolve().parent / "cursor-grok.sh"
FAILED = []
TMP = None
LEFTOVERS = []

FAKE_LINES = [
    "#!/usr/bin/env python3",
    "import json, os, sys, time, pathlib, subprocess, signal",
    "cap = pathlib.Path(os.environ['CURSOR_GROK_CAPTURE'])",
    "cap.mkdir(parents=True, exist_ok=True)",
    "(cap / 'argv.json').write_text(json.dumps(sys.argv[1:], ensure_ascii=False), encoding='utf-8')",
    "(cap / 'stdin.bin').write_bytes(sys.stdin.buffer.read())",
    "(cap / 'cwd.txt').write_text(os.getcwd(), encoding='utf-8')",
    "(cap / 'self.pid').write_text(str(os.getpid()), encoding='utf-8')",
    "(cap / 'gitdir.txt').write_text(os.environ.get('GIT_DIR', ''), encoding='utf-8')",
    "(cap / 'gitwork.txt').write_text(os.environ.get('GIT_WORK_TREE', ''), encoding='utf-8')",
    "previous_umask = os.umask(0o077)",
    "os.umask(previous_umask)",
    "(cap / 'umask.txt').write_text('%04o' % previous_umask, encoding='utf-8')",
    "mode = os.environ.get('CURSOR_GROK_FAKE_MODE', 'ok')",
    "raw_exit = os.environ.get('CURSOR_GROK_FAKE_EXIT', '')",
    "code = int(raw_exit) if raw_exit else 0",
    "def emit_ok():",
    "    out = sys.stdout.buffer",
    "    out.write(b'{\"type\":\"thinking\",\"subtype\":\"delta\",\"text\":\"SECRET-THOUGHT\"}\\n')",
    "    out.write(b'{\"type\":\"assistant\",\"subtype\":\"delta\",\"text\":\"SECRET-ASSIST\"}\\n')",
    "    result = 'caf' + chr(0xE9) + ' ' + chr(0x20AC) + ' READY'",
    "    line = json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': result}, ensure_ascii=False)",
    "    out.write(line.encode() + b'\\n')",
    "    out.flush()",
    "if mode == 'empty':",
    "    raise SystemExit(code)",
    "if mode == 'malformed':",
    "    sys.stdout.buffer.write(b'{\"type\":\"result\",\"result\":')",
    "    raise SystemExit(0)",
    "if mode == 'false-result':",
    "    text = 'SECRET-ASSIST ' + chr(34) + 'type' + chr(34) + ': ' + chr(34) + 'result' + chr(34)",
    "    line = json.dumps({'type': 'assistant', 'subtype': 'delta', 'text': text}, ensure_ascii=False)",
    "    sys.stdout.buffer.write(line.encode() + b'\\n')",
    "    raise SystemExit(0)",
    "if mode == 'error-result':",
    "    line = json.dumps({'type': 'result', 'subtype': 'success', 'is_error': True, 'result': 'semantic failure'}, ensure_ascii=False)",
    "    sys.stdout.buffer.write(line.encode() + b'\\n')",
    "    raise SystemExit(code)",
    "if mode == 'slow':",
    "    sys.stderr.buffer.write(b'connection lost sample\\n')",
    "    sys.stderr.buffer.flush()",
    "    time.sleep(3)",
    "    emit_ok()",
    "    raise SystemExit(code)",
    "if mode == 'burst':",
    "    err = sys.stderr.buffer",
    "    for n in range(1, 31):",
    "        err.write(('burst-%s\\n' % n).encode())",
    "    err.flush()",
    "    emit_ok()",
    "    raise SystemExit(0)",
    "if mode == 'ignore-term':",
    "    signal.signal(signal.SIGTERM, signal.SIG_IGN)",
    "    signal.signal(signal.SIGINT, signal.SIG_IGN)",
    "    signal.signal(signal.SIGHUP, signal.SIG_IGN)",
    "    (cap / 'ignoring').write_text('1', encoding='utf-8')",
    "    time.sleep(120)",
    "    raise SystemExit(0)",
    "if mode == 'tree':",
    "    child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'])",
    "    (cap / 'grand.pid').write_text(str(child.pid), encoding='utf-8')",
    "    time.sleep(120)",
    "    raise SystemExit(0)",
    "emit_ok()",
    "raise SystemExit(code)",
]


def check(condition, message):
    if not condition:
        FAILED.append(message)


def install_fake(directory):
    path = directory / "fake-agent.py"
    path.write_text("\n".join(FAKE_LINES) + "\n", encoding="utf-8")
    path.chmod(0o755)
    return path


def git(path, *args):
    env = os.environ.copy()
    env["GIT_CONFIG_GLOBAL"] = os.devnull
    env["GIT_CONFIG_SYSTEM"] = os.devnull
    env["GIT_TERMINAL_PROMPT"] = "0"
    proc = subprocess.run(
        ["git", "-C", str(path), *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed ({proc.returncode}) {proc.stderr.strip()}")
    return proc


def init_repo(path, branch=None, detach=False):
    path.mkdir(parents=True, exist_ok=True)
    git(path, "init", "-q", "-b", "main")
    git(path, "config", "user.email", "cursor-grok-test@example.com")
    git(path, "config", "user.name", "cursor-grok-test")
    git(path, "config", "commit.gpgsign", "false")
    (path / "f.txt").write_text("x", encoding="utf-8")
    git(path, "add", "--", "f.txt")
    git(path, "commit", "-q", "-m", "init")
    if branch:
        git(path, "checkout", "-q", "-b", branch)
    if detach:
        git(path, "checkout", "-q", "--detach", "HEAD")


def make_env(fake, capture, mode, fake_exit):
    env = os.environ.copy()
    env.pop("CURSOR_API_KEY", None)
    env["CURSOR_GROK_AGENT"] = str(fake)
    env["CURSOR_GROK_CAPTURE"] = str(capture)
    env["CURSOR_GROK_FAKE_MODE"] = mode
    if fake_exit is None:
        env.pop("CURSOR_GROK_FAKE_EXIT", None)
    else:
        env["CURSOR_GROK_FAKE_EXIT"] = str(fake_exit)
    return env


def launch(args, prompt, env, timeout=20, cwd=None):
    return subprocess.run(
        [str(WRAPPER), *args],
        input=prompt,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        timeout=timeout,
        cwd=cwd,
        check=False,
    )


def capture_of(capture):
    argv_path = capture / "argv.json"
    if not argv_path.exists():
        return None
    argv = json.loads(argv_path.read_text(encoding="utf-8"))
    stdin = (capture / "stdin.bin").read_bytes() if (capture / "stdin.bin").exists() else b""
    cwd = (capture / "cwd.txt").read_text(encoding="utf-8") if (capture / "cwd.txt").exists() else ""
    return argv, stdin, cwd


def prefix():
    return ["-p", "--output-format", "stream-json", "--trust", "--model", "grok-4.7-xhigh"]


def assert_result(stdout, label):
    check(stdout.startswith(b"{"), f"{label} stdout does not start with {{: {stdout[:80]!r}")
    check(not stdout.startswith(b"\xef\xbb\xbf"), f"{label} stdout has a UTF-8 BOM")
    check(stdout.endswith(b"\n") and stdout.count(b"\n") == 1, f"{label} stdout is not one JSON line: {stdout!r}")
    check(b"\xc3\xa9" in stdout and b"\xe2\x82\xac" in stdout, f"{label} stdout lost UTF-8: {stdout!r}")
    check(b"SECRET" not in stdout, f"{label} stdout leaked a payload: {stdout!r}")
    check(b"thinking" not in stdout and b"assistant" not in stdout, f"{label} stdout included a non-result event")
    try:
        obj = json.loads(stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        check(False, f"{label} stdout is not JSON: {exc}")
        return
    check(isinstance(obj, dict) and obj.get("type") == "result", f"{label} type {obj!r}")
    check("READY" in str(obj.get("result")), f"{label} result text {obj!r}")


def assert_error_result(proc, label, code):
    err = proc.stderr.decode("utf-8", "replace")
    check(proc.returncode == code, f"{label} exit {proc.returncode}: {err}")
    check(proc.stdout.endswith(b"\n") and proc.stdout.count(b"\n") == 1, f"{label} stdout is not one JSON line: {proc.stdout!r}")
    try:
        obj = json.loads(proc.stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        check(False, f"{label} stdout is not JSON: {exc}")
        return
    check(isinstance(obj, dict) and obj.get("type") == "result", f"{label} type {obj!r}")
    check(obj.get("is_error") is True, f"{label} is_error {obj!r}")
    check(obj.get("result") == "semantic failure", f"{label} result text {obj!r}")
    check("no result event" not in err, f"{label} dropped the result record: {err}")


def assert_rejected(name, proc, capture):
    err = proc.stderr.decode("utf-8", "replace")
    check(proc.returncode == 1, f"{name} exit {proc.returncode}: {err}")
    check("Writing Grok runs require" in err and "issue/<number>" in err, f"{name} guard missing: {err}")
    check(capture_of(capture) is None, f"{name} launched the fake CLI")
    check("Traceback" not in err and "null-valued" not in err, f"{name} crashed: {err}")


def alive(pid):
    if pid is None or pid <= 1:
        return False
    stat = Path(f"/proc/{pid}/stat")
    try:
        text = stat.read_text(encoding="utf-8")
    except FileNotFoundError:
        return False
    state = text.rsplit(")", 1)[-1].split()[0]
    return state != "Z"


def flag_value(argv, flag):
    return argv[argv.index(flag) + 1]


def wait_file(path, proc, seconds=10):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if path.exists():
            return True
        if proc.poll() is not None:
            return False
        time.sleep(0.05)
    return path.exists()


def wait_pid(path, proc, seconds=10):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if path.exists():
            text = path.read_text(encoding="utf-8").strip()
            if text.isdigit():
                return int(text)
        if proc.poll() is not None:
            return None
        time.sleep(0.05)
    return None


def kill_recorded(root):
    if root is None or not root.exists():
        return
    for pidfile in root.rglob("*.pid"):
        text = pidfile.read_text(encoding="utf-8").strip()
        if text.isdigit():
            pid = int(text)
            if pid > 1 and pid != os.getpid():
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
    for pid in LEFTOVERS:
        if pid > 1 and pid != os.getpid():
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass


def run_tests():
    global TMP
    syntax = subprocess.run(["bash", "-n", str(WRAPPER)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    check(syntax.returncode == 0, f"bash -n failed: {syntax.stderr.decode()}")
    body = WRAPPER.read_text(encoding="utf-8")
    for word in ("pkill", "killall", "taskkill", "--sandbox"):
        check(word not in body, f"wrapper contains {word}")

    TMP = Path(tempfile.mkdtemp(prefix="cursor-grok-test-"))
    fake = install_fake(TMP)
    ws = TMP / "space dir" / "caf\u00e9 \u20ac"
    ws.mkdir(parents=True)
    prompt = "say \"hi\"\nnext line\ncaf\u00e9 \u20ac"
    prompt_b = prompt.encode("utf-8")

    def case(name, args, data, mode="ok", fake_exit=None, timeout=20):
        cap = TMP / f"cap-{name}"
        cap.mkdir()
        env = make_env(fake, cap, mode, fake_exit)
        try:
            proc = launch(args, data, env, timeout=timeout)
        except subprocess.TimeoutExpired:
            check(False, f"{name} timed out")
            return None, cap
        return proc, cap

    ask, ask_cap = case(
        "ask",
        ["--workspace", str(ws), "--worktree", "--heartbeat-seconds", "30"],
        prompt_b,
    )
    if ask is not None:
        got = capture_of(ask_cap)
        err = ask.stderr.decode("utf-8", "replace")
        check(ask.returncode == 0, f"ask exit {ask.returncode}: {err}")
        check(got is not None, "ask did not launch the fake CLI")
        if got is not None:
            argv, stdin, cwd = got
            expected = prefix() + ["--mode", "ask", "--worktree", "--workspace", str(ws)]
            check(argv == expected, f"ask argv {argv!r}")
            check("--force" not in argv and "--sandbox" not in argv, f"ask extra flags {argv!r}")
            check(stdin == prompt_b, f"ask stdin {stdin!r}")
            check(cwd == str(ws), f"ask cwd {cwd!r} != {str(ws)!r}")
            check("next line" not in "\n".join(argv), f"prompt leaked into argv {argv!r}")
            parent_umask = os.umask(0o077)
            os.umask(parent_umask)
            got_umask = (ask_cap / "umask.txt").read_text(encoding="utf-8").strip()
            check(got_umask == f"{parent_umask:04o}", f"child umask {got_umask} != {parent_umask:04o}")
        assert_result(ask.stdout, "ask")
        check("cursor-grok: thinking/delta" in err, f"ask missing thinking progress: {err}")
        check("cursor-grok: assistant/delta" in err, f"ask missing assistant progress: {err}")
        check("SECRET-THOUGHT" not in err and "SECRET-ASSIST" not in err, f"ask stderr leaked payload: {err}")
        check("READY" not in err, f"ask stderr leaked the result: {err}")

    plan, plan_cap = case("plan", ["--mode", "plan", "--workspace", str(ws)], b"plan-me")
    if plan is not None:
        got = capture_of(plan_cap)
        err = plan.stderr.decode("utf-8", "replace")
        check(plan.returncode == 0, f"plan exit {plan.returncode}: {err}")
        check(got is not None, "plan did not launch")
        if got is not None:
            argv, stdin, _cwd = got
            expected = prefix() + ["--mode", "plan", "--workspace", str(ws)]
            check(argv == expected, f"plan argv {argv!r}")
            check("--force" not in argv and "--worktree" not in argv, f"plan flags {argv!r}")
            check(stdin == b"plan-me", f"plan stdin {stdin!r}")

    exit3, _ = case("exit3", ["--workspace", str(ws)], b"x", fake_exit=3)
    if exit3 is not None:
        check(exit3.returncode == 3, f"nonzero exit was not propagated: {exit3.returncode}")
        assert_result(exit3.stdout, "exit3")

    empty, _ = case("empty", ["--workspace", str(ws)], b"x", mode="empty")
    if empty is not None:
        err = empty.stderr.decode("utf-8", "replace")
        check(empty.returncode == 1, f"empty agent should exit 1, got {empty.returncode}")
        check(empty.stdout == b"", f"empty stdout {empty.stdout!r}")
        check("no result event" in err, f"missing no-result notice: {err}")

    empty5, _ = case("empty5", ["--workspace", str(ws)], b"x", mode="empty", fake_exit=5)
    if empty5 is not None:
        err = empty5.stderr.decode("utf-8", "replace")
        check(empty5.returncode == 5, f"empty nonzero exit was not propagated: {empty5.returncode} {err}")
        check(empty5.stdout == b"", f"empty5 stdout {empty5.stdout!r}")
        check("no result event" in err, err)

    malformed, _ = case("malformed", ["--workspace", str(ws)], b"x", mode="malformed")
    if malformed is not None:
        err = malformed.stderr.decode("utf-8", "replace")
        check(malformed.returncode == 1, f"malformed exit {malformed.returncode}: {err}")
        check(malformed.stdout == b"", f"malformed stdout {malformed.stdout!r}")
        check("no result event" in err, err)
        try:
            json.loads(malformed.stdout.decode() or "null")
            parsed = True
        except json.JSONDecodeError:
            parsed = False
        check(not parsed or malformed.stdout == b"", "malformed result was treated as success")

    false_result, _ = case("false-result", ["--workspace", str(ws)], b"x", mode="false-result")
    if false_result is not None:
        err = false_result.stderr.decode("utf-8", "replace")
        check(false_result.returncode == 1, f"false-result exit {false_result.returncode}: {err}")
        check(false_result.stdout == b"", f"false-result stdout {false_result.stdout!r}")
        check("no result event" in err, err)
        check("SECRET-ASSIST" not in err, f"false-result leaked payload: {err}")
        check("cursor-grok: assistant/delta" in err, f"false-result progress missing: {err}")

    error_result, _ = case("error-result", ["--workspace", str(ws)], b"x", mode="error-result")
    if error_result is not None:
        assert_error_result(error_result, "error-result", 1)

    error_child, _ = case("error-child", ["--workspace", str(ws)], b"x", mode="error-result", fake_exit=4)
    if error_child is not None:
        assert_error_result(error_child, "error-child", 4)

    burst, _ = case("burst", ["--workspace", str(ws)], b"x", mode="burst")
    if burst is not None:
        err = burst.stderr.decode("utf-8", "replace")
        check(burst.returncode == 0, f"burst exit {burst.returncode}: {err}")
        lines = set(err.splitlines())
        missing = [n for n in range(1, 31) if f"burst-{n}" not in lines]
        check(not missing, f"queued stderr was dropped: {missing}")

    main_repo = TMP / "reject-main"
    init_repo(main_repo)
    reject, reject_cap = case("reject-main", ["--mode", "agent", "--workspace", str(main_repo)], b"do not write")
    if reject is not None:
        assert_rejected("main", reject, reject_cap)

    detach_repo = TMP / "detach"
    init_repo(detach_repo, detach=True)
    detached, detach_cap = case("detach", ["--mode", "agent", "--workspace", str(detach_repo)], b"do not write")
    if detached is not None:
        assert_rejected("detached", detached, detach_cap)

    plain = TMP / "not-a-repo"
    plain.mkdir()
    nonrepo, nonrepo_cap = case("nonrepo", ["--mode", "agent", "--workspace", str(plain)], b"do not write")
    if nonrepo is not None:
        assert_rejected("nonrepo", nonrepo, nonrepo_cap)

    bare = TMP / "issue-bare"
    init_repo(bare, branch="issue/77")
    bare_proc, bare_cap = case("issue-bare", ["--mode", "agent", "--workspace", str(bare)], b"do not write")
    if bare_proc is not None:
        assert_rejected("issue/77", bare_proc, bare_cap)

    nope = TMP / "issue-nope"
    init_repo(nope, branch="issue/nope")
    nope_proc, nope_cap = case("issue-nope", ["--mode", "agent", "--workspace", str(nope)], b"do not write")
    if nope_proc is not None:
        assert_rejected("issue/nope", nope_proc, nope_cap)

    accept_repo = TMP / "issue dir" / "caf\u00e9"
    init_repo(accept_repo, branch="issue/77-synthetic")
    accept, accept_cap = case(
        "accept",
        ["--mode", "agent", "--workspace", str(accept_repo)],
        "write in fake only\ncaf\u00e9".encode(),
    )
    if accept is not None:
        got = capture_of(accept_cap)
        err = accept.stderr.decode("utf-8", "replace")
        check(accept.returncode == 0, f"accepted exit {accept.returncode}: {err}")
        check(got is not None, f"accepted issue branch did not launch: {err}")
        if got is not None:
            argv, stdin, cwd = got
            expected = prefix() + ["--force", "--workspace", str(accept_repo)]
            check(argv == expected, f"agent argv {argv!r}")
            check("--mode" not in argv, f"agent mode passed --mode: {argv!r}")
            check(stdin == "write in fake only\ncaf\u00e9".encode(), f"agent stdin {stdin!r}")
            check(cwd == str(accept_repo), f"agent cwd {cwd!r}")
        assert_result(accept.stdout, "accept")

    slow, _ = case(
        "slow",
        ["--mode", "ask", "--workspace", str(ws), "--heartbeat-seconds", "1"],
        b"ping",
        mode="slow",
        timeout=15,
    )
    if slow is not None:
        err = slow.stderr.decode("utf-8", "replace")
        check(slow.returncode == 0, f"slow exit {slow.returncode}: {err}")
        check("cursor-grok: waiting" in err, f"missing heartbeat: {err}")
        check("cursor-grok: assistant/delta" in err, f"missing progress: {err}")
        check("connection lost sample" in err, f"child stderr was dropped: {err}")
        assert_result(slow.stdout, "slow")

    quiet, _ = case(
        "quiet",
        ["--workspace", str(ws)],
        b"ping",
        mode="slow",
        timeout=15,
    )
    if quiet is not None:
        err = quiet.stderr.decode("utf-8", "replace")
        check(quiet.returncode == 0, f"default heartbeat exit {quiet.returncode}: {err}")
        check("cursor-grok: waiting" not in err, f"default heartbeat fired too soon: {err}")
        check("cursor-grok: assistant/delta" in err, f"default run missing progress: {err}")

    missing_cap = TMP / "missing-agent"
    missing_cap.mkdir()
    missing_env = make_env(fake, missing_cap, "ok", None)
    missing_env["CURSOR_GROK_AGENT"] = str(TMP / "no-such-agent")
    missing = launch(["--workspace", str(ws)], b"x", missing_env, timeout=10)
    check(missing.returncode != 0, f"missing agent exit {missing.returncode}")
    check(capture_of(missing_cap) is None, "missing override fell back to a real CLI")
    check("Cursor CLI not found" in missing.stderr.decode("utf-8", "replace"), missing.stderr.decode())

    bad_mode, bad_cap = case("bad-mode", ["--mode", "write", "--workspace", str(ws)], b"x")
    if bad_mode is not None:
        check(bad_mode.returncode == 2, f"bad mode exit {bad_mode.returncode}")
        check(capture_of(bad_cap) is None, "bad mode launched the fake CLI")

    bad_beat, beat_cap = case("bad-beat", ["--workspace", str(ws), "--heartbeat-seconds", "0"], b"x")
    if bad_beat is not None:
        check(bad_beat.returncode == 2, f"heartbeat 0 exit {bad_beat.returncode}")
        check(capture_of(beat_cap) is None, "heartbeat 0 launched the fake CLI")

    empty_prompt, empty_prompt_cap = case("empty-prompt", ["--workspace", str(ws)], b"\n")
    if empty_prompt is not None:
        check(empty_prompt.returncode == 2, f"empty prompt exit {empty_prompt.returncode}")
        check(capture_of(empty_prompt_cap) is None, "empty prompt launched the fake CLI")

    test_relative_workspace(fake)
    test_git_env_guard(fake)
    test_exec_failure(fake)
    test_cancel(fake)
    test_cancel_ignores_term(fake)


def test_relative_workspace(fake):
    base = TMP / "rel base"
    target = base / "my ws"
    nested = base / "nest"
    target.mkdir(parents=True)
    nested.mkdir()
    decoy = TMP / "cdpath-decoy" / "my ws"
    decoy.mkdir(parents=True)

    def assert_abs(name, cwd, arg):
        cap = TMP / f"cap-{name}"
        cap.mkdir()
        env = make_env(fake, cap, "ok", None)
        env["CDPATH"] = str(TMP / "cdpath-decoy")
        proc = launch(
            ["--workspace", arg, "--heartbeat-seconds", "30"],
            b"rel",
            env,
            cwd=cwd,
        )
        err = proc.stderr.decode("utf-8", "replace")
        got = capture_of(cap)
        check(proc.returncode == 0, f"{name} exit {proc.returncode}: {err}")
        check(got is not None, f"{name} did not launch: {err}")
        if got is None:
            return
        argv, _stdin, child_cwd = got
        chosen = flag_value(argv, "--workspace")
        matches = os.path.isabs(chosen) and os.path.isdir(chosen) and os.path.samefile(chosen, target)
        check(matches, f"{name} workspace {chosen!r} != {target}")
        check("cdpath-decoy" not in chosen, f"{name} followed CDPATH: {chosen!r}")
        check(child_cwd == chosen, f"{name} cwd {child_cwd!r} != workspace {chosen!r}")

    assert_abs("rel-name", base, "my ws")
    assert_abs("rel-dotdot", nested, "../my ws")


def test_git_env_guard(fake):
    decoy = TMP / "git-decoy"
    init_repo(decoy, branch="issue/89-decoy")
    main_repo = TMP / "git-env-main"
    init_repo(main_repo)
    foreign = {
        "GIT_DIR": str(decoy / ".git"),
        "GIT_WORK_TREE": str(decoy),
    }
    cap = TMP / "cap-git-env"
    cap.mkdir()
    env = make_env(fake, cap, "ok", None)
    env.update(foreign)
    rejected = launch(["--mode", "agent", "--workspace", str(main_repo)], b"no", env)
    assert_rejected("git-env", rejected, cap)

    issue = TMP / "git-env-issue"
    init_repo(issue, branch="issue/89-real")
    cap_ok = TMP / "cap-git-env-ok"
    cap_ok.mkdir()
    env_ok = make_env(fake, cap_ok, "ok", None)
    env_ok["GIT_DIR"] = str(main_repo / ".git")
    env_ok["GIT_WORK_TREE"] = str(main_repo)
    accepted = launch(["--mode", "agent", "--workspace", str(issue)], b"yes", env_ok)
    err = accepted.stderr.decode("utf-8", "replace")
    got = capture_of(cap_ok)
    check(accepted.returncode == 0, f"issue workspace with foreign GIT_DIR exit {accepted.returncode}: {err}")
    check(got is not None, f"foreign GIT_DIR blocked a real issue branch: {err}")
    if got is not None:
        _argv, _stdin, cwd = got
        check(cwd == str(issue), f"foreign GIT_DIR redirected cwd to {cwd!r}")
        gitdir = (cap_ok / "gitdir.txt").read_text(encoding="utf-8")
        gitwork = (cap_ok / "gitwork.txt").read_text(encoding="utf-8")
        check(gitdir == "" and gitwork == "", f"child inherited GIT_DIR={gitdir!r} GIT_WORK_TREE={gitwork!r}")

    wt_main = TMP / "wt-main"
    init_repo(wt_main)
    wt = TMP / "wt-issue"
    git(wt_main, "worktree", "add", "-q", "-b", "issue/89-wt", str(wt))
    cap_wt = TMP / "cap-git-env-wt"
    cap_wt.mkdir()
    env_wt = make_env(fake, cap_wt, "ok", None)
    env_wt["GIT_DIR"] = str(wt_main / ".git")
    env_wt["GIT_WORK_TREE"] = str(wt_main)
    accepted_wt = launch(["--mode", "agent", "--workspace", str(wt)], b"wt", env_wt)
    err_wt = accepted_wt.stderr.decode("utf-8", "replace")
    got_wt = capture_of(cap_wt)
    check(accepted_wt.returncode == 0, f"issue worktree with foreign GIT_DIR exit {accepted_wt.returncode}: {err_wt}")
    check(got_wt is not None, f"foreign GIT_DIR blocked an issue worktree: {err_wt}")
    if got_wt is not None:
        _argv, _stdin, cwd = got_wt
        check(cwd == str(wt), f"worktree cwd {cwd!r}")
        gitdir = (cap_wt / "gitdir.txt").read_text(encoding="utf-8")
        gitwork = (cap_wt / "gitwork.txt").read_text(encoding="utf-8")
        check(gitdir == "" and gitwork == "", f"worktree child inherited GIT_DIR={gitdir!r} GIT_WORK_TREE={gitwork!r}")


def test_exec_failure(fake):
    bindir = TMP / "bad-python"
    bindir.mkdir()
    stub = bindir / "python3"
    stub.write_text("#!/no/such/interpreter\n", encoding="utf-8")
    stub.chmod(0o755)
    cap = TMP / "cap-exec-fail"
    cap.mkdir()
    ws = TMP / "exec-ws"
    ws.mkdir()
    env = make_env(fake, cap, "ok", None)
    env["PATH"] = str(bindir) + os.pathsep + env.get("PATH", "")
    proc = launch(["--workspace", str(ws)], b"x", env, timeout=10)
    err = proc.stderr.decode("utf-8", "replace")
    check(proc.returncode == 1, f"failed exec exit {proc.returncode}: {err}")
    check("failed to start cursor-grok supervisor" in err, f"exec failure was silent: {err}")
    check(capture_of(cap) is None, "failed supervisor exec launched the fake CLI")


def test_cancel(fake):
    cap = TMP / "tree"
    cap.mkdir()
    tree_ws = TMP / "tree-ws"
    tree_ws.mkdir()
    env = make_env(fake, cap, "tree", None)
    other = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
    LEFTOVERS.append(other.pid)
    proc = subprocess.Popen(
        [str(WRAPPER), "--workspace", str(tree_ws), "--heartbeat-seconds", "30"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
    )
    try:
        proc.stdin.write(b"tree")
        proc.stdin.close()
    except BrokenPipeError:
        pass
    grand = wait_pid(cap / "grand.pid", proc)
    fake_pid = wait_pid(cap / "self.pid", proc)
    check(grand is not None, "interruption test never started the grandchild")
    check(fake_pid is not None, "interruption test never started the fake CLI")
    if grand is not None and fake_pid is not None:
        check(os.getpgid(fake_pid) == fake_pid, f"fake {fake_pid} is not its process-group leader")
        check(os.getpgid(grand) == fake_pid, f"grandchild {grand} is not in the fake group {fake_pid}")
        check(os.getpgid(other.pid) != fake_pid, "unrelated process is in the child group")
        check(os.getpgid(proc.pid) != fake_pid, "wrapper is in the child group")
    os.kill(proc.pid, signal.SIGTERM)
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=5)
        check(False, "wrapper did not exit on SIGTERM")
    err = proc.stderr.read().decode("utf-8", "replace")
    out = proc.stdout.read()
    check(proc.returncode == 143, f"cancel exit {proc.returncode} stderr={err[:400]}")
    check(out == b"", f"cancel wrote stdout {out!r}")
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and (alive(grand) or alive(fake_pid)):
        time.sleep(0.05)
    check(not alive(grand), f"grandchild {grand} still running after SIGTERM")
    check(not alive(fake_pid), f"fake {fake_pid} still running after SIGTERM")
    check(alive(other.pid), f"unrelated process {other.pid} was killed")


def test_cancel_ignores_term(fake):
    cap = TMP / "ignore-term"
    cap.mkdir()
    tree_ws = TMP / "ignore-ws"
    tree_ws.mkdir()
    env = make_env(fake, cap, "ignore-term", None)
    other = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
    LEFTOVERS.append(other.pid)
    proc = subprocess.Popen(
        [str(WRAPPER), "--workspace", str(tree_ws), "--heartbeat-seconds", "30"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
    )
    try:
        proc.stdin.write(b"ignore")
        proc.stdin.close()
    except BrokenPipeError:
        pass
    try:
        ready = wait_file(cap / "ignoring", proc)
        fake_pid = wait_pid(cap / "self.pid", proc)
        check(ready, "ignore-term child never installed SIG_IGN")
        check(fake_pid is not None, "ignore-term child never started")
        if ready and fake_pid is not None:
            started = time.monotonic()
            os.kill(proc.pid, signal.SIGTERM)
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=5)
                check(False, "SIGKILL escalation waited for the heartbeat")
            elapsed = time.monotonic() - started
            err = proc.stderr.read().decode("utf-8", "replace")
            out = proc.stdout.read()
            check(elapsed < 5, f"cancel escalation took {elapsed:.2f}s with heartbeat 30")
            check(proc.returncode == 143, f"ignore-term exit {proc.returncode} stderr={err[:400]}")
            check(out == b"", f"ignore-term wrote stdout {out!r}")
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline and alive(fake_pid):
                time.sleep(0.05)
            check(not alive(fake_pid), f"fake {fake_pid} still running after SIGKILL escalation")
            check(alive(other.pid), f"unrelated process {other.pid} was killed")
    finally:
        if proc.poll() is None:
            proc.kill()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass


def main():
    try:
        run_tests()
    except Exception:
        FAILED.append(traceback.format_exc())
    finally:
        kill_recorded(TMP)
        if TMP is not None:
            subprocess.run(["rm", "-rf", str(TMP)], check=False)
    if FAILED:
        for item in FAILED:
            print(item, file=sys.stderr)
        raise SystemExit(1)
    print("cursor-grok tests passed")


if __name__ == "__main__":
    main()
