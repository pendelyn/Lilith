import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CHAT_STORAGE_KEY } from "./chat.ts";
import {
  ACCENT_COLOR,
  ACCENTS,
  APPEARANCES,
  DEFAULT_ACCENT,
  DEFAULT_APPEARANCE,
  identityFromChoice,
  parsePersistedIdentity,
  serializeIdentity,
  IDENTITY_STORAGE_KEY,
} from "./identity.ts";
import {
  MASCOT_MARK_COLOR,
  MASCOT_PIXELS,
  MASCOT_STATES,
  mascotPresentation,
  paintMascotAppearance,
} from "./mascot.ts";
import { ACCOUNT_STORAGE_KEYS } from "./privacy.ts";
import { colors } from "./theme.ts";

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

test("accent and appearance persist inside the identity record account deletion removes", () => {
  assert.deepEqual([...ACCENTS], ["lavender", "mint", "rose", "sky"]);
  assert.deepEqual([...APPEARANCES], ["classic", "tuxedo", "tabby", "siamese"]);
  assert.deepEqual([...ACCOUNT_STORAGE_KEYS], [CHAT_STORAGE_KEY, IDENTITY_STORAGE_KEY]);

  const chosen = identityFromChoice("Nyx", "recommended", { accent: "rose", appearance: "tuxedo" });
  const raw = serializeIdentity(chosen);
  assert.deepEqual(parsePersistedIdentity(raw), chosen);
  assert.equal(JSON.parse(raw).accent, "rose");
  assert.equal(JSON.parse(raw).appearance, "tuxedo");

  const renamed = identityFromChoice("Other", chosen.mode, chosen);
  assert.equal(renamed.name, "Other");
  assert.equal(renamed.accent, "rose");
  assert.equal(renamed.appearance, "tuxedo");
  assert.deepEqual(renamed.tools, ["webResearch", "memory"]);

  assert.deepEqual(
    parsePersistedIdentity(JSON.stringify({ mode: "blank", name: "Nyx", accent: "nope", appearance: "siamese", tools: ["memory"] })),
    {
      name: "Nyx",
      mode: "blank",
      tools: [],
      accent: DEFAULT_ACCENT,
      appearance: "siamese",
    },
  );
  assert.equal(
    parsePersistedIdentity(JSON.stringify({ mode: "recommended", appearance: " tabby " }))?.appearance,
    DEFAULT_APPEARANCE,
  );
  assert.equal(parsePersistedIdentity(JSON.stringify({ accent: "mint", appearance: "tabby" })), null);
});

test("selectable accents stay readable on the dark surfaces and as button fills", () => {
  assert.equal(ACCENT_COLOR.lavender, colors.accent);
  assert.equal(new Set(Object.values(ACCENT_COLOR)).size, ACCENTS.length);
  for (const accent of Object.values(ACCENT_COLOR)) {
    for (const background of [colors.canvas, colors.surface, colors.inset, colors.user]) {
      assert.ok(contrast(accent, background) >= 4.5, `${accent} on ${background}`);
    }
    assert.ok(contrast(colors.canvas, accent) >= 4.5, `canvas text on ${accent}`);
  }
  assert.ok(contrast(MASCOT_MARK_COLOR.w, MASCOT_MARK_COLOR.k) >= 3);
  assert.ok(contrast(MASCOT_MARK_COLOR.b, MASCOT_MARK_COLOR.t) >= 3);
  assert.ok(contrast(MASCOT_MARK_COLOR.c, MASCOT_MARK_COLOR.d) >= 3);
});

