# Local loopback alpha (Issue #68)

Private single-user API on `<user>@<lan-host>`, bound to `127.0.0.1:3000` only. This staging is private. It is not the Cloudflare Tunnel, not Issue #29, and it does not unpause provider #8. The mobile app was not checked against this host. The optional system unit below is not applied.

Deployed source is `origin/main` commit `5b50049bf9f1eb9753d37a7625e16de3910a9bac`. Archive SHA-256: `c0fe779512fc8ad5905225fd375ab04f76db4c7565f68531cb720b86072132fa`. The archive has no `.git`, `node_modules`, or `.env`.

Stop if any of these are false: SSH user is not root, `~/lilith-alpha` is absent, `~/.config/lilith-alpha/api.env` is absent, `~/.config/systemd/user/lilith-alpha.service` is absent, and nothing is listening on port 3000. Do not use sudo, Docker, `HOST=0.0.0.0`, or a router port forward.

## Install

From the Windows checkout:

```powershell
git archive --format=tar.gz -o $env:TEMP\lilith-main-5b50049.tar.gz origin/main
scp -o BatchMode=yes $env:TEMP\lilith-main-5b50049.tar.gz <user>@<lan-host>:lilith-main-5b50049.tar.gz
```

On the server, with `~/node-v24` (this host: Node v24.21.0, npm 11.19.0):

```bash
test ! -e "$HOME/lilith-alpha"
mkdir -m 700 "$HOME/lilith-alpha"
tar -xzf "$HOME/lilith-main-5b50049.tar.gz" -C "$HOME/lilith-alpha"
rm -f "$HOME/lilith-main-5b50049.tar.gz"
export PATH="$HOME/node-v24/bin:$PATH"
cd "$HOME/lilith-alpha"
npm ci
```

`npm ci` added 497 packages under `node_modules`. Do not copy a local `.env` or token into the tree.

Create the throwaway token on the server. This writes `~/.config/lilith-alpha/api.env` as mode `0600` and does not print the token:

```bash
test ! -e "$HOME/.config/lilith-alpha/api.env"
install -d -m 700 "$HOME/.config/lilith-alpha"
"$HOME/node-v24/bin/node" <<'NODE'
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const file = path.join(process.env.HOME, ".config", "lilith-alpha", "api.env");
const token = crypto.randomBytes(32).toString("hex");
if (!/^[0-9a-f]{64}$/.test(token)) process.exit(1);
const body = [
  "LOCAL_API_TOKEN=" + token,
  "ALPHA_OWNER_ID=local-owner",
  "HOST=127.0.0.1",
  "PORT=3000",
  "",
].join("\n");
if (body.includes("0.0.0.0")) process.exit(1);
fs.writeFileSync(file, body, { mode: 0o600, flag: "wx" });
fs.chmodSync(file, 0o600);
NODE
```

`WorkingDirectory` is `services/api` because `npm run dev:api` runs the workspace there and `src/index.ts` stores state in `process.cwd()`. The unit does not use `npm run dev:api`: that script adds `--watch` and reads a `.env` file. There is no `.env` in this tree.

```bash
install -d -m 700 "$HOME/.config/systemd/user"
umask 077
cat > "$HOME/.config/systemd/user/lilith-alpha.service" <<'UNIT'
[Unit]
Description=Lilith local alpha API (loopback only)
After=default.target

[Service]
Type=simple
UMask=0077
NoNewPrivileges=yes
UnsetEnvironment=SSH_AUTH_SOCK GPG_AGENT_INFO
WorkingDirectory=%h/lilith-alpha/services/api
EnvironmentFile=%h/.config/lilith-alpha/api.env
ExecStart=%h/node-v24/bin/node src/index.ts
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
UNIT
chmod 600 "$HOME/.config/systemd/user/lilith-alpha.service"
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DBUS_SESSION_BUS_ADDRESS="unix:path=${XDG_RUNTIME_DIR}/bus"
systemctl --user daemon-reload
systemctl --user enable --now lilith-alpha.service
```

`docs/lilith-alpha.service` is that same unit. `install -d -m 700` also sets the mode of the existing `~/.config/systemd/user` directory. Other user units there were not edited. Linger was already `yes` and was not changed. `systemctl --user enable` adds `default.target.wants/lilith-alpha.service`.

## Checks (2026-09-25)

