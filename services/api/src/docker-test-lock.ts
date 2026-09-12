import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RUNNER_WORKSPACES_ROOT } from "./runner.ts";

export async function withDockerMutex<T>(run: () => Promise<T>): Promise<T> {
  await mkdir(RUNNER_WORKSPACES_ROOT, { recursive: true, mode: 0o700 });
  const lock = join(RUNNER_WORKSPACES_ROOT, ".docker-test.lock");
  const started = Date.now();
  while (Date.now() - started < 240_000) {
    try {
      await writeFile(lock, `${process.pid}\n`, { flag: "wx" });
      try {
        return await run();
      } finally {
        await rm(lock, { force: true });
      }
    } catch (error) {
      const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code !== "EEXIST") throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error("Docker test mutex timed out");
}
