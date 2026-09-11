import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isForbiddenMemoryContent,
  isRememberCommand,
  isSensitiveMemoryContent,
  parseChatStreamEvent,
  parseMemoryConfirmRequest,
  parseMemoryConfirmResponse,
  parseMemoryItem,
  parseMemoryListResponse,
  parseMemoryPauseRequest,
  parseMemoryRetrieveRequest,
  parseMemoryRetrieveResponse,
  parseRememberContent,
} from "@lilith/contracts";
import { test } from "node:test";
import { createHealthServer } from "./health.ts";
import {
  MEMORY_CONFIRM_REPLY,
  MEMORY_CONFIRM_TTL_MS,
  MEMORY_EMPTY_REPLY,
  MEMORY_OFF_REPLY,
  MEMORY_PAUSED_REPLY,
  MEMORY_REMEMBER_PROMPT,
  MEMORY_SECRET_REPLY,
  MEMORY_TEST_QUERY,
  MEMORY_TOO_LONG_REPLY,
  captureExplicitMemory,
  confirmMemory,
  createMemoryStore,
  deleteMemory,
  listMemories,
  memoriesForProvider,
  memoryContentDigest,
  setMemoryPaused,
  updateMemory,
  type MemoryStore,
} from "./memory.ts";
import { COLOR_COMPARE_PROMPT, createTaskStore, type TaskStore } from "./tasks.ts";

const AUTH = { Authorization: "Bearer secret-token" };
const owner = { ownerId: "alpha-owner" };
const enabled = { memoryEnabled: true as const };

test("remember parser accepts Merk dir and rejects empty content", () => {
  assert.equal(parseRememberContent("Merk dir: Antwortsprache Deutsch"), "Antwortsprache Deutsch");
  assert.equal(parseRememberContent("  merk dir Antwortsprache Deutsch  "), "Antwortsprache Deutsch");
  assert.equal(parseRememberContent("Merk dir：Antwortsprache Deutsch"), "Antwortsprache Deutsch");
  assert.equal(
    parseRememberContent("Merk dir: password: hunter2\nbitte merken"),
    "password: hunter2\nbitte merken",
  );
  assert.equal(parseRememberContent("Merk dir:"), undefined);
  assert.equal(parseRememberContent("Hello"), undefined);
  assert.equal(isRememberCommand("Merk dir:"), true);
  assert.equal(isRememberCommand("Merk dir:\n"), true);
  assert.equal(isRememberCommand("Hello"), false);
});

test("passwords tokens and payment-auth content are forbidden", () => {
  for (const content of [
    "password: hunter2",
    "Mein Passwort ist geheim",
    "Kennwort ist geheim",
    "Geheimzahl ist 1234",
    "api token abc",
    "Bearer abcdef",
    "cvv 123",
    "Kreditkarte 4111111111111111",
    "4111111111111111",
    "ghp_secretvalue",
  ]) {
    assert.equal(isForbiddenMemoryContent(content), true, content);
    assert.equal(isSensitiveMemoryContent(content), false, content);
  }
  for (const content of ["Antwortsprache Deutsch", "Ich mag Tee", "Termine am Freitag"]) {
    assert.equal(isForbiddenMemoryContent(content), false, content);
    assert.equal(isSensitiveMemoryContent(content), false, content);
  }
});

test("explicit capture stores content origin and timestamp", () => {
  const now = 1_700_000_000_000;
  const store = createMemoryStore({ now: () => now });
  const reply = captureExplicitMemory(store, owner, MEMORY_REMEMBER_PROMPT, true);
  assert.equal(reply, "Remembered: Antwortsprache Deutsch");
  assert.deepEqual(listMemories(store, owner), [
    {
      id: [...store.memories.values()][0]?.id,
      content: "Antwortsprache Deutsch",
      origin: "chat",
      createdAt: now,
      updatedAt: now,
    },
  ]);
});

