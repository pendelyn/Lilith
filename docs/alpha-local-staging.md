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

`docs/lilith-alpha-system.service` is a systemd 259 system unit. `DynamicUser=yes` allocates user and group `lilith-alpha` with no supplementary groups. `StateDirectory=lilith-alpha` and `WorkingDirectory=/var/lib/lilith-alpha` are the only writable persistent paths; that path is a symlink to `/var/lib/private/lilith-alpha`. Do not pre-create it. When the kernel supports idmapped mounts, systemd leaves that directory owned by `65534:65534` on the host and maps it to the dynamic uid and gid inside the service mount namespace. A directory that already belongs to the dynamic uid is left unchanged. `ProtectSystem=strict` leaves `/opt` read-only. `ProtectHome=yes` is stricter than the DynamicUser default of read-only, so `/home` is inaccessible. `PrivateTmp=disconnected` is the DynamicUser default; do not set `PrivateTmp=yes`. `NoNewPrivileges=yes`, `UMask=0077`, and empty `CapabilityBoundingSet=` and `AmbientCapabilities=` are set. Node and the repo stay root-owned under `/opt/node-v24` and `/opt/lilith-alpha`. `EnvironmentFile=/etc/lilith-alpha/api.env` is `root:root` mode `0600`. PID 1 reads it; the dynamic user cannot. `EnvironmentFile=` overrides `Environment=`, so `ExecStart` uses `/usr/bin/env HOST=127.0.0.1`. `HOME` is the state directory. The script path is absolute because the working directory is state, not `services/api`. There is no `User=`, `Group=`, `SupplementaryGroups=`, `ReadWritePaths=`, `BindPaths=`, Docker group, or Docker socket.

`SocketBindAllow=ipv4:tcp:3000` and `SocketBindDeny=any` allow only an IPv4 TCP bind on port 3000. A systemd bind rule cannot name `127.0.0.1`; `SocketBindAllow=ipv4:127.0.0.1:3000` is not valid and is not used. `IPAddressAllow=127.0.0.1` and `IPAddressDeny=any` drop other packets when cgroup eBPF is available, and they block outbound traffic from this unit. If the kernel has no cgroup eBPF, those four lines have no effect. They are not the loopback proof. `chmod` does not clear ACLs copied by `cp -a`. This runbook does not call `getfacl` or `setfacl`.

### Migration

One-time manual interactive `sudo`, pasted into `bash`. Not run. The block stops on the first failed command. The private user unit is stopped only after the `/opt` and `/etc` copies and the unit install succeed. From that stop onward, any failure runs the system-unit rollback below. `systemctl start` does not `enable` the unit. `enable --now` runs only after the uid, group, capability, docker-socket, mount-namespace, single-listener, and health checks have passed. A reboot before that leaves the system unit disabled. Do not pre-create `/var/lib/lilith-alpha`. Do not print the token. Do not `cat` the env file, do not run `systemctl show -p Environment`, and do not use `set -x`.

Stop if systemd is older than 259, a static `lilith-alpha` user or group exists, `/run/docker.sock` exists, or `/var/lib/lilith-alpha`, `/var/lib/private/lilith-alpha`, or `/etc/lilith-alpha/overlay-complete` already exists. A prepared host that already has those paths uses the resume section below. This script does not delete them. An existing `/opt/node-v24`, `/opt/lilith-alpha`, or `/opt/lilith-import`, including a symlink, is also a hard stop. This script does not delete those paths. `/opt/lilith-import` is created `root:root` mode `0700` and is not a `cp -a` target. The copied trees are directories inside it, so `ben` cannot enter them while `cp -a` replaces the copy target's owner and mode. Owner and mode of `/opt/lilith-import` are checked again before `chmod -R u=rwX,go=rX`. After the trees move to the final paths, `rmdir` removes only the empty import directory created by this run. The final `/opt` trees are not removed. A symlink is kept only when `readlink -e` resolves an existing target inside `/opt/node-v24` or `/opt/lilith-alpha`.

From the Windows checkout:

```powershell
scp -o BatchMode=yes docs/lilith-alpha-system.service <user>@<lan-host>:lilith-alpha-system.service
```

On the server:

