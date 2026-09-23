export type HomeScreen = "chat" | "agents" | "workspace" | "account" | "settings" | "memories" | "privacy";

export function agentOverviewDestination(current: HomeScreen): HomeScreen {
  return current === "agents" ? "chat" : "agents";
}

export function accountInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? `${words[0]?.[0] ?? ""}${words.at(-1)?.[0] ?? ""}` : (words[0] ?? "?").slice(0, 2))
    .toLocaleUpperCase();
}
