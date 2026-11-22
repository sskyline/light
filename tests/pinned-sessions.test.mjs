import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import stateModule from "../dist-electron/state.js";
import serverModule from "../dist-electron/server.js";

const { StateStore, sanitizeCwd } = stateModule;
const { startServer } = serverModule;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const claudeHook = path.join(root, "hooks", "claude-hook.mjs");
const codexHook = path.join(root, "hooks", "codex-hook.mjs");

const IDLE_GC_MS = 60 * 60_000;
const CLAUDE_UUID = "11111111-1111-4111-8111-111111111111";
const CODEX_UUID = "22222222-2222-4222-8222-222222222222";
const GHOSTTY_UUID = "33333333-3333-4333-8333-333333333333";
const REX_SESSION = "session:44444444-4444-4444-8444-444444444444";
const REX_BLOCK = "block:55555555-5555-4555-8555-555555555555";
const ITERM_PANE = "w0t1p2:66666666-6666-4666-8666-666666666666";

function runHook(script, event, payload, { port, cwd, env: extraEnv = {} }) {
  const env = {
    ...process.env,
    LIGHT_PORT: String(port),
    LIGHT_HOOK_DEBUG: "0",
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

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, event], {
      cwd,
      env: { ...env, ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`hook timed out: ${script} ${event}`));
    }, 4000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        assert.equal(code, 0, stderr);
        assert.equal(stdout, "");
        assert.equal(stderr, "");
        resolve();
      } catch (err) {
        reject(err);
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

test("pinning prevents IDLE_GC_MS expiry and unpinning starts IDLE_GC_MS countdown", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000 });
  const store = new StateStore();
  const states = [];
  store.on("state", (s) => states.push(s));
  t.after(() => store.clearAll());

  assert.equal(store.setPinned("claude-code::missing", true), false);

  store.ingest({
    agent: "claude-code",
    sessionId: CLAUDE_UUID,
    type: "user_prompt",
    message: "keep me alive",
    timestamp: new Date().toISOString(),
  });
  store.ingest({
    agent: "claude-code",
    sessionId: CLAUDE_UUID,
    type: "stop",
    timestamp: new Date().toISOString(),
  });

  const key = `claude-code::${CLAUDE_UUID}`;
  assert.equal("pinned" in store.getState().sessions[0], false, "unpinned snapshot omits pinned key");

  // Settle from done -> idle (8s linger)
  t.mock.timers.tick(8_000);
  assert.equal(store.getState().sessions[0].status, "idle");

  // Pin before 1-hour GC expires
  t.mock.timers.tick(30 * 60_000);
  assert.equal(store.setPinned(key, true), true);
  assert.equal(store.getState().sessions[0].pinned, true);
  assert.equal(states.at(-1).sessions[0].pinned, true);

  // Advance well past IDLE_GC_MS (multiple hours): pinned session must remain
  t.mock.timers.tick(IDLE_GC_MS * 4);
  assert.equal(store.getState().sessions.length, 1);
  assert.equal(store.getState().sessions[0].key, key);
  assert.equal(store.getState().sessions[0].pinned, true);

  // Unpinning clears pinned flag and starts a fresh 1-hour GC countdown
  assert.equal(store.setPinned(key, false), true);
  assert.equal("pinned" in store.getState().sessions[0], false);

  t.mock.timers.tick(IDLE_GC_MS - 1);
  assert.equal(store.getState().sessions.length, 1, "still present 1ms before IDLE_GC_MS");

  t.mock.timers.tick(1);
  assert.deepEqual(store.getState().sessions, [], "collected exactly at IDLE_GC_MS after unpinning");
});