```bash
# -E keeps the ERR trap when the owner proof fails inside a function.
set -Eeuo pipefail
rollback_copy_body() {
  local api="" work="" base="" dest="" item="" list="" home_any=0 copy_rc=0 find_rc=0 symlink_list=""
  local -a items=()
  if ! sudo test -f /etc/lilith-alpha/overlay-complete; then
    return 0
  fi
  if sudo test -L /etc/lilith-alpha/overlay-complete; then
    echo "Rollback refused a symlink marker; home was not changed." >&2
    return 1
  fi
  if ! test "$(sudo stat -c '%U:%G %a' /etc/lilith-alpha/overlay-complete)" = "root:root 600"; then
    echo "Rollback refused the state marker; home was not changed." >&2
    return 1
  fi
  symlink_list=$(mktemp) || return 1
  sudo find /var/lib/private/lilith-alpha -mindepth 1 \( -name '.lilith-*' -o -path '*/.lilith-*/*' \) -type l -print -quit >"$symlink_list"
  find_rc=$?
  if [ "$find_rc" -ne 0 ] || [ -s "$symlink_list" ]; then
    rm -f -- "$symlink_list"
    echo "Rollback refused a symlink in the state tree; home was not changed." >&2
    return 1
  fi
  rm -f -- "$symlink_list"
  api="${HOME}/lilith-alpha/services/api"
  symlink_list=$(mktemp) || return 1
  find "$api" -mindepth 1 -maxdepth 1 -name '.lilith-*' -type l -print -quit >"$symlink_list"
  find_rc=$?
  if [ "$find_rc" -ne 0 ] || [ -s "$symlink_list" ]; then
    rm -f -- "$symlink_list"
    echo "Rollback refused a symlink in the home state tree; home was not changed." >&2
    return 1
  fi
  rm -f -- "$symlink_list"
  work=$(mktemp -d "${HOME}/.lilith-alpha-rollback.XXXXXX") || {
    echo "Rollback could not stage state; home was not changed." >&2
    return 1
  }
  chmod 700 "$work" || {
    rm -rf -- "$work"
    echo "Rollback could not stage state; home was not changed." >&2
    return 1
  }
  sudo find /var/lib/private/lilith-alpha -mindepth 1 -maxdepth 1 -name '.lilith-*' ! -type l -print0 | sudo xargs -0 -r cp -a -t "$work/"
  copy_rc=$?
  if [ "$copy_rc" -ne 0 ]; then
    sudo rm -rf -- "$work"
    echo "Rollback could not stage state; home was not changed." >&2
    return 1
  fi
  symlink_list=$(mktemp) || {
    sudo rm -rf -- "$work"
    echo "Rollback could not stage state; home was not changed." >&2
    return 1
  }
  sudo find "$work" -type l -print -quit >"$symlink_list"
  find_rc=$?
  if [ "$find_rc" -ne 0 ]; then
    rm -f -- "$symlink_list"
    sudo rm -rf -- "$work"
    echo "Rollback could not stage state; home was not changed." >&2
    return 1
  fi
  if [ -s "$symlink_list" ]; then
    rm -f -- "$symlink_list"
    sudo rm -rf -- "$work"
    echo "Rollback refused a symlink in the staged state; home was not changed." >&2
    return 1
  fi
  rm -f -- "$symlink_list"
  sudo chown -R "$(id -u):$(id -g)" "$work" || {
    sudo rm -rf -- "$work"
    echo "Rollback could not chown staged state; home was not changed." >&2
    return 1
  }
  list=$(mktemp) || {
    rm -rf -- "$work"
    echo "Rollback could not stage state; home was not changed." >&2
    return 1
  }
  find "$work" -mindepth 1 -maxdepth 1 -print0 >"$list" || {
    rm -f -- "$list"
    rm -rf -- "$work"
    echo "Rollback could not stage state; home was not changed." >&2
    return 1
  }
  while IFS= read -r -d '' item; do
    items+=("$item")
  done <"$list"
  rm -f -- "$list"
  if [ "${#items[@]}" -eq 0 ]; then
    rmdir "$work" || rm -rf -- "$work"
    if find "$api" -mindepth 1 -maxdepth 1 -name '.lilith-*' -print -quit | grep -q .; then
      home_any=1
    fi
    if [ "$home_any" -eq 0 ]; then
      return 0
    fi
    echo "Rollback found no state files; home was not changed." >&2
    return 1
  fi
  for item in "${items[@]}"; do
    base=${item##*/}
    case "$base" in
      .lilith-*) ;;
      *)
        echo "Rollback refused an unexpected name; home was not changed." >&2
        rm -rf -- "$work"
        return 1
        ;;
    esac
    if [ -L "${api}/${base}" ]; then
      echo "Rollback refused a symlink in the home state tree; home was not changed." >&2
      rm -rf -- "$work"
      return 1
    fi
  done
  for item in "${items[@]}"; do
    base=${item##*/}
    dest="${api}/${base}"
    if [ -e "$dest" ] || [ -L "$dest" ]; then
      rm -rf -- "$dest" || {
        echo "Rollback could not replace home state; user unit was not started." >&2
        return 2
      }
    fi
    mv -- "$item" "$api/" || {
      echo "Rollback could not move staged state into home; user unit was not started." >&2
      return 2
    }
  done
  if ! rmdir "$work"; then
    echo "Rollback left a staged directory in the home directory; user unit was not started." >&2
    return 2
  fi
  return 0
}
rollback_copy() {
  set +e
  rollback_copy_body
  rollback_rc=$?
  set -e
  return "$rollback_rc"
}
# Host 65534 is not enough. The process ids must be dynamic, the mount namespace
# must show those ids on the state directory, and the private parent must be a
# protected directory. Legacy acceptance is the same proof with the host pair.
accept_state_owner() {
  local uid="$1" gid="$2" login_uid="$3" login_gid="$4"
  local inner_uid="$5" inner_gid="$6"
  local host_uid="$7" host_gid="$8" host_mode="$9"
  local parent_uid="${10}" parent_gid="${11}" parent_mode="${12}" parent_kind="${13}"
  local mnt_separate="${14}"
  case "$uid" in 0|[1-9][0-9]*) ;; *) return 1 ;; esac
  case "$gid" in 0|[1-9][0-9]*) ;; *) return 1 ;; esac
  case "$login_uid" in 0|[1-9][0-9]*) ;; *) return 1 ;; esac
  case "$login_gid" in 0|[1-9][0-9]*) ;; *) return 1 ;; esac
  case "$inner_uid" in 0|[1-9][0-9]*) ;; *) return 1 ;; esac
  case "$inner_gid" in 0|[1-9][0-9]*) ;; *) return 1 ;; esac
  case "$host_uid" in 0|[1-9][0-9]*) ;; *) return 1 ;; esac
  case "$host_gid" in 0|[1-9][0-9]*) ;; *) return 1 ;; esac
  case "$parent_uid" in 0|[1-9][0-9]*) ;; *) return 1 ;; esac
  case "$parent_gid" in 0|[1-9][0-9]*) ;; *) return 1 ;; esac
  if [ "$host_mode" != "700" ]; then return 1; fi
  if [ "$parent_mode" != "700" ]; then return 1; fi
  if [ "$mnt_separate" != "1" ]; then return 1; fi
  if [ "$parent_kind" != "dir" ]; then return 1; fi
  if ! test "$uid" -ge 61184; then return 1; fi
  if ! test "$uid" -le 65519; then return 1; fi
  if ! test "$gid" -ge 61184; then return 1; fi
  if ! test "$gid" -le 65519; then return 1; fi
  if [ "$uid" = 0 ] || [ "$gid" = 0 ]; then return 1; fi
  if [ "$uid" = 65534 ] || [ "$gid" = 65534 ]; then return 1; fi
  if [ "$uid" = "$login_uid" ] || [ "$gid" = "$login_gid" ]; then return 1; fi
  if [ "$inner_uid" != "$uid" ] || [ "$inner_gid" != "$gid" ]; then return 1; fi
  if [ "$parent_uid" != 0 ] || [ "$parent_gid" != 0 ]; then return 1; fi
  if [ "$host_uid" = "$uid" ] && [ "$host_gid" = "$gid" ]; then return 0; fi
  if [ "$host_uid" = 65534 ] && [ "$host_gid" = 65534 ]; then return 0; fi
  return 1
}
prove_state_owner() {
  local pid="$1" login_uid="$2" login_gid="$3"
  local uid="" gid="" inner="" inner_uid="" inner_gid=""
  local host_uid="" host_gid="" host_mode=""
  local parent_uid="" parent_gid="" parent_mode="" parent_perm="" parent_kind=""
  local svc_mnt="" init_mnt="" self_mnt="" mnt_separate=0
  case "$pid" in
    [1-9][0-9]*) ;;
    *) return 1 ;;
  esac
  uid=$(sudo awk '/^Uid:/ { if (NF != 5 || $2 != $3 || $2 != $4 || $2 != $5) exit 1; print $2; exit }' "/proc/${pid}/status")
  gid=$(sudo awk '/^Gid:/ { if (NF != 5 || $2 != $3 || $2 != $4 || $2 != $5) exit 1; print $2; exit }' "/proc/${pid}/status")
  [ -n "$uid" ]
  [ -n "$gid" ]
  id "$uid"
  sudo awk -v primary="$gid" 'BEGIN { found = 0 } /^Groups:/ { found = 1; for (i = 2; i <= NF; i++) if ($i != primary) exit 1 } END { if (!found) exit 1 }' "/proc/${pid}/status"
  sudo awk 'BEGIN { cap = 0; nnp = 0 } /^CapEff:/ || /^CapBnd:/ || /^CapAmb:/ { if ($2 ~ /[^0]/) exit 1; cap++ } /^NoNewPrivs:/ { if ($2 != 1) exit 1; nnp = 1 } /^Uid:/ { if ($2 == 0 || $3 == 0 || $4 == 0 || $5 == 0) exit 1 } END { if (cap != 3 || nnp != 1) exit 1 }' "/proc/${pid}/status"
  test ! -e /run/docker.sock
  svc_mnt=$(sudo readlink "/proc/${pid}/ns/mnt")
  init_mnt=$(sudo readlink /proc/1/ns/mnt)
  self_mnt=$(sudo readlink /proc/self/ns/mnt)
  mnt_separate=0
  if [ -n "$svc_mnt" ] && [ "$svc_mnt" != "$init_mnt" ] && [ "$svc_mnt" != "$self_mnt" ]; then
    mnt_separate=1
  fi
  sudo nsenter -t "$pid" -m -- test -d /var/lib/private/lilith-alpha
  sudo nsenter -t "$pid" -m -- test ! -L /var/lib/private/lilith-alpha
  inner=$(sudo nsenter -t "$pid" -m -- stat -c '%u:%g' /var/lib/private/lilith-alpha)
  inner_uid=${inner%%:*}
  inner_gid=${inner#*:}
  sudo test -d /var/lib/private/lilith-alpha
  sudo test ! -L /var/lib/private/lilith-alpha
  host_uid=$(sudo stat -c '%u' /var/lib/private/lilith-alpha)
  host_gid=$(sudo stat -c '%g' /var/lib/private/lilith-alpha)
  host_mode=$(sudo stat -c '%a' /var/lib/private/lilith-alpha)
  sudo test -d /var/lib/private
  sudo test ! -L /var/lib/private
  parent_uid=$(sudo stat -c '%u' /var/lib/private)
  parent_gid=$(sudo stat -c '%g' /var/lib/private)
  parent_mode=$(sudo stat -c '%a' /var/lib/private)
  parent_perm=$(sudo ls -ld /var/lib/private | awk '{ print $1 }')
  parent_kind=bad
  if [ "$parent_perm" = "drwx------" ]; then
    parent_kind=dir
  fi
  accept_state_owner "$uid" "$gid" "$login_uid" "$login_gid" "$inner_uid" "$inner_gid" "$host_uid" "$host_gid" "$host_mode" "$parent_uid" "$parent_gid" "$parent_mode" "$parent_kind" "$mnt_separate"
  proved_uid=$uid
  proved_gid=$gid
  proved_host_uid=$host_uid
  proved_host_gid=$host_gid
  proved_host_mode=$host_mode
}
on_fail() {
  trap - ERR
  set +e
  sudo systemctl disable --now lilith-alpha.service
  if [ "$?" -ne 0 ]; then
    echo "System unit did not stop; user unit was not started." >&2
    exit 1
  fi
  export XDG_RUNTIME_DIR="/run/user/$(id -u)"
  export DBUS_SESSION_BUS_ADDRESS="unix:path=${XDG_RUNTIME_DIR}/bus"
  rollback_rc=0
  rollback_copy || rollback_rc=$?
  if [ "$rollback_rc" -ne 0 ]; then
    if [ "$rollback_rc" -eq 2 ]; then
      echo "Home state may be partial; user unit was not started." >&2
    fi
    exit 1
  fi
  systemctl --user enable --now lilith-alpha.service
  exit 1
}
ver=$(systemctl --version | awk 'NR==1 { print $2 }')
test "${ver%%.*}" -ge 259
if getent passwd lilith-alpha >/dev/null || getent group lilith-alpha >/dev/null; then exit 1; fi
if sudo test -e /var/lib/lilith-alpha || sudo test -L /var/lib/lilith-alpha; then exit 1; fi
if sudo test -e /var/lib/private/lilith-alpha || sudo test -L /var/lib/private/lilith-alpha; then exit 1; fi
if sudo test -e /etc/lilith-alpha/overlay-complete || sudo test -L /etc/lilith-alpha/overlay-complete; then exit 1; fi
test ! -e /run/docker.sock
test -x "$HOME/node-v24/bin/node"
"$HOME/node-v24/bin/node" -p process.versions.node | grep -q '^24\.'
test -f "$HOME/.config/lilith-alpha/api.env"
test -f "$HOME/lilith-alpha/services/api/src/index.ts"
if sudo test -e /opt/node-v24 || sudo test -L /opt/node-v24; then exit 1; fi
if sudo test -e /opt/lilith-alpha || sudo test -L /opt/lilith-alpha; then exit 1; fi
if sudo test -e /opt/lilith-import || sudo test -L /opt/lilith-import; then exit 1; fi
sudo mkdir -m 700 /opt/lilith-import
sudo chown root:root /opt/lilith-import
sudo chmod 700 /opt/lilith-import
sudo mkdir /opt/lilith-import/node-v24
sudo mkdir /opt/lilith-import/lilith-alpha
test "$(sudo stat -c '%U:%G %a' /opt/lilith-import)" = "root:root 700"
sudo cp -a "$HOME/node-v24/." /opt/lilith-import/node-v24/
sudo cp -a "$HOME/lilith-alpha/." /opt/lilith-import/lilith-alpha/
sudo find /opt/lilith-import/lilith-alpha -name '.lilith-*' -prune -exec rm -rf {} +
secret_list=$(mktemp)
sudo find /opt/lilith-import/node-v24 /opt/lilith-import/lilith-alpha \( -name '.env' -o -name 'api.env' -o -name '.lilith-*' \) -print -quit >"$secret_list"
if [ -s "$secret_list" ]; then
  rm -f -- "$secret_list"
  exit 1
fi
rm -f -- "$secret_list"
sudo chown -R root:root /opt/lilith-import/node-v24 /opt/lilith-import/lilith-alpha
test "$(sudo stat -c '%U:%G %a' /opt/lilith-import)" = "root:root 700"
sudo chmod -R u=rwX,go=rX /opt/lilith-import/node-v24 /opt/lilith-import/lilith-alpha
if sudo test -e /opt/node-v24 || sudo test -L /opt/node-v24; then exit 1; fi
if sudo test -e /opt/lilith-alpha || sudo test -L /opt/lilith-alpha; then exit 1; fi
sudo mv /opt/lilith-import/node-v24 /opt/node-v24
sudo mv /opt/lilith-import/lilith-alpha /opt/lilith-alpha
sudo rmdir -- /opt/lilith-import
if sudo find /opt/node-v24 /opt/lilith-alpha -type l -print0 | sudo xargs -0 -r readlink -e 2>/dev/null | awk '
  BEGIN { bad = 0 }
  $0 == "/opt/node-v24" || $0 == "/opt/lilith-alpha" { next }
  index($0, "/opt/node-v24/") == 1 || index($0, "/opt/lilith-alpha/") == 1 { next }
  { bad = 1 }
  END { exit bad }
'; then
  :
else
  exit 1
fi
opt_list=$(mktemp)
sudo find /opt/node-v24 /opt/lilith-alpha ! -type l \( ! -user root -o ! -group root -o -perm /022 -o ! -perm -004 \) -print -quit >"$opt_list"
if [ -s "$opt_list" ]; then
  rm -f -- "$opt_list"
  exit 1
fi
rm -f -- "$opt_list"
opt_list=$(mktemp)
sudo find /opt/node-v24 /opt/lilith-alpha -type l \( ! -user root -o ! -group root \) -print -quit >"$opt_list"
if [ -s "$opt_list" ]; then
  rm -f -- "$opt_list"
  exit 1
fi
rm -f -- "$opt_list"
opt_list=$(mktemp)
sudo find /opt/node-v24 /opt/lilith-alpha -type d ! -perm -005 -print -quit >"$opt_list"
if [ -s "$opt_list" ]; then
  rm -f -- "$opt_list"
  exit 1
fi
rm -f -- "$opt_list"
test -x /opt/node-v24/bin/node
test -r /opt/lilith-alpha/services/api/src/index.ts
test ! -w /opt/lilith-alpha/services/api/src/index.ts
if sudo test -L /etc/lilith-alpha || sudo test -L /etc/lilith-alpha/api.env; then exit 1; fi
sudo install -d -m 700 -o root -g root /etc/lilith-alpha
sudo install -m 600 -o root -g root "$HOME/.config/lilith-alpha/api.env" /etc/lilith-alpha/api.env
sudo test ! -L /etc/lilith-alpha
sudo test ! -L /etc/lilith-alpha/api.env
sudo test -f /etc/lilith-alpha/api.env
sudo awk '
  BEGIN { bad = 0 }
  /^[[:space:]]*(#|$)/ { next }
  /^[A-Za-z_][A-Za-z0-9_]*=/ {
    key = $0
    sub(/=.*/, "", key)
    val = $0
    sub(/^[^=]*=/, "", val)
    if (seen[key]++) bad = 1
    if (key !~ /^(LOCAL_API_TOKEN|ALPHA_OWNER_ID|HOST|PORT)$/) bad = 1
    if (val == "" || val ~ /[[:space:]\\"]/) bad = 1
    if (index(val, "0.0.0.0") > 0) bad = 1
    if (key == "HOST" && val != "127.0.0.1") bad = 1
    if (key == "PORT" && val != "3000") bad = 1
    next
  }
  { bad = 1 }
  END {
    if (!seen["LOCAL_API_TOKEN"] || !seen["ALPHA_OWNER_ID"] || !seen["HOST"] || !seen["PORT"]) bad = 1
    exit bad
  }
' /etc/lilith-alpha/api.env
sudo grep -qx 'HOST=127.0.0.1' /etc/lilith-alpha/api.env
sudo grep -qx 'PORT=3000' /etc/lilith-alpha/api.env
if sudo grep -q '0.0.0.0' /etc/lilith-alpha/api.env; then exit 1; fi
test "$(sudo stat -c '%U:%G %a' /etc/lilith-alpha)" = "root:root 700"
test "$(sudo stat -c '%U:%G %a' /etc/lilith-alpha/api.env)" = "root:root 600"
if sudo test -e /etc/systemd/system/lilith-alpha.service.d || sudo test -L /etc/systemd/system/lilith-alpha.service.d; then exit 1; fi
if sudo test -e /run/systemd/system/lilith-alpha.service.d || sudo test -L /run/systemd/system/lilith-alpha.service.d; then exit 1; fi
if sudo test -e /usr/lib/systemd/system/lilith-alpha.service.d || sudo test -L /usr/lib/systemd/system/lilith-alpha.service.d; then exit 1; fi
if sudo test -L /etc/systemd/system/lilith-alpha.service; then exit 1; fi
if sudo test -e /etc/systemd/system/lilith-alpha.service; then
  sudo cmp -s "$HOME/lilith-alpha-system.service" /etc/systemd/system/lilith-alpha.service
fi
sudo install -m 644 -o root -g root "$HOME/lilith-alpha-system.service" /etc/systemd/system/lilith-alpha.service
sudo cmp -s "$HOME/lilith-alpha-system.service" /etc/systemd/system/lilith-alpha.service
rm -f "$HOME/lilith-alpha-system.service"
sudo systemctl daemon-reload
active=$(systemctl is-active lilith-alpha.service || true)
test "$active" = "inactive"
sudo systemctl disable lilith-alpha.service
enabled=$(systemctl is-enabled lilith-alpha.service || true)
test "$enabled" = "disabled"
test "$(systemctl show -p FragmentPath --value lilith-alpha.service)" = "/etc/systemd/system/lilith-alpha.service"
test -z "$(systemctl show -p DropInPaths --value lilith-alpha.service)"
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DBUS_SESSION_BUS_ADDRESS="unix:path=${XDG_RUNTIME_DIR}/bus"
trap on_fail ERR
systemctl --user disable --now lilith-alpha.service
listeners=$(ss -ltn 'sport = :3000' | awk 'NR>1 { print }')
test -z "$listeners"
symlink_list=$(mktemp)
find "$HOME/lilith-alpha/services/api" -mindepth 1 \( -name '.lilith-*' -o -path '*/.lilith-*/*' \) -type l -print -quit >"$symlink_list"
symlink_bad=0
if [ -s "$symlink_list" ]; then
  symlink_bad=1
fi
rm -f -- "$symlink_list"
test "$symlink_bad" -eq 0
sudo systemctl start lilith-alpha.service
pid=$(systemctl show -p MainPID --value lilith-alpha.service)
test "$pid" -gt 1
prove_state_owner "$pid" "$(id -u)" "$(id -g)"
sudo systemctl stop lilith-alpha.service
test "$(sudo stat -c '%u:%g %a' /var/lib/private/lilith-alpha)" = "${proved_host_uid}:${proved_host_gid} ${proved_host_mode}"
listeners=$(ss -ltn 'sport = :3000' | awk 'NR>1 { print }')
test -z "$listeners"
enabled=$(systemctl is-enabled lilith-alpha.service || true)
test "$enabled" = "disabled"
sudo test -d /var/lib/private/lilith-alpha
sudo test ! -L /var/lib/private/lilith-alpha
sudo test -d /var/lib/private
sudo test ! -L /var/lib/private
test "$(sudo stat -c '%u:%g %a' /var/lib/private)" = "0:0 700"
sudo test -L /var/lib/lilith-alpha
test "$(sudo readlink -f /var/lib/lilith-alpha)" = "/var/lib/private/lilith-alpha"
test "$(sudo stat -c '%u:%g' /var/lib/lilith-alpha)" = "0:0"
list=$(mktemp)
find "$HOME/lilith-alpha/services/api" -mindepth 1 -maxdepth 1 -name '.lilith-*' ! -type l -print0 >"$list"
states=()
while IFS= read -r -d '' src; do
  states+=("$src")
done <"$list"
rm -f -- "$list"
if [ "${#states[@]}" -gt 0 ]; then
  for src in "${states[@]}"; do
    base=${src##*/}
    case "$base" in
      .lilith-*) ;;
      *) false ;;
    esac
    dest="/var/lib/private/lilith-alpha/${base}"
    if sudo test -e "$dest" || sudo test -L "$dest"; then
      sudo rm -rf -- "$dest"
    fi
    sudo cp -a -- "$src" /var/lib/private/lilith-alpha/
  done
fi
sudo chown -R --reference=/var/lib/private/lilith-alpha -- /var/lib/private/lilith-alpha
sudo test -L /var/lib/lilith-alpha
test "$(sudo stat -c '%u:%g' /var/lib/lilith-alpha)" = "0:0"
mode_list=$(mktemp)
sudo find /var/lib/private/lilith-alpha -mindepth 1 ! -type l -perm /0077 -print -quit >"$mode_list"
mode_bad=0
if [ -s "$mode_list" ]; then
  mode_bad=1
fi
rm -f -- "$mode_list"
test "$mode_bad" -eq 0
owner_list=$(mktemp)
sudo find /var/lib/private/lilith-alpha -mindepth 1 ! -type l \( ! -uid "$proved_host_uid" -o ! -gid "$proved_host_gid" \) -print -quit >"$owner_list"
owner_bad=0
if [ -s "$owner_list" ]; then
  owner_bad=1
fi
rm -f -- "$owner_list"
test "$owner_bad" -eq 0
sudo test ! -e /etc/lilith-alpha/overlay-complete
sudo test ! -L /etc/lilith-alpha/overlay-complete
marker_src=$(mktemp)
sudo install -m 600 -o root -g root "$marker_src" /etc/lilith-alpha/overlay-complete
rm -f -- "$marker_src"
sudo test ! -L /etc/lilith-alpha/overlay-complete
test "$(sudo stat -c '%U:%G %a' /etc/lilith-alpha/overlay-complete)" = "root:root 600"
sudo systemctl start lilith-alpha.service
enabled=$(systemctl is-enabled lilith-alpha.service || true)
test "$enabled" = "disabled"
pid=$(systemctl show -p MainPID --value lilith-alpha.service)
test "$pid" -gt 1
prove_state_owner "$pid" "$(id -u)" "$(id -g)"
test ! -e /run/docker.sock
mapfile -t addrs < <(ss -H -ltn 'sport = :3000' | awk '{ print $4 }')
test "${#addrs[@]}" -eq 1
test "${addrs[0]}" = "127.0.0.1:3000"
curl -s -o /dev/null --connect-timeout 2 'http://[::1]:3000/health' && false
code_anon=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/health)
code_ok=$(sudo awk -F= '$1=="LOCAL_API_TOKEN" { printf "header = \"Authorization: Bearer %s\"\n", $2 }' /etc/lilith-alpha/api.env | curl --config - -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/health)
printf '%s %s\n' "$code_anon" "$code_ok"
test "$code_anon" = 401
test "$code_ok" = 200
sudo systemctl enable --now lilith-alpha.service
trap - ERR
```

