import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  parseHealthResponse,
  parseProviderConnection,
  parseResumeRequest,
  parseSubagentCard,
  parseTaskListResponse,
  type ChatStreamEvent,
} from "@lilith/contracts";
import { authenticateOwner, type OwnerContext } from "./auth.ts";
import { createProviderStore, type ProviderStore } from "./provider.ts";
import {
  APPROVAL_ASSIGNMENT,
  decideApproval,
  mockApprovalAction,
  mockExternalWrite,
  runApprovalResearch,
  createTaskStore,
  answerTask,
  isApprovalPrompt,
  isColorComparePrompt,
  isHoldPrompt,
  isQuestionPrompt,
  listResearchCards,
  resumeTask,
  runColorCompare,
  runHeldResearch,
  runQuestionResearch,
  stopTask,
  subagentCard,
  type TaskStore,
} from "./tasks.ts";

export type ApiConfig = {
  token: string;
  ownerId: string;
  host: string;
  port: number;
};

export function loadConfig(env: NodeJS.Dict<string | undefined> = process.env): ApiConfig {
  const token = env.LOCAL_API_TOKEN?.trim() ?? "";
  if (token === "") {
    throw new Error("LOCAL_API_TOKEN is required and must be non-blank");
  }

  const ownerId = env.ALPHA_OWNER_ID?.trim() ?? "";
  if (ownerId === "") {
    throw new Error("ALPHA_OWNER_ID is required and must be non-blank");
  }

  const host = env.HOST?.trim() || "127.0.0.1";
  const portRaw = env.PORT?.trim() || "3000";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("PORT must be an integer between 0 and 65535");
  }

  return { token, ownerId, host, port };
}

export function createHealthServer(
  auth: Pick<ApiConfig, "token" | "ownerId">,
  store: TaskStore = createTaskStore(),
  provider: ProviderStore = createProviderStore({ ownerId: auth.ownerId }),
): Server {
  return createServer((req, res) => {
    handleRequest(req, res, auth, store, provider);
  });
}

function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  auth: Pick<ApiConfig, "token" | "ownerId">,
  store: TaskStore,
  provider: ProviderStore,
): void {
  try {
    const owner = authenticateOwner(req.headers.authorization, auth);
    if (owner === null) {
      res.writeHead(401);
      res.end();
      return;
    }

    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname === "/health") {
      if (req.method !== "GET") {
        res.writeHead(405, { Allow: "GET" });
        res.end();
        return;
      }

      const body = JSON.stringify(parseHealthResponse({ status: "ok" }));
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(body);
      return;
    }

    if (pathname === "/chat") {
      if (req.method !== "POST") {
        res.writeHead(405, { Allow: "POST" });
        res.end();
        return;
      }
      void streamChatReply(req, res, owner, store, provider);
      return;
    }

    if (pathname === "/provider") {
      if (req.method !== "GET") {
        res.writeHead(405, { Allow: "GET" });
        res.end();
        return;
      }
      writeJson(res, parseProviderConnection(provider.view(owner)));
      return;
    }

    const providerAction = providerRoute(pathname);
    if (providerAction !== undefined) {
      if (req.method !== "POST") {
        res.writeHead(405, { Allow: "POST" });
        res.end();
        return;
      }
      void handleProviderAction(req, res, owner, provider, providerAction);
      return;
    }

    if (pathname === "/tasks") {
      if (req.method !== "GET") {
        res.writeHead(405, { Allow: "GET" });
        res.end();
        return;
      }
      writeJson(res, parseTaskListResponse({ tasks: listResearchCards(store, owner) }));
      return;
    }

    const action = taskAction(pathname);
    if (action !== undefined) {
      if (req.method !== "POST") {
        res.writeHead(405, { Allow: "POST" });
        res.end();
        return;
      }
      void handleTaskAction(req, res, owner, store, action);
      return;
    }

    res.writeHead(404);
    res.end();
  } catch {
    if (!res.headersSent) {
      res.writeHead(500);
      res.end();
    }
  }
}

async function streamChatReply(
  req: IncomingMessage,
  res: ServerResponse,
  owner: OwnerContext,
  store: TaskStore,
  provider: ProviderStore,
): Promise<void> {
  const ac = new AbortController();
  req.on("aborted", () => ac.abort());
  res.on("close", () => {
    if (!res.writableEnded) ac.abort();
  });
  try {
    const value = await readJsonBody(req);
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      !("message" in value) ||
      typeof value.message !== "string" ||
      value.message.trim() === "" ||
      value.message.length > 4_000
    ) {
      throw new Error("Invalid message");
    }

    await streamNdjson(res, chatEvents(value.message.trim(), owner, store, provider, ac.signal));
  } catch {
    if (!res.headersSent) res.writeHead(400);
    if (!res.writableEnded) res.end();
  }
}

async function handleProviderAction(
  req: IncomingMessage,
  res: ServerResponse,
  owner: OwnerContext,
  provider: ProviderStore,
  action: "setup" | "check" | "revoke",
): Promise<void> {
  const ac = new AbortController();
  req.on("aborted", () => ac.abort());
  res.on("close", () => {
    if (!res.writableEnded) ac.abort();
  });
  try {
    const body = await readJsonBody(req);
    if (body !== undefined && !isEmptyObject(body)) throw new Error("Invalid body");
    if (ac.signal.aborted) throw new Error("Codex login aborted");
    const connection =
      action === "setup"
        ? await provider.setup(owner, ac.signal)
        : action === "check"
          ? await provider.check(owner)
          : await provider.revoke(owner);
    writeJson(res, parseProviderConnection(connection));
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (ac.signal.aborted || message === "Codex login aborted") {
      if (!res.headersSent) res.writeHead(499);
      if (!res.writableEnded) res.end();
      return;
    }
    const status =
      message === "Provider already connected"
        ? 409
        : message === "Resource access denied"
          ? 404
          : message === "Invalid body"
            ? 400
            : 500;
    if (!res.headersSent) res.writeHead(status);
    res.end();
  }
}

