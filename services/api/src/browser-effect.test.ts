import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parseChatStreamEvent, parseSubagentCard, parseTaskListResponse, type ApprovalRequest } from "@lilith/contracts";
import {
  FORM_AMBIGUOUS_PROMPT_PREFIX,
  FORM_MESSAGE_PROMPT_PREFIX,
  FORM_PREVIEW_PROMPT_PREFIX,
  FORM_PURCHASE_PROMPT_PREFIX,
  FORM_SUBMIT_PROMPT_PREFIX,
  FORM_UPLOAD_PROMPT_PREFIX,
  assertPlanHasNoOutwardOp,
  formatBrowserEffectExecuted,
  runBrowserSession,
  type BrowserDeps,
  type BrowserDriver,
  type BrowserPlan,
  type BrowserSessionResult,
} from "./browser.ts";
import {
  FORM_NOTE_ID,
  classifyFormNode,
  formDomDigest,
  formControlsFromNodes,
  parseFormNodes,
  type RawFormNode,
} from "./browser-policy.ts";
import { createHealthServer } from "./health.ts";
import { createTaskStore } from "./tasks.ts";
import { WEB_RESEARCH_OFF_REPLY, offlineWebResearchDeps } from "./web-research.ts";

const AUTH = { Authorization: "Bearer secret-token" };
const FORM_HTML = readFileSync(fileURLToPath(new URL("../../../fixtures/browser/form.html", import.meta.url)), "utf8");
const EFFECTS = [
  [FORM_SUBMIT_PROMPT_PREFIX, "submit", "POST /submit", "https://example.com/submit"],
  [FORM_UPLOAD_PROMPT_PREFIX, "upload", "POST /upload", "https://example.com/upload"],
  [FORM_MESSAGE_PROMPT_PREFIX, "message", "POST /message", "https://example.com/message"],
  [FORM_PURCHASE_PROMPT_PREFIX, "purchase", "POST /buy", "https://example.com/buy"],
  [FORM_AMBIGUOUS_PROMPT_PREFIX, "ambiguous", "POST /go", "https://example.com/go"],
] as const;

test("form controls classify text as preview and outward controls as gated effects", () => {
  const controls = formControlsFromNodes(parseFormNodes(FORM_HTML));
  assert.deepEqual(
    controls.map((control) => [control.id, control.effect, control.label]),
    [
      ["ambiguous", "ambiguous", "Continue"],
      ["buy", "purchase", "Kaufen"],
      ["file", "upload", "Upload"],
      ["message", "message", "Nachricht senden"],
      ["note", "text", "Note"],
      ["submit", "submit", "Absenden"],
    ],
  );
  assert.equal(
    classifyFormNode({
      id: "send",
      tag: "button",
      type: "submit",
      name: "",
      label: "Absenden",
      value: "",
      action: "https://example.com/submit",
    })?.effect,
    "submit",
  );
  assert.equal(
    classifyFormNode({
      id: "pw",
      tag: "input",
      type: "password",
      name: "password",
      label: "Password",
      value: "hunter2",
      action: "",
    }),
    undefined,
  );
  assert.equal(
    classifyFormNode({
      id: "ok",
      tag: "button",
      type: "button",
      name: "",
      label: "Accept",
      value: "",
      action: "https://example.com/go",
    })?.effect,
    "ambiguous",
  );
  const filled = controls.map((control) => (control.id === FORM_NOTE_ID ? { ...control, value: "Hallo" } : control));
  assert.notEqual(formDomDigest(controls), formDomDigest(filled));
  assert.equal(/\bundo\b|\brevert\b|rückgängig/i.test(formatBrowserEffectExecuted("submit")), false);
});

test("an outward op never reaches the browser driver", async () => {
  let called = false;
  const driver: BrowserDriver = {
    async run() {
      called = true;
      return { results: [] };
    },
  };
  await assert.rejects(
    runBrowserSession({ ops: [{ op: "click" } as unknown as BrowserPlan["ops"][number]], approved: [] }, createTaskStore(), { ownerId: "alpha-owner" }, "missing", {
      driver,
    }),
    /requires approval/,
  );
  assert.equal(called, false);
  assert.throws(() => assertPlanHasNoOutwardOp({ ops: [{ op: "submit" } as unknown as BrowserPlan["ops"][number]], approved: [] }), /requires approval/);
  const worker = readFileSync(fileURLToPath(new URL("./browser-worker.mjs", import.meta.url)), "utf8");
  assert.match(worker, /method !== "GET"/);
  assert.match(worker, /Outward browser action requires approval/);
  assert.match(worker, /op\.selector !== "#note"/);
});

