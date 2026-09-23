import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  parseChatStreamEvent,
  parseMemoryItem,
  parseMemoryListResponse,
  parseSubagentCard,
  parseTaskListResponse,
  parseToolAllowResponse,
} from "@lilith/contracts";
import { type BrowserDeps, type BrowserDriver } from "./browser.ts";
import { createHealthServer } from "./health.ts";
import {
  MEMORY_CONFIRM_REPLY,
  MEMORY_OFF_REPLY,
  MEMORY_REMEMBER_PROMPT,
  captureExplicitMemory,
  createMemoryStore,
  listMemories,
  type MemoryStore,
} from "./memory.ts";
import { createRetentionStore, deleteAccount, putArtifact, type RetentionStore } from "./retention.ts";
import { APPROVAL_PROMPT, COLOR_COMPARE_PROMPT, createTaskStore, type TaskStore } from "./tasks.ts";
import {
  applyToolPreset,
  createToolAllowStore,
  readToolAllow,
  replaceToolAllow,
  toolAllowed,
} from "./tool-allow.ts";
import {
  DISCLOSURE_PROMPT,
  TEST_COLOR_FIXTURE_COMMIT,
  WEB_RESEARCH_OFF_REPLY,
  colorFixtureUrls,
  fetchPublicHttpsPage,
  offlineWebResearchDeps,
} from "./web-research.ts";

const AUTH = { Authorization: "Bearer secret-token" };
const owner = { ownerId: "alpha-owner" };
const other = { ownerId: "other-owner" };
const ADDRESS = "meine Adresse ist Berliner Straße 1";

