export const DEFAULT_NAME = "Lilith";
export const MAX_NAME_LENGTH = 40;
export const IDENTITY_STORAGE_KEY = "lilith.identity";

export const SETUP_MODES = ["recommended", "blank"] as const;
export type SetupMode = (typeof SETUP_MODES)[number];

export const OPTIONAL_TOOLS = ["webResearch", "memory"] as const;
export type OptionalTool = (typeof OPTIONAL_TOOLS)[number];

export type AgentIdentity = {
  name: string;
  mode: SetupMode;
  tools: OptionalTool[];
};

export function toolsForMode(mode: SetupMode): OptionalTool[] {
  return mode === "recommended" ? ["webResearch", "memory"] : [];
}

export function normalizeName(value: string): string {
  const name = value.trim().slice(0, MAX_NAME_LENGTH);
  return name === "" ? DEFAULT_NAME : name;
}

export function identityFromChoice(name: string, mode: SetupMode): AgentIdentity {
  return {
    name: normalizeName(name),
    mode,
    tools: toolsForMode(mode),
  };
}

export function parsePersistedIdentity(raw: string | null): AgentIdentity | null {
  if (raw == null || raw.trim() === "") {
    return null;
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  if (!("mode" in value) || (value.mode !== "recommended" && value.mode !== "blank")) {
    return null;
  }

  const name = "name" in value && typeof value.name === "string" ? value.name : DEFAULT_NAME;
  return identityFromChoice(name, value.mode);
}

export function serializeIdentity(identity: AgentIdentity): string {
  return JSON.stringify(identityFromChoice(identity.name, identity.mode));
}
