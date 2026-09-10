import type { ProviderCapabilities, ProviderConnection } from "@lilith/contracts";

export function capabilitiesSummary(capabilities: ProviderCapabilities): string {
  const flags = [
    ["tool events", capabilities.toolEvents],
    ["questions", capabilities.questions],
    ["approvals", capabilities.approvals],
    ["model switching", capabilities.modelSwitching],
  ] as const;
  const provided = flags.filter(([, on]) => on).map(([name]) => name);
  const missing = flags.filter(([, on]) => !on).map(([name]) => name);
  const left = provided.length === 0 ? "Codex: none." : `Codex: ${provided.join(", ")}.`;
  return missing.length === 0 ? left : `${left} Not provided: ${missing.join(", ")}.`;
}

export function providerStatusText(provider: ProviderConnection | null): string {
  if (provider === null) return "Codex is not loaded.";
  const caps = capabilitiesSummary(provider.capabilities);
  if (provider.state === "connected") return `Codex connected. ${caps}`;
  if (provider.state === "pending") return `Finish device login, then check. ${caps}`;
  return `Codex disconnected. ${caps}`;
}

export function deviceCodeLabel(userCode: string): string {
  return `Codex device code ${userCode}`;
}
