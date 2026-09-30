import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const unit = readFileSync(new URL("../../../docs/lilith-alpha.service", import.meta.url), "utf8");
const staging = readFileSync(new URL("../../../docs/alpha-local-staging.md", import.meta.url), "utf8");

test("local alpha unit template is loopback, user-scoped, and secret-free", () => {
  assert.match(unit, /^UMask=0077$/m);
  assert.match(unit, /^NoNewPrivileges=yes$/m);
  assert.match(unit, /^UnsetEnvironment=SSH_AUTH_SOCK GPG_AGENT_INFO$/m);
  assert.match(unit, /^WorkingDirectory=%h\/lilith-alpha\/services\/api$/m);
  assert.match(unit, /^EnvironmentFile=%h\/\.config\/lilith-alpha\/api\.env$/m);
  assert.match(unit, /^ExecStart=%h\/node-v24\/bin\/node src\/index\.ts$/m);
  assert.doesNotMatch(unit, /0\.0\.0\.0/);
  assert.doesNotMatch(unit, /LOCAL_API_TOKEN=/);
  assert.doesNotMatch(unit, /^User=root$/m);
  assert.doesNotMatch(unit, /docker/i);

  assert.match(staging, /^NoNewPrivileges=yes$/m);
  assert.match(staging, /^UnsetEnvironment=SSH_AUTH_SOCK GPG_AGENT_INFO$/m);
  assert.match(staging, /This staging is private/);
  assert.match(staging, /The mobile app was not checked against this host/);
  assert.match(staging, /MUST NOT run as the same UID that can access a rootful Docker socket/);
  assert.match(staging, /dedicated unprivileged API user/);
  assert.match(staging, /reviewed rootless setup/);
  assert.match(staging, /systemctl --user disable --now lilith-alpha\.service/);
  assert.doesNotMatch(staging, /192\.168\.178\.35/);
  assert.doesNotMatch(staging, /ben@/);
  assert.doesNotMatch(staging, /LOCAL_API_TOKEN=[0-9a-fA-F]/);
  assert.doesNotMatch(staging, /mobile app works/i);
});