The same script checks the running process. Real, effective, saved, and filesystem uid must be one dynamic id, and the four gid fields must be one dynamic id. Both are in `61184`–`65519`, not root, not `65534`, and not the login ids. `Groups` is empty or only that gid (not in `docker`, `lxd`, or `sudo`). Capabilities stay zero, `NoNewPrivs` stays 1, and `/run/docker.sock` stays absent. The service mount namespace must differ from pid 1 and from this shell. `nsenter -m stat` of `/var/lib/private/lilith-alpha` in that namespace must show the process uid and gid. On the host, that directory is accepted when it is owned by that same pair, or by `65534:65534` after the same proof. Host `65534` also requires `/var/lib/private` to be a non-symlink `root:root` mode `0700` directory whose `ls` mode is `drwx------` with no ACL mark. Legacy ownership is that same proof when the host pair is the process pair. After `stop`, host owner and mode must match the pre-stop observation. `chown -R --reference` keeps that owner. The script does not chown the tree to the process uid. Children must use the backing owner. The second `start` repeats the proof before `enable`. `ss` must show exactly one listener, `127.0.0.1:3000`. The peer `0.0.0.0:*` is the unspecified remote, not the bind. `[::1]:3000` must refuse. The codes must be 401 and 200. The token is passed to curl on stdin, not printed. `stat` must show `root:root` mode `0700` and `root:root` mode `0600`, or the script stops. `grep -qx` does not print the token.

