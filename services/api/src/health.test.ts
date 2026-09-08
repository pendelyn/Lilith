import assert from "node:assert/strict";
import { test } from "node:test";
import { createHealthServer, loadConfig } from "./health.ts";

test("missing authentication config fails closed", () => {
  assert.throws(() => loadConfig({ ALPHA_OWNER_ID: "alpha-owner" }), /LOCAL_API_TOKEN/);
  assert.throws(() => loadConfig({ LOCAL_API_TOKEN: "secret-token" }), /ALPHA_OWNER_ID/);
});

test("valid token returns exact HealthResponse JSON", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/health`, {
      headers: { Authorization: "Bearer secret-token" },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(await response.text(), '{"status":"ok"}');
  });
});

test("missing credentials return 401", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/health`);
    assert.equal(response.status, 401);
    assert.equal(await response.text(), "");
  });
});

test("wrong credentials return 401", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/health`, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    assert.equal(response.status, 401);
    assert.equal(await response.text(), "");
  });
});

test("unknown authenticated route returns 404", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/nope`, {
      headers: { Authorization: "Bearer secret-token" },
    });
    assert.equal(response.status, 404);
    assert.equal(await response.text(), "");
  });
});

test("unknown unauthenticated route returns 401", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/nope`);
    assert.equal(response.status, 401);
  });
});

test("authenticated unsupported health method returns 405", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/health`, {
      method: "POST",
      headers: { Authorization: "Bearer secret-token" },
    });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET");
    assert.equal(await response.text(), "");
  });
});

async function withServer(run: (base: string) => Promise<void>): Promise<void> {
  const server = createHealthServer({ token: "secret-token", ownerId: "alpha-owner" });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address");
  }
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
