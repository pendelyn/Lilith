import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appendReply,
  beginReply,
  finishReply,
  parsePersistedChat,
  retryReply,
  serializeChat,
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

test("malformed persisted chat fails closed", () => {
  assert.deepEqual(parsePersistedChat("not json"), []);
  assert.deepEqual(parsePersistedChat('[{"id":"1","role":"assistant"}]'), []);
});
