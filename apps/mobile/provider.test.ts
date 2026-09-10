import assert from "node:assert/strict";
import { test } from "node:test";
import { parseProviderConnection, type ProviderCapabilities } from "@lilith/contracts";
import { capabilitiesSummary, deviceCodeLabel, providerStatusText } from "./provider.ts";

const CODEX_CAPABILITIES: ProviderCapabilities = {
  questions: false,
  approvals: false,
  toolEvents: false,
  modelSwitching: false,
};

test("Codex capability copy matches the adapter flags and omits secrets", () => {
  assert.equal(
    capabilitiesSummary(CODEX_CAPABILITIES),
    "Codex: none. Not provided: tool events, questions, approvals, model switching.",
  );
  const pending = parseProviderConnection({
    provider: "codex",
    state: "pending",
    capabilities: CODEX_CAPABILITIES,
    verificationUrl: "https://auth.openai.com/codex/device",
    userCode: "ABCD-EFGH",
  });
  assert.equal(
    providerStatusText(pending),
    "Finish device login, then check. Codex: none. Not provided: tool events, questions, approvals, model switching.",
  );
  assert.equal(pending.state, "pending");
  if (pending.state !== "pending") throw new Error("expected pending");
  assert.equal(deviceCodeLabel(pending.userCode), "Codex device code ABCD-EFGH");
  assert.equal(JSON.stringify(pending).includes("token"), false);
  assert.equal(JSON.stringify(pending).includes("authJson"), false);
});
