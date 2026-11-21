import assert from "node:assert/strict";
import test from "node:test";
import navigation from "../dist-electron/sessionNavigation.js";
import rexNavigation from "../dist-electron/rexNavigation.js";
import { terminalSource } from "../hooks/terminal-source.mjs";

const { resolveJumpTarget, openJumpTarget } = navigation;
const uuid = "01234567-1234-4123-8123-123456789abc";

test("Claude Code and Codex use the originating Rex session and block", () => {
  const session = "session:" + uuid;
  const id = "block:" + uuid;
  const env = { REX_SESSION: session, REX_BLOCK: id, TERM_PROGRAM: "ghostty", GHOSTTY_SURFACE_ID: uuid };
  for (const agent of ["claude-code", "codex"]) {
    assert.deepEqual(resolveJumpTarget(agent, uuid, terminalSource(env)), { kind: "rex", session, id });
  }
  assert.equal(resolveJumpTarget("claude-code", uuid, { kind: "rex", session, id: "next" }), undefined);
  assert.equal(terminalSource({ ...env, TMUX: "tmux" }), null);
});

test("Rex resolves the exact local client, tab and pane before changing focus", async () => {
  const session = "session:" + uuid, block = "block:" + uuid, windowId = "window:" + uuid;
  const client = { client_id: "client:" + uuid, info: { kind: "app", platform: "macos" },
    principal: { transport: "unix" }, connection_state: "connected" };
  const clients = [client, { ...client, principal: { transport: "network" } }];
  const calls = [];
  let refuse = false;
  const execute = async (file, args) => {
    if (args.includes("ls")) return JSON.stringify({ clients });
    if (args.includes("inspect")) return JSON.stringify({ session_id: session, block: { block_id: block, window_id: windowId } });
    calls.push([file, ...args.filter(a => !["--autostart=false", "--timeout", "4s"].includes(a))]);
    if (refuse) throw new Error("Error: Rex.app is not accepting actions. Turn on Remote Control in its Settings under Rex Server.");
    return "";
  };
  const jump = () => rexNavigation.focusRexPane(session, block, "/test/rex", execute);
  assert.equal(await jump(), true);
  assert.deepEqual(calls.splice(0), [
    ["/test/rex", "-C", client.client_id, "do", "session.select", "session_id=" + session, "window_id=" + windowId],
    ["/test/rex", "block", "focus", block, "-s", session, "-w", windowId],
    ["/usr/bin/open", "-b", "com.superlogical.rex"],
  ]);
  refuse = true;
  await assert.rejects(jump(), /Rex → Settings → Server 页底部的 Client Info 中开启 Remote Control/);
  assert.equal(calls.splice(0).length, 1);
  clients.push(client);
  await assert.rejects(jump(), /本机 Rex 客户端/);
  assert.equal(calls.length, 0);
});

test("session navigation uses only supported destinations and full IDs", () => {
  assert.deepEqual(resolveJumpTarget("codex", uuid), { kind: "codex", id: uuid });
  assert.equal(resolveJumpTarget("codex", uuid.slice(0, 12)), undefined);
  assert.equal(resolveJumpTarget("claude-code", uuid), undefined);
  for (const source of [null, { kind: "iterm", id: "iterm2:/command?c=date" }, { kind: "ghostty", id: "unknown" }]) {
    assert.equal(resolveJumpTarget("antigravity", uuid, source), undefined);
  }
  const env = { TERM_PROGRAM: "ghostty", GHOSTTY_SURFACE_ID: uuid };
  assert.deepEqual(resolveJumpTarget("claude-code", uuid, terminalSource(env)), { kind: "ghostty", id: uuid });
  assert.equal(terminalSource({ ...env, TMUX: "/tmp/tmux" }), null);
});

test("native launch addresses the chosen thread or pane and reports dispatch failures", async () => {
  const id = "w0t1p2:" + uuid;
  const calls = [];
  const run = (file, args, done) => { calls.push([file, args]); done(null); };
  await openJumpTarget({ kind: "codex", id: uuid }, run);
  await openJumpTarget({ kind: "iterm", id }, run);
  await openJumpTarget({ kind: "ghostty", id: uuid }, run);
  assert.deepEqual(calls[0], ["/usr/bin/open", ["-b", "com.openai.codex", "codex://threads/" + uuid]]);
  assert.deepEqual(calls[1], ["/usr/bin/open", ["-b", "com.googlecode.iterm2", "iterm2:reveal?sessionid=" + encodeURIComponent(id)]]);
  assert.equal(calls[2][0], "/usr/bin/osascript");
  assert.equal(calls[2][1].at(-1), uuid);
  assert.match(calls[2][1][1], /focus \(terminal id surfaceID\)/);
  await assert.rejects(openJumpTarget({ kind: "codex", id: uuid }, (_file, _args, cb) => cb(new Error("unavailable"))), /unavailable/);
});
