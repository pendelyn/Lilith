import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { color, type } from "./src/theme/tokens.ts";
import { colors, FONT_FACE } from "./theme.ts";

function luminance(hex: string): number {
  const rgb = [1, 3, 5].map((offset) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
}

function contrast(a: string, b: string): number {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0]! + 0.05) / (values[1]! + 0.05);
}

test("plum palette preserves readable text and distinguishable controls", () => {
  for (const background of [colors.canvas, colors.surface, colors.inset, colors.user]) {
    for (const foreground of [colors.text, colors.secondary, colors.accent]) {
      assert.ok(contrast(foreground, background) >= 4.5, `${foreground} on ${background}`);
    }
  }
  for (const background of [colors.canvas, colors.surface, colors.inset]) {
    for (const foreground of [colors.muted, colors.danger, colors.success]) {
      assert.ok(contrast(foreground, background) >= 4.5, `${foreground} on ${background}`);
    }
    assert.ok(contrast(colors.outline, background) >= 3, `outline on ${background}`);
  }
  assert.ok(contrast(colors.canvas, colors.accent) >= 4.5);
});

test("v4 text tokens stay readable and every type role maps to its one loaded face", () => {
  assert.equal(colors.canvas, color.bg);
  for (const background of [color.bg, color.surface]) {
    for (const foreground of [color.text, color.textMuted, color.textFaint, color.accent]) {
      assert.ok(contrast(foreground, background) >= 4.5, `${foreground} on ${background}`);
    }
  }
  assert.ok(contrast(color.onAccent, color.accent) >= 4.5);

  assert.deepEqual(Object.keys(FONT_FACE.Onest), ["400", "500", "600", "700"]);
  assert.deepEqual(Object.keys(FONT_FACE.PixelifySans), ["400"]);
  assert.deepEqual(Object.keys(FONT_FACE.GeistMono), ["400"]);
  for (const [role, style] of Object.entries(type)) {
    const family = role === "mascotBubble" ? "PixelifySans" : role === "code" ? "GeistMono" : "Onest";
    assert.equal(style.fontFamily, family, role);
    const faces: Record<string, string> = FONT_FACE[style.fontFamily];
    assert.ok(faces[style.fontWeight] !== undefined, `${role} ${style.fontWeight}`);
  }
});

test("App owns each safe-area inset once, uses loaded faces only, and caps only chrome text", () => {
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const section = (start: string, end: string) => {
    const from = app.indexOf(start);
    const to = app.indexOf(end, from + start.length);
    assert.ok(from !== -1 && to !== -1, start);
    return app.slice(from, to);
  };
  const count = (source: string, needle: string) => source.split(needle).length - 1;

  assert.equal(app.includes("SafeAreaView"), false);
  assert.equal(count(app, "useSafeAreaInsets()"), 2);
  for (const screen of [section("function Onboarding(", "function Home("), section("function Home(", "function PrivacyPanel(")]) {
    for (const edge of ["top", "bottom", "left", "right"]) assert.equal(count(screen, `insets.${edge}`), 1, edge);
  }
  assert.match(app, /style=\{\[styles\.topBar, \{ marginTop: insets\.top \}\]\}/);
  assert.match(app, /useFonts\(FONT_ASSETS\)/);
  assert.match(app, /!ready \|\| \(!fontsLoaded && fontError === null\)/);

  const styles = app.slice(app.indexOf("const styles = StyleSheet.create({"));
  assert.doesNotMatch(app, /fontWeight|Menlo|monospace|letterSpacing: [0-9]|textTransform/);
  assert.equal(count(styles, "fontFamily:"), count(styles, 'fontFamily: onest["'));
  for (const [, name, body] of styles.matchAll(/(\w+): \{([^{}]*)\}/g)) {
    if (body!.includes("fontSize")) assert.match(body!, /fontFamily: onest\["[4-7]00"\]/, name);
  }

  assert.doesNotMatch(app, /allowFontScaling=\{false\}/);
  assert.equal(count(app, "maxFontSizeMultiplier={MAX_CHROME_FONT_SCALE}"), 3);
  assert.match(section('<View style={[styles.topBar', "</View>"), /maxFontSizeMultiplier=\{MAX_CHROME_FONT_SCALE\}/);
  assert.equal(count(section("styles.composerDock", "function PrivacyPanel"), "maxFontSizeMultiplier"), 2);
  assert.equal(section("function MessageBubble", "function SubagentStatusCard").includes("maxFontSizeMultiplier"), false);
});
