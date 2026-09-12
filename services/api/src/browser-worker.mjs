import { readFile, writeFile } from "node:fs/promises";
import { posix } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");

const SESSION = "/workspace/.lilith-browser/session.json";
const RESULT = "/workspace/.lilith-browser/result.json";
const SHOT = "/workspace/.lilith-browser/shot.jpg";
const READY = "/workspace/.lilith-browser/ready";
const INBOX = "/workspace/.lilith-net/inbox";
const REPLY = "/workspace/.lilith-net/reply";
const BODY = "/workspace/.lilith-net/body";
const ALLOWED_FILE = "/workspace/cookie.html";
const COOKIE_DIALOG_LOCATOR =
  '[role="dialog"], [role="alertdialog"], [id*="cookie" i], [class*="cookie" i]';

let seq = 0;

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

function workspaceFilePath(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "file:") return undefined;
  if (url.hostname !== "" && url.hostname !== "localhost") return undefined;
  const path = decodeURIComponent(url.pathname);
  if (!path.startsWith("/")) return undefined;
  const normalized = posix.normalize(path);
  if (normalized !== ALLOWED_FILE) return undefined;
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

async function handleRoute(route) {
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
    if (workspaceFilePath(request.url()) === undefined) {
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

async function runOp(page, op, policy) {
  if (op.op === "open") {
    await page.goto(op.url, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await writeFile(READY, "page-ready\n");
    return { op: "open", url: page.url() };
  }
  if (op.op === "dismissCookies") {
    return { op: "dismissCookies", ...(await dismissCookies(page, policy)) };
  }
  if (op.op === "read") {
    const text = ((await page.locator("body").innerText()) ?? "").slice(0, 256 * 1024);
    return { op: "read", text };
  }
  if (op.op === "find") {
    const text = (await page.locator("body").innerText()) ?? "";
    return { op: "find", text: op.text, found: text.includes(op.text) };
  }
  if (op.op === "scroll") {
    const dy = Number(op.dy) || 800;
    await page.evaluate((delta) => window.scrollBy(0, delta), dy);
    const scrollY = await page.evaluate(() => window.scrollY);
    return { op: "scroll", scrollY };
  }
  if (op.op === "screenshot") {
    const bytes = await page.screenshot({ type: "jpeg", quality: 40, fullPage: false });
    await writeFile(SHOT, bytes);
    return { op: "screenshot", file: SHOT, bytes: bytes.length };
  }
  if (op.op === "hang") {
    await new Promise(() => {});
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
    await context.route("**/*", handleRoute);
    const page = await context.newPage();
    const results = [];
    for (const op of session.ops ?? []) {
      results.push(await runOp(page, op, session.cookie));
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