Service user `<user>`, non-root, active and enabled. `ss` local address `127.0.0.1:3000`. The peer column `0.0.0.0:*` is the unspecified remote, not the bind. `<lan-host>:3000` and `[::1]:3000` refused connections. Journal lines were only start/stop and `API listening on http://127.0.0.1:3000`.

| Check | Result |
| --- | --- |
| `GET /health` with no token | 401 |
| `GET /health` with the wrong bearer | 401 |
| `GET /health` with the server token | 200 `{"status":"ok"}` |
| `POST /chat` `{"message":"alpha-local-ping"}` | 200 `application/x-ndjson`, done, text `No model is connected yet. You said: alpha-local-ping` |
| Hold prompt, then `systemctl --user restart` | tasks `3c435072-9f45-4e94-aa5d-1ca513d290b1` and `4ee0912c-9f21-46b4-922a-599db287bf51` stayed `working` (API pid 60242, then 60429) |

Synthetic state was `services/api/.lilith-tasks.json` mode `0600` and an empty `services/api/.lilith-retention` mode `0700`. `npm test` also created an empty `services/api/.lilith-jobs`; that directory was removed. No real user data was copied.

`npm run typecheck` exited 0. Latest acceptance: `npm test` API 180 passed, 14 skipped, 0 failed; mobile 44 passed. The local user-service tests passed on Node 24. Skipped tests are the Docker and live-HTTPS tests. Docker is not installed, and sudo needs a password, so those stay skipped. Git diff check passed.

The user manager had inherited `SSH_AUTH_SOCK` and `GPG_AGENT_INFO`, and pid 60429 still had both (`NoNewPrivs` 0). After the unit gained `NoNewPrivileges=yes` and `UnsetEnvironment=SSH_AUTH_SOCK GPG_AGENT_INFO`, restart pid 62378 had neither variable (`NoNewPrivs` 1, uid 1000) while the manager still had both. `GET /health` was 401 with no token and with a wrong bearer, and 200 `{"status":"ok"}` with the existing token. `<lan-host>:3000` and `[::1]:3000` refused. The token file stayed mode `0600` and was not rewritten.

Those two hold tasks were the only records in `.lilith-tasks.json` (`v` and `tasks` only, no backup). Both were stopped, then the file was replaced with `{"v":1,"tasks":[]}` while the unit was stopped. After start, pid 62603 still had no agent variables and `NoNewPrivs` 1. `GET /tasks` was 200 `{"tasks":[]}` and `GET /health` with the same token was 200. `~/lilith-alpha` is still mode `0700` and has no `.git`. The empty `.lilith-retention` directory was left in place.

## Security gate

Before rootful Docker or a public tunnel, this gate is mandatory.

The API service MUST NOT run as the same UID that can access a rootful Docker socket. The staging account is in groups `docker` and `lxd`. No Docker daemon is installed yet. Those later steps need a dedicated unprivileged API user and an isolated runner, or a reviewed rootless setup. The optional system unit below is that user. It is not applied. This document does not add the runner and does not install Docker.

## Optional system unit (not applied)

Public-eligible shape for this same single-user API. It is not applied. The private user unit above stays active. Do not install Docker. The bind stays `127.0.0.1`.

`docs/lilith-alpha-system.service` is a systemd 259 system unit. `DynamicUser=yes` allocates user and group `lilith-alpha` with no supplementary groups. `StateDirectory=lilith-alpha` and `WorkingDirectory=/var/lib/lilith-alpha` are the only writable persistent paths; that path is a symlink to `/var/lib/private/lilith-alpha`. Do not pre-create it. `ProtectSystem=strict` leaves `/opt` read-only. `ProtectHome=yes` is stricter than the DynamicUser default of read-only, so `/home` is inaccessible. `PrivateTmp=disconnected` is the DynamicUser default; do not set `PrivateTmp=yes`. `NoNewPrivileges=yes`, `UMask=0077`, and empty `CapabilityBoundingSet=` and `AmbientCapabilities=` are set. Node and the repo stay root-owned under `/opt/node-v24` and `/opt/lilith-alpha`. `EnvironmentFile=/etc/lilith-alpha/api.env` is `root:root` mode `0600`. PID 1 reads it; the dynamic user cannot. `EnvironmentFile=` overrides `Environment=`, so `ExecStart` uses `/usr/bin/env HOST=127.0.0.1`. `HOME` is the state directory. The script path is absolute because the working directory is state, not `services/api`. There is no `User=`, `Group=`, `SupplementaryGroups=`, `ReadWritePaths=`, `BindPaths=`, Docker group, or Docker socket.

