import {
  ACCOUNT_DELETION_NOTICE,
  PROVIDER_SIDE_LIMIT,
  RETENTION_SCHEDULE,
} from "@lilith/contracts";
import { CHAT_STORAGE_KEY } from "./chat.ts";
import { IDENTITY_STORAGE_KEY } from "./identity.ts";

export { ACCOUNT_DELETION_NOTICE, PROVIDER_SIDE_LIMIT, RETENTION_SCHEDULE };

export const ACCOUNT_STORAGE_KEYS = [CHAT_STORAGE_KEY, IDENTITY_STORAGE_KEY] as const;

export type AccountPurge = {
  serverDeleted: boolean;
  localCleared: boolean;
};

export type PersistQueue = {
  current: Promise<unknown>;
};

export function createAccountPurge(): AccountPurge {
  return { serverDeleted: false, localCleared: false };
}

export function shouldPersistAccountData(purge: AccountPurge): boolean {
  return !purge.serverDeleted;
}

export function markAccountServerDeleted(purge: AccountPurge): void {
  purge.serverDeleted = true;
}

export function markAccountLocalCleared(purge: AccountPurge): void {
  purge.localCleared = true;
}

export function accountLocalWipePending(purge: AccountPurge): boolean {
  return purge.serverDeleted && !purge.localCleared;
}

export function enqueueAccountWrite(
  queue: PersistQueue,
  purge: AccountPurge,
  write: () => Promise<void>,
): Promise<void> {
  const save = queue.current.catch(() => undefined).then(async () => {
    if (!shouldPersistAccountData(purge)) return;
    await write();
  });
  queue.current = save;
  return save;
}

export async function clearLocalAccountData(
  queues: PersistQueue[],
  remove: () => Promise<void>,
): Promise<void> {
  const wipe = Promise.all(queues.map((queue) => queue.current.catch(() => undefined))).then(() => remove());
  for (const queue of queues) queue.current = wipe;
  await wipe;
}
