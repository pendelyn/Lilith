import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  parseAccountDeleteRequest,
  parseAccountDeleteResponse,
  parseHealthResponse,
  parseMemoryConfirmRequest,
  parseMemoryConfirmResponse,
  parseMemoryItem,
  parseMemoryListResponse,
  parseMemoryPauseRequest,
  parseMemoryRetrieveRequest,
  parseMemoryRetrieveResponse,
  parseMemoryUpdateRequest,
  parseResumeRequest,
  parseSubagentCard,
  parseTaskListResponse,
  type ChatStreamEvent,
} from "@lilith/contracts";
import { authenticateOwner, type OwnerContext } from "./auth.ts";
import {
  captureExplicitMemory,
  confirmMemory,
  createMemoryStore,
  deleteMemory,
  isMemoryPaused,
  listMemories,
  memoriesForProvider,
  setMemoryPaused,
  updateMemory,
  type MemoryStore,
} from "./memory.ts";
import {
  decideApproval,
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
  runHeldResearch,
  runQuestionResearch,
  stopTask,
  subagentCard,
  type TaskStore,
} from "./tasks.ts";
import { createRetentionStore, deleteAccount, type RetentionStore } from "./retention.ts";
import {
  WEB_RESEARCH_OFF_REPLY,
  invokeDataDisclosure,
  isDisclosurePrompt,
  parsePublicReadPrompt,
  runColorCompare,
  runDisclosureResearch,
  runPublicPageRead,
  webResearchDepsForTask,
  type WebResearchDeps,
} from "./web-research.ts";

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
  memories: MemoryStore = createMemoryStore(),
  web: WebResearchDeps = {},
  retention: RetentionStore = createRetentionStore(),
): Server {
  return createServer((req, res) => {
    handleRequest(req, res, auth, store, memories, web, retention);
  });
}

function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  auth: Pick<ApiConfig, "token" | "ownerId">,
  store: TaskStore,
  memories: MemoryStore,
  web: WebResearchDeps,
  retention: RetentionStore,
): void {
  try {
    const owner = authenticateOwner(req.headers.authorization, auth);
    if (owner === null) {
      res.writeHead(401);
      res.end();
      return;
    }

    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (blocksOwnerApi(pathname, retention, owner)) {
      res.writeHead(409);
      res.end();
      return;
    }

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
      void streamChatReply(req, res, owner, store, memories, web);
      return;
    }

    if (handleMemoryRoute(req, res, owner, memories, pathname)) {
      return;
    }

    if (pathname === "/account/delete") {
      if (req.method !== "POST") {
        res.writeHead(405, { Allow: "POST" });
        res.end();
        return;
      }
      void handleAccountDelete(req, res, owner, store, memories, retention);
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
      void handleTaskAction(req, res, owner, store, action, web);
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
  memories: MemoryStore,
  web: WebResearchDeps,
): Promise<void> {
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
    if ("memoryEnabled" in value && typeof value.memoryEnabled !== "boolean") {
      throw new Error("Invalid message");
    }
    if ("webResearchEnabled" in value && typeof value.webResearchEnabled !== "boolean") {
      throw new Error("Invalid message");
    }

    streamNdjson(
      res,
      await chatEvents(
        value.message.trim(),
        owner,
        store,
        memories,
        "memoryEnabled" in value && value.memoryEnabled === true,
        "webResearchEnabled" in value && value.webResearchEnabled === true,
        web,
      ),
    );
  } catch {
    if (!res.headersSent) res.writeHead(400);
    res.end();
  }
}

