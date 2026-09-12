import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseChatStreamEvent,
  parseQuestionAnswer,
  parseQuestionCard,
  parseResumeRequest,
  parseSubagentCard,
  parseTaskListResponse,
  type ApprovalRequest,
} from "@lilith/contracts";
import { test } from "node:test";
import { createHealthServer, loadConfig } from "./health.ts";
import {
  APPROVAL_PROMPT,
  COLOR_COMPARE_PROMPT,
  HOLD_ASSIGNMENT,
  HOLD_PROMPT,
  QUESTION_ASSIGNMENT,
  QUESTION_OPTIONS,
  QUESTION_PROMPT,
  QUESTION_TEXT,
  RESEARCH_ASSIGNMENT,
  TASK_MAX_COST_CENTS,
  TASK_MAX_RUNTIME_MS,
  acceptToolResult,
  createTaskStore,
  recordCost,
  type TaskStore,
} from "./tasks.ts";
import {
  DISCLOSURE_PROMPT,
  TEST_COLOR_FIXTURE_COMMIT,
  UNTRUSTED_PAGE_TEXT,
  WEB_RESEARCH_OFF_REPLY,
  colorFixtureUrls,
  offlineWebResearchDeps,
} from "./web-research.ts";

const AUTH = { Authorization: "Bearer secret-token" };

test("missing authentication config fails closed", () => {
  assert.throws(() => loadConfig({ ALPHA_OWNER_ID: "alpha-owner" }), /LOCAL_API_TOKEN/);
  assert.throws(() => loadConfig({ LOCAL_API_TOKEN: "secret-token" }), /ALPHA_OWNER_ID/);
});

test("valid token returns exact HealthResponse JSON", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/health`, {
      headers: AUTH,
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(await response.text(), '{"status":"ok"}');
  });
});

test("chat replies stream as validated NDJSON without raw logs", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/chat`, {
      method: "POST",
      headers: {
        ...AUTH,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message: "Hello\n🌙" }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/x-ndjson; charset=utf-8");
    const events = (await response.text()).trim().split("\n").map((line) =>
      parseChatStreamEvent(JSON.parse(line))
    );
    const deltas = events.filter((event) => event.type === "delta");
    assert.ok(deltas.length > 1);
    assert.equal(
      deltas.map((event) => event.text).join(""),
      "No model is connected yet. You said: Hello\n🌙",
    );
    assert.equal(events.some((event) => event.type === "subagent"), false);
    assert.deepEqual(events.at(-1), { type: "done" });
  });
});

test("color compare test task streams one research subagent and Blau", async () => {
  await withServer(async (base) => {
    const urls = colorFixtureUrls(TEST_COLOR_FIXTURE_COMMIT);
    const response = await fetch(`${base}/chat`, {
      method: "POST",
      headers: {
        ...AUTH,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message: `  ${COLOR_COMPARE_PROMPT}  `, webResearchEnabled: true }),
    });
    assert.equal(response.status, 200);
    const events = (await response.text()).trim().split("\n").map((line) =>
      parseChatStreamEvent(JSON.parse(line))
    );
    const subagents = events.flatMap((event) => (event.type === "subagent" ? [event] : []));
    const ids = new Set(subagents.map((event) => event.id));
    const reply = events
      .flatMap((event) => (event.type === "delta" ? [event.text] : []))
      .join("");

    assert.equal(ids.size, 1);
    assert.deepEqual(
      subagents.map((event) => event.state),
      ["waiting", "working", "completed"],
    );
    assert.equal(subagents[0]?.role, "research");
    assert.equal(subagents[0]?.assignment, RESEARCH_ASSIGNMENT);
    assert.match(subagents.at(-1)?.result ?? "", /Blau/);
    assert.equal(subagents.at(-1)?.result?.includes(urls.A), true);
    assert.equal(subagents.at(-1)?.result?.includes(urls.B), true);
    assert.equal(subagents.at(-1)?.result?.includes(urls.C), true);
    assert.match(reply, /Blau/);
    assert.equal(reply.includes(urls.A), true);
    assert.equal(reply.includes("No model is connected yet"), false);
    assert.deepEqual(events.at(-1), { type: "done" });
  });
});

test("Blank or omitted webResearchEnabled does not run color compare or fetch", async () => {
  let connects = 0;
  const web = offlineWebResearchDeps({ connect: () => { connects += 1; } });
  await withServer(async (base) => {
    for (const body of [
      JSON.stringify({ message: COLOR_COMPARE_PROMPT }),
      JSON.stringify({ message: COLOR_COMPARE_PROMPT, webResearchEnabled: false }),
    ]) {
      const response = await fetch(`${base}/chat`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body,
      });
      assert.equal(response.status, 200);
      const events = (await response.text()).trim().split("\n").map((line) =>
        parseChatStreamEvent(JSON.parse(line)),
      );
      const reply = events.flatMap((event) => (event.type === "delta" ? [event.text] : [])).join("");
      assert.equal(events.some((event) => event.type === "subagent"), false);
      assert.equal(reply, WEB_RESEARCH_OFF_REPLY);
    }
    assert.equal(connects, 0);
  }, undefined, web);
});

