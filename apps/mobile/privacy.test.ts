import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ACCOUNT_DELETION_NOTICE,
  parseAccountDeleteRequest,
  parseAccountDeleteResponse,
  parseRetentionKind,
} from "@lilith/contracts";
import { CHAT_STORAGE_KEY } from "./chat.ts";
import { IDENTITY_STORAGE_KEY } from "./identity.ts";
import {
  ACCOUNT_STORAGE_KEYS,
  accountLocalWipePending,
  clearLocalAccountData,
  createAccountPurge,
  enqueueAccountWrite,
  markAccountLocalCleared,
  markAccountServerDeleted,
  PROVIDER_SIDE_LIMIT,
  RETENTION_SCHEDULE,
  shouldPersistAccountData,
} from "./privacy.ts";

test("privacy copy names deletion, provider limits, and retention periods", () => {
  assert.deepEqual([...ACCOUNT_STORAGE_KEYS], [CHAT_STORAGE_KEY, IDENTITY_STORAGE_KEY]);
  assert.equal(ACCOUNT_DELETION_NOTICE.includes("chats"), true);
  assert.equal(ACCOUNT_DELETION_NOTICE.includes("memories"), true);
  assert.equal(ACCOUNT_DELETION_NOTICE.includes("immediately"), true);
  assert.equal(ACCOUNT_DELETION_NOTICE.includes("Backups expire within 30 days"), true);
  assert.equal(ACCOUNT_DELETION_NOTICE.includes("90 days"), true);
  assert.equal(ACCOUNT_DELETION_NOTICE.includes("environment secret"), true);
  assert.equal(ACCOUNT_DELETION_NOTICE.includes("does not revoke"), true);
  assert.equal(PROVIDER_SIDE_LIMIT.includes("No model provider is connected"), true);
  assert.equal(PROVIDER_SIDE_LIMIT.includes("cannot delete"), true);
  assert.deepEqual([...RETENTION_SCHEDULE], [
    "Screenshots expire after 7 days.",
    "Temporary task files expire after 30 days.",
    "Security audit records expire after 90 days.",
    "Backups expire after 30 days.",
    "Chats, tasks, and memories stay until you delete them. Automated expiry never deletes them.",
  ]);
  assert.deepEqual(parseAccountDeleteRequest({ consent: true }), { consent: true });
  assert.deepEqual(parseAccountDeleteResponse({ deleted: true }), { deleted: true });
  assert.throws(() => parseAccountDeleteRequest({ consent: true, extra: 1 }), /Invalid/);
  assert.throws(() => parseRetentionKind("chat"), /Invalid/);
  assert.throws(() => parseRetentionKind("memory"), /Invalid/);
});

test("local account wipe waits for both queues and blocks later identity writes", async () => {
  const purge = createAccountPurge();
  const storage = new Map<string, string>([
    [IDENTITY_STORAGE_KEY, "identity"],
    [CHAT_STORAGE_KEY, "chat"],
  ]);
  const identityQueue = { current: Promise.resolve() as Promise<unknown> };
  const chatQueue = { current: Promise.resolve() as Promise<unknown> };

  let releaseIdentity: () => void = () => undefined;
  const pendingIdentity = new Promise<void>((resolve) => {
    releaseIdentity = resolve;
  });
  const identityWrite = enqueueAccountWrite(identityQueue, purge, async () => {
    await pendingIdentity;
    storage.set(IDENTITY_STORAGE_KEY, "resurrected");
  });

  markAccountServerDeleted(purge);
  const wipe = clearLocalAccountData([identityQueue, chatQueue], async () => {
    for (const key of ACCOUNT_STORAGE_KEYS) storage.delete(key);
  });
  const lateWrite = enqueueAccountWrite(identityQueue, purge, async () => {
    storage.set(IDENTITY_STORAGE_KEY, "after-wipe");
  });

  releaseIdentity();
  await identityWrite;
  await wipe;
  await lateWrite;

  assert.equal(storage.has(IDENTITY_STORAGE_KEY), false);
  assert.equal(storage.has(CHAT_STORAGE_KEY), false);
  assert.equal(shouldPersistAccountData(purge), false);
  assert.equal(accountLocalWipePending(purge), true);
});

test("local wipe failure stays visible and retry clears storage", async () => {
  const purge = createAccountPurge();
  markAccountServerDeleted(purge);
  const storage = new Map<string, string>([[IDENTITY_STORAGE_KEY, "identity"], [CHAT_STORAGE_KEY, "chat"]]);
  const identityQueue = { current: Promise.resolve() as Promise<unknown> };
  const chatQueue = { current: Promise.resolve() as Promise<unknown> };
  let fail = true;

  await assert.rejects(
    () =>
      clearLocalAccountData([identityQueue, chatQueue], async () => {
        if (fail) throw new Error("disk");
        for (const key of ACCOUNT_STORAGE_KEYS) storage.delete(key);
      }),
    /disk/,
  );
  assert.equal(storage.get(IDENTITY_STORAGE_KEY), "identity");
  assert.equal(accountLocalWipePending(purge), true);
  assert.equal(shouldPersistAccountData(purge), false);

  await enqueueAccountWrite(identityQueue, purge, async () => {
    storage.set(IDENTITY_STORAGE_KEY, "should-not-write");
  });
  assert.equal(storage.get(IDENTITY_STORAGE_KEY), "identity");

  fail = false;
  await clearLocalAccountData([identityQueue, chatQueue], async () => {
    for (const key of ACCOUNT_STORAGE_KEYS) storage.delete(key);
  });
  markAccountLocalCleared(purge);
  assert.equal(storage.size, 0);
  assert.equal(accountLocalWipePending(purge), false);
});