async function handleTaskAction(
  req: IncomingMessage,
  res: ServerResponse,
  owner: OwnerContext,
  store: TaskStore,
  action: { id: string; kind: "stop" | "resume" | "answer" | "approve" },
  web: WebResearchDeps,
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
      if (task.approval === undefined) throw new Error("Task not found");
      const stored = {
        actionId: task.approval.actionId,
        actionClass: task.approval.actionClass,
        origin: task.approval.origin,
        operation: task.approval.operation,
        payload: task.approval.payload,
        files: task.approval.files,
        maxCostCents: task.approval.maxCostCents,
      };
      const invoke =
        stored.actionClass === "data_disclosure"
          ? (actionArg: typeof stored, key: string) =>
              invokeDataDisclosure(actionArg, key, webResearchDepsForTask(store, task.id, web))
          : mockExternalWrite;
      const updated = await decideApproval(store, owner, task.id, body, stored, invoke);
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

async function chatEvents(
  message: string,
  owner: OwnerContext,
  store: TaskStore,
  memories: MemoryStore,
  memoryEnabled: boolean,
  webResearchEnabled: boolean,
  web: WebResearchDeps,
): Promise<ChatStreamEvent[]> {
  const remembered = captureExplicitMemory(memories, owner, message, memoryEnabled);
  if (remembered !== undefined) {
    return [...deltaEvents(remembered), { type: "done" }];
  }

  if (isApprovalPrompt(message)) {
    const run = runApprovalResearch(store, owner);
    return [
      ...run.cards.map((card) => ({ type: "subagent" as const, ...card })),
      ...deltaEvents("Review the mock action before approving. No external call has been made."),
      { type: "done" },
    ];
  }

  if (isColorComparePrompt(message)) {
    if (!webResearchEnabled) return [...deltaEvents(WEB_RESEARCH_OFF_REPLY), { type: "done" }];
    try {
      const run = await runColorCompare(store, owner, web);
      if (run.result === undefined) {
        return [
          ...run.cards.map((card) => ({ type: "subagent" as const, ...card })),
          ...deltaEvents("Web research failed."),
          { type: "done" },
        ];
      }
      return [
        ...run.cards.map((card) => ({ type: "subagent" as const, ...card })),
        ...deltaEvents(
          `A research subagent compared test sources A, B, and C. Shared color: ${run.result}.`,
        ),
        { type: "done" },
      ];
    } catch {
      return [...deltaEvents("Web research failed."), { type: "done" }];
    }
  }

  if (isDisclosurePrompt(message)) {
    if (!webResearchEnabled) return [...deltaEvents(WEB_RESEARCH_OFF_REPLY), { type: "done" }];
    try {
      const run = runDisclosureResearch(store, owner, web);
      return [
        ...run.cards.map((card) => ({ type: "subagent" as const, ...card })),
        ...deltaEvents("Review the bound request before any user data is sent. No network call has been made."),
        { type: "done" },
      ];
    } catch {
      return [...deltaEvents("Web research failed."), { type: "done" }];
    }
  }

  const publicUrl = parsePublicReadPrompt(message);
  if (publicUrl !== undefined) {
    if (!webResearchEnabled) return [...deltaEvents(WEB_RESEARCH_OFF_REPLY), { type: "done" }];
    try {
      const run = await runPublicPageRead(store, owner, publicUrl, web);
      if (run.cards.some((card) => card.approval?.state === "pending")) {
        return [
          ...run.cards.map((card) => ({ type: "subagent" as const, ...card })),
          ...deltaEvents("Review the bound request before any user data is sent. No network call has been made."),
          { type: "done" },
        ];
      }
      if (run.result === undefined) {
        return [
          ...run.cards.map((card) => ({ type: "subagent" as const, ...card })),
          ...deltaEvents("Web research failed."),
          { type: "done" },
        ];
      }
      return [
        ...run.cards.map((card) => ({ type: "subagent" as const, ...card })),
        ...deltaEvents(run.result),
        { type: "done" },
      ];
    } catch {
      return [...deltaEvents("Web research failed."), { type: "done" }];
    }
  }

  if (isHoldPrompt(message)) {
    const run = runHeldResearch(store, owner);
    return [
      ...run.cards.map((card) => ({ type: "subagent" as const, ...card })),
      ...deltaEvents("A research subagent is working."),
      { type: "done" },
    ];
  }

  if (isQuestionPrompt(message)) {
    const run = runQuestionResearch(store, owner);
    return [
      ...run.cards.map((card) => ({ type: "subagent" as const, ...card })),
      ...deltaEvents("A research subagent needs a choice."),
      { type: "done" },
    ];
  }

  // ponytail: deterministic bridge until the gated provider adapter in Issue #8 is activated.
  return [...deltaEvents(`No model is connected yet. You said: ${message}`), { type: "done" }];
}

function deltaEvents(reply: string): ChatStreamEvent[] {
  return (reply.match(/[\s\S]{1,12}/g) ?? []).map((text) => ({ type: "delta", text }));
}

function streamNdjson(res: ServerResponse, events: ChatStreamEvent[]): void {
  res.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": "application/x-ndjson; charset=utf-8",
  });
  let index = 0;
  const timer = setInterval(() => {
    const event = events[index++];
    if (event === undefined) {
      clearInterval(timer);
      res.end();
      return;
    }
    res.write(`${JSON.stringify(event)}\n`);
    if (event.type === "done") {
      clearInterval(timer);
      res.end();
    }
  }, 40);
  res.on("close", () => clearInterval(timer));
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