test("text input is a preview and does not submit or leave the machine", async () => {
  const gate = harness();
  await withServer(async (base) => {
    const off = await chatEvents(base, `${FORM_PREVIEW_PROMPT_PREFIX}Hallo`);
    assert.equal(reply(off), WEB_RESEARCH_OFF_REPLY);
    assert.equal(gate.model.runs, 0);
    const events = await chatEvents(base, `${FORM_PREVIEW_PROMPT_PREFIX}Hallo`, true);
    assert.equal(reply(events), "Preview: Hallo");
    assert.equal(reply(events).includes("Merk dir"), false);
    assert.equal(/executed|submitted|cannot be undone/i.test(reply(events)), false);
    assert.equal(events.some((event) => event.type === "subagent" && event.approval !== undefined), false);
    assert.equal(gate.posts.length, 0);
    assert.equal(gate.lookups(), 0);
    assert.equal(gate.plans.some((plan) => plan.ops.some((op) => op.op === "snapshot" || op.op === "fill") && plan.ops.some((op) => op.op === "read")), true);
    const outward = new Set<string>(["effect", "submit", "click"]);
    assert.equal(gate.plans.some((plan) => plan.ops.some((op) => outward.has(op.op))), false);
  }, gate.web);
});

test("submit, upload, message, purchase, and ambiguous clicks stop for one-time approval", async () => {
  for (const [prefix, effect, operation, url] of EFFECTS) {
    const gate = harness();
    await withServer(async (base) => {
      const events = await chatEvents(base, `${prefix}Hallo`, true);
      const card = events.find((event) => event.type === "subagent" && event.approval?.state === "pending");
      assert.ok(card && card.type === "subagent" && card.approval);
      assert.equal(card.approval.actionClass, "external_effect");
      assert.equal(card.approval.operation, operation);
      assert.equal(card.approval.origin, "https://example.com");
      const payload = JSON.parse(card.approval.payload) as { tool: string; effect: string; url: string; fields: { value: string }[] };
      assert.equal(payload.tool, "browser-effect");
      assert.equal(payload.effect, effect);
      assert.equal(payload.url, url);
      assert.equal(payload.fields[0]?.value, "Hallo");
      assert.match(reply(events), /Nothing has been sent/);
      assert.equal(/cannot be undone|undo|revert|rückgängig/i.test(reply(events)), false);
      if (effect === "upload") assert.deepEqual(card.approval.files, [{ path: "upload.txt", content: "Hallo" }]);
      else assert.deepEqual(card.approval.files, []);
      assert.equal(gate.posts.length, 0);
      assert.equal(gate.lookups(), 0);
    }, gate.web);
  }
});

test("rejection, payload changes, and DOM changes do not send", async () => {
  const rejected = harness();
  await withServer(async (base) => {
    const card = await pendingCard(base, `${FORM_SUBMIT_PROMPT_PREFIX}Hallo`);
    const result = await decide(base, card, false);
    assert.equal(result.status, 200);
    const body = parseSubagentCard(await result.json());
    assert.equal(body.approval?.state, "rejected");
    assert.match(body.result ?? "", /No call/);
    assert.equal(/\bundo\b|\brevert\b|rückgängig/i.test(body.result ?? ""), false);
    assert.equal(rejected.posts.length, 0);
    assert.equal(rejected.lookups(), 0);
  }, rejected.web);

  const tampered = harness();
  await withServer(async (base) => {
    const card = await pendingCard(base, `${FORM_UPLOAD_PROMPT_PREFIX}Hallo`);
    const changed = {
      ...card,
      payload: card.payload.replace("Hallo", "Hacked"),
      files: [{ path: "upload.txt", content: "Hacked" }],
    };
    const result = await decide(base, changed, true);
    assert.equal(result.status, 409);
    assert.equal((await listed(base)).find((task) => task.id === card.taskId)?.approval?.state, "pending");
    assert.equal(tampered.posts.length, 0);
  }, tampered.web);

  const dom = harness();
  await withServer(async (base) => {
    const card = await pendingCard(base, `${FORM_SUBMIT_PROMPT_PREFIX}Hallo`);
    const submit = dom.model.nodes.find((node) => node.id === "submit");
    assert.ok(submit);
    submit.label = "Absenden-changed";
    const result = await decide(base, card, true);
    assert.equal(result.status, 409);
    const task = (await listed(base)).find((item) => item.id === card.taskId);
    assert.equal(task?.approval?.state, "pending");
    assert.equal(task?.state, "needs_input");
    assert.equal(dom.posts.length, 0);
    assert.equal(dom.lookups(), 0);
  }, dom.web);
});