test("subagent events reject extra fields", () => {
  assert.throws(
    () =>
      parseChatStreamEvent({
        type: "subagent",
        id: "sub-1",
        role: "research",
        assignment: "task",
        state: "working",
        log: "raw tool output",
      }),
    /Invalid/,
  );
});

test("strict parsers reject extra keys and non-consent resume bodies", () => {
  assert.throws(() => parseTaskListResponse({ tasks: [], log: "secret" }), /Invalid/);
  assert.throws(
    () => parseSubagentCard({
      id: "sub-1",
      role: "research",
      assignment: "task",
      state: "stopped",
      result: "Blau",
    }),
    /Invalid/,
  );
  assert.throws(() => parseResumeRequest({}), /Invalid/);
  assert.throws(() => parseResumeRequest({ consent: false }), /Invalid/);
  assert.throws(() => parseResumeRequest({ consent: true, extra: true }), /Invalid/);
  assert.deepEqual(parseResumeRequest({ consent: true }), { consent: true });
});

test("invalid chat messages fail without echoing input", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/chat`, {
      method: "POST",
      headers: {
        ...AUTH,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message: "" }),
    });
    assert.equal(response.status, 400);
    assert.equal(await response.text(), "");
  });
});

test("missing credentials return 401", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/health`);
    assert.equal(response.status, 401);
    assert.equal(await response.text(), "");
  });
});

test("wrong credentials return 401", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/health`, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    assert.equal(response.status, 401);
    assert.equal(await response.text(), "");
  });
});

test("unknown authenticated route returns 404", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/nope`, {
      headers: AUTH,
    });
    assert.equal(response.status, 404);
    assert.equal(await response.text(), "");
  });
});

test("unknown unauthenticated route returns 401", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/nope`);
    assert.equal(response.status, 401);
  });
});

test("authenticated unsupported health method returns 405", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/health`, {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET");
    assert.equal(await response.text(), "");
  });
});

test("repeating the hold prompt reuses one tree and stop ends that tree", async () => {
  const store = createTaskStore();
  await withServer(async (base) => {
    const first = await chatEvents(base, HOLD_PROMPT);
    const second = await chatEvents(base, HOLD_PROMPT);
    const firstId = first.find((event) => event.type === "subagent")?.id;
    const secondCards = second.flatMap((event) => (event.type === "subagent" ? [event] : []));
    if (firstId === undefined) throw new Error("expected a held subagent");

    assert.deepEqual(
      secondCards.map((event) => ({ id: event.id, state: event.state })),
      [{ id: firstId, state: "working" }],
    );
    assert.equal(
      [...store.tasks.values()].filter((task) => task.parentTaskId === undefined).length,
      1,
    );
    assert.equal(
      [...store.tasks.values()].filter((task) => task.parentTaskId !== undefined).length,
      1,
    );

    const hello = await chatEvents(base, "Hello");
    assert.equal(hello.some((event) => event.type === "subagent"), false);
    assert.equal(store.tasks.get(firstId)?.state, "working");

    const stopped = await fetch(`${base}/tasks/${firstId}/stop`, { method: "POST", headers: AUTH });
    assert.equal(stopped.status, 200);
    assert.equal(parseSubagentCard(await stopped.json()).state, "stopped");
    assert.equal(
      [...store.tasks.values()].some((task) => task.state === "working" || task.state === "waiting"),
      false,
    );
    const listed = parseTaskListResponse(await readJson(await fetch(`${base}/tasks`, { headers: AUTH })));
    assert.equal(listed.tasks.length, 1);
    assert.equal(listed.tasks[0]?.id, firstId);
    assert.equal(listed.tasks[0]?.state, "stopped");

    const third = await chatEvents(base, HOLD_PROMPT);
    const thirdId = third.find((event) => event.type === "subagent")?.id;
    if (thirdId === undefined) throw new Error("expected a new held subagent");
    assert.notEqual(thirdId, firstId);
    assert.equal(
      [...store.tasks.values()].filter((task) => task.parentTaskId === undefined).length,
      2,
    );
  }, store);
});

