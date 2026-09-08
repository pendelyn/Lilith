import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { parseHealthResponse } from "@lilith/contracts";
import { authenticateOwner } from "./auth.ts";

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

export function createHealthServer(auth: Pick<ApiConfig, "token" | "ownerId">): Server {
  return createServer((req, res) => {
    handleRequest(req, res, auth);
  });
}

function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  auth: Pick<ApiConfig, "token" | "ownerId">,
): void {
  if (authenticateOwner(req.headers.authorization, auth) === null) {
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

  res.writeHead(404);
  res.end();
}