test("system alpha unit is a loopback dynamic user with no extra privileges", () => {
  const systemUnit = readFileSync(new URL("../../../docs/lilith-alpha-system.service", import.meta.url), "utf8");

  assert.match(systemUnit, /^DynamicUser=yes$/m);
  assert.match(systemUnit, /^StateDirectory=lilith-alpha$/m);
  assert.match(systemUnit, /^StateDirectoryMode=0700$/m);
  assert.match(systemUnit, /^WorkingDirectory=\/var\/lib\/lilith-alpha$/m);
  assert.match(systemUnit, /^UMask=0077$/m);
  assert.match(systemUnit, /^NoNewPrivileges=yes$/m);
  assert.match(systemUnit, /^ProtectHome=yes$/m);
  assert.match(systemUnit, /^ProtectSystem=strict$/m);
  assert.match(systemUnit, /^PrivateTmp=disconnected$/m);
  assert.match(systemUnit, /^CapabilityBoundingSet=$/m);
  assert.match(systemUnit, /^AmbientCapabilities=$/m);
  assert.match(systemUnit, /^Environment=HOME=\/var\/lib\/lilith-alpha$/m);
  assert.match(systemUnit, /^EnvironmentFile=\/etc\/lilith-alpha\/api\.env$/m);
  assert.match(
    systemUnit,
    /^ExecStart=\/usr\/bin\/env HOST=127\.0\.0\.1 \/opt\/node-v24\/bin\/node \/opt\/lilith-alpha\/services\/api\/src\/index\.ts$/m,
  );
  assert.doesNotMatch(systemUnit, /0\.0\.0\.0/);
  assert.doesNotMatch(systemUnit, /LOCAL_API_TOKEN=/);
  assert.doesNotMatch(systemUnit, /^User=/m);
  assert.doesNotMatch(systemUnit, /^Group=/m);
  assert.doesNotMatch(systemUnit, /^SupplementaryGroups=/m);
  assert.doesNotMatch(systemUnit, /^ReadWritePaths=/m);
  assert.doesNotMatch(systemUnit, /^BindPaths=/m);
  assert.doesNotMatch(systemUnit, /docker/i);

  assert.match(staging, /docs\/lilith-alpha-system\.service/);
  assert.match(staging, /not applied/);
  assert.match(staging, /Do not print the token/);
  assert.match(staging, /root:root/);
  assert.match(staging, /0600/);
  assert.match(staging, /\/opt\/node-v24/);
  assert.match(staging, /\/opt\/lilith-alpha/);
  assert.match(staging, /sudo systemctl enable --now lilith-alpha\.service/);
  assert.match(staging, /systemctl --user enable --now lilith-alpha\.service/);
  assert.match(staging, /does not delete/);
  assert.match(staging, /no Docker socket/);
  assert.match(staging, /Issue #29 is separate/);
  assert.match(staging, /owned FQDN/);
  assert.match(staging, /Do not install Docker/);
  assert.match(staging, /not in `docker`, `lxd`, or `sudo`/);
  assert.doesNotMatch(staging, /ben@/);
  assert.doesNotMatch(staging, /LOCAL_API_TOKEN=[0-9a-fA-F]/);
});

test("migration gates stay fail-closed", () => {
  const systemUnit = readFileSync(new URL("../../../docs/lilith-alpha-system.service", import.meta.url), "utf8");
  const migrationStart = staging.indexOf("### Migration");
  const rollbackStart = staging.indexOf("### System-unit rollback");
  const afterRollback = staging.indexOf("## Rollback");
  assert.ok(migrationStart !== -1 && rollbackStart > migrationStart && afterRollback > rollbackStart);
  const migration = staging.slice(migrationStart, rollbackStart);
  const rollback = staging.slice(rollbackStart, afterRollback);

  const at = (haystack: string, needle: string): number => {
    const index = haystack.indexOf(needle);
    assert.notEqual(index, -1, needle);
    return index;
  };

  const copy = 'sudo cp -a "$HOME/node-v24/." /opt/lilith-import/node-v24/';
  assert.ok(at(migration, "sudo mkdir -m 700 /opt/lilith-import") < at(migration, copy));
  assert.ok(at(migration, '= "root:root 700"') < at(migration, copy));
  assert.doesNotMatch(migration, /install -d -m 755/);
  assert.match(migration, /xargs -0 -r readlink -e/);
  assert.match(migration, /index\(\$0, "\/opt\/node-v24\/"\) == 1/);
  assert.match(migration, /index\(\$0, "\/opt\/lilith-alpha\/"\) == 1/);
  assert.doesNotMatch(migration, /grep -F -e '\/home\/'/);

  const enable = "sudo systemctl enable --now lilith-alpha.service";
  const proof = 'test "${addrs[0]}" = "127.0.0.1:3000"';
  assert.equal(migration.indexOf(enable), migration.lastIndexOf(enable));
  assert.ok(at(migration, 'test "${#addrs[@]}" -eq 1') < at(migration, proof));
  assert.ok(at(migration, proof) < at(migration, enable));
  assert.ok(at(migration, 'sudo install -m 600 -o root -g root "$marker_src"') < at(migration, proof));
  assert.ok(at(migration, "sudo systemctl start lilith-alpha.service") < at(migration, 'sudo install -m 600 -o root -g root "$marker_src"'));
  assert.match(migration, /chown -R --reference=\/var\/lib\/private\/lilith-alpha/);
  assert.doesNotMatch(migration, /chown[^\n]*65534/);
  assert.doesNotMatch(migration, /chown[^\n]*proved_uid/);
  assert.doesNotMatch(migration, /state_uid=\$\(sudo stat -c '%u' \/var\/lib\/private\/lilith-alpha\)/);
  const proveCall = 'prove_state_owner "$pid" "$(id -u)" "$(id -g)"';
  assert.ok(at(migration, 'sudo nsenter -t "$pid" -m -- stat -c \'%u:%g\' /var/lib/private/lilith-alpha') < at(migration, proveCall));
  assert.ok(at(migration, proveCall) < at(migration, "sudo systemctl stop lilith-alpha.service"));
  assert.ok(at(migration, "sudo systemctl stop lilith-alpha.service") < at(migration, "chown -R --reference=/var/lib/private/lilith-alpha"));
  assert.notEqual(migration.indexOf(proveCall), migration.lastIndexOf(proveCall));
  assert.ok(migration.lastIndexOf(proveCall) > at(migration, 'sudo install -m 600 -o root -g root "$marker_src"'));
  assert.ok(migration.lastIndexOf(proveCall) < at(migration, enable));
  assert.match(migration, /test "\$\(sudo stat -c '%u:%g' \/var\/lib\/lilith-alpha\)" = "0:0"/);
  assert.match(migration, /LOCAL_API_TOKEN\|ALPHA_OWNER_ID\|HOST\|PORT/);
  assert.match(migration, /grep -qx 'HOST=127\.0\.0\.1'/);
  assert.match(migration, /grep -qx 'PORT=3000'/);
  assert.match(migration, /test "\$\(sudo stat -c '%U:%G %a' \/etc\/lilith-alpha\/api\.env\)" = "root:root 600"/);
  assert.doesNotMatch(staging, /0\.0\.0\.0:3000/);

  assert.match(systemUnit, /^SocketBindAllow=ipv4:tcp:3000$/m);
  assert.match(systemUnit, /^SocketBindDeny=any$/m);
  assert.match(systemUnit, /^IPAddressAllow=127\.0\.0\.1$/m);
  assert.match(systemUnit, /^IPAddressDeny=any$/m);
  assert.doesNotMatch(systemUnit, /SocketBindAllow=ipv4:127\.0\.0\.1/);

  assert.match(rollback, /overlay-complete/);
  assert.match(rollback, /does not delete/);
  assert.match(rollback, /systemctl --user enable --now lilith-alpha\.service/);
  assert.match(rollback, /return 2/);
  assert.doesNotMatch(rollback, /rm -rf[^\n]*\/var\/lib/);

  const resumeStart = staging.indexOf("## Prepared-host resume");
  const stillStart = staging.indexOf("## Still blocked");
  assert.ok(resumeStart > afterRollback && stillStart > resumeStart);
  const resume = staging.slice(resumeStart, stillStart);
  assert.doesNotMatch(resume, /rm -rf[^\n]*\/var\/lib/);
  assert.doesNotMatch(resume, /rm -rf[^\n]*\/opt/);
  assert.doesNotMatch(resume, /cp -a "\$HOME\/node-v24/);
  assert.doesNotMatch(resume, /cp -a "\$HOME\/lilith-alpha\//);
  assert.match(resume, /chown -R --reference=\/var\/lib\/private\/lilith-alpha/);
  assert.match(resume, /private_inventory_ok/);
  const resumeCopy = resume.indexOf('sudo cp -a -- "$src" /var/lib/private/lilith-alpha/');
  const markerInstall = 'sudo install -m 600 -o root -g root "$marker_src"';
  const secondStart = resume.lastIndexOf("sudo systemctl start lilith-alpha.service");
  assert.ok(resume.indexOf(proveCall) !== -1 && resume.indexOf(proveCall) < resumeCopy);
  assert.ok(resume.lastIndexOf(proveCall) > secondStart);
  assert.ok(resumeCopy < resume.indexOf(markerInstall) && resume.indexOf(markerInstall) < secondStart);
  assert.ok(secondStart < resume.indexOf("sudo systemctl enable --now lilith-alpha.service"));
  assert.ok(resume.indexOf("xargs -0 -r readlink -e") < resume.indexOf("trap on_fail ERR"));
  assert.ok(resume.indexOf("trap on_fail ERR") < resume.indexOf("systemctl --user disable --now lilith-alpha.service"));
  assertEnableOnlyAfterRollbackAbort(resume);
  assert.equal(extractFunction(resume, "accept_state_owner"), extractFunction(migration, "accept_state_owner"));
  assert.equal(extractFunction(resume, "prove_state_owner"), extractFunction(migration, "prove_state_owner"));
  assert.equal(extractFunction(resume, "rollback_copy_body"), extractFunction(migration, "rollback_copy_body"));
  assert.equal(extractFunction(resume, "on_fail"), extractFunction(migration, "on_fail"));
});

function extractFunction(script: string, name: string): string {
  const header = `${name}() {`;
  const start = script.indexOf(header);
  assert.notEqual(start, -1, name);
  assert.equal(script.indexOf(header), script.lastIndexOf(header), name);
  let depth = 0;
  for (let i = start; i < script.length; i += 1) {
    if (script[i] === "{") depth += 1;
    else if (script[i] === "}") {
      depth -= 1;
      if (depth === 0) return script.slice(start, i + 1);
    }
  }
  assert.fail(`unclosed ${name}`);
}

function insideTree(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function commandResult(command: string, args: string[], env?: NodeJS.ProcessEnv): { status: number; stdout: string } {
  try {
    return {
      status: 0,
      stdout: execFileSync(command, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        ...(env ? { env } : {}),
      }),
    };
  } catch (error) {
    const failed = error as { status?: unknown; stdout?: unknown };
    if (typeof failed.status === "number") {
      return { status: failed.status, stdout: typeof failed.stdout === "string" ? failed.stdout : "" };
    }
    throw error;
  }
}

function resumeOptContainment(treeA: string, treeB: string): number {
  const resume = staging.slice(staging.indexOf("## Prepared-host resume"), staging.indexOf("## Still blocked"));
  const header = "sudo find /opt/node-v24 /opt/lilith-alpha -type l -print0 | sudo xargs -0 -r readlink -e 2>/dev/null | awk '";
  const start = resume.indexOf(header);
  assert.notEqual(start, -1);
  assert.equal(start, resume.lastIndexOf(header));
  const end = resume.indexOf("'; then", start);
  assert.notEqual(end, -1);
  const pipeline = resume
    .slice(start, end + 1)
    .split("sudo ")
    .join("")
    .split("/opt/node-v24")
    .join(treeA)
    .split("/opt/lilith-alpha")
    .join(treeB);
  return commandResult("bash", ["-c", `set -o pipefail\nif ${pipeline}; then exit 0; else exit 1; fi`]).status;
}

function symlinkGate(treeA: string, treeB: string): number {
  const script = `
set -o pipefail
find "$TREE_A" "$TREE_B" -type l -print0 | xargs -0 -r readlink -e 2>/dev/null | awk -v a="$TREE_A" -v b="$TREE_B" '
  BEGIN { bad = 0 }
  $0 == a || $0 == b { next }
  index($0, a "/") == 1 || index($0, b "/") == 1 { next }
  { bad = 1 }
  END { exit bad }
'
`;
  return commandResult("bash", ["-c", script], { ...process.env, TREE_A: treeA, TREE_B: treeB }).status;
}

test("cp -a overwrites dest mode and symlink targets must exist inside the trees", { skip: process.platform === "linux" ? false : "requires linux cp and readlink" }, () => {
  const root = mkdtempSync(join(tmpdir(), "lilith-copy-gate-"));
  try {
    const source = join(root, "source");
    const dest = join(root, "dest");
    mkdirSync(source);
    writeFileSync(join(source, "payload"), "x");
    chmodSync(source, 0o755);
    mkdirSync(dest);
    writeFileSync(join(dest, "keep"), "k");
    chmodSync(dest, 0o700);
    assert.equal(statSync(dest).mode & 0o777, 0o700);
    execFileSync("cp", ["-a", `${source}/.`, dest]);
    assert.equal(statSync(dest).mode & 0o777, statSync(source).mode & 0o777);
    assert.notEqual(statSync(dest).mode & 0o777, 0o700);
    assert.equal(statSync(join(dest, "keep")).isFile(), true);
    assert.equal(statSync(join(dest, "payload")).isFile(), true);

    const nodeTree = join(root, "node-v24");
    const alphaTree = join(root, "lilith-alpha");
    mkdirSync(join(nodeTree, "bin"), { recursive: true });
    mkdirSync(join(nodeTree, "lib"), { recursive: true });
    writeFileSync(join(nodeTree, "lib", "npm"), "npm");
    symlinkSync("../lib/npm", join(nodeTree, "bin", "npm"));
    mkdirSync(join(alphaTree, "services", "api"), { recursive: true });
    mkdirSync(join(alphaTree, "node_modules", "@lilith"), { recursive: true });
    writeFileSync(join(alphaTree, "services", "api", "index.ts"), "x");
    symlinkSync("../../services/api/index.ts", join(alphaTree, "node_modules", "@lilith", "api"));
    const npmLink = commandResult("readlink", ["-e", join(nodeTree, "bin", "npm")]);
    assert.equal(npmLink.status, 0);
    assert.equal(npmLink.stdout.trim(), join(nodeTree, "lib", "npm"));
    const pkgLink = commandResult("readlink", ["-e", join(alphaTree, "node_modules", "@lilith", "api")]);
    assert.equal(pkgLink.status, 0);
    assert.equal(pkgLink.stdout.trim(), join(alphaTree, "services", "api", "index.ts"));
    assert.equal(symlinkGate(nodeTree, alphaTree), 0);
    assert.equal(resumeOptContainment(nodeTree, alphaTree), 0);

    mkdirSync(join(nodeTree, "sub"));
    const dangling = join(nodeTree, "dangling");
    symlinkSync("sub/missing", dangling);
    const danglingF = commandResult("readlink", ["-f", dangling]);
    assert.equal(danglingF.status, 0);
    assert.equal(danglingF.stdout.trim(), join(nodeTree, "sub", "missing"));
    const danglingE = commandResult("readlink", ["-e", dangling]);
    assert.notEqual(danglingE.status, 0);
    assert.equal(danglingE.stdout.trim(), "");
    assert.notEqual(symlinkGate(nodeTree, alphaTree), 0);

    unlinkSync(dangling);
    const outside = join(root, "outside");
    writeFileSync(outside, "no");
    symlinkSync(outside, join(alphaTree, "escaped"));
    const escaped = commandResult("readlink", ["-e", join(alphaTree, "escaped")]);
    assert.equal(escaped.status, 0);
    assert.equal(insideTree(escaped.stdout.trim(), nodeTree) || insideTree(escaped.stdout.trim(), alphaTree), false);
    assert.notEqual(symlinkGate(nodeTree, alphaTree), 0);
    assert.notEqual(resumeOptContainment(nodeTree, alphaTree), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function assertEnableOnlyAfterRollbackAbort(script: string): void {
  const call = script.indexOf("rollback_copy || rollback_rc=$?");
  assert.notEqual(call, -1);
  const tail = script.slice(call);
  const enable = "systemctl --user enable --now lilith-alpha.service";
  const enableAt = tail.indexOf(enable);
  assert.notEqual(enableAt, -1);
  assert.equal(tail.indexOf(enable), tail.lastIndexOf(enable));
  const between = tail.slice(0, enableAt);
  const guardAt = between.indexOf('if [ "$rollback_rc" -ne 0 ]; then');
  assert.notEqual(guardAt, -1);
  const guard = between.slice(guardAt);
  assert.match(guard, /if \[ "\$rollback_rc" -eq 2 \]; then/);
  assert.match(guard, /Home state may be partial; user unit was not started\./);
  assert.match(guard, /\n[ \t]*exit[ \t]/);
  assert.doesNotMatch(guard, /enable --now/);
  assert.match(guard, /\n[ \t]*fi\n[ \t]*$/);
}

test("mode 000 blocks unprivileged find -type l and rm -rf, and rollback enables the user unit only when rollback_rc is 0", {
  skip:
    process.platform !== "linux"
      ? "requires linux find and rm"
      : process.getuid?.() === 0
        ? "requires a non-root user"
        : false,
}, () => {
  const migrationStart = staging.indexOf("### Migration");
  const rollbackStart = staging.indexOf("### System-unit rollback");
  const afterRollback = staging.indexOf("## Rollback");
  assert.ok(migrationStart !== -1 && rollbackStart > migrationStart && afterRollback > rollbackStart);
  assertEnableOnlyAfterRollbackAbort(staging.slice(migrationStart, rollbackStart));
  assertEnableOnlyAfterRollbackAbort(staging.slice(rollbackStart, afterRollback));

  const root = mkdtempSync(join(tmpdir(), "lilith-rollback-eacces-"));
  const work = join(root, "stage");
  const locked = join(work, "locked");
  try {
    mkdirSync(locked, { recursive: true });
    writeFileSync(join(locked, "payload"), "x");
    chmodSync(locked, 0o000);
    const found = commandResult("find", [work, "-type", "l", "-print", "-quit"]);
    assert.notEqual(found.status, 0);
    assert.equal(found.stdout, "");
    const removed = commandResult("rm", ["-rf", "--", work]);
    assert.notEqual(removed.status, 0);
    assert.equal(statSync(locked).isDirectory(), true);
  } finally {
    if (existsSync(locked)) chmodSync(locked, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

test("state owner accepts idmapped and legacy pairs only with namespace, identity, and parent proof", {
  skip: process.platform === "linux" ? false : "requires linux bash",
}, () => {
  const migrationStart = staging.indexOf("### Migration");
  const rollbackStart = staging.indexOf("### System-unit rollback");
  const resumeStart = staging.indexOf("## Prepared-host resume");
  assert.ok(migrationStart !== -1 && rollbackStart > migrationStart && resumeStart > rollbackStart);
  const predicate = extractFunction(staging.slice(migrationStart, rollbackStart), "accept_state_owner");
  const inventory = extractFunction(staging.slice(resumeStart), "private_inventory_ok");
  const accept = (args: string[]): number =>
    commandResult("bash", ["-c", `set -u\n${predicate}\naccept_state_owner "$@"`, "accept", ...args]).status;
  const args = (
    uid: string,
    gid: string,
    loginUid: string,
    loginGid: string,
    innerUid: string,
    innerGid: string,
    hostUid: string,
    hostGid: string,
    hostMode: string,
    parentUid: string,
    parentGid: string,
    parentMode: string,
    parentKind: string,
    mntSeparate: string,
  ): string[] => [
    uid, gid, loginUid, loginGid, innerUid, innerGid, hostUid, hostGid, hostMode, parentUid, parentGid, parentMode, parentKind, mntSeparate,
  ];
  const idmap = args("62000", "62000", "1000", "1000", "62000", "62000", "65534", "65534", "700", "0", "0", "700", "dir", "1");
  const legacy = args("61184", "65519", "1000", "1000", "61184", "65519", "61184", "65519", "700", "0", "0", "700", "dir", "1");
  assert.equal(accept(idmap), 0);
  assert.equal(accept(legacy), 0);
  const reject = (patch: Record<number, string>): void => {
    const next = idmap.slice();
    for (const [index, value] of Object.entries(patch)) {
      if (value !== undefined) next[Number(index)] = value;
    }
    assert.equal(accept(next), 1);
  };
  reject({ 4: "65534", 5: "65534" });
  reject({ 13: "0" });
  reject({ 11: "755" });
  reject({ 12: "symlink" });
  reject({ 12: "acl" });
  reject({ 9: "1000" });
  reject({ 0: "65534", 1: "65534", 4: "65534", 5: "65534", 6: "65534", 7: "65534" });
  reject({ 0: "0", 1: "0", 4: "0", 5: "0", 6: "0", 7: "0" });
  reject({ 2: "62000" });
  reject({ 3: "62000" });
  reject({ 0: "61183", 1: "61183", 4: "61183", 5: "61183", 6: "61183", 7: "61183" });
  reject({ 0: "65520", 1: "65520", 4: "65520", 5: "65520", 6: "65520", 7: "65520" });
  reject({ 4: "62001", 5: "62001", 6: "62000", 7: "62000" });
  reject({ 6: "63000", 7: "63000" });
  reject({ 6: "65534", 7: "62000" });
  reject({ 8: "755" });
  const legacyParent = legacy.slice();
  legacyParent[11] = "755";
  assert.equal(accept(legacyParent), 1);

  const listed = (dir: string): number =>
    commandResult("bash", ["-c", `set -u\n${inventory}\nprivate_inventory_ok "$1"`, "inventory", dir]).status;
  const root = mkdtempSync(join(tmpdir(), "lilith-state-owner-"));
  try {
    const empty = join(root, "empty");
    mkdirSync(empty);
    assert.equal(listed(empty), 0);
    const retention = join(root, "retention");
    mkdirSync(join(retention, ".lilith-retention"), { recursive: true });
    assert.equal(listed(retention), 0);
    const filled = join(root, "filled");
    mkdirSync(join(filled, ".lilith-retention"), { recursive: true });
    writeFileSync(join(filled, ".lilith-retention", "shot"), "x");
    assert.equal(listed(filled), 1);
    assert.equal(existsSync(join(filled, ".lilith-retention", "shot")), true);
    const tasks = join(root, "tasks");
    mkdirSync(tasks);
    writeFileSync(join(tasks, ".lilith-tasks.json"), "{}");
    assert.equal(listed(tasks), 1);
    assert.equal(existsSync(join(tasks, ".lilith-tasks.json")), true);
    const both = join(root, "both");
    mkdirSync(join(both, ".lilith-retention"), { recursive: true });
    writeFileSync(join(both, ".lilith-tools.json"), "{}");
    assert.equal(listed(both), 1);
    const link = join(root, "link");
    mkdirSync(link);
    symlinkSync(empty, join(link, ".lilith-retention"));
    assert.equal(listed(link), 1);
    const nested = join(root, "nested");
    mkdirSync(join(nested, ".lilith-retention"), { recursive: true });
    symlinkSync(empty, join(nested, ".lilith-retention", "out"));
    assert.equal(listed(nested), 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resume failure copies new private state back before the user unit starts", {
  skip: process.platform === "linux" ? false : "requires linux bash",
}, () => {
  const resume = staging.slice(staging.indexOf("## Prepared-host resume"), staging.indexOf("## Still blocked"));
  const rollback = extractFunction(resume, "rollback_copy_body");
  const copy = extractFunction(resume, "rollback_copy");
  const fail = extractFunction(resume, "on_fail");
  const healthAt = resume.indexOf("mapfile -t addrs < <(ss -H -ltn 'sport = :3000' | awk '{ print $4 }')");
  const healthEnd = resume.indexOf('test "$code_ok" = 200', healthAt);
  assert.ok(healthAt !== -1 && healthEnd > healthAt);
  const health = resume.slice(healthAt, healthEnd + 'test "$code_ok" = 200'.length);
  const harness = `
set -Eeuo pipefail
sudo() {
  local -a args=()
  local a
  for a in "$@"; do
    case "$a" in
      /etc/lilith-alpha|/etc/lilith-alpha/*|/var/lib/private/lilith-alpha|/var/lib/private/lilith-alpha/*|/var/lib/lilith-alpha|/var/lib/lilith-alpha/*)
        args+=("\${ROOT}\${a}")
        ;;
      *)
        args+=("$a")
        ;;
    esac
  done
  if [ "\${args[0]}" = stat ] && [ "\${args[1]}" = -c ] && [[ "\${args[2]}" == *%U:%G* ]]; then
    local mode
    mode=$(command stat -c '%a' "\${args[3]}")
    printf 'root:root %s\\n' "$mode"
    return 0
  fi
  if [ "\${args[0]}" = chown ]; then
    return 0
  fi
  if [ "\${args[0]}" = systemctl ]; then
    systemctl "\${args[@]:1}"
    return $?
  fi
  "\${args[@]}"
}
systemctl() {
  printf '%s\\n' "$*" >> "$LOG"
  if [ "$1" = start ] && [ "$2" = lilith-alpha.service ]; then
    printf '%s\\n' live > "\${ROOT}/var/lib/private/lilith-alpha/.lilith-retention.json"
  fi
  if [ "$1" = --user ] && [ "$2" = enable ]; then
    local got
    got=$(cat "$HOME/lilith-alpha/services/api/.lilith-retention.json" 2>/dev/null || true)
    if [ "$got" = live ]; then
      printf '%s\\n' user-live >> "$LOG"
    else
      printf '%s\\n' user-stale >> "$LOG"
    fi
  fi
  return 0
}
curl() {
  local arg
  for arg in "$@"; do
    case "$arg" in
      *"[::1]"*) return 1 ;;
    esac
  done
  for arg in "$@"; do
    if [ "$arg" = --config ]; then
      printf '%s' 500
      return 0
    fi
  done
  printf '%s' 401
  return 0
}
ss() {
  printf '%s\\n' "LISTEN 0 511 127.0.0.1:3000 0.0.0.0:*"
}
${rollback}
${copy}
${fail}
trap on_fail ERR
sudo systemctl start lilith-alpha.service
${health}
`;
  const run = (prepare: (paths: { root: string; home: string; api: string; state: string }) => void): { status: number; log: string; homeFile: string } => {
    const root = mkdtempSync(join(tmpdir(), "lilith-resume-fail-"));
    const home = join(root, "home");
    const api = join(home, "lilith-alpha", "services", "api");
    const state = join(root, "var", "lib", "private", "lilith-alpha");
    const log = join(root, "systemctl.log");
    try {
      mkdirSync(api, { recursive: true });
      mkdirSync(state, { recursive: true });
      mkdirSync(join(root, "etc", "lilith-alpha"), { recursive: true });
      writeFileSync(join(api, ".lilith-tasks.json"), "stale\n");
      writeFileSync(join(root, "etc", "lilith-alpha", "api.env"), "LOCAL_API_TOKEN=abc\nALPHA_OWNER_ID=local-owner\nHOST=127.0.0.1\nPORT=3000\n");
      const marker = join(root, "etc", "lilith-alpha", "overlay-complete");
      writeFileSync(marker, "");
      chmodSync(marker, 0o600);
      writeFileSync(log, "");
      prepare({ root, home, api, state });
      const result = commandResult("bash", ["-c", harness], { ...process.env, HOME: home, ROOT: root, LOG: log });
      const homeCopy = join(api, ".lilith-retention.json");
      return {
        status: result.status,
        log: readFileSync(log, "utf8"),
        homeFile: existsSync(homeCopy) ? readFileSync(homeCopy, "utf8") : "",
      };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  const copied = run(() => undefined);
  assert.equal(copied.status, 1);
  assert.match(copied.log, /user-live/);
  assert.doesNotMatch(copied.log, /user-stale/);
  assert.equal(copied.homeFile, "live\n");
  const blocked = run(({ state }) => {
    symlinkSync(join(state, "missing"), join(state, ".lilith-escape"));
  });
  assert.equal(blocked.status, 1);
  assert.doesNotMatch(blocked.log, /user-live/);
  assert.doesNotMatch(blocked.log, /user-stale/);
  assert.equal(blocked.homeFile, "");
});

test("resume unit pin matches the versioned system unit", () => {
  const lfPin = "eae81e0a76fef378fe88fc196c3c223e540d0f7140dcb5e903bb26f6271f78e0";
  const crlfPin = "c582eb0845e91daccec4d64546fa69971a5157b881b84de451ad0b69c8eb1cc8";
  const text = readFileSync(new URL("../../../docs/lilith-alpha-system.service", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const lf = Buffer.from(text, "utf8");
  const crlf = Buffer.from(text.replace(/\n/g, "\r\n"), "utf8");
  assert.equal(createHash("sha256").update(lf).digest("hex"), lfPin);
  assert.equal(createHash("sha256").update(crlf).digest("hex"), crlfPin);
  const resume = staging.slice(staging.indexOf("## Prepared-host resume"), staging.indexOf("## Still blocked"));
  const hashLine = "unit_hash=$(sudo sha256sum /etc/systemd/system/lilith-alpha.service | awk '{ print $1 }')";
  const pinCase = `case "$unit_hash" in\n  ${lfPin}|${crlfPin}) ;;\n  *) exit 1 ;;\nesac`;
  assert.ok(resume.indexOf(hashLine) !== -1 && resume.indexOf(hashLine) < resume.indexOf(pinCase));
  assert.ok(resume.indexOf(pinCase) < resume.indexOf("trap on_fail ERR"));
  assert.doesNotMatch(resume, /cmp -s \/opt\/lilith-alpha\/docs\/lilith-alpha-system\.service/);
  if (process.platform !== "linux") return;
  const script = `set -euo pipefail\n${hashLine.replace("sudo sha256sum /etc/systemd/system/lilith-alpha.service", 'sha256sum "$1"')}\n${pinCase}\n`;
  const root = mkdtempSync(join(tmpdir(), "lilith-unit-pin-"));
  const check = (name: string): number => commandResult("bash", ["-c", script, "unit", join(root, name)]).status;
  try {
    writeFileSync(join(root, "lf"), lf);
    writeFileSync(join(root, "crlf"), crlf);
    assert.equal(check("lf"), 0);
    assert.equal(check("crlf"), 0);
    assert.notEqual(check("missing"), 0);
    const changed = Buffer.from(lf);
    changed[0] = changed[0] === 0x5b ? 0x23 : 0x5b;
    writeFileSync(join(root, "changed"), changed);
    assert.notEqual(check("changed"), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
