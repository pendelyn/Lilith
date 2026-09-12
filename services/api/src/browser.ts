import { createRequire } from "node:module";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { ApprovalAction, SubagentCard } from "@lilith/contracts";
import { parsePublicHttpsUrl } from "./ssrf.ts";
import {
  ALLOWED_WORKSPACE_FILES,
  COOKIE_ACCEPT_RE,
  COOKIE_BARE_OK_RE,
  COOKIE_DIALOG_LOCATOR,
  COOKIE_FIXTURE_FILE,
  COOKIE_HAS_RE,
  COOKIE_NEED_RE,
} from "./browser-policy.ts";
import {
  closeHostProtocol,
  HOST_BODY_CONTAINER_PATH,
  openHostProtocol,
  readHostFd,
  removeTreeNoFollow,
  writeHostFd,
  type HostProtocol,
} from "./browser-hostfs.ts";
import { putArtifact, type RetentionStore } from "./retention.ts";
import {
  dockerArgs,
  RUNNER_WORKSPACES_ROOT,
  runIsolatedJob,
  type IsolatedJob,
} from "./runner.ts";
import {
  createParentTask,
  openApproval,
  researchAbortSignal,
  setTaskState,
  startSubagent,
  startTool,
  subagentCard,
  type TaskStore,
} from "./tasks.ts";
import type { OwnerContext } from "./auth.ts";
import {
  fetchPublicHttpsPage,
  needsDisclosureConsent,
  pinnedColorFixtureCommit,
  type WebResearchDeps,
} from "./web-research.ts";

export const BROWSER_IMAGE =
  "mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27";
// Evidence: Chromium headless_shell under the CLI 64-pid cgroup fails with
// pthread_create EAGAIN / zygote fork failure (timeout). dump-dom succeeded at
// 128 pids. Node + playwright-core + Chromium at 128 pids hung until the 60s
// job timeout; browser jobs therefore use 256 pids. CLI jobs stay at 64.
export const BROWSER_PIDS_LIMIT = 256;
export const COOKIE_BROWSER_PROMPT = "Öffne die Cookie-Testseite";
export const COOKIE_FIND_TOKEN = "FIND-TOKEN-18";
export { COOKIE_FIXTURE_FILE };
export const COOKIE_ASSIGNMENT = "Open the cookie test page in the isolated browser.";
export const PUBLIC_OPEN_PROMPT_PREFIX = "Öffne ";
export const PUBLIC_OPEN_ASSIGNMENT = "Open one public HTTPS page in the isolated browser.";

const WORKER_FILE = fileURLToPath(new URL("./browser-worker.mjs", import.meta.url));
const COOKIE_FIXTURE = fileURLToPath(new URL("../../../fixtures/browser/cookie.html", import.meta.url));
const require = createRequire(import.meta.url);
const PLAYWRIGHT_CORE_ROOT = dirname(require.resolve("playwright-core/package.json"));

export type BrowserOp =
  | { op: "open"; url: string }
  | { op: "dismissCookies" }
  | { op: "read" }
  | { op: "find"; text: string }
  | { op: "scroll"; dy?: number }
  | { op: "screenshot" }
  | { op: "hang" };

export type BrowserPlan = {
  ops: BrowserOp[];
  approved: string[];
};

export type BrowserOpResult = {
  op: string;
  url?: string;
  text?: string;
  found?: boolean;
  dismissed?: boolean;
  name?: string;
  scrollY?: number;
  file?: string;
  bytes?: number;
};

export type BrowserSessionResult = {
  results: BrowserOpResult[];
  screenshotId?: string;
};

export type BrowserDriver = {
  run(plan: BrowserPlan, deps: BrowserDeps): Promise<BrowserSessionResult>;
};

export type BrowserDeps = WebResearchDeps & {
  driver?: BrowserDriver;
  retention?: RetentionStore;
  owner?: OwnerContext;
};

export function isApprovedBrowserFetch(raw: string, approved: readonly string[]): boolean {
  try {
    const href = parsePublicHttpsUrl(raw).href;
    return approved.some((item) => parsePublicHttpsUrl(item).href === href);
  } catch {
    return false;
  }
}

export function isCookieBrowserPrompt(message: string): boolean {
  return message.trim() === COOKIE_BROWSER_PROMPT;
}

export function parsePublicOpenPrompt(message: string): string | undefined {
  const match = /^Öffne (https:\/\/\S+)$/.exec(message.trim());
  return match?.[1];
}

