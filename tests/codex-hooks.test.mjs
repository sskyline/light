import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import stateModule from "../dist-electron/state.js";
import serverModule from "../dist-electron/server.js";
import installerModule from "../dist-electron/hookInstaller.js";

const { StateStore } = stateModule;
const { startServer } = serverModule;
const { installHooks } = installerModule;

const adapter = fileURLToPath(new URL("../hooks/codex-hook.mjs", import.meta.url));
const suggestion = "This is an app-generated request for a suggested next user message. The user did not write this message.\n\nYour suggestion will appear in the user's empty message composer.";

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "light-codex-test-"));
  const received = [];
  const store = new StateStore();
  store.on("event", (event) => received.push(event));
  const server = startServer(store, 0);
  await once(server, "listening");
  t.after(async () => {
    store.clearAll();
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
  return { send, received, dir, store };
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

test("Interrupt reaches the real server, clears working/waiting state and allows a fresh turn", async (t) => {
  const { send, received, store } = await fixture(t);
  const session = () => store.getState().sessions.find((s) => s.sessionId === "human");
  await send("UserPromptSubmit", { session_id: "other", prompt: "继续运行" });
  for (const activeEvent of ["PreToolUse", "PermissionRequest"]) {
    await send("UserPromptSubmit", { session_id: "human", prompt: "执行任务" });
    await send(activeEvent, { session_id: "human", tool_name: "Bash" });
    assert.ok(session().startedAt);
    assert.equal(session().currentTool, "Bash");
    await send("Interrupt", { session_id: "human", turn_id: "cancelled-turn", permission_mode: "default" });
    assert.equal(session().status, "idle");
    assert.equal(session().startedAt, undefined);
    assert.equal(session().currentTool, undefined);
    assert.equal(session().recent[0].type, "interrupt");
    assert.equal(received.at(-1).message, "用户已取消本轮任务");
    assert.equal(store.getState().sessions.find((s) => s.sessionId === "other").status, "working");
  }
  await send("UserPromptSubmit", { session_id: "human", prompt: "重新开始" });
  assert.equal(session().status, "working");
  assert.ok(session().startedAt);
  assert.equal(session().lastPrompt, "重新开始");
});

test("interrupting a suggestion clears its marker without creating a phantom session", async (t) => {
  const { send, received, dir } = await fixture(t);
  await send("UserPromptSubmit", { session_id: "background", prompt: suggestion });
  await send("Interrupt", { session_id: "background" });
  assert.deepEqual(received, []);
  assert.equal(fs.readdirSync(dir).some((name) => name.startsWith("light-codex-suggestion-")), false);
  await send("UserPromptSubmit", { session_id: "background", prompt: "真实任务" });
  await send("Interrupt", { session_id: "background" });
  assert.deepEqual(received.map(({ type }) => type), ["user_prompt", "interrupt"]);
});

test("installer upgrades existing Codex hooks with Interrupt and preserves other handlers", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "light-codex-install-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = {
    appPath: path.dirname(path.dirname(adapter)), execPath: process.execPath,
    homeDir: path.join(dir, "home"), userDataPath: path.join(dir, "Light"),
  };
  const first = installHooks(options);
  const configPath = first.codex.path;
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  delete config.hooks.Interrupt;
  const custom = { hooks: [{ type: "command", command: "echo cancelled", timeout: 1 }] };
  config.hooks.Interrupt = [custom];
  const original = JSON.stringify(config);
  fs.writeFileSync(configPath, original);

  const result = installHooks(options).codex;
  assert.equal(result.error, undefined);
  assert.equal(result.added, 1);
  assert.equal(result.skipped, 5);
  assert.equal(fs.readFileSync(result.backupPath, "utf8"), original);
  const saved = fs.readFileSync(configPath, "utf8");
  const hooks = JSON.parse(saved).hooks;
  assert.deepEqual(hooks.Interrupt[0], custom);
  assert.deepEqual(hooks.Stop, config.hooks.Stop);
  const handler = hooks.Interrupt[1].hooks[0];
  assert.match(handler.command, /codex-hook\.mjs.*Interrupt/);
  assert.equal(handler.timeout, 3);
  assert.equal(hooks.Interrupt[1].matcher, undefined);
  assert.equal(installHooks(options).codex.changed, false);
  assert.equal(fs.readFileSync(configPath, "utf8"), saved);
});
