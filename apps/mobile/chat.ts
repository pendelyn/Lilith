import {
  MEMORY_REDACTED_USER_TEXT,
  MEMORY_SECRET_REPLY,
  isForbiddenRememberMessage,
  parseSubagentCard,
  redactSensitiveUrlsInText,
  type BrowserStep,
  type SubagentCard,
  type TaskState,
} from "@lilith/contracts";
import { persistedChatHasScreenshotBytes } from "./screenshots.ts";

export const CHAT_STORAGE_KEY = "lilith.chat";
export const MAX_MESSAGE_LENGTH = 4_000;

export type { SubagentCard } from "@lilith/contracts";

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  status: "sent" | "streaming" | "complete" | "failed";
  replyTo?: string;
  subagents?: SubagentCard[];
};

export function rememberDisplayText(raw: string): string {
  const text = raw.trim().slice(0, MAX_MESSAGE_LENGTH);
  if (text === "") return text;
  if (isForbiddenRememberMessage(text)) return MEMORY_REDACTED_USER_TEXT;
  return redactSensitiveUrlsInText(text);
}

function displayChatText(raw: string, max = MAX_MESSAGE_LENGTH * 4): string {
  return redactSensitiveUrlsInText(raw).slice(0, max);
}

function sanitizeStep(step: BrowserStep): BrowserStep {
  if (step.url === undefined) return step;
  const url = redactSensitiveUrlsInText(step.url).slice(0, MAX_MESSAGE_LENGTH);
  return url === step.url ? step : { ...step, url };
}

function sanitizeCard(card: SubagentCard): SubagentCard {
  const result = card.result === undefined ? card.result : displayChatText(card.result, MAX_MESSAGE_LENGTH);
  let browser = card.browser;
  if (browser !== undefined) {
    const timeline = browser;
    const current = sanitizeStep(timeline.current);
    const steps = timeline.steps.map(sanitizeStep);
    if (current !== timeline.current || steps.some((step, index) => step !== timeline.steps[index])) {
      browser = { current, steps };
    }
  }
  if (result === card.result && browser === card.browser) return card;
  return {
    ...card,
    ...(result === undefined ? {} : { result }),
    ...(browser === undefined ? {} : { browser }),
  };
}

function cardsUnchanged(current: SubagentCard[] | undefined, next: SubagentCard[] | undefined): boolean {
  if (current === next) return true;
  if (current === undefined || next === undefined || current.length !== next.length) return false;
  return current.every((card, index) => card === next[index]);
}

export function redactRefusedSecrets(messages: ChatMessage[]): ChatMessage[] {
  const refusedUserIds = new Set(
    messages.flatMap((message) =>
      message.role === "assistant" && message.text === MEMORY_SECRET_REPLY && message.replyTo !== undefined
        ? [message.replyTo]
        : [],
    ),
  );
  return messages.map((message) => {
    const text =
      message.role === "user"
        ? refusedUserIds.has(message.id)
          ? MEMORY_REDACTED_USER_TEXT
          : rememberDisplayText(message.text)
        : displayChatText(message.text);
    const subagents = message.subagents?.map(sanitizeCard);
    if (text === message.text && cardsUnchanged(message.subagents, subagents)) return message;
    return {
      ...message,
      text,
      ...(subagents === undefined || subagents.length === 0 ? {} : { subagents }),
    };
  });
}