export function isBrowserOpenAction(action: ApprovalAction): boolean {
  if (action.actionClass !== "data_disclosure" || !action.operation.startsWith("OPEN ")) return false;
  try {
    const parsed: unknown = JSON.parse(action.payload);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      "tool" in parsed &&
      parsed.tool === "browser" &&
      "url" in parsed &&
      typeof parsed.url === "string"
    );
  } catch {
    return false;
  }
}

export function browserDockerArgs(
  job: Pick<IsolatedJob, "workspace" | "command">,
  name: string,
): string[] {
  return dockerArgs(
    {
      ...job,
      image: BROWSER_IMAGE,
      pidsLimit: BROWSER_PIDS_LIMIT,
      containerEnv: browserContainerEnv(),
    },
    name,
  );
}

export async function runCookieBrowser(
  store: TaskStore,
  owner: OwnerContext,
  deps: BrowserDeps = {},
): Promise<{ cards: SubagentCard[]; result?: string }> {
  const parent = createParentTask(store, owner, COOKIE_BROWSER_PROMPT);
  const started = startSubagent(store, owner, {
    parentTaskId: parent.id,
    assignment: COOKIE_ASSIGNMENT,
    role: "research",
  });
  const cards = [subagentCard(started)];
  try {
    cards.push(subagentCard(setTaskState(store, owner, started.id, "working")));
    startTool(store, owner, started.id);
    const session = await runBrowserSession(
      {
        ops: [
          { op: "open", url: `file:///workspace/${COOKIE_FIXTURE_FILE}` },
          { op: "dismissCookies" },
          { op: "find", text: COOKIE_FIND_TOKEN },
          { op: "scroll", dy: 800 },
          { op: "read" },
          { op: "screenshot" },
        ],
        approved: [],
      },
      store,
      owner,
      started.id,
      deps,
    );
    const result = formatBrowserResult(session);
    cards.push(subagentCard(setTaskState(store, owner, started.id, "completed", result)));
    setTaskState(store, owner, parent.id, "completed", result);
    return { cards, result };
  } catch {
    failBrowser(store, owner, started.id, parent.id);
    const failed = store.tasks.get(started.id);
    if (failed !== undefined && failed.role === "research") cards.push(subagentCard(failed));
    return { cards };
  }
}

export async function runPublicBrowserOpen(
  store: TaskStore,
  owner: OwnerContext,
  url: string,
  deps: BrowserDeps = {},
): Promise<{ cards: SubagentCard[]; result?: string }> {
  const parent = createParentTask(store, owner, `${PUBLIC_OPEN_PROMPT_PREFIX}${url}`);
  const started = startSubagent(store, owner, {
    parentTaskId: parent.id,
    assignment: PUBLIC_OPEN_ASSIGNMENT,
    role: "research",
  });
  const cards = [subagentCard(started)];
  try {
    if (needsDisclosureConsent({ url }, pinnedColorFixtureCommit(deps))) {
      openApproval(store, owner, started.id, browserOpenAction({ url }));
      const opened = store.tasks.get(started.id);
      if (opened === undefined) throw new Error("Task not found");
      return { cards: [subagentCard(opened)] };
    }
    cards.push(subagentCard(setTaskState(store, owner, started.id, "working")));
    startTool(store, owner, started.id);
    const session = await openApprovedInBrowser(url, store, owner, started.id, deps);
    const result = formatBrowserResult(session);
    cards.push(subagentCard(setTaskState(store, owner, started.id, "completed", result)));
    setTaskState(store, owner, parent.id, "completed", result);
    return { cards, result };
  } catch {
    failBrowser(store, owner, started.id, parent.id);
    const failed = store.tasks.get(started.id);
    if (failed !== undefined && failed.role === "research") cards.push(subagentCard(failed));
    return { cards };
  }
}

export async function invokeBrowserOpen(
  action: ApprovalAction,
  _idempotencyKey: string,
  deps: BrowserDeps & { store: TaskStore; owner: OwnerContext; taskId: string },
): Promise<string> {
  const url = browserUrlFromApproval(action);
  const session = await openApprovedInBrowser(url, deps.store, deps.owner, deps.taskId, deps);
  return formatBrowserResult(session);
}

export async function runBrowserSession(
  plan: BrowserPlan,
  store: TaskStore,
  owner: OwnerContext,
  taskId: string,
  deps: BrowserDeps = {},
): Promise<BrowserSessionResult> {
  const driver = deps.driver ?? dockerBrowserDriver;
  return await driver.run(plan, {
    ...deps,
    owner,
    signal: mergeSignals(deps.signal, researchAbortSignal(store, taskId)),
  });
}

