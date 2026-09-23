import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  DEFAULT_NAME,
  identityFromChoice,
  parsePersistedIdentity,
  sameToolSet,
  serializeIdentity,
  toolSyncPlan,
  toolsForMode,
  webResearchEnabledFromIdentity,
} from "./identity.ts";

test("settings name field stays disabled during account deletion and after server deletion", () => {
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  assert.match(app, /<NameField value=\{name\} onChangeText=\{setName\} onEndEditing=\{\(\) => commitName\(name\)\} editable=\{!accountBusy && !serverDeleted\} \/>/);
  assert.match(app, /onEndEditing=\{onEndEditing\}\s+editable=\{editable\}/);
  assert.match(app, /accessibilityRole="switch"\s+accessibilityLabel=\{TOOL_LABELS\[tool\]\}/);
  assert.match(app, /accessibilityLabel="Tool preset"/);
  assert.match(app, /preset: plan\.preset/);
  assert.match(app, /toolSyncPlan\(allow, identity\.tools, allowToolMigrate\)/);
  assert.match(app, /const \[allowToolMigrate, setAllowToolMigrate\] = useState\(false\)/);
  assert.match(app, /setAllowToolMigrate\(true\)/);
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
    accent: "lavender",
    appearance: "classic",
  });

  assert.deepEqual(
    parsePersistedIdentity(
      JSON.stringify({ name: "  ", mode: "recommended", tools: [] }),
    ),
    {
      name: DEFAULT_NAME,
      mode: "blank",
      tools: [],
      accent: "lavender",
      appearance: "classic",
    },
  );

  assert.deepEqual(
    parsePersistedIdentity(
      JSON.stringify({ name: " Nyx ", mode: "blank", tools: ["webResearch", "memory"] }),
    ),
    {
      name: "Nyx",
      mode: "recommended",
      tools: ["webResearch", "memory"],
      accent: "lavender",
      appearance: "classic",
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
      parsePersistedIdentity(JSON.stringify({ name: "Nyx", mode: "blank" })),
    ),
    false,
  );
  assert.equal(
    webResearchEnabledFromIdentity(
      parsePersistedIdentity(JSON.stringify({ name: "Nyx", mode: "blank", tools: ["plugin"] })),
    ),
    false,
  );
});

test("custom tool subset survives rename, accent, appearance, and relaunch", () => {
  const custom = identityFromChoice("Nyx", "recommended", {
    accent: "rose",
    appearance: "tuxedo",
    tools: ["memory"],
  });
  assert.deepEqual(custom.tools, ["memory"]);
  assert.equal(custom.mode, "custom");

  const renamed = identityFromChoice("Other", custom.mode, {
    ...custom,
    accent: "sky",
    appearance: "tabby",
  });
  assert.equal(renamed.name, "Other");
  assert.equal(renamed.accent, "sky");
  assert.equal(renamed.appearance, "tabby");
  assert.deepEqual(renamed.tools, ["memory"]);
  assert.deepEqual(parsePersistedIdentity(serializeIdentity(renamed)), renamed);

  const blank = identityFromChoice(renamed.name, "blank", {
    accent: renamed.accent,
    appearance: renamed.appearance,
  });
  assert.deepEqual(blank.tools, []);
  assert.equal(sameToolSet(blank.tools, toolsForMode("blank")), true);
  assert.equal(sameToolSet(toolsForMode("recommended"), ["webResearch", "memory"]), true);
});

test("stored tools are not uploaded onto an unconfigured server", () => {
  assert.deepEqual(toolSyncPlan({ configured: false }, ["webResearch", "memory"]), {
    kind: "adopt",
    tools: [],
    mode: "blank",
  });
  assert.deepEqual(toolSyncPlan({ configured: false }, ["memory"]), {
    kind: "adopt",
    tools: [],
    mode: "blank",
  });
  assert.deepEqual(toolSyncPlan({ configured: false }, []), {
    kind: "adopt",
    tools: [],
    mode: "blank",
  });
  assert.deepEqual(toolSyncPlan({ configured: false }, ["webResearch", "memory"], true), {
    kind: "migrate",
    preset: "recommended",
  });
  assert.deepEqual(toolSyncPlan({ configured: false }, ["memory"], true), {
    kind: "migrate",
    tools: ["memory"],
  });
  assert.deepEqual(toolSyncPlan({ configured: false }, [], true), {
    kind: "migrate",
    preset: "blank",
  });
  assert.deepEqual(toolSyncPlan({ configured: true, tools: ["memory"] }, ["webResearch", "memory"]), {
    kind: "adopt",
    tools: ["memory"],
    mode: "custom",
  });
  assert.deepEqual(toolSyncPlan({ configured: true, tools: [] }, ["webResearch", "memory"]), {
    kind: "adopt",
    tools: [],
    mode: "blank",
  });
});
