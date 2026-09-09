import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appendReply,
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
