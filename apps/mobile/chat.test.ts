import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appendReply,
  applyServerCards,
  beginReply,
  finishReply,
  parsePersistedChat,
  retryReply,
  serializeChat,
  setTaskReply,
  upsertSubagent,
} from "./chat.ts";

test("chat survives restart and interrupted streams become retryable", () => {
  let messages = beginReply([], "user-1", "assistant-1", " Hello ");
  messages = appendReply(messages, "user-1", "partial");

  const restored = parsePersistedChat(serializeChat(messages));
  assert.deepEqual(restored, [
    { id: "user-1", role: "user", text: "Hello", status: "sent" },
    {
      id: "assistant-1",
      role: "assistant",
      text: "partial",
      status: "failed",
      replyTo: "user-1",
    },
  ]);
});

test("retry reuses the failed reply without duplicating the user message", () => {
  let messages = beginReply([], "user-1", "assistant-1", "Hello");
  messages = finishReply(messages, "user-1", "failed");
  messages = retryReply(messages, "user-1");
  messages = appendReply(messages, "user-1", "Done");
  messages = finishReply(messages, "user-1", "complete");

  assert.equal(messages.filter((message) => message.role === "user").length, 1);
  assert.deepEqual(messages.at(-1), {
    id: "assistant-1",
    role: "assistant",
    text: "Done",
    status: "complete",
    replyTo: "user-1",
  });
});

test("subagent cards persist on the assistant message and retry starts clean", () => {
  let messages = beginReply([], "user-1", "assistant-1", "task");
  messages = upsertSubagent(messages, "user-1", {
    id: "sub-1",
    role: "research",
    assignment: "Collect the shared color from test sources A, B, and C.",
    state: "working",
  });
  messages = upsertSubagent(messages, "user-1", {
    id: "sub-1",
    role: "research",
    assignment: "Collect the shared color from test sources A, B, and C.",
    state: "completed",
    result: "Blau",
  });

  const restored = parsePersistedChat(serializeChat(messages));
  assert.deepEqual(restored[1]?.subagents, [
    {
      id: "sub-1",
      role: "research",
      assignment: "Collect the shared color from test sources A, B, and C.",
      state: "completed",
      result: "Blau",
    },
  ]);

  messages = finishReply(messages, "user-1", "failed");
  messages = retryReply(messages, "user-1");
  assert.equal("subagents" in (messages.at(-1) ?? {}), false);
});

test("hold retry upserts the same card after retry clears it", () => {
  const card = {
    id: "hold-1",
    role: "research" as const,
    assignment: "Hold research until the user stops or resumes.",
    state: "working" as const,
  };
  let messages = beginReply(
    [],
    "user-1",
    "assistant-1",
    "Halte den Recherche-Unteragenten, bis ich stoppe oder fortsetze",
  );
  messages = upsertSubagent(messages, "user-1", card);
  messages = finishReply(messages, "user-1", "failed");
  messages = retryReply(messages, "user-1");
  assert.equal("subagents" in (messages.at(-1) ?? {}), false);

  messages = upsertSubagent(messages, "user-1", card);
  messages = finishReply(messages, "user-1", "complete");
  assert.equal(messages.filter((message) => message.role === "user").length, 1);
  assert.deepEqual(messages.at(-1)?.subagents, [card]);

  const stopped = applyServerCards(messages, [{ ...card, state: "stopped" }]);
  assert.deepEqual(stopped.at(-1)?.subagents, [{ ...card, state: "stopped" }]);
  assert.equal(
    stopped.filter((message) => message.subagents?.some((item) => item.id === card.id)).length,
    1,
  );
});

test("malformed persisted chat fails closed", () => {
  assert.deepEqual(parsePersistedChat("not json"), []);
  assert.deepEqual(parsePersistedChat('[{"id":"1","role":"assistant"}]'), []);
  assert.deepEqual(
    parsePersistedChat(
      JSON.stringify([
        {
          id: "assistant-1",
          role: "assistant",
          text: "x",
          status: "complete",
          replyTo: "user-1",
          subagents: [{ id: "sub-1" }],
        },
      ]),
    ),
    [],
  );
});

test("server cards hydrate onto failed rows after app restart", () => {
  let messages = beginReply([], "user-1", "assistant-1", "task");
  messages = upsertSubagent(messages, "user-1", {
    id: "sub-1",
    role: "research",
    assignment: "Hold research until the user stops or resumes.",
    state: "working",
  });
  messages = finishReply(messages, "user-1", "failed");

  const hydrated = applyServerCards(messages, [
    {
      id: "sub-1",
      role: "research",
      assignment: "Hold research until the user stops or resumes.",
      state: "stopped",
    },
  ]);
  assert.equal(hydrated[1]?.status, "failed");
  assert.deepEqual(hydrated[1]?.subagents, [
    {
      id: "sub-1",
      role: "research",
      assignment: "Hold research until the user stops or resumes.",
      state: "stopped",
    },
  ]);
});

