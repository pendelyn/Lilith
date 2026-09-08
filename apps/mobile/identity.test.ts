import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_NAME,
  identityFromChoice,
  parsePersistedIdentity,
  serializeIdentity,
} from "./identity.ts";

test("persistence parsing applies defaults and mode tools", () => {
  assert.equal(parsePersistedIdentity(null), null);
  assert.equal(parsePersistedIdentity(""), null);
  assert.equal(parsePersistedIdentity("not-json"), null);
  assert.equal(parsePersistedIdentity(JSON.stringify({ name: "Nyx" })), null);
  assert.equal(parsePersistedIdentity(JSON.stringify({ name: "Nyx", mode: "other" })), null);
  assert.equal(identityFromChoice("x".repeat(50), "blank").name, "x".repeat(40));

  assert.deepEqual(parsePersistedIdentity(JSON.stringify({ mode: "recommended" })), {
    name: DEFAULT_NAME,
    mode: "recommended",
    tools: ["webResearch", "memory"],
  });

  assert.deepEqual(
    parsePersistedIdentity(
      JSON.stringify({ name: "  ", mode: "recommended", tools: [] }),
    ),
    {
      name: DEFAULT_NAME,
      mode: "recommended",
      tools: ["webResearch", "memory"],
    },
  );

  assert.deepEqual(
    parsePersistedIdentity(
      JSON.stringify({ name: " Nyx ", mode: "blank", tools: ["webResearch", "memory"] }),
    ),
    {
      name: "Nyx",
      mode: "blank",
      tools: [],
    },
  );

  const recommended = identityFromChoice("", "recommended");
  assert.deepEqual(JSON.parse(serializeIdentity(recommended)), recommended);
  assert.deepEqual(parsePersistedIdentity(serializeIdentity(recommended)), recommended);
});