### Migration

One-time manual interactive `sudo`. Not run. The block stops on the first failed command. The private user unit is disabled only after the `/opt` and `/etc` copies succeed. If the system unit does not become active, run the system-unit rollback below. It re-enables the original user unit and does not delete data.

Stop if systemd is older than 259, a static `lilith-alpha` user or group exists, Docker is installed, or the state path already exists. Do not print the token. Do not `cat` the env file, do not run `systemctl show -p Environment`, and do not use `set -x`.

From the Windows checkout:

```powershell
scp -o BatchMode=yes docs/lilith-alpha-system.service <user>@<lan-host>:lilith-alpha-system.service
```

On the server:

```bash
set -euo pipefail
ver=$(systemctl --version | awk 'NR==1 { print $2 }')
test "${ver%%.*}" -ge 259
if getent passwd lilith-alpha >/dev/null || getent group lilith-alpha >/dev/null; then exit 1; fi
sudo test ! -e /var/lib/lilith-alpha
sudo test ! -e /var/lib/private/lilith-alpha
test ! -e /run/docker.sock
test -x "$HOME/node-v24/bin/node"
"$HOME/node-v24/bin/node" -p process.versions.node | grep -q '^24\.'
test -f "$HOME/.config/lilith-alpha/api.env"
test -f "$HOME/lilith-alpha/services/api/src/index.ts"
sudo install -d -m 755 -o root -g root /opt/node-v24 /opt/lilith-alpha
sudo cp -a "$HOME/node-v24/." /opt/node-v24/
sudo cp -a "$HOME/lilith-alpha/." /opt/lilith-alpha/
sudo find /opt/lilith-alpha -name '.lilith-*' -prune -exec rm -rf {} +
if sudo find /opt/node-v24 /opt/lilith-alpha \( -name '.env' -o -name 'api.env' -o -name '.lilith-*' \) -print | grep -q .; then exit 1; fi
if sudo find /opt/node-v24 /opt/lilith-alpha -type l -printf '%l\n' | grep -F -e '/home/' -e "$HOME" | grep -q .; then exit 1; fi
sudo chown -R root:root /opt/node-v24 /opt/lilith-alpha
sudo chmod -R u=rwX,go=rX /opt/node-v24 /opt/lilith-alpha
if sudo find /opt/node-v24 /opt/lilith-alpha ! -type l \( ! -user root -o ! -group root -o -perm /022 -o ! -perm -004 \) -print | grep -q .; then exit 1; fi
if sudo find /opt/node-v24 /opt/lilith-alpha -type l \( ! -user root -o ! -group root \) -print | grep -q .; then exit 1; fi
if sudo find /opt/node-v24 /opt/lilith-alpha -type d ! -perm -005 -print | grep -q .; then exit 1; fi
test -x /opt/node-v24/bin/node
test -r /opt/lilith-alpha/services/api/src/index.ts
test ! -w /opt/lilith-alpha/services/api/src/index.ts
sudo install -d -m 700 -o root -g root /etc/lilith-alpha
sudo install -m 600 -o root -g root "$HOME/.config/lilith-alpha/api.env" /etc/lilith-alpha/api.env
sudo stat -c '%U:%G %a' /etc/lilith-alpha /etc/lilith-alpha/api.env
sudo grep -q '^HOST=127.0.0.1$' /etc/lilith-alpha/api.env
if sudo grep -q '0.0.0.0' /etc/lilith-alpha/api.env; then exit 1; fi
sudo install -m 644 -o root -g root "$HOME/lilith-alpha-system.service" /etc/systemd/system/lilith-alpha.service
rm -f "$HOME/lilith-alpha-system.service"
sudo systemctl daemon-reload
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DBUS_SESSION_BUS_ADDRESS="unix:path=${XDG_RUNTIME_DIR}/bus"
systemctl --user disable --now lilith-alpha.service
listeners=$(ss -ltn 'sport = :3000' | awk 'NR>1 { print }')
test -z "$listeners"
sudo systemctl enable --now lilith-alpha.service
```

`.lilith-*` state stays in the home tree. `stat` must show `root:root 700` and `root:root 600`. `grep -q` does not print the token.

Then confirm the dynamic uid is in `61184`–`65519`, `Groups` is empty or only that gid (not in `docker`, `lxd`, or `sudo`), capabilities are zero, `NoNewPrivs` is 1, and `/run/docker.sock` is absent. `ss` must show `127.0.0.1:3000` only. The peer `0.0.0.0:*` is the unspecified remote, not the bind. `<lan-host>:3000` and `[::1]:3000` must refuse. The codes must be 401 and 200. The token is passed to curl on stdin, not printed.