Regular `.lilith-*` names are copied into `/var/lib/private/lilith-alpha` after a `start` and `stop` that lets systemd create that directory. That first `start` is not `enable`. The symlink `/var/lib/lilith-alpha` stays `root:root`. State modes are not opened to the world. `/etc/lilith-alpha/overlay-complete` is created only after that copy. A later fresh migration stops while `/var/lib/lilith-alpha`, `/var/lib/private/lilith-alpha`, or that marker exists. Do not delete those paths to retry. The prepared-host resume is the only continuation, and only when its inventory passes. Removing the paths after a checked copy-back is a separate step. This runbook does not do that removal.

Browser and CLI tools are unavailable because there is no Docker socket. Issue #29 is separate. Named Tunnel and Access stay blocked on an owned FQDN and an Access identity.

### System-unit rollback

Stops the system unit, copies `.lilith-*` state back only when `/etc/lilith-alpha/overlay-complete` is a regular `root:root` mode `0600` file, and re-enables the original user unit only when the marker is missing or the copy-back is complete. Without that marker, home is left unchanged. A symlink under the state names refuses the copy and does not start the user unit. Any other failed copy-back also leaves the user unit stopped. It does not delete `~/lilith-alpha`, `~/.config/lilith-alpha/api.env`, `/opt/node-v24`, `/opt/lilith-alpha`, `/etc/lilith-alpha/api.env`, `/var/lib/lilith-alpha`, `/var/lib/private/lilith-alpha`, or the marker. Paste into `bash`. Not run.

