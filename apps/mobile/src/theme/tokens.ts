/**
 * Lilith design tokens (dark, the only theme for now).
 * Rule: one accent. `accent` means "something is happening" or "you decide here".
 * Never use it for decoration, links, or brand flourishes.
 */
export const color = {
  bg: "#171717", // app background, chat canvas
  surface: "#1F1F22", // composer, sheets, cards
  raised: "#27272B", // user bubble, secondary buttons, + button, stop button
  line: "#2E2E33", // default borders
  lineSoft: "#26262A", // dividers inside lists and the dock
  lineStrong: "#3A3A44", // focused composer border, dock with a pending decision
  text: "#EDEDF0", // primary text (15.5:1 on bg)
  textMuted: "#A1A1AA", // secondary text (7.1:1 on bg)
  textFaint: "#8B8B94", // placeholders, date separators (5.4:1 on bg) — never smaller than 13 pt
  accent: "#C9C9F2", // primary action, live indicator, active agent
  onAccent: "#15151B", // text / icons on accent (11:1)
  mascotInactive: "#8E8E98",
  headerBlur: "rgba(23,23,23,0.84)", // compact header over blur (solid fallback on Android)
  scrim: "rgba(0,0,0,0.55)", // behind sheets
} as const;

export const font = {
  ui: "Onest", // weights 400, 500, 600, 700
  pixel: "PixelifySans", // ONLY mascot speech bubbles; weight 400/500
  mono: "GeistMono", // ONLY code (mascot studio, code blocks in messages)
} as const;

/** size / lineHeight in pt, letterSpacing in pt. */
export const type = {
  largeTitle: { fontFamily: font.ui, fontWeight: "700", fontSize: 34, lineHeight: 38, letterSpacing: -1 },
  title: { fontFamily: font.ui, fontWeight: "700", fontSize: 24, lineHeight: 30, letterSpacing: -0.5 },
  headline: { fontFamily: font.ui, fontWeight: "600", fontSize: 18, lineHeight: 24, letterSpacing: -0.2 },
  compactTitle: { fontFamily: font.ui, fontWeight: "600", fontSize: 16, lineHeight: 20, letterSpacing: 0 },
  body: { fontFamily: font.ui, fontWeight: "400", fontSize: 16, lineHeight: 25, letterSpacing: 0 },
  bodyStrong: { fontFamily: font.ui, fontWeight: "500", fontSize: 16, lineHeight: 25, letterSpacing: 0 },
  callout: { fontFamily: font.ui, fontWeight: "400", fontSize: 15, lineHeight: 21, letterSpacing: 0 },
  subhead: { fontFamily: font.ui, fontWeight: "400", fontSize: 14, lineHeight: 20, letterSpacing: 0 },
  footnote: { fontFamily: font.ui, fontWeight: "400", fontSize: 13, lineHeight: 18, letterSpacing: 0 },
  mascotBubble: { fontFamily: font.pixel, fontWeight: "400", fontSize: 13, lineHeight: 16, letterSpacing: 0 },
  code: { fontFamily: font.mono, fontWeight: "400", fontSize: 12.5, lineHeight: 22, letterSpacing: 0 },
} as const;

export const space = { xxs: 2, xs: 4, s: 8, m: 12, l: 16, xl: 20, xxl: 24, xxxl: 32 } as const;

export const radius = {
  control: 12, // +, send, stop, attachment chip
  button: 14, // dock buttons (Ablehnen / Einmal freigeben)
  pill: 18, // "Neueste" jump pill, source pills
  bubble: 20, // user bubble (bottom-right corner uses bubbleTail)
  bubbleTail: 6,
  composer: 20,
  sheet: 24, // top corners of bottom sheets
} as const;

export const size = {
  touch: 44, // minimum hit area
  control: 40, // visual size of +, send, stop
  composerMin: 58, // 8 + 40 + 8 + 2 border
  composerMaxLines: 5,
  mascotComposer: 36,
  mascotShelf: 42,
  screenGutter: 20, // horizontal padding of chat content
  composerInset: 12, // composer distance from screen edges
  composerBottom: 12, // distance above the bottom safe-area inset
} as const;

export const elevation = {
  composer: { shadowColor: "#000", shadowOpacity: 0.4, shadowRadius: 16, shadowOffset: { width: 0, height: 12 }, elevation: 12 },
  pill: { shadowColor: "#000", shadowOpacity: 0.35, shadowRadius: 9, shadowOffset: { width: 0, height: 6 }, elevation: 6 },
} as const;

export const motion = {
  sendAppear: 120, // send button fade + scale 0.9 -> 1
  dockExpand: 200, // dock top panel height + opacity
  sheet: 280, // bottom sheets
  headerCollapse: { start: 44, end: 72 }, // scroll offset range for large -> compact title
  easing: "standard", // Easing.bezier(0.2, 0, 0, 1)
} as const;