async function handleAccountDelete(
  req: IncomingMessage,
  res: ServerResponse,
  owner: OwnerContext,
  store: TaskStore,
  memories: MemoryStore,
  retention: RetentionStore,
): Promise<void> {
  try {
    parseAccountDeleteRequest(await readJsonBody(req));
    deleteAccount(retention, store, memories, owner);
    writeJson(res, parseAccountDeleteResponse({ deleted: true }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const status =
      message === "Invalid AccountDeleteRequest" ||
      message === "Request too large" ||
      message.startsWith("Invalid") ||
      error instanceof SyntaxError
        ? 400
        : 500;
    if (!res.headersSent) res.writeHead(status);
    res.end();
  }
}

function taskAction(pathname: string): { id: string; kind: "stop" | "resume" | "answer" | "approve" } | undefined {
  const match = /^\/tasks\/([^/]+)\/(stop|resume|answer|approve)$/.exec(pathname);
  if (match?.[1] === undefined || (match[2] !== "stop" && match[2] !== "resume" && match[2] !== "answer" && match[2] !== "approve")) {
    return undefined;
  }
  return { id: decodeURIComponent(match[1]), kind: match[2] };
}

function handleMemoryRoute(
  req: IncomingMessage,
  res: ServerResponse,
  owner: OwnerContext,
  memories: MemoryStore,
  pathname: string,
): boolean {
  if (pathname === "/memories") {
    if (req.method !== "GET") {
      res.writeHead(405, { Allow: "GET" });
      res.end();
      return true;
    }
    writeJson(
      res,
      parseMemoryListResponse({
        memories: listMemories(memories, owner),
        paused: isMemoryPaused(memories, owner),
      }),
    );
    return true;
  }

  if (pathname === "/memories/retrieve") {
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" });
      res.end();
      return true;
    }
    void handleMemoryRetrieve(req, res, owner, memories);
    return true;
  }

  if (pathname === "/memories/pause") {
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" });
      res.end();
      return true;
    }
    void handleMemoryPause(req, res, owner, memories);
    return true;
  }

  if (pathname === "/memories/confirm") {
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" });
      res.end();
      return true;
    }
    void handleMemoryConfirm(req, res, owner, memories);
    return true;
  }

  const item = /^\/memories\/([^/]+)$/.exec(pathname);
  if (item?.[1] === undefined) return false;
  if (req.method !== "PATCH" && req.method !== "DELETE") {
    res.writeHead(405, { Allow: "PATCH, DELETE" });
    res.end();
    return true;
  }
  void handleMemoryItem(req, res, owner, memories, decodeURIComponent(item[1]), req.method);
  return true;
}

async function handleMemoryRetrieve(
  req: IncomingMessage,
  res: ServerResponse,
  owner: OwnerContext,
  memories: MemoryStore,
): Promise<void> {
  try {
    const input = parseMemoryRetrieveRequest(await readJsonBody(req));
    writeJson(
      res,
      parseMemoryRetrieveResponse({ memories: memoriesForProvider(memories, owner, input) }),
    );
  } catch (error) {
    writeMemoryError(res, error);
  }
}

async function handleMemoryPause(
  req: IncomingMessage,
  res: ServerResponse,
  owner: OwnerContext,
  memories: MemoryStore,
): Promise<void> {
  try {
    const input = parseMemoryPauseRequest(await readJsonBody(req));
    writeJson(res, parseMemoryPauseRequest({ paused: setMemoryPaused(memories, owner, input.paused) }));
  } catch (error) {
    writeMemoryError(res, error);
  }
}

async function handleMemoryConfirm(
  req: IncomingMessage,
  res: ServerResponse,
  owner: OwnerContext,
  memories: MemoryStore,
): Promise<void> {
  try {
    writeJson(
      res,
      parseMemoryConfirmResponse(confirmMemory(memories, owner, parseMemoryConfirmRequest(await readJsonBody(req)))),
    );
  } catch (error) {
    writeMemoryError(res, error);
  }
}

async function handleMemoryItem(
  req: IncomingMessage,
  res: ServerResponse,
  owner: OwnerContext,
  memories: MemoryStore,
  id: string,
  method: string,
): Promise<void> {
  try {
    if (method === "DELETE") {
      const body = await readJsonBody(req);
      if (body !== undefined && !isEmptyObject(body)) throw new Error("Invalid memory");
      deleteMemory(memories, owner, id);
      writeJson(
        res,
        parseMemoryListResponse({
          memories: listMemories(memories, owner),
          paused: isMemoryPaused(memories, owner),
        }),
      );
      return;
    }
    const updated = updateMemory(
      memories,
      owner,
      id,
      parseMemoryUpdateRequest(await readJsonBody(req)).content,
    );
    writeJson(res, parseMemoryItem(updated));
  } catch (error) {
    writeMemoryError(res, error);
  }
}

function writeMemoryError(res: ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : "";
  const status =
    message === "Resource access denied" || message === "Memory not found"
      ? 404
      : message === "Memory confirmation required" ||
          message === "Memory confirmation not found" ||
          message === "Memory confirmation expired" ||
          message === "Memory confirmation changed" ||
          message === "Memory is off" ||
          message === "Memory is paused"
        ? 409
        : message === "Invalid memory" ||
            message === "Forbidden memory" ||
            message === "Request too large" ||
            message.startsWith("Invalid") ||
            error instanceof SyntaxError
          ? 400
          : 500;
  if (!res.headersSent) res.writeHead(status);
  res.end();
}

function isEmptyObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0;
}

function writeJson(res: ServerResponse, value: unknown): void {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

function blocksOwnerApi(pathname: string, retention: RetentionStore, owner: OwnerContext): boolean {
  // /health has no owner payload; authenticated POST /account/delete is the explicit retry.
  return pathname !== "/health" && pathname !== "/account/delete" && retention.pendingOwnerDeletes.has(owner.ownerId);
}
