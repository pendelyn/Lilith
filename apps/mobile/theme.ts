import { color, font } from "./src/theme/tokens.ts";

// Shared by the native surfaces; no runtime theme switching.
export const colors = {
  canvas: color.bg,
  surface: "#1D1D24",
  inset: "#202027",
  chat: "#1B1B21",
  hairline: "#30303C",
  outline: "#807D96",
  accentSoft: "#8A8AC2",
  accent: "#D3D3FF",
  text: "#F2F0FF",
  secondary: "#D6D3EE",
  muted: "#AAA8BC",
  user: "#37364D",
  success: "#97DDB6",
  danger: "#FFABB9",
} as const;

// ponytail: Expo Go loads fonts at runtime and Android then matches them by family name only
// (expo-font fills just the regular slot), so each token weight is its own family and styles
// omit fontWeight. Ceiling: if loading fails, text falls back to the system font at regular
// weight. Upgrade path: embed the fonts with the expo-font config plugin in a native build.
export const FONT_FACE = {
  [font.ui]: { "400": "Onest_400Regular", "500": "Onest_500Medium", "600": "Onest_600SemiBold", "700": "Onest_700Bold" },
  [font.pixel]: { "400": "PixelifySans_400Regular" },
  [font.mono]: { "400": "GeistMono_400Regular" },
} as const;

export type FontFace = {
  [F in keyof typeof FONT_FACE]: (typeof FONT_FACE)[F][keyof (typeof FONT_FACE)[F]];
}[keyof typeof FONT_FACE];

// Header, composer, and dock stop growing here; message text scales without a cap.
export const MAX_CHROME_FONT_SCALE = 1.4;
