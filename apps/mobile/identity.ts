import { colors } from "./theme.ts";

export const DEFAULT_NAME = "Lilith";
export const MAX_NAME_LENGTH = 40;
export const IDENTITY_STORAGE_KEY = "lilith.identity";

export const SETUP_MODES = ["recommended", "blank"] as const;
export type SetupMode = (typeof SETUP_MODES)[number];

export const OPTIONAL_TOOLS = ["webResearch", "memory"] as const;
export type OptionalTool = (typeof OPTIONAL_TOOLS)[number];

export const ACCENTS = ["lavender", "mint", "rose", "sky"] as const;
export type AccentId = (typeof ACCENTS)[number];
export const DEFAULT_ACCENT: AccentId = "lavender";

// ponytail: closed light accents on the fixed dark surfaces. A darker accent needs its own text color.
export const ACCENT_COLOR: Record<AccentId, string> = {
  lavender: colors.accent,
  mint: "#C6F3D8",
  rose: "#FFD0DC",
  sky: "#C9E6FF",
};

export const ACCENT_LABEL: Record<AccentId, string> = {
  lavender: "Lavender",
  mint: "Mint",
  rose: "Rose",
  sky: "Sky",
};

export const APPEARANCES = ["classic", "tuxedo", "tabby", "siamese"] as const;
export type AppearanceId = (typeof APPEARANCES)[number];
export const DEFAULT_APPEARANCE: AppearanceId = "classic";

export const APPEARANCE_LABEL: Record<AppearanceId, string> = {
  classic: "Classic",
  tuxedo: "Tuxedo",
  tabby: "Tabby",
  siamese: "Siamese",
};

export type AgentIdentity = {
  name: string;
  mode: SetupMode;
  tools: OptionalTool[];
  accent: AccentId;
  appearance: AppearanceId;
};

export function toolsForMode(mode: SetupMode): OptionalTool[] {
  return mode === "recommended" ? ["webResearch", "memory"] : [];
}

export function webResearchEnabledFromIdentity(identity: AgentIdentity | null): boolean {
  return identity?.tools.includes("webResearch") === true;
}

export function normalizeName(value: string): string {
  const name = value.trim().slice(0, MAX_NAME_LENGTH);
  return name === "" ? DEFAULT_NAME : name;
}

function normalizeAccent(value: unknown): AccentId {
  return typeof value === "string" && (ACCENTS as readonly string[]).includes(value) ? (value as AccentId) : DEFAULT_ACCENT;
}

function normalizeAppearance(value: unknown): AppearanceId {
  return typeof value === "string" && (APPEARANCES as readonly string[]).includes(value)
    ? (value as AppearanceId)
    : DEFAULT_APPEARANCE;
}

export function identityFromChoice(
  name: string,
  mode: SetupMode,
  look?: { accent?: unknown; appearance?: unknown },
): AgentIdentity {
  return {
    name: normalizeName(name),
    mode,
    tools: toolsForMode(mode),
    accent: normalizeAccent(look?.accent),
    appearance: normalizeAppearance(look?.appearance),
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
  const accent = "accent" in value ? value.accent : undefined;
  const appearance = "appearance" in value ? value.appearance : undefined;
  return identityFromChoice(name, value.mode, { accent, appearance });
}

export function serializeIdentity(identity: AgentIdentity): string {
  return JSON.stringify(
    identityFromChoice(identity.name, identity.mode, {
      accent: identity.accent,
      appearance: identity.appearance,
    }),
  );
}
