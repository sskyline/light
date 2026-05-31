#!/usr/bin/env node
// Forwards a Claude Code hook invocation to the Light desktop app.
// Usage:  node claude-hook.mjs <event-type>
// Where <event-type> is one of: user_prompt | tool_use | stop | notification
// The Claude Code hook system pipes a JSON payload to stdin, which we
// parse for sessionId, tool name, and prompt text.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const PORT = Number(process.env.LIGHT_PORT || 51789);
const HOST = "127.0.0.1";
const TYPE = process.argv[2];

// Debug log so we can see whether Claude is actually invoking us.
const LOG_PATH = path.join(os.tmpdir(), "light-hook.log");
function logLine(s) {
  try {
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${s}\n`);
  } catch {
    /* ignore */
  }
}
logLine(`invoked type=${TYPE} pid=${process.pid} cwd=${process.cwd()}`);

const VALID = new Set([
  "user_prompt",
  "tool_use",
  "stop",
  "notification",
  "error",
  "session_start",
  "session_end",
]);
if (!VALID.has(TYPE)) {
  console.error(`claude-hook: invalid type "${TYPE}"`);
  process.exit(2);
}

async function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    if (process.stdin.isTTY) return resolve("");
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    // 1-second cap so we never hang Claude's hook pipeline.
    setTimeout(() => resolve(data), 1000).unref();
  });
}

function pickFields(parsed) {
  if (!parsed || typeof parsed !== "object") return {};
  const sessionId =
    typeof parsed.session_id === "string" ? parsed.session_id : undefined;
  const tool =
    typeof parsed.tool_name === "string" ? parsed.tool_name : undefined;
  let message;
  if (typeof parsed.prompt === "string") message = parsed.prompt;
  else if (typeof parsed.message === "string") message = parsed.message;
  return { sessionId, tool, message };
}

function post(payload) {
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    const req = http.request(
      {
        host: HOST,
        port: PORT,
        path: "/event",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": body.length,
        },
        timeout: 800,
      },
      (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (buf += c));
        res.on("end", () => resolve({ ok: res.statusCode === 200, status: res.statusCode, body: buf }));
      },
    );
    req.on("error", (e) => resolve({ ok: false, error: e.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, error: "timeout" });
    });
    req.write(body);
    req.end();
  });
}

async function postWithLog(payload) {
  const result = await post(payload);
  logLine(`post type=${payload.type} -> ${JSON.stringify(result)}`);
  return result;
}

(async () => {
  const raw = await readStdin();
  let parsed = {};
  try {
    if (raw.trim()) parsed = JSON.parse(raw);
  } catch {
    /* ignore parse errors — the event still goes through */
  }
  const fields = pickFields(parsed);
  const ok = await postWithLog({
    agent: "claude-code",
    type: TYPE,
    sessionId: fields.sessionId,
    tool: fields.tool,
    message: fields.message,
    timestamp: new Date().toISOString(),
  });
  // Always exit 0 — we don't want to break Claude's hook pipeline if Light is offline.
  process.exit(0);
})();