test("pause blocks capture and retrieval while list edit delete remain", () => {
  const store = createMemoryStore();
  captureExplicitMemory(store, owner, MEMORY_REMEMBER_PROMPT, true);
  const id = listMemories(store, owner)[0]?.id;
  if (id === undefined) throw new Error("expected a memory");
  setMemoryPaused(store, owner, true);
  assert.equal(captureExplicitMemory(store, owner, MEMORY_REMEMBER_PROMPT, true), MEMORY_PAUSED_REPLY);
  assert.equal(listMemories(store, owner).length, 1);
  assert.deepEqual(memoriesForProvider(store, owner, { query: MEMORY_TEST_QUERY, ...enabled }), []);
  const edited = updateMemory(store, owner, id, "Antwortsprache Englisch");
  assert.equal(edited.content, "Antwortsprache Englisch");
  deleteMemory(store, owner, id);
  assert.deepEqual(listMemories(store, owner), []);
});

test("disabled memory rejects capture and retrieval", () => {
  const store = createMemoryStore();
  assert.equal(captureExplicitMemory(store, owner, MEMORY_REMEMBER_PROMPT, false), MEMORY_OFF_REPLY);
  assert.deepEqual(listMemories(store, owner), []);
  captureExplicitMemory(store, owner, MEMORY_REMEMBER_PROMPT, true);
  assert.deepEqual(memoriesForProvider(store, owner, { query: MEMORY_TEST_QUERY, memoryEnabled: false }), []);
});

test("secret rejection on create and edit stores nothing and keeps the previous value", () => {
  const store = createMemoryStore();
  assert.equal(
    captureExplicitMemory(store, owner, "Merk dir: password: hunter2", true),
    MEMORY_SECRET_REPLY,
  );
  assert.deepEqual(listMemories(store, owner), []);
  assert.equal(
    captureExplicitMemory(store, owner, "Merk dir: Kennwort ist geheim", true),
    MEMORY_SECRET_REPLY,
  );
  assert.deepEqual(listMemories(store, owner), []);
  captureExplicitMemory(store, owner, MEMORY_REMEMBER_PROMPT, true);
  const id = listMemories(store, owner)[0]?.id;
  if (id === undefined) throw new Error("expected a memory");
  assert.throws(() => updateMemory(store, owner, id, "api token abc"), /Forbidden memory/);
  assert.throws(() => updateMemory(store, owner, id, "Kennwort ist geheim"), /Forbidden memory/);
  assert.throws(() => updateMemory(store, owner, id, "Geheimzahl 9999"), /Forbidden memory/);
  assert.equal(listMemories(store, owner)[0]?.content, "Antwortsprache Deutsch");
});

test("sensitive capture and edit stay out of the store until bound confirmation", () => {
  const store = createMemoryStore({ now: () => 1_000 });
  const address = "meine Adresse ist Berliner Straße 1";
  const email = "email ist test@example.com";
  assert.equal(isSensitiveMemoryContent(address), true);
  assert.equal(
    captureExplicitMemory(store, owner, `Merk dir: ${address}`, true),
    MEMORY_CONFIRM_REPLY,
  );
  assert.deepEqual(listMemories(store, owner), []);
  assert.throws(
    () => confirmMemory(store, owner, { consent: true, content: email, memoryEnabled: true }),
    /Memory confirmation changed/,
  );
  assert.deepEqual(listMemories(store, owner), []);
  assert.deepEqual(
    confirmMemory(store, owner, { consent: false, content: address, memoryEnabled: true }),
    { confirmed: false },
  );
  assert.deepEqual(listMemories(store, owner), []);
  assert.equal(
    captureExplicitMemory(store, owner, `Merk dir: ${address}`, true),
    MEMORY_CONFIRM_REPLY,
  );
  const stored = confirmMemory(store, owner, { consent: true, content: address, memoryEnabled: true });
  assert.equal(stored.confirmed, true);
  assert.equal(stored.memory?.content, address);
  assert.equal(listMemories(store, owner)[0]?.id, stored.memory?.id);
  assert.deepEqual(
    memoriesForProvider(store, owner, { query: "Adresse Berliner", ...enabled }).map((item) => item.id),
    [stored.memory?.id],
  );
  assert.throws(
    () => confirmMemory(store, owner, { consent: true, content: address, memoryEnabled: true }),
    /Memory confirmation not found/,
  );
  assert.equal(listMemories(store, owner).length, 1);

  const id = stored.memory?.id;
  if (id === undefined) throw new Error("expected a memory");
  assert.throws(() => updateMemory(store, owner, id, email), /Memory confirmation required/);
  assert.equal(listMemories(store, owner)[0]?.content, address);
  const edited = confirmMemory(store, owner, { consent: true, content: email, memoryEnabled: true });
  assert.equal(edited.memory?.content, email);
  assert.equal(listMemories(store, owner)[0]?.content, email);
});

