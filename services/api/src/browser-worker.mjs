import { readFile, writeFile } from "node:fs/promises";
import { posix } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");

const SESSION = "/workspace/.lilith-browser/session.json";
const RESULT = "/workspace/.lilith-browser/result.json";
const SHOT = "/workspace/.lilith-browser/shot.jpg";
const READY = "/workspace/.lilith-browser/ready";
const PROGRESS = "/workspace/.lilith-browser/progress";
const PROGRESS_ACK = "/workspace/.lilith-browser/progress-ack";
const INBOX = "/workspace/.lilith-net/inbox";
const REPLY = "/workspace/.lilith-net/reply";
const BODY = "/workspace/.lilith-net/body";
const COOKIE_DIALOG_LOCATOR =
  '[role="dialog"], [role="alertdialog"], [id*="cookie" i], [class*="cookie" i]';
const MASKED_INPUT_VALUE = "••••••••";

let seq = 0;
let stepSeq = 0;
let shots = 0;
let captureBusy = false;

async function askHost(url, method) {
  const id = String(++seq);
  await writeFile(INBOX, `${JSON.stringify({ t: "need", id, url, method })}\n`);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const parsed = JSON.parse(await readFile(REPLY, "utf8"));
      if (parsed && parsed.id === id) return parsed;
    } catch {
      // reply not ready or torn by a host rewrite
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { t: "deny", id };
}

function workspaceFilePath(raw, allowed) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "file:") return undefined;
  if (url.username || url.password) return undefined;
  if (url.hostname !== "" && url.hostname !== "localhost") return undefined;
  const path = decodeURIComponent(url.pathname);
  if (!path.startsWith("/")) return undefined;
  const normalized = posix.normalize(path);
  const files = Array.isArray(allowed) ? allowed : [];
  if (!files.includes(normalized)) return undefined;
  return normalized;
}

function isCookieDialogText(text, policy) {
  return new RegExp(policy.has, "i").test(text) && new RegExp(policy.need, "i").test(text);
}

function pickCookieAccept(buttons, policy) {
  const acceptRe = new RegExp(policy.accept, "i");
  const okRe = new RegExp(policy.bareOk, "i");
  let okFallback;
  for (const button of buttons) {
    if (acceptRe.test(button.name.trim())) return button;
    if (okFallback === undefined && okRe.test(button.name.trim())) okFallback = button;
  }
  return okFallback;
}

async function dismissCookies(page, policy) {
  const locator =
    typeof policy.locator === "string" && policy.locator === COOKIE_DIALOG_LOCATOR
      ? policy.locator
      : COOKIE_DIALOG_LOCATOR;
  const containers = page.locator(locator);
  const count = await containers.count();
  const buttons = [];
  for (let i = 0; i < count; i += 1) {
    const container = containers.nth(i);
    if (!(await container.isVisible())) continue;
    const label = `${(await container.innerText().catch(() => "")) ?? ""} ${
      (await container.getAttribute("aria-label")) ?? ""
    }`;
    if (!isCookieDialogText(label, policy)) continue;
    const found = container.locator("button, [role='button'], input[type='button'], input[type='submit']");
    const n = await found.count();
    for (let j = 0; j < n; j += 1) {
      const locatorBtn = found.nth(j);
      if (!(await locatorBtn.isVisible())) continue;
      const name = (
        (await locatorBtn.innerText().catch(() => "")) ||
        (await locatorBtn.getAttribute("value")) ||
        ""
      ).trim();
      buttons.push({ name, locator: locatorBtn });
    }
  }
  const chosen = pickCookieAccept(buttons, policy);
  if (chosen === undefined) return { dismissed: false };
  await chosen.locator.click();
  return { dismissed: true, name: chosen.name };
}

function sanitizeUrl(raw, session) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol === "file:") {
    const path = workspaceFilePath(raw, session.allowedFiles);
    return path === undefined ? undefined : `file://${path}`;
  }
  if (url.protocol !== "https:") return undefined;
  url.username = "";
  url.password = "";
  if (url.port !== "" && url.port !== "443") return undefined;
  const keys = Array.isArray(session.sensitive?.queryKeys) ? session.sensitive.queryKeys : [];
  for (const key of [...url.searchParams.keys()]) {
    if (keys.includes(key.toLowerCase())) url.searchParams.set(key, "[redacted]");
  }
  if (url.hash !== "") {
    try {
      const params = new URLSearchParams(url.hash.slice(1));
      let changed = false;
      for (const key of [...params.keys()]) {
        if (keys.includes(key.toLowerCase())) {
          params.set(key, "[redacted]");
          changed = true;
        }
      }
      if (changed) url.hash = params.toString();
    } catch {
      url.hash = "";
    }
  }
  return `${url.origin}${url.pathname}${url.search}${url.hash}`.slice(0, 500);
}

