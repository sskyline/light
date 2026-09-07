import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import stateModule from "../dist-electron/state.js";
import serverModule from "../dist-electron/server.js";
import installerModule from "../dist-electron/hookInstaller.js";

const { StateStore } = stateModule;
const { startServer } = serverModule;
const { installHooks, installAntigravityHooks } = installerModule;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const adapter = path.join(root, "hooks/antigravity-hook.mjs");
const conversationId = "a1111111-1111-4111-8111-111111111111";

function invoke(event, payload, port, command) {
  return new Promise((resolve, reject) => {
    const child = command
      ? spawn(command, { shell: true, env: { ...process.env, LIGHT_PORT: String(port) } })
      : spawn(process.execPath, [adapter, event], { env: { ...process.env, LIGHT_PORT: String(port) } });
    let stdout = "", stderr = "";
    const timeout = setTimeout(() => { child.kill(); reject(new Error("hook did not exit promptly")); }, 3000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timeout);
      try {
        assert.equal(code, 0, stderr);
        assert.equal(stdout, "{}\n", "stdout must contain only a passive protocol response");
        assert.equal(stderr, "");
        resolve();
      } catch (error) { reject(error); }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(typeof payload === "string" ? payload : JSON.stringify(payload));
  });
}

async function fixture(t) {
  const store = new StateStore();
  const server = startServer(store, 0);
  await once(server, "listening");
  t.after(() => {
    store.clearAll();
    server.closeAllConnections();
    server.close();
  });
  return { store, port: server.address().port };
}

function installFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "light-agy-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = {
    appPath: root, execPath: process.execPath,
    homeDir: path.join(dir, "home"), userDataPath: path.join(dir, "Light's data"),
  };
  const configPath = path.join(options.homeDir, ".gemini/config/hooks.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  return { options, configPath };
}

test("real HTTP event flow preserves per-turn timing, task recovery and background work", async (t) => {
  const { store, port } = await fixture(t);
  const send = (event, fields = {}) => invoke(event, { conversationId, ...fields }, port);
  const session = () => store.getState().sessions[0];
  await send("PreInvocation", { invocationNum: 0 });
  assert.equal(session().agent, "antigravity");
  assert.equal(session().status, "working");
  const startedAt = session().startedAt;
  await send("PostToolUse", { toolCall: { name: "run_command" }, error: "exit status 1" });
  assert.equal(session().status, "working", "recoverable tool failure must not end the task");
  assert.equal(session().recent[0].tool, "run_command");
  assert.match(session().recent[0].message, /exit status 1/);
  await send("PreInvocation", { invocationNum: 1 });
  assert.equal(session().startedAt, startedAt);
  await send("Stop", { fullyIdle: false, terminationReason: "NO_TOOL_CALL" });
  assert.equal(session().status, "working");
  assert.equal(session().startedAt, startedAt);
  await send("Stop", { fullyIdle: true, terminationReason: "NO_TOOL_CALL", error: "" });
  assert.equal(session().status, "done");
  await send("PreInvocation", { invocationNum: 0 });
  assert.equal(session().status, "working");
  assert.notEqual(session().startedAt, startedAt, "next turn starts a fresh timer even during done linger");
  await send("Stop", { fullyIdle: false, error: "model unavailable" });
  assert.equal(session().status, "error");
});

test("conversation IDs isolate sessions and Stop recognizes the actual ERROR enum", async (t) => {
  const { store, port } = await fixture(t);
  await invoke("PreInvocation", { conversationId }, port); // proto default zero
  await invoke("PreInvocation", { conversationId: "b2222222-2222-4222-8222-222222222222", invocationNum: 0 }, port);
  await invoke("Stop", { conversationId, terminationReason: "ERROR", fullyIdle: true }, port);
  const sessions = store.getState().sessions;
  assert.equal(sessions.length, 2);
  assert.equal(sessions.find((s) => s.sessionId.startsWith("a111")).status, "error");
  assert.equal(sessions.find((s) => s.sessionId.startsWith("b222")).status, "working");
});

test("malformed or unidentified input and unsupported events cannot create phantom sessions", async (t) => {
  const { store, port } = await fixture(t);
  for (const input of ["bad json", "null", "[]", {}, { conversationId: "" }]) {
    await invoke("PreInvocation", input, port);
  }
  await invoke("PostInvocation", { conversationId }, port);
  assert.deepEqual(store.getState().sessions, []);
});

