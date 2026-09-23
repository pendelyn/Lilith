import assert from "node:assert/strict";
import { test } from "node:test";
import { accountInitials, agentOverviewDestination } from "./navigation.ts";

test("agent overview opens from chat and toggles back to the conversation", () => {
  assert.equal(agentOverviewDestination("chat"), "agents");
  assert.equal(agentOverviewDestination("agents"), "chat");
});

test("account badge uses readable initials for single and multiple names", () => {
  assert.equal(accountInitials("Lilith"), "LI");
  assert.equal(accountInitials("  Billie   Thompson "), "BT");
  assert.equal(accountInitials(""), "?");
});
