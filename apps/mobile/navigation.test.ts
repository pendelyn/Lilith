import assert from "node:assert/strict";
import { test } from "node:test";
import { agentOverviewDestination } from "./navigation.ts";

test("agent overview opens from chat and toggles back to the conversation", () => {
  assert.equal(agentOverviewDestination("chat"), "agents");
  assert.equal(agentOverviewDestination("agents"), "chat");
});