test("offline Light and a server that never completes its response cannot block the agent", async (t) => {
  const server = http.createServer((_req, res) => { res.writeHead(200); res.write("{"); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  t.after(() => { server.closeAllConnections(); server.close(); });
  await invoke("Stop", { conversationId }, port);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await invoke("Stop", { conversationId }, port);
});

test("installer preserves other hooks, creates a backup and is idempotent", async (t) => {
  const { options, configPath } = installFixture(t);
  const original = JSON.stringify({
    "other-plugin": { enabled: false, PreToolUse: [{ matcher: "*", hooks: [{ command: "audit" }] }] },
  }, null, 2);
  fs.writeFileSync(configPath, original);
  const result = installHooks(options);
  assert.equal(result.antigravity.added, 3);
  assert.equal(result.antigravity.error, undefined);
  assert.equal(result.claude.error, undefined);
  assert.equal(result.codex.error, undefined);
  assert.equal(fs.readFileSync(result.antigravity.backupPath, "utf8"), original);
  const saved = fs.readFileSync(configPath, "utf8");
  const config = JSON.parse(saved);
  assert.deepEqual(config["other-plugin"], JSON.parse(original)["other-plugin"]);
  const light = config["light-antigravity"];
  assert.deepEqual(Object.keys(light), ["PreInvocation", "PostToolUse", "Stop"]);
  assert.equal(light.PreToolUse, undefined);
  assert.equal(light.PostToolUse[0].matcher, "*");
  assert.equal(light.PreInvocation[0].timeout, 3);
  const again = installAntigravityHooks(options);
  assert.equal(again.changed, false);
  assert.equal(again.skipped, 3);
  assert.equal(fs.readFileSync(configPath, "utf8"), saved);
  // Exercise the installed command, including its quoted path containing an apostrophe.
  const { store, port } = await fixture(t);
  await invoke("PreInvocation", { conversationId, invocationNum: 0 }, port, light.PreInvocation[0].command);
  assert.equal(store.getState().sessions[0].status, "working");
});

test("partial and disabled installations retain the user's choices", (t) => {
  const { options, configPath } = installFixture(t);
  const existing = { enabled: false, Stop: [{ command: "node /custom/antigravity-hook.mjs Stop" }] };
  fs.writeFileSync(configPath, JSON.stringify({ "light-antigravity": existing }));
  const result = installAntigravityHooks(options);
  assert.equal(result.added, 2);
  assert.equal(result.skipped, 1);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(config["light-antigravity"].enabled, false);
  assert.deepEqual(config["light-antigravity"].Stop, existing.Stop);
});

test("invalid configuration is reported without overwriting the original file", (t) => {
  const { options, configPath } = installFixture(t);
  for (const input of ["{ invalid", "[]", '{"light-antigravity": false}', '{"light-antigravity":{"Stop":{}}}']) {
    fs.writeFileSync(configPath, input);
    const result = installAntigravityHooks(options);
    assert.ok(result.error);
    assert.equal(result.changed, false);
    assert.equal(fs.readFileSync(configPath, "utf8"), input);
  }
});

test("packaged app migration updates generated paths for all agents and preserves custom hooks", (t) => {
  const { options, configPath } = installFixture(t);
  const first = installHooks(options);
  const claudePath = first.claude.path;
  const codexPath = first.codex.path;
  const claude = JSON.parse(fs.readFileSync(claudePath, "utf8"));
  const custom = { type: "command", command: "CUSTOM=1 node /custom/claude-hook.mjs stop && echo audited", timeout: 7 };
  claude.hooks.Stop[0].hooks.push(custom);
  claude.hooks.PreToolUse[0].matcher = "Bash";
  fs.writeFileSync(claudePath, JSON.stringify(claude));
  const agy = JSON.parse(fs.readFileSync(configPath, "utf8"));
  agy["light-antigravity"].enabled = false;
  agy["light-antigravity"].PostToolUse[0].matcher = "run_command";
  fs.writeFileSync(configPath, JSON.stringify(agy));
  const before = new Map([claudePath, codexPath, configPath].map((p) => [p, fs.readFileSync(p, "utf8")]));
  const installed = { ...options, execPath: "/Applications/Light.app/Contents/MacOS/Light" };
  const result = installHooks(installed);
  for (const [name, count] of [["claude", 7], ["codex", 5], ["antigravity", 3]]) {
    const target = result[name];
    assert.equal(target.error, undefined);
    assert.equal(target.added, 0);
    assert.equal(target.updated, count);
    assert.equal(target.changed, true);
    assert.equal(fs.readFileSync(target.backupPath, "utf8"), before.get(target.path));
  }
  const afterClaude = JSON.parse(fs.readFileSync(claudePath, "utf8"));
  assert.deepEqual(afterClaude.hooks.Stop[0].hooks[1], custom);
  assert.equal(afterClaude.hooks.PreToolUse[0].matcher, "Bash");
  assert.match(afterClaude.hooks.Stop[0].hooks[0].command, /\/Applications\/Light.app\/Contents\/MacOS\/Light/);
  const afterAgy = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(afterAgy["light-antigravity"].enabled, false);
  assert.equal(afterAgy["light-antigravity"].PostToolUse[0].matcher, "run_command");
  assert.match(afterAgy["light-antigravity"].Stop[0].command, /\/Applications\/Light.app\/Contents\/MacOS\/Light/);
  const repeat = installHooks(installed);
  for (const name of ["claude", "codex", "antigravity"]) {
    assert.equal(repeat[name].changed, false);
    assert.equal(repeat[name].updated, 0);
  }
});
