#!/usr/bin/env node
// Forwards a Codex lifecycle hook invocation to the Light desktop app.
// Usage: node codex-hook.mjs <CodexHookEvent>
// Example events: UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest, Stop

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const PORT = Number(process.env.LIGHT_PORT || 51789);
const HOST = "127.0.0.1";
const HOOK_EVENT = process.argv[2];
const DEBUG_RAW = process.env.LIGHT_HOOK_DEBUG === "1";
const LOG_PATH = path.join(os.tmpdir(), "light-codex-hook.log");
const IGNORED_EVENTS = new Set(["SessionStart", "session_start", "Enter", "enter"]);

const EVENT_MAP = new Map([
  ["SessionEnd", "session_end"],
  ["session_end", "session_end"],
  ["Exit", "session_end"],
  ["exit", "session_end"],
  ["UserPromptSubmit", "user_prompt"],
  ["user_prompt", "user_prompt"],
  ["PreToolUse", "tool_use"],
  ["tool_use", "tool_use"],
  ["PostToolUse", "tool_result"],
  ["PermissionRequest", "approval_request"],
  ["approval_request", "approval_request"],
  ["tool_result", "tool_result"],
  ["PreCompact", "notification"],
  ["PostCompact", "notification"],
  ["SubagentStart", "notification"],
  ["SubagentStop", "notification"],
  ["Stop", "stop"],
  ["stop", "stop"],
  ["error", "error"],
  ["notification", "notification"],
]);

function logLine(message) {
  try {
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${message}\n`);
  } catch {
    /* ignore */
  }
}

function truncate(value, max) {
  if (typeof value !== "string") return undefined;
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

async function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    if (process.stdin.isTTY) return resolve("");
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    setTimeout(() => resolve(data), 1000).unref();
  });
}

function getPath(obj, pathParts) {
  let cur = obj;
  for (const part of pathParts) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = cur[part];
  }
  return typeof cur === "string" ? cur : undefined;
}

function findStringByKey(obj, keys, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 4) return undefined;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findStringByKey(item, keys, depth + 1);
      if (found) return found;
    }
    return undefined;
  }

  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value;
  }

  for (const value of Object.values(obj)) {
    const found = findStringByKey(value, keys, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function pickSessionId(parsed) {
  if (process.env.LIGHT_CODEX_SESSION_ID) return process.env.LIGHT_CODEX_SESSION_ID;
  return findStringByKey(parsed, [
    "session_id",
    "sessionId",
    "thread_id",
    "threadId",
    "conversation_id",
    "conversationId",
  ]);
}

function pickTool(parsed) {
  return findStringByKey(parsed, [
    "tool_name",
    "toolName",
    "tool",
    "name",
    "subagent_type",
    "subagentType",
  ]);
}

function pickPrompt(parsed) {
  return findStringByKey(parsed, [
    "prompt",
    "user_prompt",
    "userPrompt",
    "message",
    "text",
    "input",
  ]);
}

function pickCommand(parsed) {
  return (
    getPath(parsed, ["tool_input", "command"]) ||
    getPath(parsed, ["toolInput", "command"]) ||
    getPath(parsed, ["input", "command"]) ||
    getPath(parsed, ["arguments", "command"]) ||
    findStringByKey(parsed, ["command", "cmd"])
  );
}

function buildMessage(type, hookEvent, parsed, tool) {
  if (type === "user_prompt") return truncate(pickPrompt(parsed), 400);
  if (type === "approval_request") {
    const command = pickCommand(parsed);
    if (command && tool) return truncate(`${tool}: ${command}`, 400);
    if (command) return truncate(command, 400);
    return truncate(tool ? `${tool} approval requested` : "approval requested", 400);
  }
  if (type === "tool_use") {
    const command = pickCommand(parsed);
    if (command && tool) return truncate(`${tool}: ${command}`, 400);
    if (command) return truncate(command, 400);
    return truncate(tool, 400);
  }
  if (type === "tool_result") {
    const command = pickCommand(parsed);
    if (command && tool) return truncate(`completed: ${tool}: ${command}`, 400);
    if (command) return truncate(`completed: ${command}`, 400);
    return truncate(tool ? `${tool} completed` : "tool completed", 400);
  }
  if (type === "notification") {
    const command = pickCommand(parsed);
    if (hookEvent === "PostToolUse") {
      return truncate(command ? `completed: ${command}` : "tool completed", 400);
    }
    if (hookEvent === "PermissionRequest") {
      return truncate(command ? `approval requested: ${command}` : "approval requested", 400);
    }
    return truncate(pickPrompt(parsed) || hookEvent, 400);
  }
  return truncate(pickPrompt(parsed), 400);
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
        res.on("data", (chunk) => (buf += chunk));
        res.on("end", () =>
          resolve({ ok: res.statusCode === 200, status: res.statusCode, body: buf }),
        );
      },
    );
    req.on("error", (error) => resolve({ ok: false, error: error.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, error: "timeout" });
    });
    req.write(body);
    req.end();
  });
}

(async () => {
  const type = EVENT_MAP.get(HOOK_EVENT);
  logLine(`invoked event=${HOOK_EVENT} pid=${process.pid} cwd=${process.cwd()}`);

  if (IGNORED_EVENTS.has(HOOK_EVENT)) {
    logLine(`ignored event=${HOOK_EVENT}`);
    process.exit(0);
  }

  if (!type) {
    console.error(`codex-hook: unsupported hook event "${HOOK_EVENT}"`);
    process.exit(2);
  }

  const raw = await readStdin();
  if (DEBUG_RAW && raw.trim()) logLine(`raw=${truncate(raw.replace(/\s+/g, " "), 4000)}`);

  let parsed = {};
  try {
    if (raw.trim()) parsed = JSON.parse(raw);
  } catch (error) {
    logLine(`json_parse_error=${error instanceof Error ? error.message : String(error)}`);
  }

  const tool = pickTool(parsed);
  const payload = {
    agent: "codex",
    type,
    sessionId: pickSessionId(parsed),
    tool: truncate(tool, 80),
    message: buildMessage(type, HOOK_EVENT, parsed, tool),
    timestamp: new Date().toISOString(),
  };

  const result = await post(payload);
  logLine(`post type=${payload.type} tool=${payload.tool || ""} -> ${JSON.stringify(result)}`);
  process.exit(0);
})();