test("coat masks stay recognizable, static, and distinct across the seven poses", () => {
  const idle = mascotPresentation("idle", true).rows;
  assert.equal(paintMascotAppearance(idle, "classic"), idle);
  const coats = APPEARANCES.map((appearance) => paintMascotAppearance(idle, appearance).join("\n"));
  assert.equal(new Set(coats).size, APPEARANCES.length);

  const idleArt = (appearance: (typeof APPEARANCES)[number]) => paintMascotAppearance(idle, appearance).join("");
  assert.match(idleArt("tuxedo"), /w/);
  assert.match(idleArt("tuxedo"), /k/);
  assert.match(idleArt("tabby"), /t/);
  assert.match(idleArt("tabby"), /b/);
  assert.match(idleArt("siamese"), /d/);
  assert.match(idleArt("siamese"), /c/);

  const known = new Set<string>([".", ...Object.keys(MASCOT_PIXELS), ...Object.keys(MASCOT_MARK_COLOR)]);
  for (const appearance of APPEARANCES) {
    if (appearance !== "classic") assert.equal(idleArt(appearance).includes("f"), false);
    const painted = paintMascotAppearance(idle, appearance);
    for (let y = 0; y < idle.length; y += 1) {
      const before = idle[y] ?? "";
      const after = painted[y] ?? "";
      assert.equal(after.length, before.length);
      for (let x = 0; x < before.length; x += 1) {
        if (before[x] !== "f") assert.equal(after[x], before[x]);
      }
    }
    const poses = new Set(
      MASCOT_STATES.map((state) => paintMascotAppearance(mascotPresentation(state, true).rows, appearance).join("\n")),
    );
    assert.equal(poses.size, MASCOT_STATES.length);
    const joined = (state: (typeof MASCOT_STATES)[number]) =>
      paintMascotAppearance(mascotPresentation(state, true).rows, appearance).join("");
    assert.ok(joined("idle").includes("o"));
    assert.ok(joined("error").includes("r"));
    assert.ok(joined("success").includes("s"));
    assert.ok(joined("thinking").includes("e"));
    assert.equal(paintMascotAppearance(mascotPresentation("working", true).rows, appearance)[2], "..oo.e.oo...");
    for (const state of MASCOT_STATES) {
      for (const row of paintMascotAppearance(mascotPresentation(state, true).rows, appearance)) {
        for (const pixel of row) assert.ok(known.has(pixel), pixel);
      }
    }
  }

  assert.equal(mascotPresentation("idle", true).animate, false);
  assert.equal(mascotPresentation("idle", false).animate, false);
  assert.deepEqual(
    paintMascotAppearance(mascotPresentation("idle", true).rows, "siamese"),
    paintMascotAppearance(mascotPresentation("idle", false).rows, "siamese"),
  );
});

test("appearance and accent stay on the main cat, the settings preview, and card color", () => {
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const pixels = readFileSync(new URL("./pixel-mascot.tsx", import.meta.url), "utf8");
  const mascot = readFileSync(new URL("./mascot.ts", import.meta.url), "utf8");
  const section = (start: string, end: string) => {
    const from = app.indexOf(start);
    const to = app.indexOf(end, from + start.length);
    assert.ok(from !== -1 && to !== -1, start);
    return app.slice(from, to);
  };
  const main = "<PixelMascot activity={{ connection: state, messages }} appearance={appearance} accent={accent} />";
  const preview = '<PixelMascot activity={{ connection: "idle", messages: [] }} appearance={id} accent={accent} />';
  const agents = section('screen === "agents"', 'screen === "account"');
  const settings = section('screen === "settings"', 'screen === "workspace"');
  const workspace = section('screen === "workspace"', 'screen === "privacy"');
  const messages = section("renderItem={({ item }) => (", 'screen === "chat" ? <View style={styles.composerDock}>');
  const composer = section("styles.composerDock", "function PrivacyPanel");
  const bubble = section("function MessageBubble", "function SubagentStatusCard");
  const taskCard = section("function SubagentStatusCard", "function BrowserTimelineView");

  assert.match(app, /accessibilityRole="radiogroup" accessibilityLabel="Accent"/);
  assert.match(app, /accessibilityRole="radiogroup" accessibilityLabel="Appearance"/);
  assert.match(app, /identityFromChoice\(raw, identity\.mode, identity\)/);
  assert.match(app, /<NameField value=\{name\}/);
  assert.deepEqual(app.match(/<PixelMascot [^/\n]*\/>/g), [main, preview, main, main]);
  assert.equal(agents.includes(main), true);
  assert.equal(settings.includes(preview), true);
  assert.match(workspace, /accessibilityRole="header">Workspace<\/Text>\s*<PixelMascot activity=\{\{ connection: state, messages \}\} appearance=\{appearance\} accent=\{accent\} \/>/);
  assert.match(workspace, /navigationCard, \{ borderColor: accent \}/);
  assert.equal(workspace.slice(workspace.indexOf("navigationCard")).includes("PixelMascot"), false);
  assert.equal(composer.includes(main), true);
  for (const region of [agents, settings, workspace, composer]) {
    assert.equal((region.match(/<PixelMascot /g) ?? []).length, 1);
  }
  assert.equal(messages.includes("PixelMascot"), false);
  assert.equal(bubble.includes("PixelMascot"), false);
  assert.equal(taskCard.includes("PixelMascot"), false);
  assert.match(taskCard, /borderColor: accent/);
  assert.equal(app.includes("mascotActivityForCard"), false);
  assert.equal(mascot.includes("mascotActivityForCard"), false);
  assert.match(pixels, /o: accent/);
  assert.equal(app.includes("ImagePicker"), false);
  assert.equal(pixels.includes("Animated"), false);
  assert.equal(app.includes("Animated"), false);
});
