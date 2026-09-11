import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseMemoryConfirmRequest,
  parseMemoryConfirmResponse,
  parseMemoryItem,
  parseMemoryListResponse,
  parseMemoryPauseRequest,
} from "@lilith/contracts";
import { identityFromChoice, parsePersistedIdentity } from "./identity.ts";
import { memoryEnabledFromIdentity, memoryRowAccessibilityLabel, removeMemory, replaceMemory } from "./memory.ts";

test("Recommended enables memory and Blank disables it", () => {
  assert.equal(memoryEnabledFromIdentity(identityFromChoice("Lilith", "recommended")), true);
  assert.equal(memoryEnabledFromIdentity(identityFromChoice("Lilith", "blank")), false);
  assert.equal(memoryEnabledFromIdentity(null), false);
});

test("stale persisted tools cannot enable memory on a Blank identity", () => {
  const identity = parsePersistedIdentity(
    JSON.stringify({ name: "Nyx", mode: "blank", tools: ["webResearch", "memory"] }),
  );
  assert.equal(memoryEnabledFromIdentity(identity), false);
  assert.equal(memoryEnabledFromIdentity(parsePersistedIdentity("not-json")), false);
});

test("memory list parsers reject extra keys and client helpers replace or drop rows", () => {
  const item = {
    id: "mem-1",
    content: "Antwortsprache Deutsch",
    origin: "chat" as const,
    createdAt: 10,
    updatedAt: 10,
  };
  assert.deepEqual(parseMemoryItem(item), item);
  assert.deepEqual(parseMemoryListResponse({ memories: [item], paused: false }), {
    memories: [item],
    paused: false,
  });
  assert.deepEqual(parseMemoryPauseRequest({ paused: true }), { paused: true });
  assert.throws(() => parseMemoryListResponse({ memories: [item], paused: false, extra: true }), /Invalid/);
  assert.throws(() => parseMemoryItem({ ...item, extra: true }), /Invalid/);
  assert.throws(() => parseMemoryPauseRequest({ paused: true, extra: true }), /Invalid/);

  const updated = { ...item, content: "Antwortsprache Englisch", updatedAt: 11 };
  assert.deepEqual(replaceMemory([item], updated), [updated]);
  assert.deepEqual(replaceMemory([item], { ...updated, id: "other" }), [item]);
  assert.deepEqual(removeMemory([item], "mem-1"), []);
  assert.deepEqual(removeMemory([item], "other"), [item]);

  assert.deepEqual(parseMemoryConfirmRequest({ consent: true, content: "x", memoryEnabled: true }), {
    consent: true,
    content: "x",
    memoryEnabled: true,
  });
  assert.deepEqual(parseMemoryConfirmResponse({ confirmed: false }), { confirmed: false });
  assert.throws(() => parseMemoryConfirmRequest({ consent: true, content: "x" }), /Invalid/);
  const editLabel = memoryRowAccessibilityLabel("Edit", "Antwortsprache Deutsch", 10);
  const otherEdit = memoryRowAccessibilityLabel("Edit", "Testquelle A ist meine Referenz", 11);
  const deleteLabel = memoryRowAccessibilityLabel("Delete", "Antwortsprache Deutsch", 10);
  assert.equal(editLabel.includes("Antwortsprache Deutsch"), true);
  assert.equal(otherEdit.includes("Testquelle A ist meine Referenz"), true);
  assert.notEqual(editLabel, otherEdit);
  assert.notEqual(editLabel, deleteLabel);
});