test("missing owner fails closed and presets replace only that owner's allow-set", () => {
  const dir = mkdtempSync(join(tmpdir(), "lilith-tools-"));
  const persistPath = join(dir, "tools.json");
  try {
    const store = createToolAllowStore({ persistPath });
    assert.deepEqual(readToolAllow(store, owner), { configured: false });
    assert.equal(toolAllowed(store, owner, "webResearch"), false);
    assert.equal(toolAllowed(store, owner, "memory"), false);

    assert.deepEqual(applyToolPreset(store, owner, "recommended"), ["webResearch", "memory"]);
    assert.deepEqual(replaceToolAllow(store, other, ["webResearch"]), ["webResearch"]);
    assert.deepEqual(applyToolPreset(store, owner, "blank"), []);
    assert.equal(toolAllowed(store, owner, "memory"), false);
    assert.equal(toolAllowed(store, other, "webResearch"), true);
    assert.deepEqual(readToolAllow(store, owner), { configured: true, tools: [] });

    const reloaded = createToolAllowStore({ persistPath });
    assert.deepEqual(readToolAllow(reloaded, owner), { configured: true, tools: [] });
    assert.deepEqual(readToolAllow(reloaded, other), { configured: true, tools: ["webResearch"] });

    writeFileSync(persistPath, JSON.stringify({ v: 1, owners: [], extra: true }));
    assert.throws(() => createToolAllowStore({ persistPath }), /Invalid tool allow store/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("account deletion clears one owner's allow-set and leaves the other", () => {
  const dir = mkdtempSync(join(tmpdir(), "lilith-tools-delete-"));
  const persistPath = join(dir, "tools.json");
  try {
    const tools = createToolAllowStore({ persistPath });
    replaceToolAllow(tools, owner, ["memory"]);
    replaceToolAllow(tools, other, ["webResearch"]);
    const memories = createMemoryStore();
    captureExplicitMemory(memories, owner, MEMORY_REMEMBER_PROMPT, true);
    deleteAccount(createRetentionStore(), createTaskStore(), memories, owner, tools);
    assert.deepEqual(readToolAllow(tools, owner), { configured: false });
    assert.equal(toolAllowed(tools, owner, "memory"), false);
    assert.deepEqual(readToolAllow(tools, other), { configured: true, tools: ["webResearch"] });
    assert.equal(listMemories(memories, owner).length, 0);
    const reloaded = createToolAllowStore({ persistPath });
    assert.deepEqual(readToolAllow(reloaded, owner), { configured: false });
    assert.deepEqual(readToolAllow(reloaded, other), { configured: true, tools: ["webResearch"] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tool routes accept only the owner token and closed ids", async () => {
  await withServer(async (base) => {
    const missing = await fetch(`${base}/tools`);
    assert.equal(missing.status, 401);

    const unconfigured = parseToolAllowResponse(await readJson(await fetch(`${base}/tools`, { headers: AUTH })));
    assert.deepEqual(unconfigured, { configured: false });

    for (const body of [
      { tools: ["browser"] },
      { tools: ["webResearch", "webResearch"] },
      { tools: ["memory"], preset: "blank" },
      { preset: "custom" },
      {},
    ]) {
      const rejected = await fetch(`${base}/tools`, {
        method: "PUT",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(rejected.status, 400);
      assert.equal(await rejected.text(), "");
    }

    const blank = parseToolAllowResponse(
      await readJson(
        await fetch(`${base}/tools`, {
          method: "PUT",
          headers: { ...AUTH, "Content-Type": "application/json" },
          body: JSON.stringify({ preset: "blank" }),
        }),
      ),
    );
    assert.deepEqual(blank, { configured: true, tools: [] });
    const custom = parseToolAllowResponse(
      await readJson(
        await fetch(`${base}/tools`, {
          method: "PUT",
          headers: { ...AUTH, "Content-Type": "application/json" },
          body: JSON.stringify({ tools: ["memory", "webResearch"] }),
        }),
      ),
    );
    assert.deepEqual(custom, { configured: true, tools: ["webResearch", "memory"] });
  });
});

test("a true client flag cannot invoke a disabled tool, and memory rows stay editable", async () => {
  const memories = createMemoryStore();
  let fetches = 0;
  const web = offlineWebResearchDeps({
    connect: () => {
      fetches += 1;
    },
  });
  await withServer(async (base) => {
    const blocked = await chat(base, COLOR_COMPARE_PROMPT, {
      webResearchEnabled: true,
      memoryEnabled: true,
    });
    assert.equal(replyOf(blocked), WEB_RESEARCH_OFF_REPLY);
    assert.equal(fetches, 0);
    const unstored = await chat(base, MEMORY_REMEMBER_PROMPT, { memoryEnabled: true });
    assert.equal(replyOf(unstored), MEMORY_OFF_REPLY);
    assert.equal(listMemories(memories, owner).length, 0);

    await putTools(base, { tools: ["memory"] });
    const stillOff = await chat(base, COLOR_COMPARE_PROMPT, { webResearchEnabled: true });
    assert.equal(replyOf(stillOff), WEB_RESEARCH_OFF_REPLY);
    assert.equal(fetches, 0);

    const stored = await chat(base, MEMORY_REMEMBER_PROMPT, { memoryEnabled: false });
    assert.equal(replyOf(stored), "Remembered: Antwortsprache Deutsch");
    const listed = parseMemoryListResponse(await readJson(await fetch(`${base}/memories`, { headers: AUTH })));
    const id = listed.memories[0]?.id;
    if (id === undefined) throw new Error("expected a memory");

    const prompted = await chat(base, `Merk dir: ${ADDRESS}`, { memoryEnabled: true });
    assert.equal(replyOf(prompted), MEMORY_CONFIRM_REPLY);
    await putTools(base, { preset: "blank" });
    const confirm = await fetch(`${base}/memories/confirm`, {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ consent: true, content: ADDRESS, memoryEnabled: true }),
    });
    assert.equal(confirm.status, 409);
    assert.equal(listMemories(memories, owner).length, 1);

    const retrieved = await fetch(`${base}/memories/retrieve`, {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "Antwortsprache", memoryEnabled: true }),
    });
    assert.equal(retrieved.status, 200);
    assert.deepEqual((await retrieved.json()).memories, []);

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
    const deleted = parseMemoryListResponse(
      await readJson(await fetch(`${base}/memories/${id}`, { method: "DELETE", headers: AUTH })),
    );
    assert.deepEqual(deleted.memories, []);

    await putTools(base, { preset: "recommended" });
    assert.equal(listMemories(memories, owner).length, 0);
    const again = await chat(base, MEMORY_REMEMBER_PROMPT, { memoryEnabled: false });
    assert.equal(replyOf(again), "Remembered: Antwortsprache Deutsch");
    assert.equal(listMemories(memories, owner).length, 1);
  }, undefined, memories, web);
});

test("pending web research approval is not consumed after the tool is turned off", async () => {
  let fetches = 0;
  const web = offlineWebResearchDeps({
    connect: () => {
      fetches += 1;
    },
  });
  const memories = createMemoryStore();
  await withServer(async (base) => {
    await putTools(base, { preset: "recommended" });
    const remembered = await chat(base, MEMORY_REMEMBER_PROMPT, { memoryEnabled: false });
    assert.equal(replyOf(remembered), "Remembered: Antwortsprache Deutsch");

    const events = await chat(base, DISCLOSURE_PROMPT, { webResearchEnabled: true });
    const card = events.find((event) => event.type === "subagent");
    if (card === undefined || card.type !== "subagent" || card.approval === undefined) {
      throw new Error("expected disclosure approval");
    }
    assert.equal(fetches, 0);

    await putTools(base, { preset: "blank" });
    assert.equal(listMemories(memories, owner).length, 1);
    const denied = await fetch(`${base}/tasks/${card.id}/approve`, {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ approval: card.approval, consent: true }),
    });
    assert.equal(denied.status, 409);
    assert.equal(await denied.text(), "");
    assert.equal(fetches, 0);
    const listed = parseTaskListResponse(await readJson(await fetch(`${base}/tasks`, { headers: AUTH })));
    assert.equal(listed.tasks.find((task) => task.id === card.id)?.approval?.state, "pending");

    const mockEvents = await chat(base, APPROVAL_PROMPT, {});
    const mock = mockEvents.find((event) => event.type === "subagent" && event.approval?.state === "pending");
    if (mock === undefined || mock.type !== "subagent" || mock.approval === undefined) {
      throw new Error("expected mock approval");
    }
    const consumed = parseSubagentCard(
      await readJson(
        await fetch(`${base}/tasks/${mock.id}/approve`, {
          method: "POST",
          headers: { ...AUTH, "Content-Type": "application/json" },
          body: JSON.stringify({ approval: mock.approval, consent: true }),
        }),
      ),
    );
    assert.equal(consumed.approval?.state, "consumed");
    assert.match(consumed.result ?? "", /Mock external write/);
    assert.equal(fetches, 0);

    await putTools(base, { preset: "recommended" });
    assert.equal(listMemories(memories, owner)[0]?.content, "Antwortsprache Deutsch");
    const allowed = parseSubagentCard(
      await readJson(
        await fetch(`${base}/tasks/${card.id}/approve`, {
          method: "POST",
          headers: { ...AUTH, "Content-Type": "application/json" },
          body: JSON.stringify({ approval: card.approval, consent: true }),
        }),
      ),
    );
    assert.equal(allowed.approval?.state, "consumed");
    assert.equal(fetches, 1);
    assert.equal(listMemories(memories, owner).length, 1);
  }, undefined, memories, web);
});

test("blank during disclosure or browser-open DNS does not GET", async () => {
  const disclosure = heldLookup();
  await withServer(async (base) => {
    await putTools(base, { preset: "recommended" });
    const events = await chat(base, DISCLOSURE_PROMPT, { webResearchEnabled: true });
    const card = events.find((event) => event.type === "subagent");
    if (card === undefined || card.type !== "subagent" || card.approval === undefined) {
      throw new Error("expected disclosure approval");
    }
    const decision = fetch(`${base}/tasks/${card.id}/approve`, {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ approval: card.approval, consent: true }),
    });
    await disclosure.opened;
    await putTools(base, { preset: "blank" });
    disclosure.release();
    const result = await decision;
    assert.equal(result.status, 409);
    assert.equal(await result.text(), "");
    assert.equal(disclosure.fetches, 0);
    const listed = parseTaskListResponse(await readJson(await fetch(`${base}/tasks`, { headers: AUTH })));
    const task = listed.tasks.find((item) => item.id === card.id);
    assert.equal(task?.state, "failed");
    assert.equal(task?.approval?.state, "consumed");
    assert.equal(task?.result, undefined);
  }, undefined, undefined, disclosure.web);

  const url = "https://example.com/";
  const browser = heldLookup();
  const driver: BrowserDriver = {
    async run(plan, deps) {
      const open = plan.ops.find((op) => op.op === "open");
      if (open === undefined || open.op !== "open") throw new Error("missing open");
      const page = await fetchPublicHttpsPage({ url: open.url }, deps);
      return { results: [{ op: "read", text: page.text }] };
    },
  };
  await withServer(async (base) => {
    await putTools(base, { preset: "recommended" });
    const events = await chat(base, `Öffne ${url}`, { webResearchEnabled: true });
    const card = events.find((event) => event.type === "subagent");
    if (card === undefined || card.type !== "subagent" || card.approval === undefined) {
      throw new Error("expected browser-open approval");
    }
    const decision = fetch(`${base}/tasks/${card.id}/approve`, {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ approval: card.approval, consent: true }),
    });
    await browser.opened;
    await putTools(base, { preset: "blank" });
    browser.release();
    const result = await decision;
    assert.equal(result.status, 409);
    assert.equal(await result.text(), "");
    assert.equal(browser.fetches, 0);
    const listed = parseTaskListResponse(await readJson(await fetch(`${base}/tasks`, { headers: AUTH })));
    const task = listed.tasks.find((item) => item.id === card.id);
    assert.equal(task?.state, "failed");
    assert.equal(task?.approval?.state, "consumed");
    assert.equal(task?.result, undefined);
  }, undefined, undefined, { ...browser.web, driver });
});

