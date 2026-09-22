import assert from "node:assert/strict";
import { test } from "node:test";
import { SCREENSHOT_TTL_MS } from "@lilith/contracts";
import {
  jpegBytesToDataUri,
  nextScreenshotExpiryDelayMs,
  persistedChatHasScreenshotBytes,
  pruneShotCache,
  rememberShot,
  screenshotExpired,
  shouldFetchScreenshot,
  shotStillVisible,
} from "./screenshots.ts";

test("screenshot cache never keeps bytes past TTL and never stores token URLs", () => {
  const now = 1_000;
  const createdAt = now;
  assert.equal(screenshotExpired(createdAt, now), false);
  assert.equal(screenshotExpired(createdAt, now + SCREENSHOT_TTL_MS), true);
  assert.equal(shouldFetchScreenshot({ screenshotId: "shot", at: createdAt }, now), true);
  assert.equal(shouldFetchScreenshot({ screenshotId: "shot", at: createdAt }, now + SCREENSHOT_TTL_MS), false);
  assert.equal(shouldFetchScreenshot({ at: createdAt }, now), false);

  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
  const uri = jpegBytesToDataUri(jpeg);
  assert.equal(uri, `data:image/jpeg;base64,${Buffer.from(jpeg).toString("base64")}`);
  assert.equal(uri.includes("token="), false);
  const large = new Uint8Array(20_000);
  large[0] = 0xff;
  large[1] = 0xd8;
  const largeUri = jpegBytesToDataUri(large);
  assert.equal(largeUri.startsWith("data:image/jpeg;base64,"), true);
  assert.equal(largeUri.slice(23), Buffer.from(large).toString("base64"));
  assert.throws(() => jpegBytesToDataUri(Uint8Array.from([0x00, 0x01])));

  let cache = rememberShot({}, "shot", uri, createdAt, now);
  assert.equal(cache.shot?.uri, uri);
  cache = rememberShot(cache, "leaky", "http://127.0.0.1/screenshots/x?token=secret", createdAt, now);
  assert.equal("leaky" in cache, false);
  cache = pruneShotCache(cache, now + SCREENSHOT_TTL_MS);
  assert.deepEqual(cache, {});
  assert.equal(shotStillVisible({ uri, expiresAt: createdAt + SCREENSHOT_TTL_MS }, createdAt, now), true);
  assert.equal(shotStillVisible({ uri, expiresAt: createdAt + SCREENSHOT_TTL_MS }, createdAt, now + SCREENSHOT_TTL_MS), false);
  assert.equal(shotStillVisible(undefined, createdAt, now), false);
  assert.equal(persistedChatHasScreenshotBytes(JSON.stringify({ browser: { screenshotId: "shot" } })), false);
  assert.equal(persistedChatHasScreenshotBytes('{"uri":"data:image/jpeg;base64,abc"}'), true);
});

test("nearest screenshot expiry is one-shot and a late load cannot restore bytes", () => {
  const now = 8_000;
  const soonAt = now;
  const laterAt = now + 25_000;
  const uri = "data:image/jpeg;base64,abc";
  const steps = [
    { screenshotId: "soon", at: soonAt },
    { screenshotId: "later", at: laterAt },
    { at: now },
  ];
  let cache = rememberShot({}, "soon", uri, soonAt, now);
  cache = rememberShot(cache, "later", uri, laterAt, now);

  assert.equal(nextScreenshotExpiryDelayMs([], {}, now), undefined);
  assert.equal(nextScreenshotExpiryDelayMs(steps, {}, soonAt + SCREENSHOT_TTL_MS), 25_000);
  assert.equal(
    nextScreenshotExpiryDelayMs([{ screenshotId: "soon", at: soonAt }], { soon: cache.soon! }, soonAt + SCREENSHOT_TTL_MS),
    undefined,
  );
  assert.equal(nextScreenshotExpiryDelayMs(steps, cache, now), SCREENSHOT_TTL_MS);
  assert.equal(nextScreenshotExpiryDelayMs(steps, cache, soonAt + SCREENSHOT_TTL_MS - 1), 1);

  let clock = now;
  const fired: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    const delay = nextScreenshotExpiryDelayMs(steps, cache, clock);
    if (delay === undefined) break;
    fired.push(delay);
    clock += delay;
    cache = pruneShotCache(cache, clock);
    cache = rememberShot(cache, "soon", uri, soonAt, clock);
    cache = rememberShot(cache, "later", uri, laterAt, clock);
  }
  assert.deepEqual(fired, [SCREENSHOT_TTL_MS, 25_000]);
  assert.equal(cache.soon, undefined);
  assert.equal(cache.later, undefined);
  assert.equal(shotStillVisible(cache.soon, soonAt, clock), false);
  assert.equal(nextScreenshotExpiryDelayMs(steps, cache, clock), undefined);
});
