import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import stateModule from "../dist-electron/state.js";
import serverModule from "../dist-electron/server.js";
import installerModule from "../dist-electron/hookInstaller.js";
import reviewsModule from "../dist-electron/codexReviews.js";
import titlesModule from "../dist-electron/codexTitles.js";

const { StateStore } = stateModule;
const { startServer } = serverModule;
const { installHooks } = installerModule;
const { readCodexThreadTitle } = titlesModule;

const adapter = fileURLToPath(new URL("../hooks/codex-hook.mjs", import.meta.url));
const suggestion = "This is an app-generated request for a suggested next user message. The user did not write this message.\n\nYour suggestion will appear in the user's empty message composer.";

async function fixture(t, script = adapter, watchReviews = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "light-codex-test-"));
  const received = [];
  const store = new StateStore();
  store.on("event", (event) => received.push(event));
  const db = path.join(dir, "state_5.sqlite");
  const watcher = watchReviews ? new reviewsModule.CodexReviewWatcher((thread, reason) => store.recordCodexDenial(thread, reason), db) : undefined;
  const server = startServer(store, 0, (thread, turn, type) => watcher?.track(thread, turn, type));
  await once(server, "listening");
  t.after(async () => {
    watcher?.stop();
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
  delete env.REX_SESSION;
  delete env.REX_BLOCK;
  delete env.TERM_PROGRAM;
  delete env.ITERM_SESSION_ID;
  delete env.GHOSTTY_SURFACE_ID;
  delete env.TMUX;
  delete env.STY;
  delete env.SSH_CONNECTION;
  function send(event, payload, sourceEnv = {}) {
    return new Promise((resolve, reject) => {
      const child = execFile(process.execPath, [script, event], { env: { ...env, ...sourceEnv }, timeout: 3000 }, (error, stdout, stderr) => {
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
  return { send, received, dir, store, watcher, db };
}

test("Claude and Codex tool call IDs survive the hook, HTTP and session snapshot", async (t) => {
  for (const [file, start, finish, idField] of [
    ["claude-hook.mjs", "tool_use", "tool_result", "tool_use_id"],
    ["codex-hook.mjs", "PreToolUse", "PostToolUse", "call_id"],
  ]) {
    const script = fileURLToPath(new URL(`../hooks/${file}`, import.meta.url));
    const { send, store } = await fixture(t, script);
    const payload = { session_id: "pair-test", tool_name: "Bash", tool_input: { command: "npm test" }, [idField]: "call-a" };
    await send(start, payload);
    await send(finish, payload);
    const [result, call] = store.getState().sessions[0].recent;
    assert.equal(call.toolCallId, "call-a");
    assert.equal(result.toolCallId, call.toolCallId);
    assert.match(call.message, /npm test/);
  }
});

test("Claude auto-mode denial reaches Light without making a permission decision", async (t) => {
  const { send, store } = await fixture(t, fileURLToPath(new URL("../hooks/claude-hook.mjs", import.meta.url)));
  const input = { session_id: "example", tool_name: "Read", permission_mode: "auto" };
  await send("PermissionRequest", input);
  assert.deepEqual(store.getState().sessions[0].recent, []);
  await send("auto_approval_failed", { ...input, hook_event_name: "PermissionDenied", reason: "Classifier unavailable" });
  const session = store.getState().sessions[0];
  assert.equal(session.status, "auto_approval_failed");
  assert.deepEqual(session.recent.map(e => [e.type, e.message]), [["auto_approval_failed", "Classifier unavailable"]]);
});

test("macOS hook routes each thread to its own terminal until its source changes or it ends", { skip: process.platform !== "darwin" }, async (t) => {
  const { send, store } = await fixture(t);
  const session_id = "aaaaaaaa-1111-4111-8111-111111111111";
  const pane = "w0t1p2:bbbbbbbb-2222-4222-8222-222222222222";
  const env = { TMUX: "", STY: "", SSH_CONNECTION: "", TERM_PROGRAM: "iTerm.app", ITERM_SESSION_ID: pane };
  await send("UserPromptSubmit", { session_id, prompt: "test" }, env);
  const [session] = store.getState().sessions;
  assert.equal(session.jumpTarget, "iterm");
  assert.deepEqual(store.getJumpTarget(session.key), { kind: "iterm", id: pane });
  assert.ok(!JSON.stringify(session).includes(pane));
  await send("PreToolUse", { session_id, tool_name: "Bash" }, { ...env, TERM_PROGRAM: "" });
  assert.deepEqual(store.getJumpTarget(session.key), { kind: "codex", id: session_id });
  await send("SessionEnd", { session_id }, env);
  assert.equal(store.getJumpTarget(session.key), undefined);
});

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

test("Codex titles use the full session ID and the latest local index entry", async (t) => {
  const { send, dir, store } = await fixture(t);
  const firstId = "0198abcd-1234-7000-8000-000000000001";
  const secondId = "0198abcd-1234-7000-8000-000000000002";
  await send("UserPromptSubmit", { session_id: firstId, prompt: "第一条提问" });
  await send("UserPromptSubmit", { session_id: secondId, prompt: "第二条提问" });
  await send("Stop", { session_id: firstId });

  const sessions = store.getState().sessions;
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].sessionId, sessions[1].sessionId);
  const first = sessions.find((session) => session.status === "done");
  const second = sessions.find((session) => session.status === "working");
  assert.deepEqual(store.getTitleSession(first.key), { agent: "codex", id: firstId });
  assert.deepEqual(store.getTitleSession(second.key), { agent: "codex", id: secondId });
  assert.equal(await readCodexThreadTitle(firstId, dir), null);

  const index = [
    { id: firstId, thread_name: "旧标题" },
    { id: firstId, thread_name: "新标题" },
    { id: secondId, thread_name: "另一个会话" },
  ].map((entry) => JSON.stringify(entry));
  fs.writeFileSync(path.join(dir, "session_index.jsonl"), [...index, "{"].join("\n"));
  assert.equal(await readCodexThreadTitle(firstId, dir), "新标题");
  assert.equal(await readCodexThreadTitle(secondId, dir), "另一个会话");
  assert.equal(await readCodexThreadTitle("unknown", dir), null);

  await send("SessionEnd", { session_id: firstId });
  assert.equal(store.getTitleSession(first.key), undefined);
  assert.deepEqual(store.getTitleSession(second.key), { agent: "codex", id: secondId });
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

test("Codex hooks correlate only this turn's final Guardian denials, including a verdict written after Stop", {
  skip: process.platform === "win32",
}, async t => {
  const { send, store, watcher, db } = await fixture(t, adapter, true);
  const thread = "aaaaaaaa-0000-4000-8000-000000000000";
  const turn = "11111111-0000-4000-8000-000000000000";
  const other = "bbbbbbbb-0000-4000-8000-000000000000";
  const input = { session_id: thread, turn_id: turn };
  const sql = stmt => execFileSync("sqlite3", [db, stmt]);
  sql("CREATE TABLE guardian_review_feedback(id TEXT PRIMARY KEY, thread_id TEXT, record BLOB)");
  const record = (id, status, session = thread, reviewedTurn = turn) => {
    const json = JSON.stringify({ reviewed_thread_id: session, reviewed_turn_id: reviewedTurn, status,
      decision: JSON.stringify({ outcome: "deny", rationale: "test reason" }) });
    sql(`INSERT INTO guardian_review_feedback VALUES('${id}', '${session}', cast('${json}' as blob))`);
  };
  await send("UserPromptSubmit", input);
  record("untouched", "approved");
  record("aborted", "aborted");
  record("another-session", "denied", other);
  record("another-turn", "denied", thread, other);
  await watcher.poll();
  const current = () => store.getState().sessions[0];
  assert.equal(current().status, "working");
  record("first", "denied");
  await watcher.poll();
  assert.equal(current().status, "auto_approval_failed");
  assert.equal(current().recent[0].message, "test reason");
  await send("Stop", input);
  record("late", "timedOut");
  await watcher.poll();
  await watcher.poll();
  assert.equal(current().status, "done");
  assert.deepEqual(current().recent.map(e => e.type), ["stop", "auto_approval_failed", "auto_approval_failed", "user_prompt"]);
  assert.equal(current().recent[1].message, "自动审批超时");
  await send("UserPromptSubmit", { ...input, turn_id: "cccccccc-0000-4000-8000-000000000000" });
  await watcher.poll();
  assert.equal(current().status, "working");
});