test("blank during chat fixture DNS does not GET", async () => {
  const fixture = colorFixtureUrls(TEST_COLOR_FIXTURE_COMMIT).A;
  const openDriver: BrowserDriver = {
    async run(plan, deps) {
      const open = plan.ops.find((op) => op.op === "open");
      if (open === undefined || open.op !== "open") throw new Error("missing open");
      const page = await fetchPublicHttpsPage({ url: open.url }, deps);
      return { results: [{ op: "read", text: page.text }] };
    },
  };
  const prompts = [COLOR_COMPARE_PROMPT, `Lies ${fixture}`, `Öffne ${fixture}`];
  for (const message of prompts) {
    const held = heldLookup();
    const web = message.startsWith("Öffne ") ? { ...held.web, driver: openDriver } : held.web;
    await withServer(async (base) => {
      await putTools(base, { preset: "recommended" });
      const pending = fetch(`${base}/chat`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ message, webResearchEnabled: true }),
      });
      await held.opened;
      await putTools(base, { preset: "blank" });
      held.release();
      const response = await pending;
      const reply = (await response.text())
        .trim()
        .split("\n")
        .flatMap((line) => {
          const event = parseChatStreamEvent(JSON.parse(line));
          return event.type === "delta" ? [event.text] : [];
        })
        .join("");
      assert.equal(response.status, 200);
      assert.equal(held.fetches, 0);
      assert.equal(reply.includes("Blau"), false);
      assert.equal(reply.includes("Example Domain"), false);
    }, undefined, undefined, web);
  }
});