test("confirmation expiry, pause, disabled, and forbidden pending never persist", () => {
  let now = 1_000;
  const store = createMemoryStore({ now: () => now });
  const address = "meine Adresse ist Berliner Straße 1";
  captureExplicitMemory(store, owner, `Merk dir: ${address}`, true);
  now += MEMORY_CONFIRM_TTL_MS;
  assert.throws(
    () => confirmMemory(store, owner, { consent: true, content: address, memoryEnabled: true }),
    /Memory confirmation expired/,
  );
  assert.deepEqual(listMemories(store, owner), []);

  now += 1;
  captureExplicitMemory(store, owner, `Merk dir: ${address}`, true);
  setMemoryPaused(store, owner, true);
  assert.throws(
    () => confirmMemory(store, owner, { consent: true, content: address, memoryEnabled: true }),
    /Memory is paused/,
  );
  assert.deepEqual(listMemories(store, owner), []);
  setMemoryPaused(store, owner, false);
  assert.throws(
    () => confirmMemory(store, owner, { consent: true, content: address, memoryEnabled: false }),
    /Memory is off/,
  );
  assert.deepEqual(listMemories(store, owner), []);
  const afterEnable = confirmMemory(store, owner, { consent: true, content: address, memoryEnabled: true });
  assert.equal(afterEnable.confirmed, true);
  assert.equal(listMemories(store, owner)[0]?.content, address);

  const forbidden = "password: hunter2";
  store.pendingByOwner.set(owner.ownerId, {
    ownerId: owner.ownerId,
    kind: "capture",
    content: forbidden,
    contentDigest: memoryContentDigest(forbidden),
    expiresAt: now + MEMORY_CONFIRM_TTL_MS,
  });
  assert.throws(
    () => confirmMemory(store, owner, { consent: true, content: forbidden, memoryEnabled: true }),
    /Forbidden memory/,
  );
  assert.equal(listMemories(store, owner).length, 1);
  assert.equal(listMemories(store, owner)[0]?.content, address);
  assert.equal(store.pendingByOwner.has(owner.ownerId), false);
});

test("empty and multiline Merk dir never fall through to echo", async () => {
  const memories = createMemoryStore();
  await withServer(async (base) => {
    const empty = await chatReply(base, "Merk dir:", true);
    assert.equal(empty.reply, MEMORY_EMPTY_REPLY);
    assert.equal(empty.raw.includes("You said:"), false);
    assert.equal(listMemories(memories, owner).length, 0);

    const multiline = await chatReply(base, "Merk dir: password: hunter2\nbitte merken", true);
    assert.equal(multiline.reply, MEMORY_SECRET_REPLY);
    assert.equal(multiline.raw.toLowerCase().includes("hunter2"), false);
    assert.equal(listMemories(memories, owner).length, 0);

    const kennwort = await chatReply(base, "Merk dir: Kennwort ist geheim", true);
    assert.equal(kennwort.reply, MEMORY_SECRET_REPLY);
    assert.equal(listMemories(memories, owner).length, 0);
  }, undefined, memories);
});