export function formatBrowserResult(session: BrowserSessionResult): string {
  const read = session.results.find((result) => result.op === "read")?.text ?? "";
  const find = session.results.find((result) => result.op === "find");
  const scroll = session.results.find((result) => result.op === "scroll");
  const cookies = session.results.find((result) => result.op === "dismissCookies");
  const lines = [
    cookies?.dismissed === true ? `Cookie dialog: ${cookies.name ?? "accepted"}` : "Cookie dialog: none",
    find !== undefined ? `Find ${find.text}: ${find.found === true ? "yes" : "no"}` : undefined,
    scroll?.scrollY !== undefined ? `ScrollY: ${scroll.scrollY}` : undefined,
    session.screenshotId === undefined ? undefined : "Screenshot stored.",
    read,
  ].filter((line): line is string => line !== undefined && line !== "");
  return lines.join("\n");
}

async function openApprovedInBrowser(
  url: string,
  store: TaskStore,
  owner: OwnerContext,
  taskId: string,
  deps: BrowserDeps,
): Promise<BrowserSessionResult> {
  const approved = parsePublicHttpsUrl(url).href;
  return await runBrowserSession(
    {
      ops: [
        { op: "open", url: approved },
        { op: "dismissCookies" },
        { op: "read" },
        { op: "screenshot" },
      ],
      approved: [approved],
    },
    store,
    owner,
    taskId,
    deps,
  );
}

function browserOpenAction(request: { url: string }, actionId: string = randomUUID()): ApprovalAction {
  const url = parsePublicHttpsUrl(request.url);
  return {
    actionId,
    actionClass: "data_disclosure",
    origin: url.origin,
    operation: `OPEN ${url.pathname}${url.search}`,
    payload: JSON.stringify({ url: url.href, tool: "browser" }),
    files: [],
    maxCostCents: 0,
  };
}

function browserUrlFromApproval(action: ApprovalAction): string {
  if (!isBrowserOpenAction(action)) throw new Error("Approval changed; request new consent");
  const parsed: unknown = JSON.parse(action.payload);
  if (typeof parsed !== "object" || parsed === null || !("url" in parsed) || typeof parsed.url !== "string") {
    throw new Error("Approval changed; request new consent");
  }
  const url = parsePublicHttpsUrl(parsed.url);
  if (url.origin !== action.origin) throw new Error("Approval changed; request new consent");
  if (action.operation !== `OPEN ${url.pathname}${url.search}`) {
    throw new Error("Approval changed; request new consent");
  }
  return url.href;
}

const dockerBrowserDriver: BrowserDriver = {
  async run(plan, deps) {
    if (deps.signal?.aborted) throw new Error("Docker job cancelled");
    await mkdir(RUNNER_WORKSPACES_ROOT, { recursive: true, mode: 0o700 });
    const workspace = await mkdtemp(join(RUNNER_WORKSPACES_ROOT, "browser-"));
    let proto: HostProtocol | undefined;
    try {
      proto = await prepareBrowserWorkspace(workspace, plan);
      const stopBroker = brokerBrowserFetches(proto, plan, deps);
      try {
        await runIsolatedJob({
          id: randomUUID(),
          workspace,
          timeoutMs: 60_000,
          command: ["node", "/workspace/.lilith-browser/worker.mjs"],
          image: BROWSER_IMAGE,
          pidsLimit: BROWSER_PIDS_LIMIT,
          containerEnv: browserContainerEnv(),
          signal: deps.signal,
        });
      } finally {
        stopBroker();
      }
      const raw = readHostFd(proto.result, 1_048_576).toString("utf8");
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || !("results" in parsed) || !Array.isArray(parsed.results)) {
        throw new Error("Browser job failed");
      }
      const session: BrowserSessionResult = { results: parsed.results as BrowserOpResult[] };
      return attachScreenshot(session, proto, deps);
    } finally {
      if (proto !== undefined) closeHostProtocol(proto);
      removeTreeNoFollow(workspace);
    }
  },
};

function brokerBrowserFetches(proto: HostProtocol, plan: BrowserPlan, deps: BrowserDeps): () => void {
  const seen = new Set<string>();
  let ticking = false;
  const timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    void tickHostInbox(proto, plan, deps, seen).finally(() => {
      ticking = false;
    });
  }, 50);
  return () => clearInterval(timer);
}