test("in-flight sensitive confirm does not restore a memory after account deletion", async () => {
  const memories = createMemoryStore();
  await withServer(async (base, server) => {
    await putTools(base, { tools: ["memory"] });
    const prompted = await chat(base, `Merk dir: ${ADDRESS}`, { memoryEnabled: true });
    assert.equal(replyOf(prompted), MEMORY_CONFIRM_REPLY);
    assert.equal(listMemories(memories, owner).length, 0);
    const held = openHeldRequest(base, "POST", "/memories/confirm", server);
    await held.started;
    const deleted = await fetch(`${base}/account/delete`, {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ consent: true }),
    });
    assert.equal(deleted.status, 200);
    const confirm = await held.finish(
      JSON.stringify({ consent: true, content: ADDRESS, memoryEnabled: true }),
    );
    assert.notEqual(confirm.status, 200);
    assert.equal(listMemories(memories, owner).length, 0);

    await putTools(base, { tools: ["memory"] });
    const stored = await chat(base, MEMORY_REMEMBER_PROMPT, { memoryEnabled: true });
    assert.equal(replyOf(stored), "Remembered: Antwortsprache Deutsch");
    const listed = parseMemoryListResponse(await readJson(await fetch(`${base}/memories`, { headers: AUTH })));
    const id = listed.memories[0]?.id;
    if (id === undefined) throw new Error("expected a memory");
    const edit = await fetch(`${base}/memories/${id}`, {
      method: "PATCH",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ content: ADDRESS }),
    });
    assert.equal(edit.status, 409);
    const heldEdit = openHeldRequest(base, "POST", "/memories/confirm", server);
    await heldEdit.started;
    const deletedAgain = await fetch(`${base}/account/delete`, {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ consent: true }),
    });
    assert.equal(deletedAgain.status, 200);
    const confirmEdit = await heldEdit.finish(
      JSON.stringify({ consent: true, content: ADDRESS, memoryEnabled: true }),
    );
    assert.notEqual(confirmEdit.status, 200);
    assert.equal(
      listMemories(memories, owner).some((item) => item.content === ADDRESS || item.content.includes("Antwortsprache")),
      false,
    );
  }, undefined, memories);
});

