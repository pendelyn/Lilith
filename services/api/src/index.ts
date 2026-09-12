import { join } from "node:path";
import { createHealthServer, loadConfig } from "./health.ts";
import { createMemoryStore } from "./memory.ts";
import { createRetentionStore, finishPendingDeletes, runExpiryJob } from "./retention.ts";
import { RUNNER_WORKSPACES_ROOT } from "./runner.ts";
import { createTaskStore } from "./tasks.ts";

const EXPIRY_INTERVAL_MS = 60 * 60 * 1000;

try {
  const config = loadConfig();
  const cwd = process.cwd();
  const tasks = createTaskStore({ persistPath: join(cwd, ".lilith-tasks.json") });
  const memories = createMemoryStore({ persistPath: join(cwd, ".lilith-memories.json") });
  const retention = createRetentionStore({
    persistPath: join(cwd, ".lilith-retention.json"),
    filesRoot: join(cwd, ".lilith-retention"),
    jobsRoot: RUNNER_WORKSPACES_ROOT,
    backupDir: cwd,
    defaultOwnerId: config.ownerId,
  });
  const retain = (): void => {
    try {
      finishPendingDeletes(retention, tasks, memories);
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
  // Listen even if the tombstone is still pending: owner APIs fail closed, delete retry stays up.
  const server = createHealthServer(config, tasks, memories, {}, retention);
  server.listen(config.port, config.host, () => {
    process.stdout.write(`API listening on http://${config.host}:${config.port}\n`);
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
