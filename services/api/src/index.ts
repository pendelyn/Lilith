import { join } from "node:path";
import { createHomeRunner, loadHomeStateKey, loadRelayConfig } from "./home-runner.ts";
import { createHealthServer, loadConfig } from "./health.ts";
import { relayMailboxFromFetch } from "./relay-mailbox.ts";
import { createMemoryStore } from "./memory.ts";
import { createToolAllowStore } from "./tool-allow.ts";
import { createRetentionStore, finishPendingDeletes, runExpiryJob } from "./retention.ts";
import { RUNNER_WORKSPACES_ROOT } from "./runner.ts";
import { createTaskStore } from "./tasks.ts";

const EXPIRY_INTERVAL_MS = 60 * 60 * 1000;

try {
  const config = loadConfig();
  const cwd = process.cwd();
  const tasks = createTaskStore({ persistPath: join(cwd, ".lilith-tasks.json") });
  const memories = createMemoryStore({ persistPath: join(cwd, ".lilith-memories.json") });
  const tools = createToolAllowStore({ persistPath: join(cwd, ".lilith-tools.json") });
  const retention = createRetentionStore({
    persistPath: join(cwd, ".lilith-retention.json"),
    filesRoot: join(cwd, ".lilith-retention"),
    jobsRoot: RUNNER_WORKSPACES_ROOT,
    backupDir: cwd,
    defaultOwnerId: config.ownerId,
  });
  const retain = (): void => {
    try {
      finishPendingDeletes(retention, tasks, memories, tools);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
    }
    try {
      runExpiryJob(retention);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
    }
  };
  retain();
  setInterval(retain, EXPIRY_INTERVAL_MS);
  const relay = loadRelayConfig(process.env, config.token);
  const stateKey = loadHomeStateKey(process.env, config.token, relay?.token ?? "");
  if (relay !== null && stateKey === null) throw new Error("LILITH_HOME_STATE_KEY is required");
  const home =
    relay === null
      ? null
      : createHomeRunner({
          relayUrl: relay.url,
          apiToken: config.token,
          relayToken: relay.token,
          relay: relayMailboxFromFetch(relay.url, relay.token),
          statePath: join(cwd, ".lilith-home-runner.json"),
          stateKey: stateKey ?? undefined,
        });
  if (home) {
    setInterval(() => {
      void home.pump().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : "Home runner relay failed");
      });
    }, 2_000);
  }
  // Listen even if the tombstone is still pending: owner APIs fail closed, delete retry stays up.
  const server = createHealthServer(config, tasks, memories, {}, retention, tools, home);
  server.listen(config.port, config.host, () => {
    process.stdout.write(`API listening on http://${config.host}:${config.port}\n`);
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