test("a missing or corrupt tool allow file does not restore bak", () => {
  const dir = mkdtempSync(join(tmpdir(), "lilith-tools-bak-"));
  const persistPath = join(dir, "tools.json");
  const bak = `${persistPath}.bak`;
  const broader = JSON.stringify({
    v: 1,
    owners: [{ ownerId: owner.ownerId, tools: ["webResearch", "memory"] }],
  });
  try {
    writeFileSync(bak, broader);
    const store = createToolAllowStore({ persistPath });
    assert.deepEqual(readToolAllow(store, owner), { configured: false });
    assert.equal(toolAllowed(store, owner, "webResearch"), false);
    assert.equal(existsSync(bak), false);
    assert.equal(existsSync(persistPath), false);

    writeFileSync(persistPath, "{");
    writeFileSync(bak, broader);
    assert.throws(() => createToolAllowStore({ persistPath }));
    assert.equal(readFileSync(persistPath, "utf8"), "{");
    assert.equal(readFileSync(bak, "utf8"), broader);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("account deletion removes a leftover tools bak", () => {
  const dir = mkdtempSync(join(tmpdir(), "lilith-tools-bak-delete-"));
  const persistPath = join(dir, "tools.json");
  const bak = `${persistPath}.bak`;
  try {
    const tools = createToolAllowStore({ persistPath });
    replaceToolAllow(tools, owner, ["memory"]);
    replaceToolAllow(tools, other, ["webResearch"]);
    writeFileSync(
      bak,
      JSON.stringify({
        v: 1,
        owners: [
          { ownerId: owner.ownerId, tools: ["webResearch", "memory"] },
          { ownerId: other.ownerId, tools: ["webResearch", "memory"] },
        ],
      }),
    );
    deleteAccount(createRetentionStore(), createTaskStore(), createMemoryStore(), owner, tools);
    assert.equal(existsSync(bak), false);
    assert.deepEqual(readToolAllow(tools, owner), { configured: false });
    assert.equal(toolAllowed(tools, owner, "memory"), false);
    assert.deepEqual(readToolAllow(tools, other), { configured: true, tools: ["webResearch"] });
    const reloaded = createToolAllowStore({ persistPath });
    assert.deepEqual(readToolAllow(reloaded, owner), { configured: false });
    assert.deepEqual(readToolAllow(reloaded, other), { configured: true, tools: ["webResearch"] });
    assert.equal(existsSync(bak), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("in-flight PUT /tools does not restore the allow-set after account deletion", async () => {
  const tools = createToolAllowStore();
  replaceToolAllow(tools, other, ["memory"]);
  await withServer(async (base, server) => {
    await putTools(base, { tools: ["webResearch"] });
    const held = openHeldRequest(base, "PUT", "/tools", server);
    await held.started;
    const deleted = await fetch(`${base}/account/delete`, {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ consent: true }),
    });
    assert.equal(deleted.status, 200);
    const put = await held.finish(JSON.stringify({ preset: "recommended" }));
    assert.equal(put.status, 409);
    assert.equal(put.text, "");
    const after = parseToolAllowResponse(await readJson(await fetch(`${base}/tools`, { headers: AUTH })));
    assert.deepEqual(after, { configured: false });
    assert.deepEqual(readToolAllow(tools, other), { configured: true, tools: ["memory"] });
  }, undefined, undefined, undefined, tools);
});

test("in-flight approval during a failed delete makes no outbound call", async () => {
  const held = heldLookup();
  const stuckDns = retentionWithStuckArtifact();
  try {
    await withServer(async (base) => {
      await putTools(base, { preset: "recommended" });
      const events = await chat(base, DISCLOSURE_PROMPT, { webResearchEnabled: true });
      const card = events.find((event) => event.type === "subagent");
      if (card === undefined || card.type !== "subagent" || card.approval === undefined) {
        throw new Error("expected disclosure approval");
      }
      const decision = fetch(`${base}/tasks/${card.id}/approve`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ approval: card.approval, consent: true }),
      });
      await held.opened;
      const deleted = await fetch(`${base}/account/delete`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ consent: true }),
      });
      assert.equal(deleted.status, 500);
      assert.equal(stuckDns.retention.pendingOwnerDeletes.has(owner.ownerId), true);
      held.release();
      const result = await decision;
      assert.notEqual(result.status, 200);
      assert.equal(await result.text(), "");
      assert.equal(held.fetches, 0);
    }, undefined, undefined, held.web, createToolAllowStore(), stuckDns.retention);
  } finally {
    rmSync(stuckDns.dir, { recursive: true, force: true });
  }

  let fetches = 0;
  const web = offlineWebResearchDeps({
    connect: () => {
      fetches += 1;
    },
  });
  const stuckBody = retentionWithStuckArtifact();
  try {
    await withServer(async (base, server) => {
      await putTools(base, { preset: "recommended" });
      const events = await chat(base, DISCLOSURE_PROMPT, { webResearchEnabled: true });
      const card = events.find((event) => event.type === "subagent");
      if (card === undefined || card.type !== "subagent" || card.approval === undefined) {
        throw new Error("expected disclosure approval");
      }
      const pending = openHeldRequest(base, "POST", `/tasks/${card.id}/approve`, server);
      await pending.started;
      const deleted = await fetch(`${base}/account/delete`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ consent: true }),
      });
      assert.equal(deleted.status, 500);
      const result = await pending.finish(JSON.stringify({ approval: card.approval, consent: true }));
      assert.equal(result.status, 409);
      assert.equal(result.text, "");
      assert.equal(fetches, 0);
    }, undefined, undefined, web, createToolAllowStore(), stuckBody.retention);
  } finally {
    rmSync(stuckBody.dir, { recursive: true, force: true });
  }
});