async function projectSafePage(page, session) {
  const selector =
    typeof session.sensitive?.inputSelector === "string" && session.sensitive.inputSelector !== ""
      ? session.sensitive.inputSelector
      : 'input[type="password"]';
  const pixelSelector =
    typeof session.sensitive?.pixelSelector === "string" && session.sensitive.pixelSelector !== ""
      ? session.sensitive.pixelSelector
      : "canvas, video, iframe";
  return page.evaluate(
    ({ selector: sel, pixelSelector: pixels, masked }) => {
      let maskedFields = 0;
      let coveredSurfaces = 0;
      const projected = [];
      for (const el of document.querySelectorAll(sel)) {
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          const original = el.value;
          const originalTitle = el.getAttribute("title") ?? "";
          const originalAria = el.getAttribute("aria-label") ?? "";
          if (original !== "") {
            el.value = masked;
            maskedFields += 1;
          }
          el.setAttribute("value", el.value === "" ? "" : masked);
          if (originalTitle !== "" && originalTitle === original) el.setAttribute("title", masked);
          if (originalAria !== "" && originalAria === original) el.setAttribute("aria-label", masked);
          projected.push({
            name: el.name,
            autocomplete: el.getAttribute("autocomplete") ?? "",
            value: el.value,
            title: el.getAttribute("title") ?? "",
            ariaLabel: el.getAttribute("aria-label") ?? "",
          });
        }
      }
      for (const el of document.querySelectorAll(pixels)) {
        if (el instanceof HTMLElement) {
          el.style.visibility = "hidden";
          coveredSurfaces += 1;
        }
      }
      return { maskedFields, coveredSurfaces, projected };
    },
    { selector, pixelSelector, masked: MASKED_INPUT_VALUE },
  );
}