test("session_end on a pinned session transitions to idle while retaining jumpTarget and resumeContext", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 2_000_000 });
  const store = new StateStore();
  t.after(() => store.clearAll());

  const projectDir = path.resolve(root);
  store.ingest({
    agent: "claude-code",
    sessionId: CLAUDE_UUID.toUpperCase(),
    type: "user_prompt",
    message: "investigate issue",
    cwd: `  ${projectDir}  `,
    terminal: { kind: "rex", session: REX_SESSION, id: REX_BLOCK },
    timestamp: new Date().toISOString(),
  });
  store.ingest({
    agent: "claude-code",
    sessionId: CLAUDE_UUID,
    type: "tool_use",
    tool: "Bash",
    message: "npm test",
    timestamp: new Date().toISOString(),
  });

  const key = `claude-code::${CLAUDE_UUID}`;
  assert.equal(store.getState().sessions[0].status, "working");
  assert.ok(store.getState().sessions[0].currentTool);
  assert.ok(store.getState().sessions[0].startedAt);

  store.setPinned(key, true);
  assert.equal(store.isSessionEnded(key), false);

  store.ingest({
    agent: "claude-code",
    sessionId: CLAUDE_UUID,
    type: "session_end",
    timestamp: new Date().toISOString(),
  });

  const [afterEnd] = store.getState().sessions;
  assert.ok(afterEnd, "pinned session must survive session_end");
  assert.equal(afterEnd.status, "idle");
  assert.equal(afterEnd.pinned, true);
  assert.equal(afterEnd.currentTool, undefined);
  assert.equal(afterEnd.startedAt, undefined);
  assert.equal(store.isSessionEnded(key), true);
  assert.deepEqual(store.getResumeContext(key), {
    agent: "claude-code",
    sessionId: CLAUDE_UUID,
    cwd: projectDir,
  });

  if (process.platform === "darwin") {
    assert.equal(afterEnd.jumpTarget, "rex");
    assert.deepEqual(store.getJumpTarget(key), {
      kind: "rex",
      session: REX_SESSION,
      id: REX_BLOCK,
    });
  }

  // Must also remain exempt from IDLE_GC_MS after session_end
  t.mock.timers.tick(IDLE_GC_MS * 2);
  assert.equal(store.getState().sessions.length, 1);

  // Subsequent activity on the resumed session clears ended and keeps pinned: true
  store.ingest({
    agent: "claude-code",
    sessionId: CLAUDE_UUID,
    type: "user_prompt",
    message: "continue work",
    timestamp: new Date().toISOString(),
  });
  assert.equal(store.isSessionEnded(key), false);
  assert.equal(store.getState().sessions[0].status, "working");
  assert.equal(store.getState().sessions[0].pinned, true);
});

test("manual removeSession deletes a pinned session and removes it from pinnedFilePath", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "light-pin-remove-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pinnedFilePath = path.join(dir, "pinned-sessions.json");

  const store = new StateStore({ pinnedFilePath });
  t.after(() => store.clearAll());

  store.ingest({
    agent: "codex",
    sessionId: CODEX_UUID,
    type: "user_prompt",
    message: "pinned codex task",
    cwd: path.resolve(root),
    terminal: { kind: "iterm", id: ITERM_PANE },
    timestamp: "2026-11-21T10:00:00.000Z",
  });

  const key = `codex::${CODEX_UUID}`;
  store.setPinned(key, true);

  const savedBefore = JSON.parse(fs.readFileSync(pinnedFilePath, "utf8"));
  assert.equal(savedBefore.version, 1);
  assert.equal(savedBefore.sessions.length, 1);
  assert.equal(savedBefore.sessions[0].key, key);

  store.removeSession(key);
  assert.deepEqual(store.getState().sessions, []);

  const savedAfter = JSON.parse(fs.readFileSync(pinnedFilePath, "utf8"));
  assert.deepEqual(savedAfter, { version: 1, sessions: [] });

  const reloaded = new StateStore({ pinnedFilePath });
  t.after(() => reloaded.clearAll());
  assert.deepEqual(reloaded.getState().sessions, []);
});