test("approval sends one pinned POST and never describes it as reversible", async () => {
  const gate = harness();
  await withServer(async (base) => {
    const card = await pendingCard(base, `${FORM_MESSAGE_PROMPT_PREFIX}Hallo`);
    const result = await decide(base, card, true);
    assert.equal(result.status, 200);
    const body = parseSubagentCard(await result.json());
    assert.equal(body.approval?.state, "consumed");
    assert.equal(body.state, "completed");
    assert.match(body.result ?? "", /executed once \(message\)/);
    assert.match(body.result ?? "", /cannot be undone/);
    assert.equal(/\bundo\b|\brevert\b|rückgängig/i.test(body.result ?? ""), false);
    assert.equal(gate.posts.length, 1);
    assert.equal(gate.lookups(), 1);
    assert.equal(gate.posts[0]?.method, "POST");
    assert.equal(gate.posts[0]?.url, "https://example.com/message");
    assert.equal(gate.posts[0]?.body, card.payload);
    assert.equal(gate.posts[0]?.headers["Idempotency-Key"], card.actionId);
    const again = await decide(base, card, true);
    assert.equal(again.status, 409);
    assert.equal(gate.posts.length, 1);
  }, gate.web);
});

test("a DOM change after consent is consumed still does not POST", async () => {
  const gate = harness({ badAfter: 3 });
  await withServer(async (base) => {
    const card = await pendingCard(base, `${FORM_SUBMIT_PROMPT_PREFIX}Hallo`);
    const result = await decide(base, card, true);
    assert.notEqual(result.status, 200);
    const task = (await listed(base)).find((item) => item.id === card.taskId);
    assert.equal(task?.state, "failed");
    assert.equal(task?.approval?.state, "consumed");
    assert.equal("result" in (task ?? {}), false);
    assert.equal(gate.posts.length, 0);
  }, gate.web);
});

test("approved form posts still refuse private DNS and do not follow redirects", async () => {
  const privateNet = harness({ lookup: "10.0.0.1" });
  await withServer(async (base) => {
    const card = await pendingCard(base, `${FORM_PURCHASE_PROMPT_PREFIX}Hallo`);
    const result = await decide(base, card, true);
    assert.equal(result.status, 400);
    assert.equal(privateNet.posts.length, 0);
    assert.equal((await listed(base)).find((task) => task.id === card.taskId)?.state, "failed");
  }, privateNet.web);

  const redirect = harness({ status: 302 });
  await withServer(async (base) => {
    const card = await pendingCard(base, `${FORM_AMBIGUOUS_PROMPT_PREFIX}Hallo`);
    const result = await decide(base, card, true);
    assert.equal(result.status, 400);
    assert.equal(redirect.posts.length, 1);
    assert.equal((await listed(base)).find((task) => task.id === card.taskId)?.result, undefined);
  }, redirect.web);
});

test("a blocked form action and stop never send", async () => {
  const blocked = harness();
  const submit = blocked.model.nodes.find((node) => node.id === "submit");
  assert.ok(submit);
  submit.action = "https://169.254.169.254/submit";
  await withServer(async (base) => {
    const events = await chatEvents(base, `${FORM_SUBMIT_PROMPT_PREFIX}Hallo`, true);
    assert.match(reply(events), /failed/);
    assert.equal(events.some((event) => event.type === "subagent" && event.approval !== undefined), false);
    assert.equal(blocked.posts.length, 0);
    assert.equal(blocked.lookups(), 0);
  }, blocked.web);

  const stopped = harness();
  await withServer(async (base) => {
    const card = await pendingCard(base, `${FORM_SUBMIT_PROMPT_PREFIX}Hallo`);
    const stop = await fetch(`${base}/tasks/${card.taskId}/stop`, { method: "POST", headers: AUTH });
    assert.equal(stop.status, 200);
    const result = await decide(base, card, true);
    assert.equal(result.status, 409);
    assert.equal(stopped.posts.length, 0);
    assert.equal(stopped.lookups(), 0);
  }, stopped.web);
});