test("confirm-then-retrieve returns the new id and ignores stale consent", async () => {
  const memories = createMemoryStore();
  const address = "meine Adresse ist Berliner Straße 1";
  const email = "email ist test@example.com";
  await withServer(async (base) => {
    const prompt = await chatReply(base, `Merk dir: ${address}`, true);
    assert.equal(prompt.reply, MEMORY_CONFIRM_REPLY);
    assert.equal(listMemories(memories, owner).length, 0);

    const stale = await postConfirm(base, email, true, true);
    assert.equal(stale.status, 409);
    assert.equal(listMemories(memories, owner).length, 0);

    const confirmed = parseMemoryConfirmResponse(await readJson(await postConfirm(base, address, true, true)));
    assert.equal(confirmed.confirmed, true);
    const id = confirmed.memory?.id;
    if (id === undefined) throw new Error("expected a confirmed memory");
    assert.deepEqual(await retrieve(base, "Adresse Berliner", true), [id]);

    const replay = await postConfirm(base, address, true, true);
    assert.equal(replay.status, 409);
    assert.equal(listMemories(memories, owner).length, 1);

    const patched = await fetch(`${base}/memories/${id}`, {
      method: "PATCH",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ content: email }),
    });
    assert.equal(patched.status, 409);
    assert.equal(listMemories(memories, owner)[0]?.content, address);
    const edited = parseMemoryConfirmResponse(await readJson(await postConfirm(base, email, true, true)));
    assert.equal(edited.memory?.content, email);
    assert.equal((await retrieveItems(base, "email example", true))[0]?.content, email);

    assert.throws(() => parseMemoryConfirmRequest({ consent: true, content: address }), /Invalid/);
    assert.equal((await fetch(`${base}/memories/confirm`, { method: "GET", headers: AUTH })).status, 405);
  }, undefined, memories);
});

test("provider retrieval is relevant-only and follows edit and delete", () => {
  const store = createMemoryStore();
  captureExplicitMemory(store, owner, MEMORY_REMEMBER_PROMPT, true);
  captureExplicitMemory(store, owner, "Merk dir: Testquelle A ist meine Referenz", true);
  const language = listMemories(store, owner).find((item) => item.content.includes("Antwortsprache"));
  const source = listMemories(store, owner).find((item) => item.content.includes("Testquelle"));
  if (language === undefined || source === undefined) throw new Error("expected both memories");

  assert.deepEqual(
    memoriesForProvider(store, owner, { query: MEMORY_TEST_QUERY, ...enabled }).map((item) => item.id),
    [language.id],
  );
  assert.deepEqual(
    memoriesForProvider(store, owner, { query: COLOR_COMPARE_PROMPT, ...enabled }).map((item) => item.id),
    [source.id],
  );

  updateMemory(store, owner, language.id, "Antwortsprache Französisch");
  assert.equal(
    memoriesForProvider(store, owner, { query: MEMORY_TEST_QUERY, ...enabled })[0]?.content,
    "Antwortsprache Französisch",
  );
  deleteMemory(store, owner, language.id);
  assert.deepEqual(memoriesForProvider(store, owner, { query: MEMORY_TEST_QUERY, ...enabled }), []);
});

test("foreign memories are invisible and cannot be mutated", () => {
  const store = createMemoryStore();
  captureExplicitMemory(store, { ownerId: "foreign-owner" }, MEMORY_REMEMBER_PROMPT, true);
  const foreignId = [...store.memories.values()][0]?.id;
  if (foreignId === undefined) throw new Error("expected a foreign memory");
  assert.deepEqual(listMemories(store, owner), []);
  assert.throws(() => updateMemory(store, owner, foreignId, "x"), /access denied/);
  assert.throws(() => deleteMemory(store, owner, foreignId), /access denied/);
  assert.throws(() => updateMemory(store, owner, "missing", "x"), /Memory not found/);
});

