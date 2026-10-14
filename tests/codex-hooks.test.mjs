import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const adapter = fileURLToPath(new URL("../hooks/codex-hook.mjs", import.meta.url));
const suggestion = "This is an app-generated request for a suggested next user message. The user did not write this message.\n\nYour suggestion will appear in the user's empty message composer.";

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "light-codex-test-"));
  const received = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received.push(JSON.parse(body));
    res.end('{"ok":true}');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const env = {
    ...process.env, LIGHT_PORT: String(server.address().port),
    TMPDIR: dir, TMP: dir, TEMP: dir, LIGHT_HOOK_DEBUG: "0",
  };
  delete env.LIGHT_CODEX_SESSION_ID;
  function send(event, payload) {
    return new Promise((resolve, reject) => {
      const child = execFile(process.execPath, [adapter, event], { env, timeout: 3000 }, (error, stdout, stderr) => {
        if (error) return reject(error);
        try {
          assert.equal(stdout, "");
          assert.equal(stderr, "");
          resolve();
        } catch (error) { reject(error); }
      });
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify(payload));
    });
  }
  return { send, received, dir };
}

test("suggestion turns and their follow-up events never reach Light; other sessions still do", async (t) => {
  const { send, received, dir } = await fixture(t);
  await send("UserPromptSubmit", { session_id: "background", prompt: suggestion });
  await send("UserPromptSubmit", { session_id: "human", prompt: "修复问题" });
  await send("PreToolUse", { session_id: "background", tool_name: "Bash" });
  await send("PostToolUse", { session_id: "background", tool_name: "Bash" });
  await send("PermissionRequest", { session_id: "background", tool_name: "Bash" });
  await send("Stop", { session_id: "background" });
  await send("Stop", { session_id: "human" });
  assert.deepEqual(received.map(({ sessionId, type }) => [sessionId, type]), [
    ["human", "user_prompt"], ["human", "stop"],
  ]);
  assert.equal(fs.readdirSync(dir).some((name) => name.startsWith("light-codex-suggestion-")), false);
});

test("a real prompt resets suppression and quoted suggestion instructions are forwarded", async (t) => {
  const { send, received } = await fixture(t);
  await send("user_prompt", { threadId: "reused", input: [{ text: `\n  ${suggestion}` }] });
  const quoted = `请过滤以下后台请求：\n> ${suggestion}`;
  await send("user_prompt", { threadId: "reused", message: quoted });
  await send("PreToolUse", { threadId: "reused", tool_name: "Bash" });
  await send("Stop", { threadId: "reused" });
  assert.deepEqual(received.map(({ type }) => type), ["user_prompt", "tool_use", "stop"]);
  assert.equal(received[0].message, quoted);
});

test("suggestions without a session ID are filtered without suppressing unidentified human prompts", async (t) => {
  const { send, received } = await fixture(t);
  await send("UserPromptSubmit", { prompt: suggestion });
  await send("UserPromptSubmit", { prompt: "hello" });
  assert.equal(received.length, 1);
  assert.equal(received[0].message, "hello");
});