function harness(options?: { badAfter?: number; lookup?: string; status?: number }) {
  const model: { nodes: RawFormNode[]; runs: number; badAfter?: number } = {
    nodes: parseFormNodes(FORM_HTML),
    runs: 0,
    ...(options?.badAfter === undefined ? {} : { badAfter: options.badAfter }),
  };
  const posts: { url: string; method: string; body?: string; headers: Record<string, string> }[] = [];
  const plans: BrowserPlan[] = [];
  let lookups = 0;
  const driver: BrowserDriver = {
    async run(plan: BrowserPlan): Promise<BrowserSessionResult> {
      model.runs += 1;
      plans.push(plan);
      const fill = plan.ops.find((op) => op.op === "fill");
      const value = fill !== undefined && fill.op === "fill" ? fill.value : "";
      const mutate = model.badAfter !== undefined && model.runs >= model.badAfter;
      const nodes = model.nodes.map((node) => {
        if (mutate && node.id === "submit") return { ...node, label: "Absenden-changed" };
        if (node.id === FORM_NOTE_ID) return { ...node, value };
        return { ...node };
      });
      const results: BrowserSessionResult["results"] = [];
      for (const op of plan.ops) {
        if (op.op === "open") results.push({ op: "open", url: op.url });
        else if (op.op === "fill") results.push({ op: "fill", text: value });
        else if (op.op === "snapshot") results.push({ op: "snapshot", nodes });
        else if (op.op === "read") results.push({ op: "read", text: "idle" });
      }
      return { results };
    },
  };
  const web: BrowserDeps = {
    ...offlineWebResearchDeps({
      lookupAll: async () => {
        lookups += 1;
        return [{ address: options?.lookup ?? "1.1.1.1", family: 4 as const }];
      },
      get: async (input) => {
        posts.push({ url: input.url.href, method: input.method, body: input.body, headers: input.headers });
        return {
          status: options?.status ?? 200,
          headers: { "content-type": "text/html; charset=utf-8" },
          body: "ok",
        };
      },
    }),
    driver,
  };
  return { model, posts, plans, lookups: () => lookups, web };
}

async function pendingCard(base: string, message: string): Promise<ApprovalRequest> {
  const events = await chatEvents(base, message, true);
  const card = events.find((event) => event.type === "subagent" && event.approval?.state === "pending");
  assert.ok(card && card.type === "subagent" && card.approval);
  return card.approval;
}

async function decide(base: string, approval: ApprovalRequest, consent: boolean): Promise<Response> {
  return fetch(`${base}/tasks/${approval.taskId}/approve`, {
    method: "POST",
    headers: { ...AUTH, "Content-Type": "application/json" },
    body: JSON.stringify({ approval, consent }),
  });
}

async function listed(base: string) {
  const response = await fetch(`${base}/tasks`, { headers: AUTH });
  assert.equal(response.status, 200);
  return parseTaskListResponse(await response.json()).tasks;
}

function reply(events: ReturnType<typeof parseChatStreamEvent>[]): string {
  return events.flatMap((event) => (event.type === "delta" ? [event.text] : [])).join("");
}

async function chatEvents(base: string, message: string, webResearchEnabled = false) {
  const response = await fetch(`${base}/chat`, {
    method: "POST",
    headers: { ...AUTH, "Content-Type": "application/json" },
    body: JSON.stringify({ message, ...(webResearchEnabled ? { webResearchEnabled: true } : {}) }),
  });
  assert.equal(response.status, 200);
  return (await response.text()).trim().split("\n").map((line) => parseChatStreamEvent(JSON.parse(line)));
}

async function withServer(run: (base: string) => Promise<void>, web: BrowserDeps): Promise<void> {
  const server: Server = createHealthServer({ token: "secret-token", ownerId: "alpha-owner" }, createTaskStore(), undefined, web);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a TCP address");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
