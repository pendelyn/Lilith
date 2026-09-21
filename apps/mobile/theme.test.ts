import assert from "node:assert/strict";
import { test } from "node:test";
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