test("hold fixture leaves one research child working after chat done", async () => {
  await withServer(async (base) => {
    const events = await chatEvents(base, HOLD_PROMPT);
    const subagents = events.flatMap((event) => (event.type === "subagent" ? [event] : []));
    const reply = events
      .flatMap((event) => (event.type === "delta" ? [event.text] : []))
      .join("");
    const listed = parseTaskListResponse(await readJson(await fetch(`${base}/tasks`, { headers: AUTH })));

    assert.equal(new Set(subagents.map((event) => event.id)).size, 1);
    assert.deepEqual(
      subagents.map((event) => event.state),
      ["waiting", "working"],
    );
    assert.equal(subagents[0]?.assignment, HOLD_ASSIGNMENT);
    assert.equal(subagents.some((event) => event.state === "completed"), false);
    assert.equal(reply.includes("Blau"), false);
    assert.deepEqual(events.at(-1), { type: "done" });
    assert.equal(listed.tasks.length, 1);
    assert.equal(listed.tasks[0]?.state, "working");
    assert.equal(listed.tasks[0]?.id, subagents[0]?.id);
  });
});

test("stop blocks late in-process results and does not present them as chat success", async () => {
  const store = createTaskStore();
  await withServer(async (base) => {
    const childId = await holdChildId(base);
    const stopped = await fetch(`${base}/tasks/${childId}/stop`, { method: "POST", headers: AUTH });
    assert.equal(stopped.status, 200);
    assert.deepEqual(parseSubagentCard(await stopped.json()), {
      id: childId,
      role: "research",
      assignment: HOLD_ASSIGNMENT,
      state: "stopped",
    });

    const listed = parseTaskListResponse(await readJson(await fetch(`${base}/tasks`, { headers: AUTH })));
    assert.equal(listed.tasks[0]?.state, "stopped");
    assert.equal("result" in (listed.tasks[0] ?? {}), false);
    assert.throws(() => acceptToolResult(store, { ownerId: "alpha-owner" }, childId, "Blau"), /cannot accept results/);
    assert.equal(store.tasks.get(childId)?.state, "stopped");

    const followUp = await chatEvents(base, "Hello");
    const reply = followUp
      .flatMap((event) => (event.type === "delta" ? [event.text] : []))
      .join("");
    assert.equal(reply, "No model is connected yet. You said: Hello");
    assert.equal(reply.includes("Blau"), false);
  }, store);
});

test("GET /tasks pauses after 15 minutes and resume requires consent true", async () => {
  let now = 0;
  const store = createTaskStore({ now: () => now });
  await withServer(async (base) => {
    const childId = await holdChildId(base);
    now = TASK_MAX_RUNTIME_MS;
    const listed = parseTaskListResponse(await readJson(await fetch(`${base}/tasks`, { headers: AUTH })));
    assert.equal(listed.tasks[0]?.state, "paused");
    assert.equal(listed.tasks[0]?.pauseReason, "time");
    assert.equal("result" in (listed.tasks[0] ?? {}), false);

    const empty = await fetch(`${base}/tasks/${childId}/resume`, {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const denied = await fetch(`${base}/tasks/${childId}/resume`, {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ consent: false }),
    });
    assert.equal(empty.status, 400);
    assert.equal(await empty.text(), "");
    assert.equal(denied.status, 400);
    assert.equal(
      parseTaskListResponse(await readJson(await fetch(`${base}/tasks`, { headers: AUTH }))).tasks[0]?.state,
      "paused",
    );

    const resumed = await fetch(`${base}/tasks/${childId}/resume`, {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ consent: true }),
    });
    assert.equal(resumed.status, 200);
    assert.equal(parseSubagentCard(await resumed.json()).state, "working");
    const after = parseTaskListResponse(await readJson(await fetch(`${base}/tasks`, { headers: AUTH })));
    assert.equal(after.tasks[0]?.state, "working");
    assert.equal("pauseReason" in (after.tasks[0] ?? {}), false);
  }, store);
});

test("GET /tasks pauses at measurable USD 1 cost", async () => {
  const store = createTaskStore();
  await withServer(async (base) => {
    const childId = await holdChildId(base);
    recordCost(store, { ownerId: "alpha-owner" }, childId, TASK_MAX_COST_CENTS);
    const listed = parseTaskListResponse(await readJson(await fetch(`${base}/tasks`, { headers: AUTH })));
    assert.equal(listed.tasks[0]?.state, "paused");
    assert.equal(listed.tasks[0]?.pauseReason, "cost");
  }, store);
});

