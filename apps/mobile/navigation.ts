export type HomeScreen = "chat" | "agents" | "workspace" | "account" | "settings" | "memories" | "privacy";

export function agentOverviewDestination(current: HomeScreen): HomeScreen {
  return current === "agents" ? "chat" : "agents";
}
