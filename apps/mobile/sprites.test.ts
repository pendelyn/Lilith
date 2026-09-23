import assert from "node:assert/strict";
import { test } from "node:test";
import { CAT_SPRITE, GRID_SPRITE, SEND_SPRITE, SPARK_SPRITE, spriteSize } from "./sprites.ts";

test("sprites are rectangular and only use lit or empty cells", () => {
  for (const sprite of [GRID_SPRITE, SPARK_SPRITE, SEND_SPRITE, CAT_SPRITE]) {
    const { width, height } = spriteSize(sprite);
    assert.ok(width > 0 && height > 0);
    assert.ok(sprite.every((row) => /^[#.]+$/.test(row)));
  }
  assert.deepEqual(spriteSize(GRID_SPRITE), { width: 5, height: 5 });
  assert.throws(() => spriteSize(["##", "#"]), /ragged/);
});