```bash
set -euo pipefail
rollback_copy_body() {
  local api="" work="" base="" dest="" item="" list="" home_any=0 copy_rc=0 find_rc=0 symlink_list=""
  local -a items=()
  if ! sudo test -f /etc/lilith-alpha/overlay-complete; then
    return 0
  fi
  if sudo test -L /etc/lilith-alpha/overlay-complete; then
    echo "Rollback refused a symlink marker; home was not changed." >&2
    return 1
  fi
  if ! test "$(sudo stat -c '%U:%G %a' /etc/lilith-alpha/overlay-complete)" = "root:root 600"; then
    echo "Rollback refused the state marker; home was not changed." >&2
    return 1
  fi
  symlink_list=$(mktemp) || return 1
  sudo find /var/lib/private/lilith-alpha -mindepth 1 \( -name '.lilith-*' -o -path '*/.lilith-*/*' \) -type l -print -quit >"$symlink_list"
  find_rc=$?
  if [ "$find_rc" -ne 0 ] || [ -s "$symlink_list" ]; then
    rm -f -- "$symlink_list"
    echo "Rollback refused a symlink in the state tree; home was not changed." >&2
    return 1
  fi
  rm -f -- "$symlink_list"
  api="${HOME}/lilith-alpha/services/api"
  symlink_list=$(mktemp) || return 1
  find "$api" -mindepth 1 -maxdepth 1 -name '.lilith-*' -type l -print -quit >"$symlink_list"
  find_rc=$?
  if [ "$find_rc" -ne 0 ] || [ -s "$symlink_list" ]; then
    rm -f -- "$symlink_list"
    echo "Rollback refused a symlink in the home state tree; home was not changed." >&2
    return 1
  fi
  rm -f -- "$symlink_list"
  work=$(mktemp -d "${HOME}/.lilith-alpha-rollback.XXXXXX") || {
    echo "Rollback could not stage state; home was not changed." >&2
    return 1
  }
  chmod 700 "$work" || {
    rm -rf -- "$work"
    echo "Rollback could not stage state; home was not changed." >&2
    return 1
  }
  sudo find /var/lib/private/lilith-alpha -mindepth 1 -maxdepth 1 -name '.lilith-*' ! -type l -print0 | sudo xargs -0 -r cp -a -t "$work/"
  copy_rc=$?
  if [ "$copy_rc" -ne 0 ]; then
    sudo rm -rf -- "$work"
    echo "Rollback could not stage state; home was not changed." >&2
    return 1
  fi
  symlink_list=$(mktemp) || {
    sudo rm -rf -- "$work"
    echo "Rollback could not stage state; home was not changed." >&2
    return 1
  }
  sudo find "$work" -type l -print -quit >"$symlink_list"
  find_rc=$?
  if [ "$find_rc" -ne 0 ]; then
    rm -f -- "$symlink_list"
    sudo rm -rf -- "$work"
    echo "Rollback could not stage state; home was not changed." >&2
    return 1
  fi
  if [ -s "$symlink_list" ]; then
    rm -f -- "$symlink_list"
    sudo rm -rf -- "$work"
    echo "Rollback refused a symlink in the staged state; home was not changed." >&2
    return 1
  fi
  rm -f -- "$symlink_list"
  sudo chown -R "$(id -u):$(id -g)" "$work" || {
    sudo rm -rf -- "$work"
    echo "Rollback could not chown staged state; home was not changed." >&2
    return 1
  }
  list=$(mktemp) || {
    rm -rf -- "$work"
    echo "Rollback could not stage state; home was not changed." >&2
    return 1
  }
  find "$work" -mindepth 1 -maxdepth 1 -print0 >"$list" || {
    rm -f -- "$list"
    rm -rf -- "$work"
    echo "Rollback could not stage state; home was not changed." >&2
    return 1
  }
  while IFS= read -r -d '' item; do
    items+=("$item")
  done <"$list"
  rm -f -- "$list"
  if [ "${#items[@]}" -eq 0 ]; then
    rmdir "$work" || rm -rf -- "$work"
    if find "$api" -mindepth 1 -maxdepth 1 -name '.lilith-*' -print -quit | grep -q .; then
      home_any=1
    fi
    if [ "$home_any" -eq 0 ]; then
      return 0
    fi
    echo "Rollback found no state files; home was not changed." >&2
    return 1
  fi
  for item in "${items[@]}"; do
    base=${item##*/}
    case "$base" in
      .lilith-*) ;;
      *)
        echo "Rollback refused an unexpected name; home was not changed." >&2
        rm -rf -- "$work"
        return 1
        ;;
    esac
    if [ -L "${api}/${base}" ]; then
      echo "Rollback refused a symlink in the home state tree; home was not changed." >&2
      rm -rf -- "$work"
      return 1
    fi
  done
  for item in "${items[@]}"; do
    base=${item##*/}
    dest="${api}/${base}"
    if [ -e "$dest" ] || [ -L "$dest" ]; then
      rm -rf -- "$dest" || {
        echo "Rollback could not replace home state; user unit was not started." >&2
        return 2
      }
    fi
    mv -- "$item" "$api/" || {
      echo "Rollback could not move staged state into home; user unit was not started." >&2
      return 2
    }
  done
  if ! rmdir "$work"; then
    echo "Rollback left a staged directory in the home directory; user unit was not started." >&2
    return 2
  fi
  return 0
}
rollback_copy() {
  set +e
  rollback_copy_body
  rollback_rc=$?
  set -e
  return "$rollback_rc"
}
sudo systemctl disable --now lilith-alpha.service
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DBUS_SESSION_BUS_ADDRESS="unix:path=${XDG_RUNTIME_DIR}/bus"
rollback_rc=0
rollback_copy || rollback_rc=$?
if [ "$rollback_rc" -ne 0 ]; then
  if [ "$rollback_rc" -eq 2 ]; then
    echo "Home state may be partial; user unit was not started." >&2
    exit 1
  fi
  exit "$rollback_rc"
fi
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

## Prepared-host resume

Not run. Use this only for the host where the migration above already installed root-owned `/opt/node-v24`, `/opt/lilith-alpha`, `/etc/lilith-alpha/api.env`, and the system unit, then stopped before `overlay-complete` because the host state directory was `65534:65534`. Do not run the fresh migration again. It stops while those paths exist. This block does not delete `/opt`, the unit, the env file, `/var/lib/lilith-alpha`, or `/var/lib/private/lilith-alpha`, and it does not copy `/opt` again.

It stops without changes unless the system unit is inactive and disabled, the installed unit is a regular file whose SHA-256 is either `eae81e0a76fef378fe88fc196c3c223e540d0f7140dcb5e903bb26f6271f78e0` (LF bytes of `docs/lilith-alpha-system.service`) or `c582eb0845e91daccec4d64546fa69971a5157b881b84de451ad0b69c8eb1cc8` (the same text with CRLF), the env file is a regular `root:root` mode `0600` file that passes the same key checks, both `/opt` trees pass the same root-owned mode checks and the same `readlink -e` containment check, `/run/docker.sock` is absent, and `overlay-complete` and `~/.lilith-alpha-rollback.*` are absent. The containment check runs before the user unit is stopped. Private state must be empty or exactly one empty non-symlink `.lilith-retention` directory. Any other name, symlink, or file stops the resume. Nothing is deleted to make the inventory pass. `65534:65534` before `start` only avoids letting systemd chown a root-owned tree; it is not acceptance. `prove_state_owner` must pass before any copy.

An existing destination is left in place only when both it and the home path are an empty `.lilith-retention` directory. Any other existing destination stops the resume. `chown -R --reference` still sets the copied owner. After that copy and the mode and owner checks, and before the second start, the block writes `/etc/lilith-alpha/overlay-complete`. A failure after that marker runs the same copy-back as the fresh migration. The user unit starts only when that copy-back returns 0. Otherwise it stays stopped, so it does not come back on the older home snapshot. The block does not copy `/opt` again.

```bash
# -E keeps the ERR trap when the owner proof fails inside a function.
set -Eeuo pipefail
# Host 65534 is not enough. The process ids must be dynamic, the mount namespace
# must show those ids on the state directory, and the private parent must be a
# protected directory. Legacy acceptance is the same proof with the host pair.
accept_state_owner() {
  local uid="$1" gid="$2" login_uid="$3" login_gid="$4"
  local inner_uid="$5" inner_gid="$6"
  local host_uid="$7" host_gid="$8" host_mode="$9"
  local parent_uid="${10}" parent_gid="${11}" parent_mode="${12}" parent_kind="${13}"
  local mnt_separate="${14}"
  case "$uid" in 0|[1-9][0-9]*) ;; *) return 1 ;; esac
  case "$gid" in 0|[1-9][0-9]*) ;; *) return 1 ;; esac
  case "$login_uid" in 0|[1-9][0-9]*) ;; *) return 1 ;; esac
  case "$login_gid" in 0|[1-9][0-9]*) ;; *) return 1 ;; esac
  case "$inner_uid" in 0|[1-9][0-9]*) ;; *) return 1 ;; esac
  case "$inner_gid" in 0|[1-9][0-9]*) ;; *) return 1 ;; esac
  case "$host_uid" in 0|[1-9][0-9]*) ;; *) return 1 ;; esac
  case "$host_gid" in 0|[1-9][0-9]*) ;; *) return 1 ;; esac
  case "$parent_uid" in 0|[1-9][0-9]*) ;; *) return 1 ;; esac
  case "$parent_gid" in 0|[1-9][0-9]*) ;; *) return 1 ;; esac
  if [ "$host_mode" != "700" ]; then return 1; fi
  if [ "$parent_mode" != "700" ]; then return 1; fi
  if [ "$mnt_separate" != "1" ]; then return 1; fi
  if [ "$parent_kind" != "dir" ]; then return 1; fi
  if ! test "$uid" -ge 61184; then return 1; fi
  if ! test "$uid" -le 65519; then return 1; fi
  if ! test "$gid" -ge 61184; then return 1; fi
  if ! test "$gid" -le 65519; then return 1; fi
  if [ "$uid" = 0 ] || [ "$gid" = 0 ]; then return 1; fi
  if [ "$uid" = 65534 ] || [ "$gid" = 65534 ]; then return 1; fi
  if [ "$uid" = "$login_uid" ] || [ "$gid" = "$login_gid" ]; then return 1; fi
  if [ "$inner_uid" != "$uid" ] || [ "$inner_gid" != "$gid" ]; then return 1; fi
  if [ "$parent_uid" != 0 ] || [ "$parent_gid" != 0 ]; then return 1; fi
  if [ "$host_uid" = "$uid" ] && [ "$host_gid" = "$gid" ]; then return 0; fi
  if [ "$host_uid" = 65534 ] && [ "$host_gid" = 65534 ]; then return 0; fi
  return 1
}
prove_state_owner() {
  local pid="$1" login_uid="$2" login_gid="$3"
  local uid="" gid="" inner="" inner_uid="" inner_gid=""
  local host_uid="" host_gid="" host_mode=""
  local parent_uid="" parent_gid="" parent_mode="" parent_perm="" parent_kind=""
  local svc_mnt="" init_mnt="" self_mnt="" mnt_separate=0
  case "$pid" in
    [1-9][0-9]*) ;;
    *) return 1 ;;
  esac
  uid=$(sudo awk '/^Uid:/ { if (NF != 5 || $2 != $3 || $2 != $4 || $2 != $5) exit 1; print $2; exit }' "/proc/${pid}/status")
  gid=$(sudo awk '/^Gid:/ { if (NF != 5 || $2 != $3 || $2 != $4 || $2 != $5) exit 1; print $2; exit }' "/proc/${pid}/status")
  [ -n "$uid" ]
  [ -n "$gid" ]
  id "$uid"
  sudo awk -v primary="$gid" 'BEGIN { found = 0 } /^Groups:/ { found = 1; for (i = 2; i <= NF; i++) if ($i != primary) exit 1 } END { if (!found) exit 1 }' "/proc/${pid}/status"
  sudo awk 'BEGIN { cap = 0; nnp = 0 } /^CapEff:/ || /^CapBnd:/ || /^CapAmb:/ { if ($2 ~ /[^0]/) exit 1; cap++ } /^NoNewPrivs:/ { if ($2 != 1) exit 1; nnp = 1 } /^Uid:/ { if ($2 == 0 || $3 == 0 || $4 == 0 || $5 == 0) exit 1 } END { if (cap != 3 || nnp != 1) exit 1 }' "/proc/${pid}/status"
  test ! -e /run/docker.sock
  svc_mnt=$(sudo readlink "/proc/${pid}/ns/mnt")
  init_mnt=$(sudo readlink /proc/1/ns/mnt)
  self_mnt=$(sudo readlink /proc/self/ns/mnt)
  mnt_separate=0
  if [ -n "$svc_mnt" ] && [ "$svc_mnt" != "$init_mnt" ] && [ "$svc_mnt" != "$self_mnt" ]; then
    mnt_separate=1
  fi
  sudo nsenter -t "$pid" -m -- test -d /var/lib/private/lilith-alpha
  sudo nsenter -t "$pid" -m -- test ! -L /var/lib/private/lilith-alpha
  inner=$(sudo nsenter -t "$pid" -m -- stat -c '%u:%g' /var/lib/private/lilith-alpha)
  inner_uid=${inner%%:*}
  inner_gid=${inner#*:}
  sudo test -d /var/lib/private/lilith-alpha
  sudo test ! -L /var/lib/private/lilith-alpha
  host_uid=$(sudo stat -c '%u' /var/lib/private/lilith-alpha)
  host_gid=$(sudo stat -c '%g' /var/lib/private/lilith-alpha)
  host_mode=$(sudo stat -c '%a' /var/lib/private/lilith-alpha)
  sudo test -d /var/lib/private
  sudo test ! -L /var/lib/private
  parent_uid=$(sudo stat -c '%u' /var/lib/private)
  parent_gid=$(sudo stat -c '%g' /var/lib/private)
  parent_mode=$(sudo stat -c '%a' /var/lib/private)
  parent_perm=$(sudo ls -ld /var/lib/private | awk '{ print $1 }')
  parent_kind=bad
  if [ "$parent_perm" = "drwx------" ]; then
    parent_kind=dir
  fi
  accept_state_owner "$uid" "$gid" "$login_uid" "$login_gid" "$inner_uid" "$inner_gid" "$host_uid" "$host_gid" "$host_mode" "$parent_uid" "$parent_gid" "$parent_mode" "$parent_kind" "$mnt_separate"
  proved_uid=$uid
  proved_gid=$gid
  proved_host_uid=$host_uid
  proved_host_gid=$host_gid
  proved_host_mode=$host_mode
}
private_inventory_ok() {
  local dir="$1" list="" entry="" count=0 name=""
  [ -n "$dir" ] || return 1
  [ -d "$dir" ] && [ ! -L "$dir" ] || return 1
  list=$(mktemp) || return 1
  if ! find "$dir" -mindepth 1 -type l -print -quit >"$list"; then
    rm -f -- "$list"
    return 1
  fi
  if [ -s "$list" ]; then
    rm -f -- "$list"
    return 1
  fi
  if ! find "$dir" -mindepth 1 -maxdepth 1 -print0 >"$list"; then
    rm -f -- "$list"
    return 1
  fi
  count=0
  name=""
  while IFS= read -r -d '' entry; do
    count=$((count + 1))
    name=${entry##*/}
  done <"$list"
  rm -f -- "$list"
  if [ "$count" -eq 0 ]; then
    return 0
  fi
  if [ "$count" -ne 1 ] || [ "$name" != ".lilith-retention" ]; then
    return 1
  fi
  if [ ! -d "$dir/.lilith-retention" ] || [ -L "$dir/.lilith-retention" ]; then
    return 1
  fi
  list=$(mktemp) || return 1
  if ! find "$dir/.lilith-retention" -mindepth 1 -print -quit >"$list"; then
    rm -f -- "$list"
    return 1
  fi
  if [ -s "$list" ]; then
    rm -f -- "$list"
    return 1
  fi
  rm -f -- "$list"
  return 0
}
rollback_copy_body() {
  local api="" work="" base="" dest="" item="" list="" home_any=0 copy_rc=0 find_rc=0 symlink_list=""
  local -a items=()
  if ! sudo test -f /etc/lilith-alpha/overlay-complete; then
    return 0
  fi
  if sudo test -L /etc/lilith-alpha/overlay-complete; then
    echo "Rollback refused a symlink marker; home was not changed." >&2
    return 1
  fi
  if ! test "$(sudo stat -c '%U:%G %a' /etc/lilith-alpha/overlay-complete)" = "root:root 600"; then
    echo "Rollback refused the state marker; home was not changed." >&2
    return 1
  fi
  symlink_list=$(mktemp) || return 1
  sudo find /var/lib/private/lilith-alpha -mindepth 1 \( -name '.lilith-*' -o -path '*/.lilith-*/*' \) -type l -print -quit >"$symlink_list"
  find_rc=$?
  if [ "$find_rc" -ne 0 ] || [ -s "$symlink_list" ]; then
    rm -f -- "$symlink_list"
    echo "Rollback refused a symlink in the state tree; home was not changed." >&2
    return 1
  fi
  rm -f -- "$symlink_list"
  api="${HOME}/lilith-alpha/services/api"
  symlink_list=$(mktemp) || return 1
  find "$api" -mindepth 1 -maxdepth 1 -name '.lilith-*' -type l -print -quit >"$symlink_list"
  find_rc=$?
  if [ "$find_rc" -ne 0 ] || [ -s "$symlink_list" ]; then
    rm -f -- "$symlink_list"
    echo "Rollback refused a symlink in the home state tree; home was not changed." >&2
    return 1
  fi
  rm -f -- "$symlink_list"
  work=$(mktemp -d "${HOME}/.lilith-alpha-rollback.XXXXXX") || {
    echo "Rollback could not stage state; home was not changed." >&2
    return 1
  }
  chmod 700 "$work" || {
    rm -rf -- "$work"
    echo "Rollback could not stage state; home was not changed." >&2
    return 1
  }
  sudo find /var/lib/private/lilith-alpha -mindepth 1 -maxdepth 1 -name '.lilith-*' ! -type l -print0 | sudo xargs -0 -r cp -a -t "$work/"
  copy_rc=$?
  if [ "$copy_rc" -ne 0 ]; then
    sudo rm -rf -- "$work"
    echo "Rollback could not stage state; home was not changed." >&2
    return 1
  fi
  symlink_list=$(mktemp) || {
    sudo rm -rf -- "$work"
    echo "Rollback could not stage state; home was not changed." >&2
    return 1
  }
  sudo find "$work" -type l -print -quit >"$symlink_list"
  find_rc=$?
  if [ "$find_rc" -ne 0 ]; then
    rm -f -- "$symlink_list"
    sudo rm -rf -- "$work"
    echo "Rollback could not stage state; home was not changed." >&2
    return 1
  fi
  if [ -s "$symlink_list" ]; then
    rm -f -- "$symlink_list"
    sudo rm -rf -- "$work"
    echo "Rollback refused a symlink in the staged state; home was not changed." >&2
    return 1
  fi
  rm -f -- "$symlink_list"
  sudo chown -R "$(id -u):$(id -g)" "$work" || {
    sudo rm -rf -- "$work"
    echo "Rollback could not chown staged state; home was not changed." >&2
    return 1
  }
  list=$(mktemp) || {
    rm -rf -- "$work"
    echo "Rollback could not stage state; home was not changed." >&2
    return 1
  }
  find "$work" -mindepth 1 -maxdepth 1 -print0 >"$list" || {
    rm -f -- "$list"
    rm -rf -- "$work"
    echo "Rollback could not stage state; home was not changed." >&2
    return 1
  }
  while IFS= read -r -d '' item; do
    items+=("$item")
  done <"$list"
  rm -f -- "$list"
  if [ "${#items[@]}" -eq 0 ]; then
    rmdir "$work" || rm -rf -- "$work"
    if find "$api" -mindepth 1 -maxdepth 1 -name '.lilith-*' -print -quit | grep -q .; then
      home_any=1
    fi
    if [ "$home_any" -eq 0 ]; then
      return 0
    fi
    echo "Rollback found no state files; home was not changed." >&2
    return 1
  fi
  for item in "${items[@]}"; do
    base=${item##*/}
    case "$base" in
      .lilith-*) ;;
      *)
        echo "Rollback refused an unexpected name; home was not changed." >&2
        rm -rf -- "$work"
        return 1
        ;;
    esac
    if [ -L "${api}/${base}" ]; then
      echo "Rollback refused a symlink in the home state tree; home was not changed." >&2
      rm -rf -- "$work"
      return 1
    fi
  done
  for item in "${items[@]}"; do
    base=${item##*/}
    dest="${api}/${base}"
    if [ -e "$dest" ] || [ -L "$dest" ]; then
      rm -rf -- "$dest" || {
        echo "Rollback could not replace home state; user unit was not started." >&2
        return 2
      }
    fi
    mv -- "$item" "$api/" || {
      echo "Rollback could not move staged state into home; user unit was not started." >&2
      return 2
    }
  done
  if ! rmdir "$work"; then
    echo "Rollback left a staged directory in the home directory; user unit was not started." >&2
    return 2
  fi
  return 0
}
rollback_copy() {
  set +e
  rollback_copy_body
  rollback_rc=$?
  set -e
  return "$rollback_rc"
}
on_fail() {
  trap - ERR
  set +e
  sudo systemctl disable --now lilith-alpha.service
  if [ "$?" -ne 0 ]; then
    echo "System unit did not stop; user unit was not started." >&2
    exit 1
  fi
  export XDG_RUNTIME_DIR="/run/user/$(id -u)"
  export DBUS_SESSION_BUS_ADDRESS="unix:path=${XDG_RUNTIME_DIR}/bus"
  rollback_rc=0
  rollback_copy || rollback_rc=$?
  if [ "$rollback_rc" -ne 0 ]; then
    if [ "$rollback_rc" -eq 2 ]; then
      echo "Home state may be partial; user unit was not started." >&2
    fi
    exit 1
  fi
  systemctl --user enable --now lilith-alpha.service
  exit 1
}
ver=$(systemctl --version | awk 'NR==1 { print $2 }')
test "${ver%%.*}" -ge 259
if getent passwd lilith-alpha >/dev/null || getent group lilith-alpha >/dev/null; then exit 1; fi
test ! -e /run/docker.sock
test -f "$HOME/.config/systemd/user/lilith-alpha.service"
test ! -L "$HOME/.config/systemd/user/lilith-alpha.service"
test -f "$HOME/.config/lilith-alpha/api.env"
test ! -L "$HOME/.config/lilith-alpha/api.env"
test -r "$HOME/lilith-alpha/services/api/src/index.ts"
sudo test -d /opt/node-v24
sudo test ! -L /opt/node-v24
sudo test -d /opt/lilith-alpha
sudo test ! -L /opt/lilith-alpha
test "$(sudo stat -c '%U:%G %a' /opt/node-v24)" = "root:root 755"
test "$(sudo stat -c '%U:%G %a' /opt/lilith-alpha)" = "root:root 755"
opt_list=$(mktemp)
sudo find /opt/node-v24 /opt/lilith-alpha ! -type l \( ! -user root -o ! -group root -o -perm /022 -o ! -perm -004 \) -print -quit >"$opt_list"
if [ -s "$opt_list" ]; then
  rm -f -- "$opt_list"
  exit 1
fi
rm -f -- "$opt_list"
opt_list=$(mktemp)
sudo find /opt/node-v24 /opt/lilith-alpha -type l \( ! -user root -o ! -group root \) -print -quit >"$opt_list"
if [ -s "$opt_list" ]; then
  rm -f -- "$opt_list"
  exit 1
fi
rm -f -- "$opt_list"
opt_list=$(mktemp)
sudo find /opt/node-v24 /opt/lilith-alpha -type d ! -perm -005 -print -quit >"$opt_list"
if [ -s "$opt_list" ]; then
  rm -f -- "$opt_list"
  exit 1
fi
rm -f -- "$opt_list"
test -x /opt/node-v24/bin/node
/opt/node-v24/bin/node -p process.versions.node | grep -q '^24\.'
test -r /opt/lilith-alpha/services/api/src/index.ts
test ! -w /opt/lilith-alpha/services/api/src/index.ts
unit_hash=$(sudo sha256sum /etc/systemd/system/lilith-alpha.service | awk '{ print $1 }')
case "$unit_hash" in
  eae81e0a76fef378fe88fc196c3c223e540d0f7140dcb5e903bb26f6271f78e0|c582eb0845e91daccec4d64546fa69971a5157b881b84de451ad0b69c8eb1cc8) ;;
  *) exit 1 ;;
