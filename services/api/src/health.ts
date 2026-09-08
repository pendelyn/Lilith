import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { parseHealthResponse } from "@lilith/contracts";

export type ApiConfig = {
  token: string;
  host: string;
  port: number;
};

export function loadConfig(env: NodeJS.Dict<string | undefined> = process.env): ApiConfig {
  const token = env.LOCAL_API_TOKEN?.trim() ?? "";
  if (token === "") {
    throw new Error("LOCAL_API_TOKEN is required and must be non-blank");
  }

  const host = env.HOST?.trim() || "127.0.0.1";
  const portRaw = env.PORT?.trim() || "3000";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("PORT must be an integer between 0 and 65535");
  }

  return { token, host, port };
}

export function createHealthServer(token: string): Server {
  return createServer((req, res) => {
    handleRequest(req, res, token);
  });
}

function handleRequest(req: IncomingMessage, res: ServerResponse, token: string): void {
  const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  const authorized = bearerMatches(req.headers.authorization, token);

  if (pathname === "/health") {
    if (!authorized) {
      res.writeHead(401);
      res.end();
      return;
    }
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

function bearerMatches(header: string | undefined, expected: string): boolean {
  if (header === undefined) {
    return false;
  }
  const space = header.indexOf(" ");
  if (space <= 0) {
    return false;
  }
  const scheme = header.slice(0, space);
  const provided = header.slice(space + 1);
  if (scheme.toLowerCase() !== "bearer" || provided === "") {
    return false;
  }
  const left = createHash("sha256").update(provided).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}