test("task routes require the owner token and reject unknown ids", async () => {
  await withServer(async (base) => {
    const childId = await holdChildId(base);
    const missing = await Promise.all([
      fetch(`${base}/tasks`),
      fetch(`${base}/tasks/${childId}/stop`, { method: "POST" }),
      fetch(`${base}/tasks/${childId}/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ consent: true }),
      }),
    ]);
    for (const response of missing) {
      assert.equal(response.status, 401);
      assert.equal(await response.text(), "");
    }

    const unknown = await fetch(`${base}/tasks/missing/stop`, { method: "POST", headers: AUTH });
    assert.equal(unknown.status, 404);
    assert.equal(await unknown.text(), "");

    const extra = await fetch(`${base}/tasks/${childId}/stop`, {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ extra: true }),
    });
    assert.equal(extra.status, 400);

    const workingResume = await fetch(`${base}/tasks/${childId}/resume`, {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ consent: true }),
    });
    assert.equal(workingResume.status, 409);
    assert.equal(await workingResume.text(), "");
  });
});

test("task store file reload keeps working status after a new server boots", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lilith-tasks-http-"));
  const persistPath = join(dir, "state.json");
  try {
    const first = createTaskStore({ persistPath });
    let childId = "";
    await withServer(async (base) => {
      childId = await holdChildId(base);
    }, first);

    const reloaded = createTaskStore({ persistPath });
    await withServer(async (base) => {
      const listed = parseTaskListResponse(await readJson(await fetch(`${base}/tasks`, { headers: AUTH })));
      assert.equal(listed.tasks.length, 1);
      assert.equal(listed.tasks[0]?.id, childId);
      assert.equal(listed.tasks[0]?.state, "working");
    }, reloaded);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("question parsers accept 2–4 unique options and reject the rest", () => {
  const two = {
    id: "q-1",
    taskId: "sub-1",
    prompt: QUESTION_TEXT,
    options: QUESTION_OPTIONS,
  };
  const four = {
    ...two,
    options: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
      { id: "c", label: "C" },
      { id: "d", label: "D" },
    ],
  };
  assert.deepEqual(parseQuestionCard(two).options.map((option) => option.label), ["Kurz", "Ausführlich"]);
  assert.equal(parseQuestionCard(four).options.length, 4);
  assert.throws(() => parseQuestionCard({ ...two, options: [{ id: "short", label: "Kurz" }] }), /Invalid/);
  assert.throws(
    () =>
      parseQuestionCard({
        ...two,
        options: [...four.options, { id: "e", label: "E" }],
      }),
    /Invalid/,
  );
  assert.throws(
    () => parseQuestionCard({ ...two, options: [{ id: "short", label: "Kurz" }, { id: "short", label: "Dup" }] }),
    /Invalid/,
  );
  assert.throws(() => parseQuestionCard({ ...two, log: "secret" }), /Invalid/);
  assert.throws(
    () =>
      parseQuestionCard({
        id: "q-1",
        taskId: "sub-1",
        prompt: QUESTION_TEXT,
        options: [
          { id: "short", label: "Kurz", extra: true },
          { id: "long", label: "Ausführlich" },
        ],
      } as unknown),
    /Invalid/,
  );
  assert.throws(() => parseQuestionAnswer({}), /Invalid/);
  assert.throws(() => parseQuestionAnswer({ optionId: "short", text: "x" }), /Invalid/);
  assert.throws(() => parseQuestionAnswer({ extra: true }), /Invalid/);
  assert.throws(() => parseQuestionAnswer({ text: "   " }), /Invalid/);
  assert.throws(() => parseQuestionAnswer({ text: "x".repeat(401) }), /Invalid/);
  assert.deepEqual(parseQuestionAnswer({ optionId: "short" }), { optionId: "short" });
  assert.deepEqual(parseQuestionAnswer({ text: "  Nur Stichpunkte  " }), { text: "Nur Stichpunkte" });
  assert.throws(
    () =>
      parseChatStreamEvent({
        type: "question",
        id: "q-1",
        taskId: "sub-1",
        prompt: QUESTION_TEXT,
        options: QUESTION_OPTIONS,
      }),
    /Invalid/,
  );
  assert.throws(
    () =>
      parseSubagentCard({
        id: "sub-1",
        role: "research",
        assignment: QUESTION_ASSIGNMENT,
        state: "needs_input",
        question: two,
        detailLevel: "short",
      }),
    /Invalid/,
  );
  assert.deepEqual(
    parseSubagentCard({
      id: "sub-1",
      role: "research",
      assignment: QUESTION_ASSIGNMENT,
      state: "needs_input",
      question: two,
    }).question?.options.map((option) => option.label),
    ["Kurz", "Ausführlich"],
  );
});

test("question fixture streams one unanswered card and answers stay on that id", async () => {
  const store = createTaskStore();
  await withServer(async (base) => {
    const events = await chatEvents(base, `  ${QUESTION_PROMPT}  `);
    const subagents = events.flatMap((event) => (event.type === "subagent" ? [event] : []));
    const reply = events.flatMap((event) => (event.type === "delta" ? [event.text] : [])).join("");
    const childId = subagents[0]?.id;
    const questionId = subagents.at(-1)?.question?.id;
    if (childId === undefined || questionId === undefined) throw new Error("expected a question card");

    assert.equal(new Set(subagents.map((event) => event.id)).size, 1);
    assert.deepEqual(
      subagents.map((event) => event.state),
      ["waiting", "working", "needs_input"],
    );
    assert.equal(subagents.at(-1)?.question?.prompt, QUESTION_TEXT);
    assert.deepEqual(
      subagents.at(-1)?.question?.options.map((option) => option.label),
      ["Kurz", "Ausführlich"],
    );
    assert.equal("answer" in (subagents.at(-1)?.question ?? {}), false);
    assert.equal(reply.includes("No model is connected yet"), false);
    assert.equal(reply.includes("Blau"), false);
    assert.deepEqual(events.at(-1), { type: "done" });

    const listed = parseTaskListResponse(await readJson(await fetch(`${base}/tasks`, { headers: AUTH })));
    assert.equal(listed.tasks[0]?.state, "needs_input");
    assert.equal(listed.tasks[0]?.question?.id, questionId);

    const retry = await chatEvents(base, QUESTION_PROMPT);
    const retryCards = retry.flatMap((event) => (event.type === "subagent" ? [event] : []));
    assert.deepEqual(
      retryCards.map((event) => ({ id: event.id, questionId: event.question?.id, state: event.state })),
      [{ id: childId, questionId, state: "needs_input" }],
    );

    const answered = await fetch(`${base}/tasks/${childId}/answer`, {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ optionId: "short" }),
    });
    assert.equal(answered.status, 200);
    const card = parseSubagentCard(await answered.json());
    assert.equal(card.id, childId);
    assert.equal(card.state, "completed");
    assert.equal(card.result, "Kurz");
    assert.deepEqual(card.question?.answer, { optionId: "short" });

    const duplicate = await fetch(`${base}/tasks/${childId}/answer`, {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ optionId: "short" }),
    });
    assert.equal(duplicate.status, 200);
    assert.deepEqual(parseSubagentCard(await duplicate.json()), card);
    assert.equal(
      [...store.tasks.values()].filter((task) => task.parentTaskId !== undefined).length,
      1,
    );

    const conflict = await fetch(`${base}/tasks/${childId}/answer`, {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ optionId: "long" }),
    });
    assert.equal(conflict.status, 409);
    assert.equal(await conflict.text(), "");
    assert.deepEqual(store.tasks.get(childId)?.question?.answer, { optionId: "short" });
    assert.equal(store.tasks.get(childId)?.result, "Kurz");
  }, store);
});

test("question answer route is owner-scoped and fail-closed", async () => {
  await withServer(async (base) => {
    const childId = await questionChildId(base);
    const missing = await Promise.all([
      fetch(`${base}/tasks/${childId}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ optionId: "short" }),
      }),
      fetch(`${base}/tasks/missing/answer`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ optionId: "short" }),
      }),
    ]);
    assert.equal(missing[0]?.status, 401);
    assert.equal(await missing[0]?.text(), "");
    assert.equal(missing[1]?.status, 404);
    assert.equal(await missing[1]?.text(), "");

    for (const body of [
      JSON.stringify({ text: "" }),
      JSON.stringify({ optionId: "short", text: "x" }),
      JSON.stringify({ optionId: "nope" }),
      JSON.stringify({ extra: true }),
    ]) {
      const response = await fetch(`${base}/tasks/${childId}/answer`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body,
      });
      assert.equal(response.status, 400);
      assert.equal(await response.text(), "");
    }

    const holdId = await holdChildId(base);
    const holdAnswer = await fetch(`${base}/tasks/${holdId}/answer`, {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ optionId: "short" }),
    });
    assert.equal(holdAnswer.status, 404);

    const stopped = await fetch(`${base}/tasks/${childId}/stop`, { method: "POST", headers: AUTH });
    assert.equal(stopped.status, 200);
    const stoppedCard = parseSubagentCard(await stopped.json());
    const afterStop = await fetch(`${base}/tasks/${childId}/answer`, {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ optionId: "short" }),
    });
    assert.equal(afterStop.status, 409);
    assert.equal(await afterStop.text(), "");
    assert.equal("result" in stoppedCard, false);
  });
});