export function beginReply(
  messages: ChatMessage[],
  userId: string,
  assistantId: string,
  rawText: string,
): ChatMessage[] {
  const text = rememberDisplayText(rawText);
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
      ? {
          id: message.id,
          role: "assistant",
          text: "",
          status: "streaming",
          replyTo: userId,
        }
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

export function upsertSubagent(
  messages: ChatMessage[],
  userId: string,
  card: SubagentCard,
): ChatMessage[] {
  return messages.map((message) => {
    if (message.role !== "assistant" || message.replyTo !== userId || message.status !== "streaming") {
      return message;
    }
    const subagents = [...(message.subagents ?? [])];
    const index = subagents.findIndex((item) => item.id === card.id);
    if (index === -1) subagents.push(card);
    else if (shouldReplaceCard(subagents[index]!, card)) subagents[index] = card;
    return { ...message, subagents };
  });
}

export function setTaskReply(messages: ChatMessage[], taskId: string, text: string): ChatMessage[] {
  if (text === "") return messages;
  return messages.map((message) => {
    const card = message.subagents?.find((item) => item.id === taskId);
    if (card === undefined || card.state === "stopped" || card.state === "failed" || card.state === "paused") {
      return message;
    }
    return { ...message, text: displayChatText(text), status: "complete" };
  });
}

const HYDRATE_STATES = new Set<TaskState>(["waiting", "working", "needs_input", "paused"]);
const TERMINAL_STATES = new Set<TaskState>(["completed", "stopped", "failed"]);

function shouldReplaceCard(current: SubagentCard, incoming: SubagentCard): boolean {
  if (current.state === "stopped" && incoming.state !== "stopped") return false;
  if (TERMINAL_STATES.has(current.state) && !TERMINAL_STATES.has(incoming.state)) return false;
  return true;
}

export function applyServerCards(messages: ChatMessage[], cards: SubagentCard[]): ChatMessage[] {
  const next = messages.map((message) => {
    if (message.subagents === undefined) return message;
    return {
      ...message,
      subagents: message.subagents.map((card) => {
        const incoming = cards.find((item) => item.id === card.id);
        if (incoming === undefined || !shouldReplaceCard(card, incoming)) return card;
        return incoming;
      }),
    };
  });
  const known = new Set(next.flatMap((message) => message.subagents?.map((card) => card.id) ?? []));
  const appended = [...next];
  for (const card of cards) {
    if (known.has(card.id) || !HYDRATE_STATES.has(card.state)) continue;
    appended.push({
      id: `server-${card.id}`,
      role: "assistant",
      text: "",
      status: "complete",
      replyTo: `server:${card.id}`,
      subagents: [card],
    });
    known.add(card.id);
  }
  return appended.slice(-200);
}

export function parsePersistedChat(raw: string | null): ChatMessage[] {
  if (raw == null) return [];
  if (persistedChatHasScreenshotBytes(raw)) return [];
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
    if (item.role === "user" && "subagents" in item) return [];
    let subagents: SubagentCard[] | undefined;
    if ("subagents" in item) {
      if (!Array.isArray(item.subagents)) return [];
      try {
        subagents = item.subagents.map((entry: unknown) => {
          const card = parseSubagentCard(entry);
          return {
            ...card,
            assignment: card.assignment.slice(0, MAX_MESSAGE_LENGTH),
            ...(card.result === undefined ? {} : { result: card.result.slice(0, MAX_MESSAGE_LENGTH) }),
            ...(card.browser === undefined
              ? {}
              : {
                  browser: {
                    ...card.browser,
                    current: sanitizeStep({
                      ...card.browser.current,
                      ...(card.browser.current.url === undefined
                        ? {}
                        : { url: card.browser.current.url.slice(0, MAX_MESSAGE_LENGTH) }),
                    }),
                    steps: card.browser.steps.map((step) =>
                      sanitizeStep({
                        ...step,
                        ...(step.url === undefined ? {} : { url: step.url.slice(0, MAX_MESSAGE_LENGTH) }),
                      }),
                    ),
                  },
                }),
          };
        });
      } catch {
        return [];
      }
    }
    messages.push({
      id: item.id,
      role: item.role,
      text: item.text.slice(0, MAX_MESSAGE_LENGTH * 4),
      status: item.status === "streaming" ? "failed" : item.status,
      ...(replyTo === undefined ? {} : { replyTo }),
      ...(subagents === undefined || subagents.length === 0 ? {} : { subagents }),
    });
  }
  return redactRefusedSecrets(messages);
}

export function serializeChat(messages: ChatMessage[]): string {
  return JSON.stringify(redactRefusedSecrets(messages).slice(-200));
}
