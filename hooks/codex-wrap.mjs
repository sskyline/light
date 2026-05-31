#!/usr/bin/env node
// Wraps the `codex` CLI invocation so Light can show its working/done state.
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

(async () => {
  await notify("session_start");
  await notify("user_prompt", { message: args.join(" ").slice(0, 200) || "(codex session)" });

  const child = spawn(CODEX_BIN, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  const exitCode = await new Promise((resolve) => {
    child.on("exit", (code) => resolve(code ?? 0));
    child.on("error", () => resolve(127));
  });

  if (exitCode === 0) {
    await notify("stop");
  } else {
    await notify("error", { message: `codex exited with ${exitCode}` });
  }
  // Show the done/error state briefly, then remove the session from the island.
  await new Promise((r) => setTimeout(r, 4000));
  await notify("session_end");
  process.exit(exitCode);
})();
