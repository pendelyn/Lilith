import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