async function reportStep(page, session, op, shot) {
  const seqNo = ++stepSeq;
  const url = sanitizeUrl(page.url(), session);
  await writeFile(PROGRESS, `${JSON.stringify({ t: "step", seq: seqNo, op, url, shot })}\n`);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const ack = JSON.parse(await readFile(PROGRESS_ACK, "utf8"));
      if (ack && ack.seq === seqNo) return;
    } catch {
      // ack not ready or torn by a host rewrite
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function captureStep(page, session, op) {
  const maxShots = Number(session.maxShots) > 0 ? Number(session.maxShots) : 12;
  captureBusy = true;
  try {
    const projection = await projectSafePage(page, session);
    let shot = false;
    if (shots < maxShots) {
      const bytes = await page.screenshot({ type: "jpeg", quality: 40, fullPage: false });
      await writeFile(SHOT, bytes);
      shots += 1;
      shot = true;
    }
    await reportStep(page, session, op, shot);
    return { ...projection, shot };
  } finally {
    captureBusy = false;
  }
}

async function handleRoute(route, session) {
  const request = route.request();
  const method = request.method();
  if (method !== "GET") {
    await route.abort("blockedbyclient");
    return;
  }
  let parsed;
  try {
    parsed = new URL(request.url());
  } catch {
    await route.abort("blockedbyclient");
    return;
  }
  if (parsed.protocol === "about:" || parsed.protocol === "data:" || parsed.protocol === "blob:") {
    await route.continue();
    return;
  }
  if (parsed.protocol === "file:") {
    if (workspaceFilePath(request.url(), session.allowedFiles) === undefined) {
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
    return;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || (parsed.port !== "" && parsed.port !== "443")) {
    await route.abort("blockedbyclient");
    return;
  }
  const reply = await askHost(parsed.href, method);
  if (reply?.t !== "ok" || reply.file !== BODY) {
    await route.abort("blockedbyclient");
    return;
  }
  const body = await readFile(BODY);
  await route.fulfill({
    status: Number(reply.status) || 200,
    headers: {
      "content-type": String(reply.contentType || "text/html; charset=utf-8"),
      "cache-control": "no-store",
    },
    body,
  });
}

async function runOp(page, op, session) {
  if (op.op === "open") {
    await page.goto(op.url, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await writeFile(READY, "page-ready\n");
    const capture = await captureStep(page, session, "open");
    return { op: "open", url: sanitizeUrl(page.url(), session), maskedFields: capture.maskedFields, coveredSurfaces: capture.coveredSurfaces, projected: capture.projected };
  }
  if (op.op === "dismissCookies") {
    const dismissed = await dismissCookies(page, session.cookie);
    const capture = await captureStep(page, session, "dismissCookies");
    return { op: "dismissCookies", ...dismissed, maskedFields: capture.maskedFields, coveredSurfaces: capture.coveredSurfaces, projected: capture.projected };
  }
  if (op.op === "read") {
    const capture = await captureStep(page, session, "read");
    const text = ((await page.locator("body").innerText()) ?? "").slice(0, 256 * 1024);
    return { op: "read", text, maskedFields: capture.maskedFields, coveredSurfaces: capture.coveredSurfaces, projected: capture.projected };
  }
  if (op.op === "find") {
    const capture = await captureStep(page, session, "find");
    const text = (await page.locator("body").innerText()) ?? "";
    return { op: "find", text: op.text, found: text.includes(op.text), maskedFields: capture.maskedFields, coveredSurfaces: capture.coveredSurfaces };
  }
  if (op.op === "scroll") {
    const dy = Number(op.dy) || 800;
    await page.evaluate((delta) => window.scrollBy(0, delta), dy);
    const scrollY = await page.evaluate(() => window.scrollY);
    const capture = await captureStep(page, session, "scroll");
    return { op: "scroll", scrollY, maskedFields: capture.maskedFields, coveredSurfaces: capture.coveredSurfaces };
  }
  if (op.op === "screenshot") {
    const capture = await captureStep(page, session, "screenshot");
    return { op: "screenshot", file: SHOT, bytes: 0, maskedFields: capture.maskedFields, coveredSurfaces: capture.coveredSurfaces };
  }
  if (op.op === "fill") {
    if (op.selector !== "#note" || typeof op.value !== "string" || op.value.length > 200) {
      throw new Error("Unsupported browser op");
    }
    const handle = page.locator("#note");
    const kind = await handle.evaluate((el) => (el instanceof HTMLInputElement ? el.type : ""));
    if (kind !== "text") throw new Error("Unsupported browser op");
    await handle.fill(op.value);
    return { op: "fill", text: await handle.inputValue() };
  }
  if (op.op === "snapshot") {
    const nodes = await page.evaluate(() => {
      const found = [];
      for (const el of document.querySelectorAll("input, button, textarea")) {
        const tag = el.tagName.toLowerCase();
        found.push({
          id: el.id,
          tag,
          type: (el.getAttribute("type") ?? "").toLowerCase(),
          name: el.getAttribute("name") ?? "",
          label: el.getAttribute("aria-label") ?? "",
          value: el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : "",
          action: el.getAttribute("data-action") ?? "",
        });
      }
      return found;
    });
    return { op: "snapshot", nodes };
  }
  if (op.op === "effect" || op.op === "submit" || op.op === "upload" || op.op === "message" || op.op === "purchase" || op.op === "click") {
    throw new Error("Outward browser action requires approval");
  }
  if (op.op === "hang") {
    const heartbeatMs = Number(session.heartbeatMs) > 0 ? Number(session.heartbeatMs) : 2_000;
    const heartbeat = setInterval(() => {
      if (captureBusy) return;
      void captureStep(page, session, "screenshot").catch(() => {
        // hang aborted or page closed
      });
    }, heartbeatMs);
    try {
      await new Promise(() => {});
    } finally {
      clearInterval(heartbeat);
    }
  }
  throw new Error("Unsupported browser op");
}

async function main() {
  const session = JSON.parse(await readFile(SESSION, "utf8"));
  const browser = await chromium.launch({
    headless: true,
    chromiumSandbox: false,
    executablePath:
      "/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell",
    args: [
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-crash-reporter",
      "--disable-breakpad",
      "--no-first-run",
      "--mute-audio",
    ],
  });
  try {
    const context = await browser.newContext({
      acceptDownloads: false,
      serviceWorkers: "block",
      javaScriptEnabled: true,
      viewport: { width: 800, height: 600 },
    });
    if (typeof context.routeWebSocket === "function") {
      await context.routeWebSocket(/.*/, (ws) => ws.close());
    }
    await context.route("**/*", (route) => handleRoute(route, session));
    const page = await context.newPage();
    const results = [];
    for (const op of session.ops ?? []) {
      results.push(await runOp(page, op, session));
    }
    await writeFile(RESULT, `${JSON.stringify({ results })}\n`);
  } finally {
    await browser.close();
  }
}

main().catch(async () => {
  try {
    await writeFile(RESULT, `${JSON.stringify({ error: "Browser job failed" })}\n`);
  } catch {
    // result path may be missing if workspace is gone
  }
  process.exit(1);
});
