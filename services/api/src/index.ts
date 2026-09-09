import { join } from "node:path";
import { createHealthServer, loadConfig } from "./health.ts";
import { createTaskStore } from "./tasks.ts";

try {
  const config = loadConfig();
  const server = createHealthServer(
    config,
    createTaskStore({ persistPath: join(process.cwd(), ".lilith-tasks.json") }),
  );
  server.listen(config.port, config.host, () => {
    process.stdout.write(`API listening on http://${config.host}:${config.port}\n`);
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