async function tickHostInbox(
  proto: HostProtocol,
  plan: BrowserPlan,
  deps: BrowserDeps,
  seen: Set<string>,
): Promise<void> {
  let message: Record<string, unknown>;
  try {
    const raw = readHostFd(proto.inbox, 65_536).toString("utf8").trim();
    if (raw === "") return;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
    message = parsed as Record<string, unknown>;
  } catch {
    return;
  }
  await handleWorkerRequest(message, proto, plan, deps, seen);
}

async function handleWorkerRequest(
  message: Record<string, unknown>,
  proto: HostProtocol,
  plan: BrowserPlan,
  deps: BrowserDeps,
  seen: Set<string>,
): Promise<void> {
  if (message.t !== "need" || typeof message.id !== "string" || typeof message.url !== "string") {
    return;
  }
  const id = message.id;
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(id) || seen.has(id)) return;
  seen.add(id);
  try {
    if (message.method !== "GET" || !isApprovedBrowserFetch(message.url, plan.approved)) {
      writeHostFd(proto.reply, `${JSON.stringify({ t: "deny", id })}\n`);
      return;
    }
    const href = parsePublicHttpsUrl(message.url).href;
    const page = await fetchPublicHttpsPage({ url: href }, deps);
    writeHostFd(proto.body, page.text);
    writeHostFd(
      proto.reply,
      `${JSON.stringify({
        t: "ok",
        id,
        status: 200,
        contentType: page.headers["content-type"] ?? "text/html; charset=utf-8",
        file: HOST_BODY_CONTAINER_PATH,
      })}\n`,
    );
  } catch {
    writeHostFd(proto.reply, `${JSON.stringify({ t: "deny", id })}\n`);
  }
}

async function prepareBrowserWorkspace(workspace: string, plan: BrowserPlan): Promise<HostProtocol> {
  const root = join(workspace, ".lilith-browser");
  await mkdir(join(workspace, ".lilith-net"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, "node_modules"), { recursive: true, mode: 0o700 });
  await cp(WORKER_FILE, join(root, "worker.mjs"));
  await cp(COOKIE_FIXTURE, join(workspace, COOKIE_FIXTURE_FILE));
  await cp(PLAYWRIGHT_CORE_ROOT, join(root, "node_modules", "playwright-core"), {
    recursive: true,
    filter: (source) => !source.includes(".local-browsers"),
  });
  await writeFile(
    join(root, "session.json"),
    `${JSON.stringify({
      ops: plan.ops,
      approved: plan.approved,
      allowedFiles: ALLOWED_WORKSPACE_FILES,
      cookie: {
        locator: COOKIE_DIALOG_LOCATOR,
        has: COOKIE_HAS_RE,
        need: COOKIE_NEED_RE,
        accept: COOKIE_ACCEPT_RE,
        bareOk: COOKIE_BARE_OK_RE,
      },
    })}\n`,
    { mode: 0o600 },
  );
  return openHostProtocol(workspace);
}

function attachScreenshot(
  session: BrowserSessionResult,
  proto: HostProtocol,
  deps: BrowserDeps,
): BrowserSessionResult {
  if (deps.retention === undefined || deps.owner === undefined) return session;
  if (!session.results.some((result) => result.op === "screenshot")) return session;
  try {
    const bytes = readHostFd(proto.shot, 1_048_576);
    if (bytes.byteLength === 0) return session;
    const record = putArtifact(deps.retention, deps.owner, { kind: "screenshot", body: bytes });
    return { ...session, screenshotId: record.id };
  } catch {
    return session;
  }
}

function browserContainerEnv(): Record<string, string> {
  return {
    HOME: "/tmp",
    XDG_CONFIG_HOME: "/tmp",
    XDG_CACHE_HOME: "/tmp",
    NODE_PATH: "/workspace/.lilith-browser/node_modules",
    PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright",
  };
}

function mergeSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const live = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (live.length === 0) return undefined;
  if (live.length === 1) return live[0];
  return AbortSignal.any(live);
}

function failBrowser(store: TaskStore, owner: OwnerContext, childId: string, parentId: string): void {
  for (const id of [childId, parentId]) {
    try {
      const task = store.tasks.get(id);
      if (task !== undefined && (task.state === "waiting" || task.state === "working" || task.state === "needs_input")) {
        setTaskState(store, owner, id, "failed");
      }
    } catch {
      // already stopped or sealed
    }
  }
}
