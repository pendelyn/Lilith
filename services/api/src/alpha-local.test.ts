import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
});

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
