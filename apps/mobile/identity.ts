import {
  OPTIONAL_TOOLS,
  TOOL_PRESETS,
  type OptionalTool,
  type ToolAllowResponse,
  type ToolPreset,
} from "@lilith/contracts";
import { colors } from "./theme.ts";

export const DEFAULT_NAME = "Lilith";
export const MAX_NAME_LENGTH = 40;
export const IDENTITY_STORAGE_KEY = "lilith.identity";

export { OPTIONAL_TOOLS, type OptionalTool };
export const SETUP_MODES = TOOL_PRESETS;
export type SetupMode = ToolPreset | "custom";

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

export function normalizeTools(values: readonly unknown[]): OptionalTool[] {
  const selected = new Set<OptionalTool>();
  for (const value of values) {
    if (value === "webResearch" || value === "memory") selected.add(value);
  }
  return OPTIONAL_TOOLS.filter((tool) => selected.has(tool));
}

export function sameToolSet(left: readonly OptionalTool[], right: readonly OptionalTool[]): boolean {
  return OPTIONAL_TOOLS.every((tool) => left.includes(tool) === right.includes(tool));
}

export function modeForTools(tools: readonly OptionalTool[]): SetupMode {
  const normalized = normalizeTools(tools);
  if (sameToolSet(normalized, toolsForMode("recommended"))) return "recommended";
  if (sameToolSet(normalized, toolsForMode("blank"))) return "blank";
  return "custom";
}

export function toolSyncPlan(
  server: ToolAllowResponse,
  tools: readonly OptionalTool[],
  migrateLocal = false,
):
  | { kind: "migrate"; preset: ToolPreset }
  | { kind: "migrate"; tools: OptionalTool[] }
  | { kind: "adopt"; tools: OptionalTool[]; mode: SetupMode } {
  if (!server.configured) {
    // ponytail: a stored phone setup is not an opt-in. Uploading it turns tools back
    // on when account deletion removed the server record before AsyncStorage clear.
    // migrateLocal is only the setup choice made in this process.
    // Upgrade: a server tombstone if that choice must survive a restart before connect.
    if (!migrateLocal) return { kind: "adopt", tools: [], mode: "blank" };
    const normalized = normalizeTools(tools);
    const mode = modeForTools(normalized);
    if (mode === "custom") return { kind: "migrate", tools: normalized };
    return { kind: "migrate", preset: mode };
  }
  const adopted = normalizeTools(server.tools);
  return { kind: "adopt", tools: adopted, mode: modeForTools(adopted) };
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
  look?: { accent?: unknown; appearance?: unknown; tools?: readonly unknown[] },
): AgentIdentity {
  const tools = look?.tools === undefined ? toolsForMode(mode) : normalizeTools(look.tools);
  return {
    name: normalizeName(name),
    mode: modeForTools(tools),
    tools,
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

  if (
    !("mode" in value) ||
    (value.mode !== "recommended" && value.mode !== "blank" && value.mode !== "custom")
  ) {
    return null;
  }

  const name = "name" in value && typeof value.name === "string" ? value.name : DEFAULT_NAME;
  const accent = "accent" in value ? value.accent : undefined;
  const appearance = "appearance" in value ? value.appearance : undefined;
  const tools = "tools" in value && Array.isArray(value.tools) ? value.tools : undefined;
  return identityFromChoice(name, value.mode, { accent, appearance, ...(tools === undefined ? {} : { tools }) });
}

export function serializeIdentity(identity: AgentIdentity): string {
  return JSON.stringify(
    identityFromChoice(identity.name, identity.mode, {
      accent: identity.accent,
      appearance: identity.appearance,
      tools: identity.tools,
    }),
  );
}