test("question cards reload from disk without running work", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lilith-question-http-"));
  const persistPath = join(dir, "state.json");
  try {
    const first = createTaskStore({ persistPath });
    let childId = "";
    let questionId = "";
    await withServer(async (base) => {
      const events = await chatEvents(base, QUESTION_PROMPT);
      const card = events.find((event) => event.type === "subagent" && event.state === "needs_input");
      if (card === undefined || card.type !== "subagent" || card.question === undefined) {
        throw new Error("expected a question card");
      }
      childId = card.id;
      questionId = card.question.id;
    }, first);

    const unanswered = createTaskStore({ persistPath });
    await withServer(async (base) => {
      const listed = parseTaskListResponse(await readJson(await fetch(`${base}/tasks`, { headers: AUTH })));
      assert.equal(listed.tasks[0]?.id, childId);
      assert.equal(listed.tasks[0]?.state, "needs_input");
      assert.equal(listed.tasks[0]?.question?.id, questionId);
      assert.equal("answer" in (listed.tasks[0]?.question ?? {}), false);
      const answered = await fetch(`${base}/tasks/${childId}/answer`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ text: "  Nur Stichpunkte  " }),
      });
      assert.equal(answered.status, 200);
      assert.equal(parseSubagentCard(await answered.json()).result, "Nur Stichpunkte");
    }, unanswered);

    const reloaded = createTaskStore({ persistPath });
    await withServer(async (base) => {
      const listed = parseTaskListResponse(await readJson(await fetch(`${base}/tasks`, { headers: AUTH })));
      assert.equal(listed.tasks[0]?.id, childId);
      assert.equal(listed.tasks[0]?.state, "completed");
      assert.equal(listed.tasks[0]?.result, "Nur Stichpunkte");
      assert.deepEqual(listed.tasks[0]?.question?.answer, { text: "Nur Stichpunkte" });
      assert.equal(listed.tasks[0]?.question?.id, questionId);
    }, reloaded);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("HTTP persistence failure returns a controlled error and the server stays healthy", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lilith-tasks-http-fail-"));
  const persistPath = join(dir, "state.json");
  let now = 0;
  try {
    const store = createTaskStore({ persistPath, now: () => now });
    await withServer(async (base) => {
      const childId = await holdChildId(base);
      const disk = readFileSync(persistPath);
      now = TASK_MAX_RUNTIME_MS;
      (store as { persistPath?: string }).persistPath = join(persistPath, "blocked.json");
      const listed = await fetch(`${base}/tasks`, { headers: AUTH });
      assert.equal(listed.status, 500);
      assert.equal(await listed.text(), "");
      assert.equal(store.tasks.get(childId)?.state, "working");
      assert.deepEqual(readFileSync(persistPath), disk);
      const health = await fetch(`${base}/health`, { headers: AUTH });
      assert.equal(health.status, 200);
      assert.equal(await health.text(), '{"status":"ok"}');
    }, store);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("approval HTTP flow previews, validates, authenticates and consumes once", async () => {
  await withServer(async (base) => {
    for (const consent of [false, true]) {
      const events = await chatEvents(base, APPROVAL_PROMPT);
      const card = events.find((event) => event.type === "subagent");
      assert.ok(card?.approval);
      assert.equal(card.state, "needs_input");
      assert.equal(
        events.filter((event) => event.type === "delta").map((event) => event.text).join("").includes("No model is connected yet"),
        false,
      );
      const approval = card.approval;
      assert.equal(approval.origin, "https://mock.example");
      assert.equal(approval.operation, "POST /notes");
      assert.equal(approval.payload, "Test note: Blau");
      assert.deepEqual(approval.files, [{ path: "test-note.txt", content: "Blau" }]);
      assert.equal(approval.maxCostCents, 0);
      assert.match(approval.payloadDigest, /^[a-f0-9]{64}$/);
      const url = `${base}/tasks/${card.id}/approve`;
      const post = (body: unknown, headers = AUTH) => fetch(url, {
        method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      assert.equal((await post({ approval, consent }, { Authorization: "Bearer wrong" })).status, 401);
      assert.equal((await fetch(url, { headers: AUTH })).status, 405);
      assert.equal((await post({ consent })).status, 400);
      assert.equal((await post({ approval: { ...approval, payload: "tampered" }, consent: true })).status, 409);
      const listed = parseTaskListResponse(await (await fetch(`${base}/tasks`, { headers: AUTH })).json());
      assert.deepEqual(listed.tasks.find((task) => task.id === card.id)?.approval, approval);
      const updated = parseSubagentCard(await readJson(await post({ approval, consent })));
      assert.equal(updated.approval?.state, consent ? "consumed" : "rejected");
      assert.equal(updated.state, "completed");
      assert.match(updated.result!, consent ? /executed once/ : /No call/);
      assert.equal((await post({ approval, consent })).status, 409);
    }
  });
});

test("approval HTTP bindings survive process reload and still dispatch once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lilith-approval-http-"));
  const persistPath = join(dir, "state.json");
  try {
    let childId = "";
    let binding: ApprovalRequest | undefined;
    await withServer(async (base) => {
      const events = await chatEvents(base, APPROVAL_PROMPT);
      const card = events.find((event) => event.type === "subagent");
      assert.ok(card?.approval);
      childId = card.id;
      binding = card.approval;
    }, createTaskStore({ persistPath }));

    await withServer(async (base) => {
      assert.ok(binding);
      const listed = parseTaskListResponse(await readJson(await fetch(`${base}/tasks`, { headers: AUTH })));
      assert.deepEqual(listed.tasks.find((task) => task.id === childId)?.approval, binding);
      const url = `${base}/tasks/${childId}/approve`;
      const post = (body: unknown) => fetch(url, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const updated = parseSubagentCard(await readJson(await post({ approval: binding, consent: true })));
      assert.equal(updated.state, "completed");
      assert.equal(updated.approval?.state, "consumed");
      assert.equal((await post({ approval: binding, consent: true })).status, 409);
    }, createTaskStore({ persistPath }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("disclosure HTTP waits for consent before any fetch and dispatches stored args once", async () => {
  let fetches = 0;
  const web = offlineWebResearchDeps({
    connect: () => {
      fetches += 1;
    },
  });
  await withServer(async (base) => {
    const events = await chatEvents(base, DISCLOSURE_PROMPT, { webResearchEnabled: true });
    const card = events.find((event) => event.type === "subagent");
    assert.ok(card?.approval);
    assert.equal(card.approval.actionClass, "data_disclosure");
    assert.equal(fetches, 0);
    const url = `${base}/tasks/${card.id}/approve`;
    const post = (body: unknown) => fetch(url, {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const rejected = parseSubagentCard(await readJson(await post({ approval: card.approval, consent: false })));
    assert.match(rejected.result ?? "", /No call/);
    assert.equal(fetches, 0);
  }, undefined, web);

  fetches = 0;
  await withServer(async (base) => {
    const events = await chatEvents(base, DISCLOSURE_PROMPT, { webResearchEnabled: true });
    const card = events.find((event) => event.type === "subagent");
    assert.ok(card?.approval);
    const url = `${base}/tasks/${card.id}/approve`;
    const post = (body: unknown) => fetch(url, {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const updated = parseSubagentCard(await readJson(await post({ approval: card.approval, consent: true })));
    assert.equal(updated.approval?.state, "consumed");
    assert.equal(fetches, 1);
    assert.equal((await post({ approval: card.approval, consent: true })).status, 409);
    assert.equal(fetches, 1);
  }, undefined, web);
});

test("HTTP stop aborts an in-flight color-compare GET", { timeout: 8_000 }, async () => {
  const store = createTaskStore();
  let aborted = false;
  let started!: () => void;
  const startedAt = new Promise<void>((resolve) => {
    started = resolve;
  });
  const web = offlineWebResearchDeps({
    get: async (input) => {
      started();
      return await new Promise<never>((_, reject) => {
        input.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("Web research cancelled"));
        });
      });
    },
  });
  await withServer(async (base) => {
    const chat = chatEvents(base, COLOR_COMPARE_PROMPT, { webResearchEnabled: true });
    await startedAt;
    const child = [...store.tasks.values()].find((task) => task.role === "research");
    assert.ok(child);
    const stopped = await fetch(`${base}/tasks/${child.id}/stop`, { method: "POST", headers: AUTH });
    assert.equal(stopped.status, 200);
    const events = await chat;
    const reply = events.flatMap((event) => (event.type === "delta" ? [event.text] : [])).join("");
    assert.equal(aborted, true);
    assert.equal(reply.includes("Blau"), false);
    assert.match(reply, /failed/);
  }, store, web);
});

test("Lies URL does not attach stored memories to the outbound request", async () => {
  const url = "https://example.com/public";
  let lookups = 0;
  let href = "";
  let headers: Record<string, string> = {};
  let body: string | undefined;
  const web = offlineWebResearchDeps({
    lookupAll: async () => {
      lookups += 1;
      return [{ address: "1.1.1.1", family: 4 }];
    },
    get: async (input) => {
      href = input.url.href;
      headers = input.headers;
      body = input.body;
      return {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
        body: "ok",
      };
    },
  });
  await withServer(async (base) => {
    await chatEvents(base, "Merk dir: Antwortsprache Deutsch", { memoryEnabled: true });
    const events = await chatEvents(base, `Lies ${url}`, { webResearchEnabled: true, memoryEnabled: true });
    const card = events.find((event) => event.type === "subagent");
    assert.ok(card?.approval);
    assert.equal(lookups, 0);
    assert.equal(href, "");
    const updated = parseSubagentCard(
      await readJson(
        await fetch(`${base}/tasks/${card.id}/approve`, {
          method: "POST",
          headers: { ...AUTH, "Content-Type": "application/json" },
          body: JSON.stringify({ approval: card.approval, consent: true }),
        }),
      ),
    );
    assert.equal(updated.approval?.state, "consumed");
    assert.equal(href, url);
    assert.equal(body, undefined);
    assert.equal(JSON.stringify(headers).includes("Deutsch"), false);
    assert.equal(JSON.stringify(headers).includes("Antwortsprache"), false);
    assert.equal(lookups, 1);
  }, undefined, web);
});

test("untrusted remote text cannot capture memory or change tools", async () => {
  const url = "https://example.com/inject";
  const web = offlineWebResearchDeps({
    pages: { [url]: UNTRUSTED_PAGE_TEXT },
  });
  await withServer(async (base) => {
    const events = await chatEvents(base, `Lies ${url}`, { webResearchEnabled: true, memoryEnabled: true });
    const card = events.find((event) => event.type === "subagent");
    assert.ok(card?.approval);
    const updated = parseSubagentCard(
      await readJson(
        await fetch(`${base}/tasks/${card.id}/approve`, {
          method: "POST",
          headers: { ...AUTH, "Content-Type": "application/json" },
          body: JSON.stringify({ approval: card.approval, consent: true }),
        }),
      ),
    );
    assert.match(updated.result ?? "", /Merk dir/);
    const listed = parseTaskListResponse(await readJson(await fetch(`${base}/tasks`, { headers: AUTH })));
    assert.equal(listed.tasks.length, 1);
    const memories = await fetch(`${base}/memories`, { headers: AUTH });
    assert.equal(memories.status, 200);
    assert.equal((await memories.json()).memories.length, 0);
  }, undefined, web);
});

test("arbitrary chat URL makes zero DNS or connect until one-time consent", async () => {
  const url = "https://example.com/notes?q=from-user";
  let lookups = 0;
  let fetches = 0;
  const web = offlineWebResearchDeps({
    pages: { [url]: "hello from the public web" },
    lookupAll: async () => {
      lookups += 1;
      return [{ address: "1.1.1.1", family: 4 }];
    },
    connect: () => {
      fetches += 1;
    },
  });
  await withServer(async (base) => {
    const events = await chatEvents(base, `Lies ${url}`, { webResearchEnabled: true });
    const card = events.find((event) => event.type === "subagent");
    assert.ok(card?.approval);
    assert.equal(card.approval.actionClass, "data_disclosure");
    assert.equal(card.approval.origin, "https://example.com");
    assert.equal(card.approval.operation, "GET /notes?q=from-user");
    assert.match(card.approval.payload, /https:\/\/example.com\/notes\?q=from-user/);
    assert.equal(lookups, 0);
    assert.equal(fetches, 0);
    const post = (body: unknown) =>
      fetch(`${base}/tasks/${card.id}/approve`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const rejected = parseSubagentCard(await readJson(await post({ approval: card.approval, consent: false })));
    assert.match(rejected.result ?? "", /No call/);
    assert.equal(lookups, 0);
    assert.equal(fetches, 0);
  }, undefined, web);

  lookups = 0;
  fetches = 0;
  await withServer(async (base) => {
    const events = await chatEvents(base, `Lies ${url}`, { webResearchEnabled: true });
    const card = events.find((event) => event.type === "subagent");
    assert.ok(card?.approval);
    const post = (body: unknown) =>
      fetch(`${base}/tasks/${card.id}/approve`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const stopped = await fetch(`${base}/tasks/${card.id}/stop`, { method: "POST", headers: AUTH });
    assert.equal(stopped.status, 200);
    assert.equal((await post({ approval: card.approval, consent: true })).status, 409);
    assert.equal(lookups, 0);
    assert.equal(fetches, 0);
  }, undefined, web);

  lookups = 0;
  fetches = 0;
  await withServer(async (base) => {
    const events = await chatEvents(base, `Lies ${url}`, { webResearchEnabled: true });
    const card = events.find((event) => event.type === "subagent");
    assert.ok(card?.approval);
    const post = (body: unknown) =>
      fetch(`${base}/tasks/${card.id}/approve`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const updated = parseSubagentCard(await readJson(await post({ approval: card.approval, consent: true })));
    assert.equal(updated.approval?.state, "consumed");
    assert.match(updated.result ?? "", /hello from the public web/);
    assert.equal(lookups, 1);
    assert.equal(fetches, 1);
    assert.equal((await post({ approval: card.approval, consent: true })).status, 409);
    assert.equal(lookups, 1);
    assert.equal(fetches, 1);
  }, undefined, web);
});

async function chatEvents(
  base: string,
  message: string,
  extra: { webResearchEnabled?: boolean; memoryEnabled?: boolean } = {},
) {
  const response = await fetch(`${base}/chat`, {
    method: "POST",
    headers: {
      ...AUTH,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message, ...extra }),
  });
  assert.equal(response.status, 200);
  return (await response.text()).trim().split("\n").map((line) => parseChatStreamEvent(JSON.parse(line)));
}

async function holdChildId(base: string): Promise<string> {
  const events = await chatEvents(base, HOLD_PROMPT);
  const id = events.find((event) => event.type === "subagent")?.id;
  if (id === undefined) throw new Error("expected a held subagent");
  return id;
}

async function questionChildId(base: string): Promise<string> {
  const events = await chatEvents(base, QUESTION_PROMPT);
  const id = events.find((event) => event.type === "subagent")?.id;
  if (id === undefined) throw new Error("expected a question subagent");
  return id;
}

async function readJson(response: Response): Promise<unknown> {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  return response.json();
}

async function withServer(
  run: (base: string) => Promise<void>,
  store?: TaskStore,
  web = offlineWebResearchDeps(),
): Promise<void> {
  const server = createHealthServer({ token: "secret-token", ownerId: "alpha-owner" }, store, undefined, web);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address");
  }
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
