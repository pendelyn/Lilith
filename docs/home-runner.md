# Home runner (issue #29 milestone)

This is not close-ready and it does not self-host Lilith. The existing API remains the authority for the owner, pairing, and job status. A Cloudflare Worker Durable Object is only a mailbox. The home machine opens outbound HTTPS to that mailbox. It does not listen, and it does not accept a public port.

Not in this milestone: live Cloudflare deploy, WebSocket transport, arbitrary commands, provider or production secrets on the relay, and chat/task integration. When the relay is configured, the API encrypts owner-bound mailbox id, capability, expiry, pairing, runner, and job state at rest in `.lilith-home-runner.json`. The key is `LILITH_HOME_STATE_KEY` (32 bytes, base64url), distinct from `LOCAL_API_TOKEN` and `LILITH_RELAY_TOKEN`. A blank relay config skips this. A relay without that key, or a file that cannot be decrypted, refuses to start. The file is gitignored. It never stores `LOCAL_API_TOKEN` or provider secrets. Mailbox auth, lanes, and expiry persist in Durable Object storage. The object schedules an alarm that deletes that storage at expiry even if the API is gone. Issue #8 stays deactivated.

## Relay

Set both values, or neither. The token must not equal `LOCAL_API_TOKEN`. The URL must be `https://`.

```
LILITH_RELAY_URL=https://<worker>
LILITH_RELAY_TOKEN=<relay admin token>
```

Missing either value fails closed at API startup. Setting the relay also requires `LILITH_HOME_STATE_KEY`; a blank key with a blank relay is skipped. The worker entry is `services/api/src/relay-object.ts` with `services/api/wrangler.toml` (`RELAY_ADMIN_TOKEN` and a `MAILBOX` Durable Object binding). It returns 503 until both exist. `POST /mailboxes` is the only init path and requires the admin token. Do not deploy it from this milestone. Node loads `src/index.ts` and `src/outbound-runner.ts` without that module.

`POST /mailboxes` with the relay admin token creates one mailbox and returns a capability. Later reads and writes use that capability, not the API token and not the admin token. An authenticated DELETE still removes an expired mailbox; reads and writes stay denied. There is no public purge route. The Durable Object alarm deletes the stored ciphertext at `expiresAt` and still does so after the object is evicted. Deleting a mailbox that is already gone succeeds. A lane write fails while that lane still holds an envelope. Bodies are opaque and at most 16 KiB.

## Pair and run one fixture

With the API running and the relay configured, an authenticated owner calls `POST /runners/pairings`. The response is the only place the pairing code and mailbox capability appear. The code expires after five minutes and works once. The runner credential expires after 24 hours and is wiped on `POST /runners/:id/revoke`. Restart reloads the encrypted state, so the owner can still revoke, read job status, and `POST /account/delete` removes the mailbox. If deleting an expired unclaimed pairing or an expired claimed runner fails, the capability stays and the next pump retries the delete.

On the home Linux host, do not set `LOCAL_API_TOKEN`, `LILITH_RELAY_TOKEN`, or a provider API key. The process refuses to start if any of those are set. It does not redact arbitrary production data; the only payload is the `echo-ok` fixture. Outbound only:

```
LILITH_RELAY_URL=https://<worker>
LILITH_MAILBOX_ID=<mailboxId>
LILITH_MAILBOX_CAPABILITY=<capability>
LILITH_PAIRING_CODE=<code>
node src/outbound-runner.ts
```

Run that from `services/api`. The process claims the mailbox, prints `{ "runnerId", "ownerId" }` on stdout, then waits for the one allowlisted fixture and runs it through `runIsolatedJob` (`/bin/echo`, `lilith-fixture-ok`, `--network=none`, and the existing container limits). Dispatch `POST /runners/:id/jobs` with that printed id. The line does not include the mailbox capability, pairing code, or runner token. Envelopes are sealed. The mailbox never receives the API token, the pairing code, the runner token, or a shell command.

The owner dispatches only `{ "fixture": "echo-ok" }` with `POST /runners/:id/jobs` and reads status with `GET /runners/:id/jobs/:jobId`. One job is outstanding per runner. The home process consumes that job envelope before it starts the fixture, so a crash cannot run the same fixture twice. A crash after that consume and before the result is posted leaves the API job queued; it is not executed again. Status strips the API token, relay token, runner token, and mailbox capability when those exact values appear. It does not strip other secrets. Any `command` field is rejected. `POST /runners/:id/revoke` with a pairing id drops an unclaimed pairing immediately. Revoke of a claimed runner deletes the mailbox before it reports success. If that delete fails, the runner stays active and the request fails. Another owner id cannot revoke, dispatch, or read that runner. `POST /account/delete` blocks new pairing, claim, dispatch, and pump work for that owner before any mailbox removal, waits for mailbox creates and an in-flight pump already in progress, then revokes every runner and unclaimed pairing and wipes the account. A claim that is already past its last freeze check cannot commit after that wait. `POST /runners/:id/revoke` also waits for that pump before it deletes a mailbox. If any mailbox delete fails, that block is lifted, the account and the remaining mailbox stay, and the response is not deleted.