test("persistence round-trip restores only pinned sessions with jumpTarget and resumeContext and rejects corrupted entries", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "light-pin-persist-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pinnedFilePath = path.join(dir, "nested", "pinned-sessions.json");

  const claudeDir = path.join(dir, "claude-project");
  const codexDir = path.join(dir, "codex-project");
  const ghosttyClaudeUuid = "77777777-7777-4777-8777-777777777777";

  const store1 = new StateStore({ pinnedFilePath });
  t.after(() => store1.clearAll());

  // 1. Pinned Claude session in Rex
  store1.ingest({
    agent: "claude-code",
    sessionId: CLAUDE_UUID,
    type: "user_prompt",
    message: "build persistence",
    cwd: claudeDir,
    terminal: { kind: "rex", session: REX_SESSION, id: REX_BLOCK },
    timestamp: "2026-11-21T08:00:00.000Z",
  });
  store1.ingest({
    agent: "claude-code",
    sessionId: CLAUDE_UUID,
    type: "stop",
    timestamp: "2026-11-21T08:05:00.000Z",
  });
  const claudeKey = `claude-code::${CLAUDE_UUID}`;
  store1.setPinned(claudeKey, true);

  // Verify tool_use bursts on a pinned session do NOT synchronously write to disk on every event
  let writeCount = 0;
  const origWriteFileSync = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", (...args) => {
    writeCount++;
    return origWriteFileSync(...args);
  });
  for (let i = 0; i < 15; i++) {
    store1.ingest({
      agent: "claude-code",
      sessionId: CLAUDE_UUID,
      type: i % 2 === 0 ? "tool_use" : "tool_result",
      tool: "Bash",
      message: `step-${i}`,
      cwd: claudeDir,
      terminal: { kind: "rex", session: REX_SESSION, id: REX_BLOCK },
      timestamp: `2026-11-21T08:06:${String(i).padStart(2, "0")}.000Z`,
    });
  }
  assert.equal(writeCount, 0, "tool_use/tool_result bursts with unchanged metadata must not call writeFileSync");
  store1.ingest({
    agent: "claude-code",
    sessionId: CLAUDE_UUID,
    type: "stop",
    cwd: claudeDir,
    terminal: { kind: "rex", session: REX_SESSION, id: REX_BLOCK },
    timestamp: "2026-11-21T08:07:00.000Z",
  });
  assert.equal(writeCount, 1, "turn boundary (stop) persists once");

  // 2. Unpinned Codex session in iTerm (must NOT be persisted)
  store1.ingest({
    agent: "codex",
    sessionId: CODEX_UUID,
    type: "user_prompt",
    message: "ephemeral codex",
    cwd: codexDir,
    terminal: { kind: "iterm", id: ITERM_PANE },
    timestamp: "2026-11-21T08:10:00.000Z",
  });

  // 3. Pinned Codex session in Ghostty using UPPERCASE hex letters A-F in UUID
  const upperCodexUuid = "ABCDEF12-34AB-4CDE-8F01-ABCDEF123456";
  const pinnedCodexUuid = upperCodexUuid.toLowerCase();
  const pinnedCodexKey = `codex::${pinnedCodexUuid}`;
  store1.ingest({
    agent: "codex",
    sessionId: upperCodexUuid,
    type: "user_prompt",
    message: "pinned ghostty codex",
    cwd: codexDir,
    terminal: { kind: "ghostty", id: GHOSTTY_UUID },
    timestamp: "2026-11-21T08:12:00.000Z",
  });
  store1.setPinned(pinnedCodexKey, true);

  // 4. Legacy persisted entry whose sessionId field on disk had uppercase hex letters
  const legacyUpperUuid = "FEDCBA98-7654-4321-89AB-CDEF01234567";
  const legacyLowerUuid = legacyUpperUuid.toLowerCase();
  const legacyKey = `claude-code::${legacyLowerUuid}`;

  // Inject legacy uppercase entry + malformed/corrupted entries alongside the valid persisted sessions
  const rawDisk = JSON.parse(fs.readFileSync(pinnedFilePath, "utf8"));
  assert.equal(rawDisk.sessions.length, 2);
  rawDisk.sessions.push(
    {
      key: legacyKey,
      agent: "claude-code",
      sessionId: legacyUpperUuid.slice(0, 12),
      lastEventAt: "2026-11-21T08:15:00Z",
      cwd: claudeDir,
      resumeId: legacyUpperUuid,
    },
    null,
    "not-an-object",
    { key: "evil::1234", agent: "evil", sessionId: "1234", lastEventAt: "2026-11-21T08:00:00Z" },
    { key: "claude-code::../traversal", agent: "claude-code", sessionId: "../traversal", lastEventAt: "2026-11-21T08:00:00Z" },
    {
      key: `claude-code::${ghosttyClaudeUuid}`,
      agent: "claude-code",
      sessionId: ghosttyClaudeUuid.slice(0, 12),
      lastEventAt: "not-a-valid-date",
    },
    {
      key: `claude-code::${ghosttyClaudeUuid}`,
      agent: "claude-code",
      sessionId: ghosttyClaudeUuid.slice(0, 12),
      lastEventAt: "2026-11-21T08:00:00Z",
      cwd: "relative/unsafe/path",
    },
    {
      key: `claude-code::${ghosttyClaudeUuid}`,
      agent: "claude-code",
      sessionId: ghosttyClaudeUuid.slice(0, 12),
      lastEventAt: "2026-11-21T08:00:00Z",
      resumeId: "not-a-uuid",
    },
    ...(process.platform === "darwin"
      ? [{
          key: `codex::${ghosttyClaudeUuid}`,
          agent: "codex",
          sessionId: ghosttyClaudeUuid.slice(0, 12),
          lastEventAt: "2026-11-21T08:00:00Z",
          jump: { kind: "rex", session: "bad-session", id: "rm -rf /" },
        }]
      : []),
  );
  fs.writeFileSync(pinnedFilePath, JSON.stringify(rawDisk, null, 2), "utf8");

  const store2 = new StateStore({ pinnedFilePath });
  t.after(() => store2.clearAll());

  const restoredSessions = store2.getState().sessions;
  assert.equal(restoredSessions.length, 3, "valid pinned sessions (including uppercase UUIDs) are restored");

  const restoredClaude = restoredSessions.find((s) => s.key === claudeKey);
  const restoredCodex = restoredSessions.find((s) => s.key === pinnedCodexKey);
  const restoredLegacy = restoredSessions.find((s) => s.key === legacyKey);
  assert.ok(restoredClaude);
  assert.ok(restoredCodex);
  assert.ok(restoredLegacy);
  assert.equal(restoredCodex.sessionId, pinnedCodexUuid.slice(0, 12));
  assert.equal(restoredLegacy.sessionId, legacyLowerUuid.slice(0, 12));
  assert.deepEqual(store2.getResumeContext(legacyKey), {
    agent: "claude-code",
    sessionId: legacyLowerUuid,
    cwd: claudeDir,
  });

  for (const s of [restoredClaude, restoredCodex, restoredLegacy]) {
    assert.equal(s.status, "idle");
    assert.equal(s.pinned, true);
    assert.equal(s.currentTool, undefined);
    assert.equal(s.startedAt, undefined);
    assert.equal(store2.isSessionEnded(s.key), true);
  }
  assert.equal(restoredClaude.lastPrompt, "build persistence");
  assert.deepEqual(restoredClaude.turnEnd, { type: "stop", timestamp: "2026-11-21T08:07:00.000Z" });
  assert.ok(restoredClaude.recent.length > 0 && restoredClaude.recent.length <= 30);

  assert.deepEqual(store2.getResumeContext(claudeKey), {
    agent: "claude-code",
    sessionId: CLAUDE_UUID,
    cwd: claudeDir,
  });
  assert.deepEqual(store2.getResumeContext(pinnedCodexKey), {
    agent: "codex",
    sessionId: pinnedCodexUuid,
    cwd: codexDir,
  });
  assert.equal(store2.getResumeContext(`codex::${CODEX_UUID}`), undefined);

  if (process.platform === "darwin") {
    assert.equal(restoredClaude.jumpTarget, "rex");
    assert.deepEqual(store2.getJumpTarget(claudeKey), {
      kind: "rex",
      session: REX_SESSION,
      id: REX_BLOCK,
    });
    assert.equal(restoredCodex.jumpTarget, "ghostty");
    assert.deepEqual(store2.getJumpTarget(pinnedCodexKey), {
      kind: "ghostty",
      id: GHOSTTY_UUID,
    });
  }

  // Completely broken JSON file must fail open to empty state without throwing
  const brokenPath = path.join(dir, "broken.json");
  fs.writeFileSync(brokenPath, "{corrupted json", "utf8");
  const store3 = new StateStore({ pinnedFilePath: brokenPath });
  t.after(() => store3.clearAll());
  assert.deepEqual(store3.getState().sessions, []);
});