test("invalid memory payloads fail closed", () => {
  const store = createMemoryStore();
  captureExplicitMemory(store, owner, MEMORY_REMEMBER_PROMPT, true);
  const id = listMemories(store, owner)[0]?.id;
  if (id === undefined) throw new Error("expected a memory");
  assert.throws(() => updateMemory(store, owner, id, "  "), /Invalid memory/);
  assert.throws(() => updateMemory(store, owner, id, "x".repeat(1001)), /Invalid memory/);
  assert.equal(
    captureExplicitMemory(store, owner, `Merk dir: ${"x".repeat(1001)}`, true),
    MEMORY_TOO_LONG_REPLY,
  );
  assert.equal(listMemories(store, owner).length, 1);
  assert.throws(() => parseMemoryRetrieveRequest({ query: MEMORY_TEST_QUERY }), /Invalid/);
  assert.throws(() => parseMemoryPauseRequest({ paused: true, extra: true }), /Invalid/);
  assert.throws(
    () => parseMemoryItem({ id: "1", content: "x", origin: "chat", createdAt: 1, updatedAt: 1, extra: true }),
    /Invalid/,
  );
});

test("memory store reloads from disk and rolls back persist failures", () => {
  const dir = mkdtempSync(join(tmpdir(), "lilith-memories-"));
  const persistPath = join(dir, "state.json");
  try {
    const first = createMemoryStore({ persistPath, now: () => 10 });
    captureExplicitMemory(first, owner, MEMORY_REMEMBER_PROMPT, true);
    setMemoryPaused(first, owner, true);
    const id = listMemories(first, owner)[0]?.id;
    if (id === undefined) throw new Error("expected a memory");

    const reloaded = createMemoryStore({ persistPath });
    assert.equal(listMemories(reloaded, owner)[0]?.content, "Antwortsprache Deutsch");
    assert.equal(listMemories(reloaded, owner)[0]?.id, id);
    assert.deepEqual(memoriesForProvider(reloaded, owner, { query: MEMORY_TEST_QUERY, ...enabled }), []);

    const disk = readFileSync(persistPath);
    (reloaded as { persistPath?: string }).persistPath = join(persistPath, "blocked.json");
    assert.throws(() => setMemoryPaused(reloaded, owner, false));
    assert.equal([...reloaded.pausedOwnerIds].includes(owner.ownerId), true);
    assert.deepEqual(readFileSync(persistPath), disk);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupt memory snapshots fail closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "lilith-memories-bad-"));
  const persistPath = join(dir, "state.json");
  try {
    writeFileSync(persistPath, JSON.stringify({ v: 1, memories: [], pausedOwnerIds: [], extra: true }));
    assert.throws(() => createMemoryStore({ persistPath }), /Invalid memory store/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Merk dir chat stores before any echo and never echoes rejected secrets", async () => {
  const memories = createMemoryStore({ now: () => 20 });
  await withServer(async (base) => {
    const stored = await chatReply(base, MEMORY_REMEMBER_PROMPT, true);
    assert.equal(stored.reply, "Remembered: Antwortsprache Deutsch");
    assert.equal(stored.raw.includes("No model is connected yet"), false);

    const listed = parseMemoryListResponse(await readJson(await fetch(`${base}/memories`, { headers: AUTH })));
    assert.equal(listed.memories.length, 1);
    assert.equal(listed.memories[0]?.content, "Antwortsprache Deutsch");
    assert.equal(listed.memories[0]?.origin, "chat");
    assert.equal(listed.memories[0]?.createdAt, 20);
    const id = listed.memories[0]?.id;
    if (id === undefined) throw new Error("expected a stored memory");

    const retrieved = parseMemoryRetrieveResponse(
      await readJson(
        await fetch(`${base}/memories/retrieve`, {
          method: "POST",
          headers: { ...AUTH, "Content-Type": "application/json" },
          body: JSON.stringify({ query: MEMORY_TEST_QUERY, memoryEnabled: true }),
        }),
      ),
    );
    assert.deepEqual(retrieved.memories.map((item) => item.id), [id]);

    const secret = await chatReply(base, "Merk dir: password: hunter2", true);
    assert.equal(secret.reply, MEMORY_SECRET_REPLY);
    assert.equal(secret.raw.toLowerCase().includes("hunter2"), false);
    assert.equal(listMemories(memories, owner).length, 1);

    const disabledSecret = await chatReply(base, "Merk dir: password: hunter2", false);
    assert.equal(disabledSecret.reply, MEMORY_SECRET_REPLY);
    assert.equal(disabledSecret.raw.toLowerCase().includes("hunter2"), false);
  }, undefined, memories);
});

test("alpha retrieval follows edit delete pause and ignores the color fixture", async () => {
  const memories = createMemoryStore();
  await withServer(async (base) => {
    await chatReply(base, MEMORY_REMEMBER_PROMPT, true);
    const id = listMemories(memories, owner)[0]?.id;
    if (id === undefined) throw new Error("expected a memory");

    const compare = await chatReply(base, COLOR_COMPARE_PROMPT, true);
    assert.match(compare.reply, /Blau/);
    assert.equal(compare.reply.includes("Deutsch"), false);
    assert.equal(compare.reply.includes("Remembered"), false);
    assert.deepEqual(await retrieve(base, COLOR_COMPARE_PROMPT, true), []);
    assert.deepEqual(await retrieve(base, MEMORY_TEST_QUERY, true), [id]);

    const edited = parseMemoryItem(
      await readJson(
        await fetch(`${base}/memories/${id}`, {
          method: "PATCH",
          headers: { ...AUTH, "Content-Type": "application/json" },
          body: JSON.stringify({ content: "Antwortsprache Englisch" }),
        }),
      ),
    );
    assert.equal(edited.content, "Antwortsprache Englisch");
    assert.equal((await retrieveItems(base, MEMORY_TEST_QUERY, true))[0]?.content, "Antwortsprache Englisch");

    const paused = await fetch(`${base}/memories/pause`, {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ paused: true }),
    });
    assert.equal(paused.status, 200);
    assert.deepEqual(parseMemoryPauseRequest(await paused.json()), { paused: true });
    const pausedRemember = await chatReply(base, MEMORY_REMEMBER_PROMPT, true);
    assert.equal(pausedRemember.reply, MEMORY_PAUSED_REPLY);
    assert.equal(listMemories(memories, owner).length, 1);
    assert.deepEqual(await retrieve(base, MEMORY_TEST_QUERY, true), []);

    const listedWhilePaused = parseMemoryListResponse(
      await readJson(await fetch(`${base}/memories`, { headers: AUTH })),
    );
    assert.equal(listedWhilePaused.paused, true);
    assert.equal(listedWhilePaused.memories[0]?.content, "Antwortsprache Englisch");

    await fetch(`${base}/memories/pause`, {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ paused: false }),
    });
    const deleted = parseMemoryListResponse(
      await readJson(
        await fetch(`${base}/memories/${id}`, { method: "DELETE", headers: AUTH }),
      ),
    );
    assert.deepEqual(deleted.memories, []);
    assert.deepEqual(await retrieve(base, MEMORY_TEST_QUERY, true), []);
  }, undefined, memories);
});

