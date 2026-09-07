#!/usr/bin/env node
// Passive Antigravity hooks only: PreInvocation, PostToolUse, Stop.
// PreToolUse is intentionally unsupported: its response controls tool permission.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const logPath = path.join(os.tmpdir(), "light-antigravity-hook.log");
const hookEvent = process.argv[2];

function log(message) {
  try { fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`); } catch {}
}

function text(value, max = 400) {
  return typeof value === "string" ? value.slice(0, max) : undefined;
}

function eventFrom(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
  // Never merge malformed/missing conversation IDs into a shared default session.
  if (typeof payload.conversationId !== "string" || !payload.conversationId.trim()) return;
  const event = {
    agent: "antigravity",
    sessionId: payload.conversationId,
    timestamp: new Date().toISOString(),
  };
  if (hookEvent === "PreInvocation") {
    // invocationNum resets to zero each turn, not each conversation. Subsequent
    // model calls keep the existing timer. Omitted proto scalar means zero.
    event.type = (payload.invocationNum ?? 0) === 0 ? "user_prompt" : "tool_result";
  } else if (hookEvent === "PostToolUse") {
    event.type = "tool_result";
    event.tool = text(payload.toolCall?.name, 80);
    // A tool error may be recovered by the agent; only Stop marks task failure.
    event.message = payload.error
      ? text(`工具失败：${text(payload.error) || "unknown error"}`)
      : text(event.tool ? `${event.tool} completed` : "tool completed");
  } else if (hookEvent === "Stop") {
    const reason = text(payload.terminationReason);
    if (payload.error || reason?.toUpperCase() === "ERROR") {
      event.type = "error";
      event.message = text(payload.error) || reason;
    } else if (payload.fullyIdle === false) {
      event.type = "tool_result";
      event.message = "后台任务仍在运行";
    } else {
      event.type = "stop";
      event.message = reason;
    }
  } else {
    return;
  }
  return event;
}

async function readInput() {
  return new Promise((resolve) => {
    let input = "";
    let bytes = 0;
    const done = (value) => {
      clearTimeout(timer);
      process.stdin.pause();
      resolve(value);
    };
    const timer = setTimeout(() => done(undefined), 700);
    if (process.stdin.isTTY) return done(undefined);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 1024 * 1024) return done(undefined);
      input += chunk;
    });
    process.stdin.once("end", () => done(input));
    process.stdin.once("error", () => done(undefined));
  });
}

async function post(event) {
  const port = Number(process.env.LIGHT_PORT || 51789);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return "invalid_port";
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify(event));
    let request;
    const finish = (result) => {
      clearTimeout(deadline);
      resolve(result);
    };
    // Wall-clock deadline also bounds servers that accept but never finish a body.
    const deadline = setTimeout(() => {
      request?.destroy();
      finish("timeout");
    }, 800);
    request = http.request({
      host: "127.0.0.1", port, path: "/event", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": body.length },
    }, (response) => {
      response.resume();
      response.once("end", () => finish(`http_${response.statusCode}`));
      response.once("error", () => finish("response_error"));
    });
    request.once("error", () => finish("unavailable"));
    request.end(body);
  });
}

try {
  const raw = await readInput();
  const event = raw ? eventFrom(JSON.parse(raw)) : undefined;
  if (event) {
    const result = await post(event);
    // Do not log stdin, prompts, tool arguments, or the HTTP response body.
    log(`event=${hookEvent} type=${event.type} result=${result}`);
  }
} catch {
  log("ignored invalid hook input or transport failure");
}
// No injected steps, permission decisions, or forced continuation. Always exit
// successfully even when Light is stopped; stdout is exclusively protocol JSON.
process.stdout.write("{}\n", () => process.exit(0));
