#!/usr/bin/env node
// Wraps the `codex` CLI invocation so Light can track the process lifetime.
// Usage:  node codex-wrap.mjs <args-passed-to-codex...>
// Requires `codex` to be available on PATH.

import http from "node:http";
import { spawn } from "node:child_process";

const PORT = Number(process.env.LIGHT_PORT || 51789);
const HOST = "127.0.0.1";
const CODEX_BIN = process.env.CODEX_BIN || "codex";

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
        timeout: 600,
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(true));
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.write(body);
    req.end();
  });
}

async function notify(type, extra = {}) {
  await post({
    agent: "codex",
    type,
    timestamp: new Date().toISOString(),
    ...extra,
  });
}

const args = process.argv.slice(2);
const sessionId = `cw-${Date.now().toString(36)}-${process.pid.toString(36)}`;

(async () => {
  await notify("session_start", { sessionId });
  if (args.length > 0) {
    await notify("user_prompt", {
      sessionId,
      message: args.join(" ").slice(0, 200),
    });
  }

  const child = spawn(CODEX_BIN, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      LIGHT_CODEX_SESSION_ID: sessionId,
    },
  });

  const exitCode = await new Promise((resolve) => {
    child.on("exit", (code) => resolve(code ?? 0));
    child.on("error", () => resolve(127));
  });

  // Process exit means the interactive shell is gone; remove it immediately.
  // Turn-level done/error states are reported by the official Codex hooks.
  await notify("session_end", { sessionId });
  process.exit(exitCode);
})();
