export const CHAT_STORAGE_KEY = "lilith.chat";
export const MAX_MESSAGE_LENGTH = 4_000;

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  status: "sent" | "streaming" | "complete" | "failed";
  replyTo?: string;
};

export function beginReply(
  messages: ChatMessage[],
  userId: string,
  assistantId: string,
  rawText: string,
): ChatMessage[] {
  const text = rawText.trim().slice(0, MAX_MESSAGE_LENGTH);
  if (text === "") return messages;
  const user: ChatMessage = { id: userId, role: "user", text, status: "sent" };
  const assistant: ChatMessage = {
    id: assistantId,
    role: "assistant",
    text: "",
    status: "streaming",
    replyTo: userId,
  };
  return [...messages, user, assistant].slice(-200);
}

export function retryReply(messages: ChatMessage[], userId: string): ChatMessage[] {
  return messages.map((message) =>
    message.role === "assistant" && message.replyTo === userId && message.status === "failed"
      ? { ...message, text: "", status: "streaming" }
      : message
  );
}

export function appendReply(
  messages: ChatMessage[],
  userId: string,
  delta: string,
): ChatMessage[] {
  return messages.map((message) =>
    message.role === "assistant" && message.replyTo === userId && message.status === "streaming"
      ? { ...message, text: message.text + delta }
      : message
  );
}

export function finishReply(
  messages: ChatMessage[],
  userId: string,
  status: "complete" | "failed",
): ChatMessage[] {
  return messages.map((message) =>
    message.role === "assistant" && message.replyTo === userId
      ? { ...message, status }
      : message
  );
}

export function parsePersistedChat(raw: string | null): ChatMessage[] {
  if (raw == null) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];

  const messages: ChatMessage[] = [];
  for (const item of value.slice(-200)) {
    if (
      typeof item !== "object" ||
      item === null ||
      Array.isArray(item) ||
      !("id" in item) ||
      typeof item.id !== "string" ||
      !("role" in item) ||
      (item.role !== "user" && item.role !== "assistant") ||
      !("text" in item) ||
      typeof item.text !== "string" ||
      !("status" in item) ||
      (item.status !== "sent" &&
        item.status !== "streaming" &&
        item.status !== "complete" &&
        item.status !== "failed")
    ) {
      return [];
    }
    const replyTo = "replyTo" in item && typeof item.replyTo === "string" ? item.replyTo : undefined;
    if (item.role === "assistant" && replyTo === undefined) return [];
    messages.push({
      id: item.id,
      role: item.role,
      text: item.text.slice(0, MAX_MESSAGE_LENGTH * 4),
      status: item.status === "streaming" ? "failed" : item.status,
      ...(replyTo === undefined ? {} : { replyTo }),
    });
  }
  return messages;
}

export function serializeChat(messages: ChatMessage[]): string {
  return JSON.stringify(messages.slice(-200));
}
