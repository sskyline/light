/**
 * Integration tests for the HTTP server endpoints.
 * Each test suite spins up a fresh server on an OS-assigned port and tears it
 * down afterward — no fixed port collisions, no leftover listeners.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { StateStore } from "../state";
import { startServer } from "../server";

// ─── helpers ─────────────────────────────────────────────────────────────────

function getPort(srv: http.Server): number {
  const addr = srv.address();
  if (!addr || typeof addr === "string") throw new Error("unexpected address");
  return addr.port;
}

function request(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      { host: "127.0.0.1", port, method, path,
        headers: payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString()) });
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function listenOnFreePort(srv: http.Server): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    srv.once("error", reject);
    srv.once("listening", () => resolve(getPort(srv)));
  });
}

// ─── /health ──────────────────────────────────────────────────────────────────

describe("GET /health", () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = startServer(new StateStore(), 0);
    port = await listenOnFreePort(server);
  });

  afterAll(() => new Promise<void>((res) => server.close(() => res())));

  it("returns 200 ok:true", async () => {
    const { status, json } = await request(port, "GET", "/health");
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
  });
});

// ─── /state ───────────────────────────────────────────────────────────────────

describe("GET /state", () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = startServer(new StateStore(), 0);
    port = await listenOnFreePort(server);
  });

  afterAll(() => new Promise<void>((res) => server.close(() => res())));

  it("returns 200 with empty sessions initially", async () => {
    const { status, json } = await request(port, "GET", "/state");
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect((json.state as { sessions: unknown[] }).sessions).toHaveLength(0);
  });
});

// ─── /event – input validation ────────────────────────────────────────────────

describe("POST /event – validation", () => {
  let server: http.Server;
  let port: number;
  let store: StateStore;

  beforeAll(async () => {
    store = new StateStore();
    server = startServer(store, 0);
    port = await listenOnFreePort(server);
  });

  afterAll(() => new Promise<void>((res) => server.close(() => res())));

  it("rejects missing agent with 400", async () => {
    const { status, json } = await request(port, "POST", "/event", {
      type: "user_prompt",
      timestamp: new Date().toISOString(),
    });
    expect(status).toBe(400);
    expect(json.ok).toBe(false);
    expect(json.error).toMatch(/agent/i);
  });

  it("rejects invalid agent with 400", async () => {
    const { status, json } = await request(port, "POST", "/event", {
      agent: "unknown-bot",
      type: "user_prompt",
      timestamp: new Date().toISOString(),
    });
    expect(status).toBe(400);
    expect(json.error).toMatch(/agent/i);
  });

  it("rejects missing type with 400", async () => {
    const { status, json } = await request(port, "POST", "/event", {
      agent: "claude-code",
      timestamp: new Date().toISOString(),
    });
    expect(status).toBe(400);
    expect(json.error).toMatch(/type/i);
  });

  it("rejects invalid type with 400", async () => {
    const { status, json } = await request(port, "POST", "/event", {
      agent: "claude-code",
      type: "explode",
      timestamp: new Date().toISOString(),
    });
    expect(status).toBe(400);
    expect(json.error).toMatch(/type/i);
  });

  it("accepts a valid event and returns 200", async () => {
    const { status, json } = await request(port, "POST", "/event", {
      agent: "claude-code",
      type: "user_prompt",
      sessionId: "test-1",
      message: "hello",
      timestamp: "2024-01-01T00:00:00.000Z",
    });
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
  });

  it("falls back to server time when timestamp is invalid", async () => {
    const before = Date.now();
    const { status, json } = await request(port, "POST", "/event", {
      agent: "codex",
      type: "user_prompt",
      sessionId: "test-ts",
      timestamp: "not-a-date",
    });
    const after = Date.now();
    expect(status).toBe(200);
    const evt = (json.event as { timestamp: string });
    const got = Date.parse(evt.timestamp);
    expect(got).toBeGreaterThanOrEqual(before);
    expect(got).toBeLessThanOrEqual(after);
  });

  it("falls back to server time when timestamp is absent", async () => {
    const before = Date.now();
    const { status, json } = await request(port, "POST", "/event", {
      agent: "trae",
      type: "session_start",
      sessionId: "test-no-ts",
    });
    const after = Date.now();
    expect(status).toBe(200);
    const evt = (json.event as { timestamp: string });
    const got = Date.parse(evt.timestamp);
    expect(got).toBeGreaterThanOrEqual(before);
    expect(got).toBeLessThanOrEqual(after);
  });

  it("returns 404 for unknown routes", async () => {
    const { status, json } = await request(port, "GET", "/unknown");
    expect(status).toBe(404);
    expect(json.ok).toBe(false);
  });
});

// ─── port conflict / error callback ──────────────────────────────────────────

describe("startServer – EADDRINUSE triggers onError callback", () => {
  it("calls onError with EADDRINUSE when port is taken", async () => {
    // Occupy a port first.
    const occupier = http.createServer();
    await new Promise<void>((res) => occupier.listen(0, "127.0.0.1", res));
    const takenPort = getPort(occupier);

    await new Promise<void>((resolve) => {
      const store = new StateStore();
      const srv = startServer(store, takenPort, (err) => {
        expect(err.code).toBe("EADDRINUSE");
        srv.close();
        occupier.close();
        resolve();
      });
    });
  });
});