test("chat without memoryEnabled fails closed on capture", async () => {
  const memories = createMemoryStore();
  await withServer(async (base) => {
    const response = await fetch(`${base}/chat`, {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ message: MEMORY_REMEMBER_PROMPT }),
    });
    assert.equal(response.status, 200);
    const raw = await response.text();
    const reply = raw
      .trim()
      .split("\n")
      .map((line) => parseChatStreamEvent(JSON.parse(line)))
      .flatMap((event) => (event.type === "delta" ? [event.text] : []))
      .join("");
    assert.equal(reply, MEMORY_OFF_REPLY);
    assert.equal(listMemories(memories, owner).length, 0);
  }, undefined, memories);
});

test("memory HTTP is owner-scoped and rejects invalid data", async () => {
  const memories = createMemoryStore();
  await withServer(async (base) => {
    await chatReply(base, MEMORY_REMEMBER_PROMPT, true);
    const id = listMemories(memories, owner)[0]?.id;
    if (id === undefined) throw new Error("expected a memory");

    const missing = await Promise.all([
      fetch(`${base}/memories`),
      fetch(`${base}/memories/retrieve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: MEMORY_TEST_QUERY, memoryEnabled: true }),
      }),
      fetch(`${base}/memories/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "x" }),
      }),
    ]);
    for (const response of missing) {
      assert.equal(response.status, 401);
      assert.equal(await response.text(), "");
    }

    memories.memories.set("foreign", {
      id: "foreign",
      ownerId: "foreign-owner",
      content: "Geheim",
      origin: "chat",
      createdAt: 1,
      updatedAt: 1,
    });
    const listed = parseMemoryListResponse(await readJson(await fetch(`${base}/memories`, { headers: AUTH })));
    assert.equal(listed.memories.some((item) => item.id === "foreign"), false);
    assert.equal(
      (await fetch(`${base}/memories/foreign`, {
        method: "PATCH",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ content: "x" }),
      })).status,
      404,
    );

    const secretEdit = await fetch(`${base}/memories/${id}`, {
      method: "PATCH",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "password: hunter2" }),
    });
    assert.equal(secretEdit.status, 400);
    assert.equal(await secretEdit.text(), "");
    assert.equal(listMemories(memories, owner)[0]?.content, "Antwortsprache Deutsch");

    const extra = await fetch(`${base}/memories/${id}`, {
      method: "PATCH",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "x", extra: true }),
    });
    assert.equal(extra.status, 400);

    const blank = await chatReply(base, MEMORY_REMEMBER_PROMPT, false);
    assert.equal(blank.reply, MEMORY_OFF_REPLY);
    assert.equal(listMemories(memories, owner).length, 1);
    assert.deepEqual(await retrieve(base, MEMORY_TEST_QUERY, false), []);

    assert.equal((await fetch(`${base}/memories`, { method: "POST", headers: AUTH })).status, 405);
  }, undefined, memories);
});

