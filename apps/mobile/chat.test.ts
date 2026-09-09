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
