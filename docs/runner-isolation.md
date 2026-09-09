# CLI job isolation

`runIsolatedJob` is Lilith's CLI isolation boundary. Issue #8 will wire the first provider to it; the P0 controls are intentionally fixed rather than configurable.

## Container boundary

Every job uses a digest-pinned Alpine image and:

- a separately created, randomly named container that is forcibly removed in `finally`
- the API process's non-root UID/GID (`65532:65532` fallback on Docker Desktop)
- a read-only root filesystem and a writable 64 MiB, `noexec`, `nosuid` `/tmp`
- all Linux capabilities dropped and `no-new-privileges`
- no Docker log driver, network, host/container socket, or host mount beyond one dedicated workspace
- one CPU, 512 MiB RAM, 64 processes, and a non-disableable 15-minute maximum
- at most 1 MiB each of captured stdout and stderr

The API refuses to load the runner as host UID/GID `0`. Every canonical workspace must be one direct child of the dedicated, ignored `.lilith-jobs` root; project source, shared directories, nested substitutes, and escaping symlinks are rejected. Issue #8 may replace the pinned image, but only with a reviewed digest and dedicated entrypoint. Provider access must use a dedicated allowlisted route; it must not replace `--network=none` with unrestricted networking.

## Credential boundary

`JobCredentialBroker` stores at most one secret per job ID, refuses overwrite, and releases it once only when that job names the broker's fixed absolute provider executable. The runner never puts the secret in its job object, command, prompt, environment variable, Docker argument, bind mount, or host temporary file. It writes the bounded, single-line credential to the attached provider process's standard input and immediately closes the stream. The trusted provider entrypoint must consume it before starting any model-controlled child process; the container's removal destroys its process memory and writable tmpfs.

Raw secrets in command arguments are rejected. Returned output and thrown messages redact the exact secret. A provider image that echoes, transforms, persists, or leaves its input available is not eligible for activation. Issue #8 must verify its fixed entrypoint and the deny-read permission profile required by `provider-qualification.md` before enabling that provider.

## Verification

Normal tests validate the generated isolation arguments without requiring Docker. The real Linux-container check additionally verifies non-root execution, cgroup limits, zero capabilities, no-new-privileges, read-only root, `noexec` temporary storage, disabled raw container logging, absent host/socket/environment, stdin-secret redaction, enforced timeout, and container removal:

```powershell
$env:RUN_DOCKER_TESTS = "1"
npm run test --workspace=@lilith/api
Remove-Item Env:RUN_DOCKER_TESTS
```