async function handleTaskAction(
  req: IncomingMessage,
  res: ServerResponse,
  owner: OwnerContext,
  store: TaskStore,
  action: { id: string; kind: "stop" | "resume" | "answer" | "approve" },
): Promise<void> {
  try {
    const body = await readJsonBody(req);
    const task = store.tasks.get(action.id);
    if (task === undefined || task.ownerId !== owner.ownerId || task.role !== "research") {
      res.writeHead(404);
      res.end();
      return;
    }
    if (action.kind === "stop") {
      if (body !== undefined && !isEmptyObject(body)) throw new Error("Invalid body");
      writeJson(res, parseSubagentCard(subagentCard(stopTask(store, owner, action.id))));
      return;
    }
    if (action.kind === "approve") {
      if (task.assignment !== APPROVAL_ASSIGNMENT || task.approval === undefined) throw new Error("Task not found");
      const updated = await decideApproval(store, owner, task.id, body, mockApprovalAction(task.approval.actionId), mockExternalWrite);
      writeJson(res, parseSubagentCard(subagentCard(updated)));
      return;
    }
    if (action.kind === "answer") {
      writeJson(res, parseSubagentCard(subagentCard(answerTask(store, owner, action.id, body))));
      return;
    }
    writeJson(res, parseSubagentCard(subagentCard(resumeTask(store, owner, action.id, parseResumeRequest(body)))));
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const status =
      message === "Task is not paused" ||
      message === "Answer conflict" ||
      message === "Task is not waiting for input" ||
      message.startsWith("Approval ") || message === "Action already consumed"
        ? 409
        : message === "Resource access denied" || message === "Task not found"
          ? 404
          : 400;
    if (!res.headersSent) res.writeHead(status);
    res.end();
  }
}

async function* chatEvents(
  message: string,
  owner: OwnerContext,
  store: TaskStore,
  provider: ProviderStore,
  signal: AbortSignal,
): AsyncIterable<ChatStreamEvent> {
  if (isApprovalPrompt(message)) {
    const run = runApprovalResearch(store, owner);
    yield* paced(
      [
        ...run.cards.map((card) => ({ type: "subagent" as const, ...card })),
        ...deltaEvents("Review the mock action before approving. No external call has been made."),
        { type: "done" },
      ],
      signal,
    );
    return;
  }

  if (isColorComparePrompt(message)) {
    const run = runColorCompare(store, owner);
    yield* paced(
      [
        ...run.cards.map((card) => ({ type: "subagent" as const, ...card })),
        ...deltaEvents(`A research subagent compared test sources A, B, and C. Shared color: ${run.result}.`),
        { type: "done" },
      ],
      signal,
    );
    return;
  }

  if (isHoldPrompt(message)) {
    const run = runHeldResearch(store, owner);
    yield* paced(
      [
        ...run.cards.map((card) => ({ type: "subagent" as const, ...card })),
        ...deltaEvents("A research subagent is working."),
        { type: "done" },
      ],
      signal,
    );
    return;
  }

  if (isQuestionPrompt(message)) {
    const run = runQuestionResearch(store, owner);
    yield* paced(
      [
        ...run.cards.map((card) => ({ type: "subagent" as const, ...card })),
        ...deltaEvents("A research subagent needs a choice."),
        { type: "done" },
      ],
      signal,
    );
    return;
  }

  if (provider.view(owner).state === "connected") {
    yield* provider.streamChat(owner, message, signal);
    return;
  }

  yield* paced([...deltaEvents(`No model is connected yet. You said: ${message}`), { type: "done" }], signal);
}

function deltaEvents(reply: string): ChatStreamEvent[] {
  return (reply.match(/[\s\S]{1,12}/g) ?? []).map((text) => ({ type: "delta", text }));
}

async function* paced(events: ChatStreamEvent[], signal: AbortSignal): AsyncIterable<ChatStreamEvent> {
  for (const event of events) {
    if (signal.aborted) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
    if (signal.aborted) return;
    yield event;
  }
}

async function streamNdjson(res: ServerResponse, events: AsyncIterable<ChatStreamEvent>): Promise<void> {
  res.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": "application/x-ndjson; charset=utf-8",
  });
  try {
    for await (const event of events) {
      if (res.destroyed) break;
      if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
    }
  } catch {
    // headers already sent; omit further events so the client fails closed
  } finally {
    if (!res.writableEnded) res.end();
  }
}

function providerRoute(pathname: string): "setup" | "check" | "revoke" | undefined {
  if (pathname === "/provider/setup") return "setup";
  if (pathname === "/provider/check") return "check";
  if (pathname === "/provider/revoke") return "revoke";
  return undefined;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  req.setEncoding("utf8");
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 8_192) throw new Error("Request too large");
  }
  if (raw.trim() === "") return undefined;
  return JSON.parse(raw);
}

function taskAction(pathname: string): { id: string; kind: "stop" | "resume" | "answer" | "approve" } | undefined {
  const match = /^\/tasks\/([^/]+)\/(stop|resume|answer|approve)$/.exec(pathname);
  if (match?.[1] === undefined || (match[2] !== "stop" && match[2] !== "resume" && match[2] !== "answer" && match[2] !== "approve")) {
    return undefined;
  }
  return { id: decodeURIComponent(match[1]), kind: match[2] };
}

function isEmptyObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0;
}

function writeJson(res: ServerResponse, value: unknown): void {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}