```bash
set -euo pipefail
pid=$(systemctl show -p MainPID --value lilith-alpha.service)
test "$pid" -gt 1
uid=$(awk '/^Uid:/ { print $2; exit }' /proc/"$pid"/status)
test "$uid" -ge 61184
test "$uid" -le 65519
id "$uid"
primary=$(awk '/^Gid:/ { print $2; exit }' /proc/"$pid"/status)
awk -v primary="$primary" '/^Groups:/ { for (i = 2; i <= NF; i++) if ($i != primary) exit 1 }' /proc/"$pid"/status
awk '/^CapEff:/ || /^CapBnd:/ || /^CapAmb:/ { if ($2 ~ /[^0]/) exit 1 } /^NoNewPrivs:/ { if ($2 != 1) exit 1 } /^Uid:/ { if ($2 == 0) exit 1 }' /proc/"$pid"/status
test ! -e /run/docker.sock
ss -ltn 'sport = :3000' | grep -q '127.0.0.1:3000'
if ss -ltn 'sport = :3000' | grep -E '0\.0\.0\.0:3000|\*:3000|\[::1\]:3000|\[::\]:3000' | grep -q .; then exit 1; fi
if curl -s -o /dev/null --connect-timeout 2 'http://[::1]:3000/health'; then exit 1; fi
code_anon=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/health)
code_ok=$(sudo awk -F= '$1=="LOCAL_API_TOKEN" { printf "header = \"Authorization: Bearer %s\"\n", $2 }' /etc/lilith-alpha/api.env | curl --config - -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/health)
printf '%s %s\n' "$code_anon" "$code_ok"
test "$code_anon" = 401
test "$code_ok" = 200
```

Browser and CLI tools are unavailable because there is no Docker socket. Issue #29 is separate. Named Tunnel and Access stay blocked on an owned FQDN and an Access identity.

### System-unit rollback

Stops the system unit and re-enables the original user unit. It does not delete `~/lilith-alpha`, `~/.config/lilith-alpha/api.env`, `/opt/node-v24`, `/opt/lilith-alpha`, `/etc/lilith-alpha/api.env`, `/var/lib/lilith-alpha`, or `/var/lib/private/lilith-alpha`.

```bash
set -euo pipefail
sudo systemctl disable --now lilith-alpha.service
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DBUS_SESSION_BUS_ADDRESS="unix:path=${XDG_RUNTIME_DIR}/bus"
systemctl --user enable --now lilith-alpha.service
```

## Rollback

Default rollback of the private user unit. It is not the system-unit rollback above. It stops and disables the user unit. It leaves the unit file, `~/lilith-alpha`, `~/.config/lilith-alpha/api.env`, and every `.lilith-*` file in place. It does not change Cloudflare or any other user unit. It was not run; the service stays active.

```bash
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DBUS_SESSION_BUS_ADDRESS="unix:path=${XDG_RUNTIME_DIR}/bus"
systemctl --user disable --now lilith-alpha.service
```

Optional data purge, only after a backup of the token and the `.lilith-*` files:

```bash
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup="$HOME/lilith-alpha-backup-$stamp"
mkdir -m 700 "$backup"
cp -a "$HOME/.config/lilith-alpha/api.env" "$backup/api.env"
find "$HOME/lilith-alpha/services/api" -maxdepth 1 -name '.lilith-*' -exec cp -a {} "$backup/" \;
test -s "$backup/api.env"
rm -f "$HOME/.config/systemd/user/lilith-alpha.service"
systemctl --user daemon-reload
rm -rf "$HOME/lilith-alpha"
rm -f "$HOME/.config/lilith-alpha/api.env"
rmdir "$HOME/.config/lilith-alpha"
```

## Still blocked

- Named Tunnel and Access stay blocked on an owned FQDN and an Access identity. The name `lilith` is not an owned domain. `cloudflared` is not installed. No DNS, Access, or Tunnel change was made.
- Browser and CLI tools are unavailable because there is no Docker socket. Issue #29 is separate. Do not install Docker yet.
- The private user service remains the live process. Its account is in `docker` and `lxd`, so it must not be the UID of a rootful Docker socket. The optional system unit is not applied.
- Issue #8 stays paused. Issue #69 was not changed.