test("orphan working cards are inserted and survive chat persistence", () => {
  const hydrated = applyServerCards([], [
    {
      id: "sub-2",
      role: "research",
      assignment: "Hold research until the user stops or resumes.",
      state: "working",
    },
  ]);
  assert.deepEqual(hydrated, [
    {
      id: "server-sub-2",
      role: "assistant",
      text: "",
      status: "complete",
      replyTo: "server:sub-2",
      subagents: [
        {
          id: "sub-2",
          role: "research",
          assignment: "Hold research until the user stops or resumes.",
          state: "working",
        },
      ],
    },
  ]);
  assert.deepEqual(parsePersistedChat(serializeChat(hydrated)), hydrated);
});

test("paused time reason round-trips and non-paused reasons fail closed", () => {
  const paused = applyServerCards([], [
    {
      id: "sub-3",
      role: "research",
      assignment: "Hold research until the user stops or resumes.",
      state: "paused",
      pauseReason: "time",
    },
  ]);
  assert.deepEqual(paused[0]?.subagents, [
    {
      id: "sub-3",
      role: "research",
      assignment: "Hold research until the user stops or resumes.",
      state: "paused",
      pauseReason: "time",
    },
  ]);
  assert.deepEqual(parsePersistedChat(serializeChat(paused)), paused);
  assert.deepEqual(
    parsePersistedChat(
      JSON.stringify([
        {
          id: "assistant-1",
          role: "assistant",
          text: "x",
          status: "complete",
          replyTo: "user-1",
          subagents: [
            {
              id: "sub-1",
              role: "research",
              assignment: "task",
              state: "working",
              pauseReason: "time",
            },
          ],
        },
      ]),
    ),
    [],
  );
});

test("question cards persist, hydrate, retry, and update the same row", () => {
  const question = {
    id: "q-1",
    taskId: "sub-q",
    prompt: "Soll das Ergebnis kurz oder ausführlich sein?",
    options: [
      { id: "short", label: "Kurz" },
      { id: "long", label: "Ausführlich" },
    ],
  };
  const unanswered = {
    id: "sub-q",
    role: "research" as const,
    assignment: "Ask whether the reply should be short or detailed.",
    state: "needs_input" as const,
    question,
  };
  let messages = beginReply(
    [],
    "user-1",
    "assistant-1",
    "Frage mich, ob du kurz oder ausführlich antworten sollst",
  );
  messages = upsertSubagent(messages, "user-1", unanswered);
  const restored = parsePersistedChat(serializeChat(messages));
  assert.deepEqual(restored[1]?.subagents, [unanswered]);
  assert.deepEqual(
    parsePersistedChat(
      JSON.stringify([
        {
          id: "assistant-1",
          role: "assistant",
          text: "x",
          status: "complete",
          replyTo: "user-1",
          subagents: [{ ...unanswered, question: { ...question, extra: true } }],
        },
      ]),
    ),
    [],
  );

  messages = finishReply(messages, "user-1", "failed");
  messages = retryReply(messages, "user-1");
  assert.equal(messages.filter((message) => message.role === "user").length, 1);
  assert.equal("subagents" in (messages.at(-1) ?? {}), false);

  messages = upsertSubagent(messages, "user-1", unanswered);
  messages = finishReply(messages, "user-1", "complete");
  assert.deepEqual(messages.at(-1)?.subagents, [unanswered]);
  assert.equal(messages.at(-1)?.id, "assistant-1");

  const hydrated = applyServerCards(
    [
      { id: "user-1", role: "user", text: "q", status: "sent" },
      {
        id: "assistant-1",
        role: "assistant",
        text: "partial",
        status: "failed",
        replyTo: "user-1",
        subagents: [unanswered],
      },
    ],
    [unanswered],
  );
  assert.equal(hydrated[1]?.status, "failed");
  assert.deepEqual(hydrated[1]?.subagents, [unanswered]);
  const orphan = applyServerCards([], [unanswered]);
  assert.equal(orphan[0]?.subagents?.[0]?.question?.id, "q-1");

  const answered = {
    ...unanswered,
    state: "completed" as const,
    result: "Kurz",
    question: { ...question, answer: { optionId: "short" as const } },
  };
  const updated = setTaskReply(applyServerCards(hydrated, [answered]), "sub-q", "Kurz");
  assert.equal(updated.length, hydrated.length);
  assert.equal(updated.filter((message) => message.role === "user").length, 1);
  assert.equal(updated[1]?.id, "assistant-1");
  assert.equal(updated[1]?.text, "Kurz");
  assert.equal(updated[1]?.status, "complete");
  assert.deepEqual(updated[1]?.subagents, [answered]);
});