test("in-flight chat does not store a memory after account deletion starts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lilith-tools-chat-delete-"));
  const tasksPath = join(dir, ".lilith-tasks.json");
  try {
    const tasks = createTaskStore({ persistPath: tasksPath });
    const memories = createMemoryStore();
    const tools = createToolAllowStore();
    await withServer(async (base, server) => {
      await putTools(base, { tools: ["memory"] });
      (tasks as { persistPath?: string }).persistPath = join(tasksPath, "blocked.json");
      const held = openHeldRequest(base, "POST", "/chat", server);
      await held.started;
      const deleted = await fetch(`${base}/account/delete`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ consent: true }),
      });
      assert.equal(deleted.status, 500);
      const chat = await held.finish(
        JSON.stringify({ message: MEMORY_REMEMBER_PROMPT, memoryEnabled: true }),
      );
      assert.equal(chat.status, 409);
      assert.equal(chat.text, "");
      assert.equal(
        listMemories(memories, owner).some((item) => item.content.includes("Antwortsprache")),
        false,
      );
    }, tasks, memories, undefined, tools);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("HTTP account deletion removes the allow-set", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lilith-tools-http-delete-"));
  const persistPath = join(dir, "tools.json");
  try {
    const tools = createToolAllowStore({ persistPath });
    replaceToolAllow(tools, other, ["memory"]);
    await withServer(async (base) => {
      await putTools(base, { tools: ["webResearch"] });
      const deleted = await fetch(`${base}/account/delete`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ consent: true }),
      });
      assert.equal(deleted.status, 200);
      const after = parseToolAllowResponse(await readJson(await fetch(`${base}/tools`, { headers: AUTH })));
      assert.deepEqual(after, { configured: false });
      const blocked = await chat(base, COLOR_COMPARE_PROMPT, { webResearchEnabled: true });
      assert.equal(replyOf(blocked), WEB_RESEARCH_OFF_REPLY);
    }, undefined, undefined, undefined, tools);
    const reloaded = createToolAllowStore({ persistPath });
    assert.deepEqual(readToolAllow(reloaded, owner), { configured: false });
    assert.deepEqual(readToolAllow(reloaded, other), { configured: true, tools: ["memory"] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function putTools(base: string, body: { tools: string[] } | { preset: "recommended" | "blank" }) {
  const response = await fetch(`${base}/tools`, {
    method: "PUT",
    headers: { ...AUTH, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  return parseToolAllowResponse(await response.json());
}

async function chat(
  base: string,
  message: string,
  extra: { webResearchEnabled?: boolean; memoryEnabled?: boolean },
) {
  const response = await fetch(`${base}/chat`, {
    method: "POST",
    headers: { ...AUTH, "Content-Type": "application/json" },
    body: JSON.stringify({ message, ...extra }),
  });
  assert.equal(response.status, 200);
  return (await response.text())
    .trim()
    .split("\n")
    .map((line) => parseChatStreamEvent(JSON.parse(line)));
}

function replyOf(events: ReturnType<typeof parseChatStreamEvent>[]): string {
  return events.flatMap((event) => (event.type === "delta" ? [event.text] : [])).join("");
}

async function readJson(response: Response): Promise<unknown> {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  return response.json();
}

function retentionWithStuckArtifact(): { dir: string; retention: RetentionStore } {
  const dir = mkdtempSync(join(tmpdir(), "lilith-tools-delete-fail-"));
  const filesRoot = join(dir, "files");
  const retention = createRetentionStore({ persistPath: join(dir, "state.json"), filesRoot });
  const shot = putArtifact(retention, owner, { kind: "screenshot", body: "shot" });
  if (shot.path === undefined) throw new Error("expected a screenshot path");
  const dest = join(filesRoot, ...shot.path.split("/"));
  rmSync(dest);
  mkdirSync(dest);
  return { dir, retention };
}

function heldLookup() {
  let fetches = 0;
  let releaseHold: () => void = () => {};
  let markOpened: () => void = () => {};
  const opened = new Promise<void>((resolve) => {
    markOpened = resolve;
  });
  const held = new Promise<void>((resolve) => {
    releaseHold = resolve;
  });
  const web: BrowserDeps = offlineWebResearchDeps({
    pages: { "https://example.com/": "Example Domain" },
    lookupAll: async () => {
      markOpened();
      await held;
      return [{ address: "1.1.1.1", family: 4 }];
    },
    connect: () => {
      fetches += 1;
    },
  });
  return {
    web,
    opened,
    release: () => releaseHold(),
    get fetches() {
      return fetches;
    },
  };
}

function openHeldRequest(base: string, method: string, path: string, server: Server) {
  let markStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const onRequest = (req: IncomingMessage) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (req.method === method && pathname === path) markStarted();
  };
  server.on("request", onRequest);
  const url = new URL(path, base);
  const req = httpRequest({
    hostname: url.hostname,
    port: url.port,
    method,
    path: url.pathname,
    headers: {
      ...AUTH,
      "Content-Type": "application/json",
    },
  });
  req.flushHeaders();
  return {
    started,
    finish(body: string) {
      return new Promise<{ status: number; text: string }>((resolve, reject) => {
        req.on("response", (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            server.off("request", onRequest);
            resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") });
          });
        });
        req.on("error", reject);
        req.end(body);
      });
    },
  };
}

async function withServer(
  run: (base: string, server: Server) => Promise<void>,
  store?: TaskStore,
  memories?: MemoryStore,
  web: BrowserDeps = {},
  tools = createToolAllowStore(),
  retention = createRetentionStore(),
): Promise<void> {
  const server = createHealthServer(
    { token: "secret-token", ownerId: "alpha-owner" },
    store ?? createTaskStore(),
    memories ?? createMemoryStore(),
    web,
    retention,
    tools,
  );
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a TCP address");
  try {
    await run(`http://127.0.0.1:${address.port}`, server);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
