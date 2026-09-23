export const OPTIONAL_TOOLS = ["webResearch", "memory"] as const;
export type OptionalTool = (typeof OPTIONAL_TOOLS)[number];

export const TOOL_PRESETS = ["recommended", "blank"] as const;
export type ToolPreset = (typeof TOOL_PRESETS)[number];

export type ToolAllowResponse =
  | { configured: false }
  | { configured: true; tools: OptionalTool[] };

export type ToolAllowUpdate = { tools: OptionalTool[] } | { preset: ToolPreset };

export function toolsForPreset(preset: ToolPreset): OptionalTool[] {
  return preset === "recommended" ? ["webResearch", "memory"] : [];
}

export function parseToolAllowResponse(value: unknown): ToolAllowResponse {
  const input = record(value);
  if (input.configured === false) {
    if (Object.keys(input).length !== 1) throw new Error("Invalid tools");
    return { configured: false };
  }
  if (input.configured !== true || Object.keys(input).length !== 2 || !Array.isArray(input.tools)) {
    throw new Error("Invalid tools");
  }
  return { configured: true, tools: parseToolList(input.tools) };
}

export function parseToolAllowUpdate(value: unknown): ToolAllowUpdate {
  const input = record(value);
  const keys = Object.keys(input);
  if (keys.length !== 1) throw new Error("Invalid tools");
  if (keys[0] === "preset") {
    if (input.preset !== "recommended" && input.preset !== "blank") throw new Error("Invalid tools");
    return { preset: input.preset };
  }
  if (keys[0] === "tools") {
    if (!Array.isArray(input.tools)) throw new Error("Invalid tools");
    return { tools: parseToolList(input.tools) };
  }
  throw new Error("Invalid tools");
}

function parseToolList(values: unknown[]): OptionalTool[] {
  const selected: OptionalTool[] = [];
  for (const value of values) {
    if (value !== "webResearch" && value !== "memory") throw new Error("Invalid tools");
    if (selected.includes(value)) throw new Error("Invalid tools");
    selected.push(value);
  }
  return OPTIONAL_TOOLS.filter((tool) => selected.includes(tool));
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid tools");
  }
  return value as Record<string, unknown>;
}
