import http from "node:http";
import {
  StateStore,
  isValidAgent,
  isValidType,
  type LightEvent,
} from "./state";

export const DEFAULT_PORT = 51789;
const MAX_BODY_BYTES = 32 * 1024;

export function startServer(store: StateStore, port: number = DEFAULT_PORT): http.Server {
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");

    if (req.method === "GET" && req.url === "/health") {
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, version: 1 }));
      return;
    }

    if (req.method === "GET" && req.url === "/state") {
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, state: store.getState() }));
      return;
    }

    if (req.method === "POST" && req.url === "/event") {
      let received = 0;
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > MAX_BODY_BYTES) {
          res.statusCode = 413;
          res.end(JSON.stringify({ ok: false, error: "body too large" }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        try {
          const raw = Buffer.concat(chunks).toString("utf8");
          const body = raw.trim() ? JSON.parse(raw) : {};
          if (!isValidAgent(body.agent)) {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: "invalid agent" }));
            return;
          }
          if (!isValidType(body.type)) {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: "invalid type" }));
            return;
          }
          const evt: LightEvent = {
            agent: body.agent,
            type: body.type,
            sessionId: body.sessionId,
            tool: body.tool,
            message: body.message,
            timestamp: body.timestamp ?? new Date().toISOString(),
          };
          const ingested = store.ingest(evt);
          res.statusCode = 200;
          res.end(JSON.stringify({ ok: true, event: ingested }));
        } catch (err: unknown) {
          res.statusCode = 400;
          res.end(
            JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "bad json" }),
          );
        }
      });
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, error: "not found" }));
  });

  server.listen(port, "127.0.0.1");
  return server;
}
