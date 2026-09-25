import { pathToFileURL } from "node:url";
import { claimOutboundRunner, loadOutboundRunnerEnv, runFixtureFromMailbox } from "./home-runner.ts";
import { relayMailboxFromFetch, type RelayMailbox } from "./relay-mailbox.ts";

type RunnerIo = {
  relay?: RelayMailbox;
  write?: (line: string) => void;
  pump?: () => Promise<void>;
  runJob?: NonNullable<Parameters<typeof runFixtureFromMailbox>[0]["runJob"]>;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  now?: () => number;
};

export async function main(env: NodeJS.Dict<string | undefined> = process.env, io: RunnerIo = {}): Promise<{
  runnerId: string;
  ownerId: string;
}> {
  const config = loadOutboundRunnerEnv(env);
  const relay = io.relay ?? relayMailboxFromFetch(config.relayUrl, null);
  const claimed = await claimOutboundRunner({
    relay,
    mailboxId: config.mailboxId,
    capability: config.capability,
    pairingCode: config.pairingCode,
    pump: io.pump,
    now: io.now,
    sleep: io.sleep,
    pollMs: io.pollMs,
  });
  const line = JSON.stringify({ runnerId: claimed.runnerId, ownerId: claimed.ownerId });
  if (io.write) io.write(line);
  else process.stdout.write(`${line}\n`);
  await runFixtureFromMailbox({
    relay,
    mailboxId: config.mailboxId,
    capability: config.capability,
    runnerToken: claimed.runnerToken,
    deadline: claimed.expiresAt,
    pump: io.pump,
    runJob: io.runJob,
    now: io.now,
    sleep: io.sleep,
    pollMs: io.pollMs,
  });
  return { runnerId: claimed.runnerId, ownerId: claimed.ownerId };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Home runner failed";
    console.error(message);
    process.exit(1);
  });
}