esac
sudo test -d /etc/lilith-alpha
sudo test ! -L /etc/lilith-alpha
sudo test -f /etc/lilith-alpha/api.env
sudo test ! -L /etc/lilith-alpha/api.env
test "$(sudo stat -c '%U:%G %a' /etc/lilith-alpha)" = "root:root 700"
test "$(sudo stat -c '%U:%G %a' /etc/lilith-alpha/api.env)" = "root:root 600"
sudo awk '
  BEGIN { bad = 0 }
  /^[[:space:]]*(#|$)/ { next }
  /^[A-Za-z_][A-Za-z0-9_]*=/ {
    key = $0
    sub(/=.*/, "", key)
    val = $0
    sub(/^[^=]*=/, "", val)
    if (seen[key]++) bad = 1
    if (key !~ /^(LOCAL_API_TOKEN|ALPHA_OWNER_ID|HOST|PORT)$/) bad = 1
    if (val == "" || val ~ /[[:space:]\\"]/) bad = 1
    if (index(val, "0.0.0.0") > 0) bad = 1
    if (key == "HOST" && val != "127.0.0.1") bad = 1
    if (key == "PORT" && val != "3000") bad = 1
    next
  }
  { bad = 1 }
  END {
    if (!seen["LOCAL_API_TOKEN"] || !seen["ALPHA_OWNER_ID"] || !seen["HOST"] || !seen["PORT"]) bad = 1
    exit bad
  }
' /etc/lilith-alpha/api.env
sudo grep -qx 'HOST=127.0.0.1' /etc/lilith-alpha/api.env
sudo grep -qx 'PORT=3000' /etc/lilith-alpha/api.env
if sudo grep -q '0.0.0.0' /etc/lilith-alpha/api.env; then exit 1; fi
if sudo test -e /etc/systemd/system/lilith-alpha.service.d || sudo test -L /etc/systemd/system/lilith-alpha.service.d; then exit 1; fi
if sudo test -e /run/systemd/system/lilith-alpha.service.d || sudo test -L /run/systemd/system/lilith-alpha.service.d; then exit 1; fi
if sudo test -e /usr/lib/systemd/system/lilith-alpha.service.d || sudo test -L /usr/lib/systemd/system/lilith-alpha.service.d; then exit 1; fi
sudo test -f /etc/systemd/system/lilith-alpha.service
sudo test ! -L /etc/systemd/system/lilith-alpha.service
test "$(sudo stat -c '%U:%G %a' /etc/systemd/system/lilith-alpha.service)" = "root:root 644"
test "$(systemctl show -p FragmentPath --value lilith-alpha.service)" = "/etc/systemd/system/lilith-alpha.service"
test -z "$(systemctl show -p DropInPaths --value lilith-alpha.service)"
active=$(systemctl is-active lilith-alpha.service || true)
test "$active" = "inactive"
enabled=$(systemctl is-enabled lilith-alpha.service || true)
test "$enabled" = "disabled"
if sudo test -e /etc/lilith-alpha/overlay-complete || sudo test -L /etc/lilith-alpha/overlay-complete; then exit 1; fi
sudo test -d /var/lib/private
sudo test ! -L /var/lib/private
test "$(sudo stat -c '%u:%g %a' /var/lib/private)" = "0:0 700"
parent_perm=$(sudo ls -ld /var/lib/private | awk '{ print $1 }')
test "$parent_perm" = "drwx------"
sudo test -L /var/lib/lilith-alpha
test "$(sudo readlink -f /var/lib/lilith-alpha)" = "/var/lib/private/lilith-alpha"
test "$(sudo stat -c '%u:%g' /var/lib/lilith-alpha)" = "0:0"
sudo test -d /var/lib/private/lilith-alpha
sudo test ! -L /var/lib/private/lilith-alpha
cand_uid=$(sudo stat -c '%u' /var/lib/private/lilith-alpha)
cand_gid=$(sudo stat -c '%g' /var/lib/private/lilith-alpha)
cand_mode=$(sudo stat -c '%a' /var/lib/private/lilith-alpha)
test "$cand_mode" = "700"
if [ "$cand_uid" != 65534 ] || [ "$cand_gid" != 65534 ]; then
  test "$cand_uid" -ge 61184
  test "$cand_uid" -le 65519
  test "$cand_gid" -ge 61184
  test "$cand_gid" -le 65519
  test "$cand_uid" != "$(id -u)"
  test "$cand_gid" != "$(id -g)"
fi
sudo bash -c "$(declare -f private_inventory_ok); private_inventory_ok /var/lib/private/lilith-alpha"
stage_list=$(mktemp)
find "$HOME" -maxdepth 1 -name '.lilith-alpha-rollback.*' -print -quit >"$stage_list"
stage_bad=0
if [ -s "$stage_list" ]; then
  stage_bad=1
fi
rm -f -- "$stage_list"
test "$stage_bad" -eq 0
symlink_list=$(mktemp)
find "$HOME/lilith-alpha/services/api" -mindepth 1 \( -name '.lilith-*' -o -path '*/.lilith-*/*' \) -type l -print -quit >"$symlink_list"
symlink_bad=0
if [ -s "$symlink_list" ]; then
  symlink_bad=1
fi
rm -f -- "$symlink_list"
test "$symlink_bad" -eq 0
if sudo find /opt/node-v24 /opt/lilith-alpha -type l -print0 | sudo xargs -0 -r readlink -e 2>/dev/null | awk '
  BEGIN { bad = 0 }
  $0 == "/opt/node-v24" || $0 == "/opt/lilith-alpha" { next }
  index($0, "/opt/node-v24/") == 1 || index($0, "/opt/lilith-alpha/") == 1 { next }
  { bad = 1 }
  END { exit bad }
'; then
  :
else
  exit 1
fi
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DBUS_SESSION_BUS_ADDRESS="unix:path=${XDG_RUNTIME_DIR}/bus"
trap on_fail ERR
systemctl --user disable --now lilith-alpha.service
listeners=$(ss -ltn 'sport = :3000' | awk 'NR>1 { print }')
test -z "$listeners"
sudo systemctl start lilith-alpha.service
pid=$(systemctl show -p MainPID --value lilith-alpha.service)
test "$pid" -gt 1
prove_state_owner "$pid" "$(id -u)" "$(id -g)"
sudo systemctl stop lilith-alpha.service
test "$(sudo stat -c '%u:%g %a' /var/lib/private/lilith-alpha)" = "${proved_host_uid}:${proved_host_gid} ${proved_host_mode}"
sudo bash -c "$(declare -f private_inventory_ok); private_inventory_ok /var/lib/private/lilith-alpha"
list=$(mktemp)
find "$HOME/lilith-alpha/services/api" -mindepth 1 -maxdepth 1 -name '.lilith-*' ! -type l -print0 >"$list"
states=()
while IFS= read -r -d '' src; do
  states+=("$src")
done <"$list"
rm -f -- "$list"
if [ "${#states[@]}" -gt 0 ]; then
  for src in "${states[@]}"; do
    base=${src##*/}
    case "$base" in
      .lilith-*) ;;
      *) false ;;
    esac
    dest="/var/lib/private/lilith-alpha/${base}"
    if sudo test -e "$dest" || sudo test -L "$dest"; then
      home_list=$(mktemp)
      priv_list=$(mktemp)
      find "$src" -mindepth 1 -print -quit >"$home_list"
      sudo find "$dest" -mindepth 1 -print -quit >"$priv_list"
      same_empty=0
      if [ "$base" = ".lilith-retention" ] && [ ! -s "$home_list" ] && [ ! -s "$priv_list" ] && [ -d "$src" ] && [ ! -L "$src" ] && sudo test -d "$dest" && sudo test ! -L "$dest"; then
        same_empty=1
      fi
      rm -f -- "$home_list" "$priv_list"
      if [ "$same_empty" -eq 1 ]; then
        continue
      fi
      echo "Resume refused existing private state; nothing was deleted." >&2
      false
    fi
    sudo cp -a -- "$src" /var/lib/private/lilith-alpha/
  done
fi
sudo chown -R --reference=/var/lib/private/lilith-alpha -- /var/lib/private/lilith-alpha
sudo test -L /var/lib/lilith-alpha
test "$(sudo stat -c '%u:%g' /var/lib/lilith-alpha)" = "0:0"
mode_list=$(mktemp)
sudo find /var/lib/private/lilith-alpha -mindepth 1 ! -type l -perm /0077 -print -quit >"$mode_list"
mode_bad=0
if [ -s "$mode_list" ]; then
  mode_bad=1
fi
rm -f -- "$mode_list"
test "$mode_bad" -eq 0
owner_list=$(mktemp)
sudo find /var/lib/private/lilith-alpha -mindepth 1 ! -type l \( ! -uid "$proved_host_uid" -o ! -gid "$proved_host_gid" \) -print -quit >"$owner_list"
owner_bad=0
if [ -s "$owner_list" ]; then
  owner_bad=1
fi
rm -f -- "$owner_list"
test "$owner_bad" -eq 0
sudo test ! -e /etc/lilith-alpha/overlay-complete
sudo test ! -L /etc/lilith-alpha/overlay-complete
marker_src=$(mktemp)
sudo install -m 600 -o root -g root "$marker_src" /etc/lilith-alpha/overlay-complete
rm -f -- "$marker_src"
sudo test ! -L /etc/lilith-alpha/overlay-complete
test "$(sudo stat -c '%U:%G %a' /etc/lilith-alpha/overlay-complete)" = "root:root 600"
sudo systemctl start lilith-alpha.service
enabled=$(systemctl is-enabled lilith-alpha.service || true)
test "$enabled" = "disabled"
pid=$(systemctl show -p MainPID --value lilith-alpha.service)
test "$pid" -gt 1
prove_state_owner "$pid" "$(id -u)" "$(id -g)"
test ! -e /run/docker.sock
mapfile -t addrs < <(ss -H -ltn 'sport = :3000' | awk '{ print $4 }')
test "${#addrs[@]}" -eq 1
test "${addrs[0]}" = "127.0.0.1:3000"
curl -s -o /dev/null --connect-timeout 2 'http://[::1]:3000/health' && false
code_anon=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/health)
code_ok=$(sudo awk -F= '$1=="LOCAL_API_TOKEN" { printf "header = \"Authorization: Bearer %s\"\n", $2 }' /etc/lilith-alpha/api.env | curl --config - -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/health)
printf '%s %s\n' "$code_anon" "$code_ok"
test "$code_anon" = 401
test "$code_ok" = 200
sudo systemctl enable --now lilith-alpha.service
trap - ERR
```

## Still blocked

- Named Tunnel and Access stay blocked on an owned FQDN and an Access identity. The name `lilith` is not an owned domain. `cloudflared` is not installed. No DNS, Access, or Tunnel change was made.
- Browser and CLI tools are unavailable because there is no Docker socket. Issue #29 is separate. Do not install Docker yet.
- The private user service remains the live process. Its account is in `docker` and `lxd`, so it must not be the UID of a rootful Docker socket. The optional system unit is not applied.
- Issue #8 stays paused. Issue #69 was not changed.
