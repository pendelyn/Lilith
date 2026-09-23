import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  DEFAULT_NAME,
  identityFromChoice,
  parsePersistedIdentity,
  serializeIdentity,
  webResearchEnabledFromIdentity,
} from "./identity.ts";

test("settings name field stays disabled during account deletion and after server deletion", () => {
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  assert.match(app, /<NameField value=\{name\} onChangeText=\{setName\} onEndEditing=\{\(\) => commitName\(name\)\} editable=\{!accountBusy && !serverDeleted\} \/>/);
  assert.match(app, /onEndEditing=\{onEndEditing\}\s+editable=\{editable\}/);
});

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

  assert.equal(webResearchEnabledFromIdentity(identityFromChoice("Lilith", "recommended")), true);
  assert.equal(webResearchEnabledFromIdentity(identityFromChoice("Lilith", "blank")), false);
  assert.equal(webResearchEnabledFromIdentity(null), false);
  assert.equal(
    webResearchEnabledFromIdentity(
      parsePersistedIdentity(JSON.stringify({ name: "Nyx", mode: "blank", tools: ["webResearch", "memory"] })),
    ),
    false,
  );
});
