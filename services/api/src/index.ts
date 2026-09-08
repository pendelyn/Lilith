import { createHealthServer, loadConfig } from "./health.ts";

try {
  const config = loadConfig();
  const server = createHealthServer(config.token);
  server.listen(config.port, config.host, () => {
    process.stdout.write(`API listening on http://${config.host}:${config.port}\n`);
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
