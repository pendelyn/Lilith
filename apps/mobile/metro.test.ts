import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);

test("Metro permits nested dependencies installed by the committed lockfile", () => {
  const config = require("./metro.config.js");
  assert.notEqual(config.resolver.disableHierarchicalLookup, true);
  const fromExpo = createRequire(require.resolve("expo/package.json"));
  assert.ok(fromExpo.resolve("expo-asset").includes("expo-asset"));
});
