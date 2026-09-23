import { createRequire } from "node:module";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { ApprovalAction, SubagentCard, BrowserStep } from "@lilith/contracts";
import { parseBrowserStepOp } from "@lilith/contracts";
import { parsePublicHttpsUrl, pinnedHttpsGet, resolvePublicHttps } from "./ssrf.ts";
import {
  ALLOWED_WORKSPACE_FILES,
  BROWSER_EFFECTS,
  COOKIE_ACCEPT_RE,
  COOKIE_BARE_OK_RE,
  COOKIE_DIALOG_LOCATOR,
  COOKIE_FIXTURE_FILE,
  COOKIE_HAS_RE,
  COOKIE_NEED_RE,
  FORM_FIXTURE_FILE,
  FORM_FIXTURE_WORKSPACE_PATH,
  FORM_NOTE_ID,
  SENSITIVE_FIXTURE_FILE,
  SENSITIVE_INPUT_SELECTOR,
  SENSITIVE_QUERY_KEYS,
  UNSAFE_PIXEL_SELECTOR,
  assertPublicUrlProjection,
  formControlsFromNodes,
  formDomDigest,
  sanitizeBrowserUrl,
  type BrowserEffect,
  type FormControlSnapshot,
  type RawFormNode,
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
import { putArtifact, isJpeg, type RetentionStore } from "./retention.ts";
import { toolAllowed, type ToolAllowStore } from "./tool-allow.ts";
import {
  dockerArgs,
  RUNNER_WORKSPACES_ROOT,
  runIsolatedJob,
  type IsolatedJob,
} from "./runner.ts";
import {
  createParentTask,
  openApproval,
  recordBrowserStep,
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
export const FORM_PREVIEW_PROMPT_PREFIX = "Bereite den Formulartext vor: ";
export const FORM_SUBMIT_PROMPT_PREFIX = "Sende das Formular: ";
export const FORM_UPLOAD_PROMPT_PREFIX = "Lade die Formulardatei hoch: ";
export const FORM_MESSAGE_PROMPT_PREFIX = "Sende die Formularnachricht: ";
export const FORM_PURCHASE_PROMPT_PREFIX = "Kaufe im Formular: ";
export const FORM_AMBIGUOUS_PROMPT_PREFIX = "Klicke unklar im Formular: ";
export const FORM_PREVIEW_ASSIGNMENT = "Prepare form text as a preview.";
export const FORM_EFFECT_ASSIGNMENT = "Wait for one-time approval before a browser action with external effect.";
export const FORM_VALUE_MAX = 200;
export const FORM_UPLOAD_PATH = "upload.txt";
const FORM_FILE_URL = `file://${FORM_FIXTURE_WORKSPACE_PATH}`;
const FORM_PROMPT_KINDS = [
  [FORM_PREVIEW_PROMPT_PREFIX, "preview"],
  [FORM_SUBMIT_PROMPT_PREFIX, "submit"],
  [FORM_UPLOAD_PROMPT_PREFIX, "upload"],
  [FORM_MESSAGE_PROMPT_PREFIX, "message"],
  [FORM_PURCHASE_PROMPT_PREFIX, "purchase"],
  [FORM_AMBIGUOUS_PROMPT_PREFIX, "ambiguous"],
] as const;
const OUTWARD_BROWSER_OPS = new Set(["effect", "submit", "upload", "message", "purchase", "click"]);

const WORKER_FILE = fileURLToPath(new URL("./browser-worker.mjs", import.meta.url));
const COOKIE_FIXTURE = fileURLToPath(new URL("../../../fixtures/browser/cookie.html", import.meta.url));
const SENSITIVE_FIXTURE = fileURLToPath(new URL("../../../fixtures/browser/sensitive.html", import.meta.url));
const FORM_FIXTURE = fileURLToPath(new URL("../../../fixtures/browser/form.html", import.meta.url));
const require = createRequire(import.meta.url);
const PLAYWRIGHT_CORE_ROOT = dirname(require.resolve("playwright-core/package.json"));
export const MAX_BROWSER_SHOTS_PER_JOB = 12;
export const BROWSER_HEARTBEAT_MS = 2_000;

export type BrowserOp =
  | { op: "open"; url: string }
  | { op: "dismissCookies" }
  | { op: "read" }
  | { op: "find"; text: string }
  | { op: "scroll"; dy?: number }
  | { op: "screenshot" }
  | { op: "hang" }
  | { op: "fill"; selector: "#note"; value: string }
  | { op: "snapshot" };

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
  maskedFields?: number;
  coveredSurfaces?: number;
  projected?: { name: string; autocomplete: string; value: string; title: string; ariaLabel: string }[];
  nodes?: RawFormNode[];
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
  toolAllow?: ToolAllowStore;
  onStep?: (step: BrowserStep) => void;
  onCard?: (card: SubagentCard) => void;
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
  const cards: SubagentCard[] = [];
  const emit = (card: SubagentCard): SubagentCard => {
    cards.push(card);
    deps.onCard?.(card);
    return card;
  };
  emit(subagentCard(started));
  try {
    emit(subagentCard(setTaskState(store, owner, started.id, "working")));
    startTool(store, owner, started.id);
    const session = await runBrowserSession(
      {
        ops: [
          { op: "open", url: `file:///workspace/${COOKIE_FIXTURE_FILE}` },
          { op: "dismissCookies" },
          { op: "find", text: COOKIE_FIND_TOKEN },
          { op: "scroll", dy: 800 },
          { op: "read" },
        ],
        approved: [],
      },
      store,
      owner,
      started.id,
      { ...deps, onCard: emit },
    );
    const result = formatBrowserResult(session);
    emit(subagentCard(setTaskState(store, owner, started.id, "completed", result)));
    setTaskState(store, owner, parent.id, "completed", result);
    return { cards, result };
  } catch {
    failBrowser(store, owner, started.id, parent.id);
    const failed = store.tasks.get(started.id);
    if (failed !== undefined && failed.role === "research") emit(subagentCard(failed));
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
  const cards: SubagentCard[] = [];
  const emit = (card: SubagentCard): SubagentCard => {
    cards.push(card);
    deps.onCard?.(card);
    return card;
  };
  try {
    if (needsDisclosureConsent({ url }, pinnedColorFixtureCommit(deps))) {
      openApproval(store, owner, started.id, browserOpenAction({ url }));
      const opened = store.tasks.get(started.id);
      if (opened === undefined) throw new Error("Task not found");
      return { cards: [emit(subagentCard(opened))] };
    }
    emit(subagentCard(started));
    emit(subagentCard(setTaskState(store, owner, started.id, "working")));
    startTool(store, owner, started.id);
    const session = await openApprovedInBrowser(url, store, owner, started.id, { ...deps, onCard: emit });
    const result = formatBrowserResult(session);
    emit(subagentCard(setTaskState(store, owner, started.id, "completed", result)));
    setTaskState(store, owner, parent.id, "completed", result);
    return { cards, result };
  } catch {
    failBrowser(store, owner, started.id, parent.id);
    const failed = store.tasks.get(started.id);
    if (failed !== undefined && failed.role === "research") emit(subagentCard(failed));
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

export type FormPrompt =
  | { kind: "preview"; value: string }
  | { kind: "effect"; effect: BrowserEffect; value: string };

export function parseFormPrompt(message: string): FormPrompt | undefined {
  const trimmed = message.trim();
  for (const [prefix, kind] of FORM_PROMPT_KINDS) {
    if (!trimmed.startsWith(prefix)) continue;
    const value = formPromptValue(trimmed.slice(prefix.length));
    if (value === undefined) return undefined;
    if (kind === "preview") return { kind: "preview", value };
    return { kind: "effect", effect: kind, value };
  }
  return undefined;
}

export function formatBrowserEffectPreview(value: string): string {
  return `Preview: ${value}`;
}

export function formatBrowserEffectExecuted(effect: BrowserEffect): string {
  return `Browser action executed once (${effect}). This cannot be undone.`;
}

export function isBrowserEffectAction(action: ApprovalAction): boolean {
  if (action.actionClass !== "external_effect") return false;
  try {
    const parsed: unknown = JSON.parse(action.payload);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      "tool" in parsed &&
      parsed.tool === "browser-effect"
    );
  } catch {
    return false;
  }
}

export function assertPlanHasNoOutwardOp(plan: BrowserPlan): void {
  for (const op of plan.ops) {
    if (OUTWARD_BROWSER_OPS.has(op.op)) throw new Error("Outward browser action requires approval");
  }
}

export async function runFormPreview(
  store: TaskStore,
  owner: OwnerContext,
  message: string,
  value: string,
  deps: BrowserDeps = {},
): Promise<{ cards: SubagentCard[]; result?: string }> {
  return runFormTask(store, owner, message, FORM_PREVIEW_ASSIGNMENT, deps, async (taskId, emit) => {
    const session = await runBrowserSession(previewPlan(value), store, owner, taskId, { ...deps, onCard: emit });
    const filled = session.results.find((result) => result.op === "fill")?.text;
    if (filled !== value) throw new Error("Browser job failed");
    return formatBrowserEffectPreview(value);
  });
}

export async function runFormEffect(
  store: TaskStore,
  owner: OwnerContext,
  message: string,
  effect: BrowserEffect,
  value: string,
  deps: BrowserDeps = {},
): Promise<{ cards: SubagentCard[]; result?: string }> {
  return runFormTask(store, owner, message, FORM_EFFECT_ASSIGNMENT, deps, async (taskId, emit) => {
    const controls = await observeForm(value, { ...deps, onCard: emit, store, owner, taskId });
    openApproval(store, owner, taskId, actionFromControls(controls, effect, value, randomUUID()));
    return undefined;
  });
}

export async function inspectBrowserEffect(
  action: ApprovalAction,
  deps: BrowserDeps & { store: TaskStore; owner: OwnerContext; taskId: string },
): Promise<ApprovalAction> {
  const bound = parseBoundEffect(action);
  const controls = await observeForm(bound.note, deps);
  return actionFromControls(controls, bound.effect, bound.note, action.actionId);
}

export async function invokeBrowserEffect(
  action: ApprovalAction,
  idempotencyKey: string,
  deps: BrowserDeps & { store: TaskStore; owner: OwnerContext; taskId: string },
): Promise<string> {
  if (idempotencyKey !== action.actionId) throw new Error("Approval changed; request new consent");
  const bound = parseBoundEffect(action);
  const signal = mergeSignals(deps.signal, researchAbortSignal(deps.store, deps.taskId));
  const live = actionFromControls(
    await observeForm(bound.note, { ...deps, signal }),
    bound.effect,
    bound.note,
    action.actionId,
  );
  if (
    live.payload !== action.payload ||
    live.operation !== action.operation ||
    live.origin !== action.origin ||
    JSON.stringify(live.files) !== JSON.stringify(action.files)
  ) {
    throw new Error("Approval changed; request new consent");
  }
  // ponytail: the outward effect is one pinned HTTPS POST, not an in-page click.
  // Chromium stays network=none, so a click cannot open a second egress path.
  // Upgrade path: gated click after this same digest check, still fulfilled only here.
  await postBoundEffect(bound, action.payload, idempotencyKey, { ...deps, signal });
  return formatBrowserEffectExecuted(bound.effect);
}

export async function runBrowserSession(
  plan: BrowserPlan,
  store: TaskStore,
  owner: OwnerContext,
  taskId: string,
  deps: BrowserDeps = {},
): Promise<BrowserSessionResult> {
  assertPlanHasNoOutwardOp(plan);
  const driver = deps.driver ?? dockerBrowserDriver;
  return await driver.run(plan, {
    ...deps,
    owner,
    signal: mergeSignals(deps.signal, researchAbortSignal(store, taskId)),
    onStep: (step) => {
      const safe = sanitizeTimelineStep(step);
      deps.onStep?.(safe);
      const recorded = recordBrowserStep(store, owner, taskId, safe);
      if (recorded.role === "research" && recorded.parentTaskId !== undefined) {
        deps.onCard?.(subagentCard(recorded));
      }
    },
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
  assertPublicUrlProjection(url.href);
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

type BoundEffect = {
  effect: BrowserEffect;
  url: string;
  domDigest: string;
  target: string;
  fields: { name: string; value: string }[];
  file?: { path: string; content: string };
  note: string;
};

async function runFormTask(
  store: TaskStore,
  owner: OwnerContext,
  message: string,
  assignment: string,
  deps: BrowserDeps,
  work: (taskId: string, emit: (card: SubagentCard) => SubagentCard) => Promise<string | undefined>,
): Promise<{ cards: SubagentCard[]; result?: string }> {
  const parent = createParentTask(store, owner, message);
  const started = startSubagent(store, owner, { parentTaskId: parent.id, assignment, role: "research" });
  const cards: SubagentCard[] = [];
  const emit = (card: SubagentCard): SubagentCard => {
    cards.push(card);
    deps.onCard?.(card);
    return card;
  };
  try {
    emit(subagentCard(started));
    emit(subagentCard(setTaskState(store, owner, started.id, "working")));
    startTool(store, owner, started.id);
    const result = await work(started.id, emit);
    if (result === undefined) {
      const opened = store.tasks.get(started.id);
      if (opened === undefined) throw new Error("Task not found");
      emit(subagentCard(opened));
      return { cards };
    }
    emit(subagentCard(setTaskState(store, owner, started.id, "completed", result)));
    setTaskState(store, owner, parent.id, "completed", result);
    return { cards, result };
  } catch {
    failBrowser(store, owner, started.id, parent.id);
    const failed = store.tasks.get(started.id);
    if (failed !== undefined && failed.role === "research") emit(subagentCard(failed));
    return { cards };
  }
}

function previewPlan(value: string): BrowserPlan {
  return {
    ops: [
      { op: "open", url: FORM_FILE_URL },
      { op: "fill", selector: "#note", value },
      { op: "read" },
    ],
    approved: [],
  };
}

async function observeForm(
  value: string,
  deps: BrowserDeps & { store: TaskStore; owner: OwnerContext; taskId: string },
): Promise<FormControlSnapshot[]> {
  const session = await runBrowserSession(
    {
      ops: [
        { op: "open", url: FORM_FILE_URL },
        { op: "fill", selector: "#note", value },
        { op: "snapshot" },
      ],
      approved: [],
    },
    deps.store,
    deps.owner,
    deps.taskId,
    deps,
  );
  const nodes = session.results.find((result) => result.op === "snapshot")?.nodes;
  if (nodes === undefined) throw new Error("Browser job failed");
  const controls = formControlsFromNodes(parseRawNodes(nodes));
  const note = controls.find((control) => control.id === FORM_NOTE_ID && control.effect === "text");
  if (note === undefined || note.name !== "note" || note.value !== value) throw new Error("Browser job failed");
  return controls;
}

function actionFromControls(
  controls: readonly FormControlSnapshot[],
  effect: BrowserEffect,
  value: string,
  actionId: string,
): ApprovalAction {
  const target = controls.find((control) => control.effect === effect);
  if (target === undefined || target.label.trim() === "") throw new Error("Approval changed; request new consent");
  let url: URL;
  try {
    url = parsePublicHttpsUrl(target.action);
    assertPublicUrlProjection(url.href);
  } catch {
    throw new Error("Approval changed; request new consent");
  }
  const fields = controls
    .filter((control) => control.effect === "text")
    .map((control) => ({ name: control.name, value: control.value }));
  if (fields.length !== 1 || fields[0]?.name !== "note" || fields[0]?.value !== value) {
    throw new Error("Approval changed; request new consent");
  }
  const file = effect === "upload" ? { path: FORM_UPLOAD_PATH, content: value } : undefined;
  return {
    actionId,
    actionClass: "external_effect",
    origin: url.origin,
    operation: `POST ${url.pathname}${url.search}`,
    payload: JSON.stringify({
      tool: "browser-effect",
      effect,
      url: url.href,
      domDigest: formDomDigest(controls),
      target: target.label,
      fields,
      ...(file === undefined ? {} : { file }),
    }),
    files: file === undefined ? [] : [file],
    maxCostCents: 0,
  };
}

function parseBoundEffect(action: ApprovalAction): BoundEffect {
  if (!isBrowserEffectAction(action)) throw new Error("Approval changed; request new consent");
  let parsed: unknown;
  try {
    parsed = JSON.parse(action.payload);
  } catch {
    throw new Error("Approval changed; request new consent");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Approval changed; request new consent");
  }
  const record = parsed as Record<string, unknown>;
  const effect = record.effect;
  if (typeof effect !== "string" || !isBrowserEffectName(effect)) throw new Error("Approval changed; request new consent");
  if (typeof record.url !== "string" || typeof record.domDigest !== "string" || !/^[a-f0-9]{64}$/.test(record.domDigest)) {
    throw new Error("Approval changed; request new consent");
  }
  if (typeof record.target !== "string" || record.target.trim() === "" || record.target.length > 200) {
    throw new Error("Approval changed; request new consent");
  }
  if (!Array.isArray(record.fields) || record.fields.length !== 1) throw new Error("Approval changed; request new consent");
  const field: unknown = record.fields[0];
  if (typeof field !== "object" || field === null || Array.isArray(field)) {
    throw new Error("Approval changed; request new consent");
  }
  const fieldRecord = field as Record<string, unknown>;
  if (
    Object.keys(fieldRecord).length !== 2 ||
    fieldRecord.name !== "note" ||
    typeof fieldRecord.value !== "string" ||
    formPromptValue(fieldRecord.value) === undefined
  ) {
    throw new Error("Approval changed; request new consent");
  }
  const note = fieldRecord.value;
  let url: URL;
  try {
    url = parsePublicHttpsUrl(record.url);
  } catch {
    throw new Error("Approval changed; request new consent");
  }
  if (url.origin !== action.origin || action.operation !== `POST ${url.pathname}${url.search}`) {
    throw new Error("Approval changed; request new consent");
  }
  const file = parseBoundFile(effect, record.file, action, note);
  const allowed = file === undefined
    ? ["tool", "effect", "url", "domDigest", "target", "fields"]
    : ["tool", "effect", "url", "domDigest", "target", "fields", "file"];
  if (Object.keys(record).length !== allowed.length || Object.keys(record).some((key) => !allowed.includes(key))) {
    throw new Error("Approval changed; request new consent");
  }
  return {
    effect,
    url: url.href,
    domDigest: record.domDigest,
    target: record.target,
    fields: [{ name: "note", value: note }],
    ...(file === undefined ? {} : { file }),
    note,
  };
}

function parseBoundFile(
  effect: BrowserEffect,
  file: unknown,
  action: ApprovalAction,
  note: string,
): { path: string; content: string } | undefined {
  if (effect !== "upload") {
    if (file !== undefined || action.files.length !== 0) throw new Error("Approval changed; request new consent");
    return undefined;
  }
  if (typeof file !== "object" || file === null || Array.isArray(file)) {
    throw new Error("Approval changed; request new consent");
  }
  const record = file as Record<string, unknown>;
  if (Object.keys(record).length !== 2 || record.path !== FORM_UPLOAD_PATH || record.content !== note) {
    throw new Error("Approval changed; request new consent");
  }
  if (action.files.length !== 1 || action.files[0]?.path !== FORM_UPLOAD_PATH || action.files[0]?.content !== note) {
    throw new Error("Approval changed; request new consent");
  }
  return { path: FORM_UPLOAD_PATH, content: note };
}

function parseRawNodes(value: RawFormNode[]): RawFormNode[] {
  if (value.length > 40) throw new Error("Browser job failed");
  return value.map((entry) => {
    const record = entry as unknown;
    if (typeof record !== "object" || record === null || Array.isArray(record)) throw new Error("Browser job failed");
    const node = record as Record<string, unknown>;
    const keys = ["id", "tag", "type", "name", "label", "value", "action"];
    if (Object.keys(node).length !== keys.length || keys.some((key) => typeof node[key] !== "string")) {
      throw new Error("Browser job failed");
    }
    return {
      id: boundedNode(node.id),
      tag: boundedNode(node.tag),
      type: boundedNode(node.type),
      name: boundedNode(node.name),
      label: boundedNode(node.label),
      value: boundedNode(node.value),
      action: boundedNode(node.action),
    };
  });
}

function boundedNode(value: unknown): string {
  if (typeof value !== "string" || value.length > 400) throw new Error("Browser job failed");
  return value;
}

async function postBoundEffect(
  bound: BoundEffect,
  payload: string,
  idempotencyKey: string,
  deps: BrowserDeps,
): Promise<void> {
  if (deps.signal?.aborted) throw new Error("Web research cancelled");
  const url = parsePublicHttpsUrl(bound.url);
  const resolved = await resolvePublicHttps(url.href, deps.lookupAll, deps.signal);
  if (deps.signal?.aborted) throw new Error("Web research cancelled");
  // Last await is above. Blank during inspect, the live DOM read, or DNS must not POST.
  assertBrowserEffectAllowed(deps);
  const get = deps.get ?? pinnedHttpsGet;
  const response = await get({
    url,
    hostname: resolved.hostname,
    addresses: resolved.addresses,
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: payload,
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
  });
  if (response.status >= 300 && response.status < 400) throw new Error("Redirect rejected");
  if (response.status !== 200) throw new Error("Fetch failed");
}

function assertBrowserEffectAllowed(deps: BrowserDeps): void {
  // Callers that are not the HTTP gate omit the store. The gate always passes it.
  if (deps.toolAllow === undefined || deps.owner === undefined) return;
  if (!toolAllowed(deps.toolAllow, deps.owner, "webResearch")) throw new Error("Web research is off");
}

function formPromptValue(raw: string): string | undefined {
  if (raw.length === 0 || raw.length > FORM_VALUE_MAX || raw !== raw.trim()) return undefined;
  if (/[\u0000-\u001F\u007F]/.test(raw)) return undefined;
  return raw;
}

function isBrowserEffectName(value: string): value is BrowserEffect {
  return (BROWSER_EFFECTS as readonly string[]).includes(value);
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
    let lastScreenshotId: string | undefined;
    try {
      proto = await prepareBrowserWorkspace(workspace, plan);
      const stopBroker = brokerBrowserFetches(proto, plan, deps, (screenshotId) => {
        lastScreenshotId = screenshotId;
      });
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
      const session: BrowserSessionResult = {
        results: parsed.results as BrowserOpResult[],
        ...(lastScreenshotId === undefined ? {} : { screenshotId: lastScreenshotId }),
      };
      return attachScreenshot(session, proto, deps);
    } finally {
      if (proto !== undefined) closeHostProtocol(proto);
      removeTreeNoFollow(workspace);
    }
  },
};

function brokerBrowserFetches(
  proto: HostProtocol,
  plan: BrowserPlan,
  deps: BrowserDeps,
  onShot: (screenshotId: string) => void,
): () => void {
  const seen = new Set<string>();
  const seenSteps = new Set<number>();
  let ticking = false;
  const timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    void tickHostInbox(proto, plan, deps, seen)
      .then(() => tickHostProgress(proto, deps, seenSteps, onShot))
      .finally(() => {
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

function tickHostProgress(
  proto: HostProtocol,
  deps: BrowserDeps,
  seen: Set<number>,
  onShot: (screenshotId: string) => void,
): void {
  if (deps.signal?.aborted) return;
  let message: Record<string, unknown>;
  try {
    const raw = readHostFd(proto.progress, 65_536).toString("utf8").trim();
    if (raw === "") return;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
    message = parsed as Record<string, unknown>;
  } catch {
    return;
  }
  if (message.t !== "step" || typeof message.seq !== "number" || !Number.isInteger(message.seq)) return;
  const seq = message.seq;
  if (seen.has(seq)) {
    try {
      writeHostFd(proto.progressAck, `${JSON.stringify({ seq })}\n`);
    } catch {
      // worker will retry
    }
    return;
  }
  seen.add(seq);
  let screenshotId: string | undefined;
  if (message.shot === true && deps.retention !== undefined && deps.owner !== undefined && deps.signal?.aborted !== true) {
    try {
      const bytes = readHostFd(proto.shot, 1_048_576);
      if (isJpeg(bytes) && bytes.byteLength > 0) {
        const record = putArtifact(deps.retention, deps.owner, { kind: "screenshot", body: bytes });
        screenshotId = record.id;
        onShot(record.id);
      }
    } catch {
      // persist failed; still ack so the worker is not stuck
    }
  }
  try {
    writeHostFd(proto.progressAck, `${JSON.stringify({ seq })}\n`);
  } catch {
    // worker will retry
  }
  if (deps.signal?.aborted) return;
  let op: BrowserStep["op"];
  try {
    op = parseBrowserStepOp(message.op);
  } catch {
    return;
  }
  const url = typeof message.url === "string" ? sanitizeBrowserUrl(message.url) : undefined;
  deps.onStep?.({
    op,
    at: Date.now(),
    ...(url === undefined ? {} : { url }),
    ...(screenshotId === undefined ? {} : { screenshotId }),
  });
}

async function prepareBrowserWorkspace(workspace: string, plan: BrowserPlan): Promise<HostProtocol> {
  const root = join(workspace, ".lilith-browser");
  await mkdir(join(workspace, ".lilith-net"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, "node_modules"), { recursive: true, mode: 0o700 });
  await cp(WORKER_FILE, join(root, "worker.mjs"));
  await cp(COOKIE_FIXTURE, join(workspace, COOKIE_FIXTURE_FILE));
  await cp(SENSITIVE_FIXTURE, join(workspace, SENSITIVE_FIXTURE_FILE));
  await cp(FORM_FIXTURE, join(workspace, FORM_FIXTURE_FILE));
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
      maxShots: MAX_BROWSER_SHOTS_PER_JOB,
      heartbeatMs: BROWSER_HEARTBEAT_MS,
      sensitive: {
        inputSelector: SENSITIVE_INPUT_SELECTOR,
        pixelSelector: UNSAFE_PIXEL_SELECTOR,
        queryKeys: SENSITIVE_QUERY_KEYS,
      },
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
  if (session.screenshotId !== undefined) return session;
  if (!session.results.some((result) => result.op === "screenshot" || result.op === "open" || result.op === "read")) {
    return session;
  }
  try {
    const bytes = readHostFd(proto.shot, 1_048_576);
    if (bytes.byteLength === 0 || !isJpeg(bytes)) return session;
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

function sanitizeTimelineStep(step: BrowserStep): BrowserStep {
  const url = step.url === undefined ? undefined : sanitizeBrowserUrl(step.url);
  return {
    op: step.op,
    at: step.at,
    ...(url === undefined ? {} : { url }),
    ...(step.screenshotId === undefined ? {} : { screenshotId: step.screenshotId }),
  };
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