test("memory HTTP persistence failure returns 500 and keeps the previous snapshot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lilith-memories-http-fail-"));
  const persistPath = join(dir, "state.json");
  try {
    const memories = createMemoryStore({ persistPath });
    await withServer(async (base) => {
      await chatReply(base, MEMORY_REMEMBER_PROMPT, true);
      const disk = readFileSync(persistPath);
      (memories as { persistPath?: string }).persistPath = join(persistPath, "blocked.json");
      const paused = await fetch(`${base}/memories/pause`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ paused: true }),
      });
      assert.equal(paused.status, 500);
      assert.equal(await paused.text(), "");
      assert.equal(memories.pausedOwnerIds.has(owner.ownerId), false);
      assert.deepEqual(readFileSync(persistPath), disk);
    }, undefined, memories);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function postConfirm(base: string, content: string, consent: boolean, memoryEnabled: boolean) {
  return fetch(`${base}/memories/confirm`, {
    method: "POST",
    headers: { ...AUTH, "Content-Type": "application/json" },
    body: JSON.stringify({ consent, content, memoryEnabled }),
  });
}

async function chatReply(base: string, message: string, memoryEnabled: boolean) {
  const response = await fetch(`${base}/chat`, {
    method: "POST",
    headers: { ...AUTH, "Content-Type": "application/json" },
    body: JSON.stringify({ message, memoryEnabled }),
  });
  assert.equal(response.status, 200);
  const raw = await response.text();
  const events = raw.trim().split("\n").map((line) => parseChatStreamEvent(JSON.parse(line)));
  return {
    raw,
    reply: events.flatMap((event) => (event.type === "delta" ? [event.text] : [])).join(""),
  };
}

async function retrieve(base: string, query: string, memoryEnabled: boolean): Promise<string[]> {
  return (await retrieveItems(base, query, memoryEnabled)).map((item) => item.id);
}

async function retrieveItems(base: string, query: string, memoryEnabled: boolean) {
  return parseMemoryRetrieveResponse(
    await readJson(
      await fetch(`${base}/memories/retrieve`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ query, memoryEnabled }),
      }),
    ),
  ).memories;
}

async function readJson(response: Response): Promise<unknown> {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  return response.json();
}

async function withServer(
  run: (base: string) => Promise<void>,
  store?: TaskStore,
  memories?: MemoryStore,
): Promise<void> {
  const server = createHealthServer(
    { token: "secret-token", ownerId: "alpha-owner" },
    store ?? createTaskStore(),
    memories ?? createMemoryStore(),
  );
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address");
  }
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