test("claude-hook.mjs and codex-hook.mjs forward cwd from stdin JSON or process.cwd(), and invalid cwds are rejected", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "light-hook-cwd-"));
  const fallbackDir = fs.realpathSync(dir);
  const explicitClaudeDir = path.join(fallbackDir, "explicit-claude");
  const explicitCodexDir = path.join(fallbackDir, "explicit-codex");
  fs.mkdirSync(explicitClaudeDir, { recursive: true });
  fs.mkdirSync(explicitCodexDir, { recursive: true });

  const store = new StateStore();
  const server = startServer(store, 0);
  await once(server, "listening");
  const port = server.address().port;

  t.after(async () => {
    store.clearAll();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Unit assertions on sanitizeCwd directly
  assert.equal(sanitizeCwd(`  ${explicitClaudeDir}  `), explicitClaudeDir);
  assert.equal(sanitizeCwd("relative/path"), undefined);
  assert.equal(sanitizeCwd("./local"), undefined);
  assert.equal(sanitizeCwd(`${explicitClaudeDir}\ninjected`), undefined);
  assert.equal(sanitizeCwd(`${explicitClaudeDir}\n`), undefined);
  assert.equal(sanitizeCwd(`${explicitClaudeDir}\r`), undefined);
  assert.equal(sanitizeCwd(`${explicitClaudeDir}\0null`), undefined);
  assert.equal(sanitizeCwd("/" + "a".repeat(1024)), undefined);
  assert.equal(sanitizeCwd(""), undefined);
  assert.equal(sanitizeCwd(null), undefined);

  // 1. Explicit stdin JSON cwd for Claude & Codex
  await runHook(
    claudeHook,
    "user_prompt",
    { session_id: CLAUDE_UUID, prompt: "from json cwd", cwd: `  ${explicitClaudeDir}  ` },
    { port, cwd: fallbackDir },
  );
  await runHook(
    codexHook,
    "UserPromptSubmit",
    { session_id: CODEX_UUID, prompt: "from json cwd", cwd: `  ${explicitCodexDir}  ` },
    { port, cwd: fallbackDir },
  );

  assert.deepEqual(store.getResumeContext(`claude-code::${CLAUDE_UUID}`), {
    agent: "claude-code",
    sessionId: CLAUDE_UUID,
    cwd: explicitClaudeDir,
  });
  assert.deepEqual(store.getResumeContext(`codex::${CODEX_UUID}`), {
    agent: "codex",
    sessionId: CODEX_UUID,
    cwd: explicitCodexDir,
  });

  // 2. Fallback process.cwd() when stdin JSON omits cwd or has whitespace-only cwd
  const fallbackClaudeUuid = "99999999-9999-4999-8999-999999999999";
  const fallbackCodexUuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  await runHook(
    claudeHook,
    "user_prompt",
    { session_id: fallbackClaudeUuid, prompt: "fallback cwd", cwd: "   " },
    { port, cwd: fallbackDir },
  );
  await runHook(
    codexHook,
    "UserPromptSubmit",
    { session_id: fallbackCodexUuid, prompt: "fallback cwd" },
    { port, cwd: fallbackDir },
  );

  assert.deepEqual(store.getResumeContext(`claude-code::${fallbackClaudeUuid}`), {
    agent: "claude-code",
    sessionId: fallbackClaudeUuid,
    cwd: fallbackDir,
  });
  assert.deepEqual(store.getResumeContext(`codex::${fallbackCodexUuid}`), {
    agent: "codex",
    sessionId: fallbackCodexUuid,
    cwd: fallbackDir,
  });

  // 3. Relative or newline-tainted cwd values sent by hooks are rejected by StateStore
  const badRelUuid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const badNewlineUuid = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  await runHook(
    claudeHook,
    "user_prompt",
    { session_id: badRelUuid, prompt: "bad rel cwd", cwd: "relative/subpath" },
    { port, cwd: fallbackDir },
  );
  await runHook(
    codexHook,
    "UserPromptSubmit",
    { session_id: badNewlineUuid, prompt: "bad newline cwd", cwd: "/tmp/valid-prefix\nrm -rf /" },
    { port, cwd: fallbackDir },
  );

  assert.deepEqual(store.getResumeContext(`claude-code::${badRelUuid}`), {
    agent: "claude-code",
    sessionId: badRelUuid,
  });
  assert.deepEqual(store.getResumeContext(`codex::${badNewlineUuid}`), {
    agent: "codex",
    sessionId: badNewlineUuid,
  });
});

test("updateJumpTarget updates stored JumpTarget, clears ended state, and persists for pinned sessions", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "light-update-jump-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pinnedFilePath = path.join(dir, "pinned-sessions.json");

  const store = new StateStore({ pinnedFilePath });
  const states = [];
  store.on("state", (s) => states.push(s));
  t.after(() => store.clearAll());

  store.ingest({
    agent: "claude-code",
    sessionId: CLAUDE_UUID,
    type: "user_prompt",
    message: "reopen test",
    cwd: path.resolve(root),
    terminal: { kind: "rex", session: REX_SESSION, id: REX_BLOCK },
    timestamp: "2026-11-21T12:00:00.000Z",
  });

  const key = `claude-code::${CLAUDE_UUID}`;
  store.setPinned(key, true);
  store.ingest({
    agent: "claude-code",
    sessionId: CLAUDE_UUID,
    type: "session_end",
    timestamp: "2026-11-21T12:05:00.000Z",
  });
  assert.equal(store.isSessionEnded(key), true);

  const newRexBlock = "block:dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const newTarget = { kind: "rex", session: REX_SESSION, id: newRexBlock };
  const prevStateCount = states.length;

  store.updateJumpTarget(key, newTarget);

  assert.equal(states.length, prevStateCount + 1, "updateJumpTarget publishes state immediately");
  assert.equal(store.isSessionEnded(key), false);
  assert.deepEqual(store.getJumpTarget(key), newTarget);
  assert.equal(store.getState().sessions[0].jumpTarget, "rex");

  const persisted = JSON.parse(fs.readFileSync(pinnedFilePath, "utf8"));
  assert.deepEqual(persisted.sessions[0].jump, newTarget);

  if (process.platform === "darwin") {
    const reloaded = new StateStore({ pinnedFilePath });
    t.after(() => reloaded.clearAll());
    assert.deepEqual(reloaded.getJumpTarget(key), newTarget);
    assert.equal(reloaded.getState().sessions[0].jumpTarget, "rex");
  }
});
