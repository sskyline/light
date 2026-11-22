import assert from "node:assert/strict";
import test from "node:test";
import navigation from "../dist-electron/sessionNavigation.js";
import rexNavigation from "../dist-electron/rexNavigation.js";
import sessionOpenGate from "../dist-electron/sessionOpenGate.js";
import { terminalSource } from "../hooks/terminal-source.mjs";

const { resolveJumpTarget, openJumpTarget, openOrReopenJumpTarget, buildResumeCommand, shellQuote } = navigation;
const { createSessionOpenGate } = sessionOpenGate;
const uuid = "01234567-1234-4123-8123-123456789abc";
const uuid2 = "89abcdef-1234-4123-8123-abcdef012345";
const uuid3 = "fedcba98-4321-4321-8321-fedcba987654";

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

test("Rex reopen when original block is closed but session still exists", async () => {
  const session = "session:" + uuid;
  const oldBlock = "block:" + uuid;
  const newBlock = "block:" + uuid2;
  const newWindow = "window:" + uuid2;
  const client = {
    client_id: "client:" + uuid,
    info: { kind: "app", platform: "macos" },
    principal: { transport: "unix" },
    connection_state: "connected",
    session_ids: [session],
  };
  const calls = [];
  const execute = async (file, args) => {
    const clean = args.filter(a => !["--autostart=false", "--timeout", "4s"].includes(a));
    if (clean[0] === "client" && clean[1] === "ls") {
      return JSON.stringify({ clients: [client] });
    }
    if (clean[0] === "block" && clean[1] === "inspect") {
      throw new Error(`Error: block target "${oldBlock}" not found`);
    }
    calls.push([file, ...clean]);
    if (clean[0] === "run") {
      return JSON.stringify({ window_id: newWindow, block_ids: [newBlock] });
    }
    return "";
  };

  const result = await openOrReopenJumpTarget(
    { kind: "rex", session, id: oldBlock },
    { agent: "claude-code", sessionId: uuid3, cwd: "/Users/test/my project" },
    { dirExists: dir => dir === "/Users/test/my project", rexCli: "/test/rex", rexExecute: execute },
  );

  assert.deepEqual(result, {
    opened: true,
    reopened: true,
    updatedTarget: { kind: "rex", session, id: newBlock },
  });
  assert.deepEqual(calls, [
    ["/test/rex", "-C", client.client_id, "do", "session.select", "session_id=" + session],
    ["/test/rex", "run", "-s", session, "--interactive", "--keep-open", "-c", "/Users/test/my project", "--json", "--", "claude", "--resume", uuid3],
    ["/test/rex", "-C", client.client_id, "do", "session.select", "session_id=" + session, "window_id=" + newWindow],
    ["/test/rex", "block", "focus", newBlock, "-s", session, "-w", newWindow],
    ["/usr/bin/open", "-b", "com.superlogical.rex"],
  ]);

  // Without ResumeSpec, missing block still rejects cleanly
  await assert.rejects(
    openOrReopenJumpTarget(
      { kind: "rex", session, id: oldBlock },
      undefined,
      { rexCli: "/test/rex", rexExecute: execute },
    ),
    /not found/,
  );
});

test("Rex reopen when original session was also closed uses active client session or rex new", async () => {
  const closedSession = "session:" + uuid;
  const activeSession = "session:" + uuid2;
  const oldBlock = "block:" + uuid;
  const newBlock = "block:" + uuid3;
  const newWindow = "window:" + uuid3;

  // Subcase 1: connected local client has an active session -> rex run -s activeSession
  const clientWithSession = {
    client_id: "client:" + uuid,
    info: { kind: "app", platform: "macos" },
    principal: { transport: "unix" },
    connection_state: "connected",
    session_ids: [activeSession],
  };
  const callsWithSession = [];
  const execWithSession = async (file, args) => {
    const clean = args.filter(a => !["--autostart=false", "--timeout", "4s"].includes(a));
    if (clean[0] === "client" && clean[1] === "ls") return JSON.stringify({ clients: [clientWithSession] });
    if (clean[0] === "block" && clean[1] === "inspect") {
      throw new Error(`Error: block target "${oldBlock}" not found: session scope: session "${closedSession}" not found`);
    }
    callsWithSession.push([file, ...clean]);
    if (clean[0] === "run") return JSON.stringify({ window_id: newWindow, block_ids: [newBlock] });
    return "";
  };

  const res1 = await openOrReopenJumpTarget(
    { kind: "rex", session: closedSession, id: oldBlock },
    { agent: "codex", sessionId: uuid3, cwd: "/work/repo" },
    { dirExists: () => true, rexCli: "/test/rex", rexExecute: execWithSession },
  );
  assert.deepEqual(res1, {
    opened: true,
    reopened: true,
    updatedTarget: { kind: "rex", session: activeSession, id: newBlock },
  });
  assert.deepEqual(callsWithSession, [
    ["/test/rex", "-C", clientWithSession.client_id, "do", "session.select", "session_id=" + activeSession],
    ["/test/rex", "run", "-s", activeSession, "--interactive", "--keep-open", "-c", "/work/repo", "--json", "--", "codex", "resume", uuid3],
    ["/test/rex", "-C", clientWithSession.client_id, "do", "session.select", "session_id=" + activeSession, "window_id=" + newWindow],
    ["/test/rex", "block", "focus", newBlock, "-s", activeSession, "-w", newWindow],
    ["/usr/bin/open", "-b", "com.superlogical.rex"],
  ]);

  // Subcase 2: connected local client has NO session -> rex new
  const createdSession = "session:" + uuid3;
  const clientNoSession = {
    client_id: "client:" + uuid,
    info: { kind: "app", platform: "macos" },
    principal: { transport: "unix" },
    connection_state: "connected",
    session_ids: [],
  };
  const callsNoSession = [];
  const execNoSession = async (file, args) => {
    const clean = args.filter(a => !["--autostart=false", "--timeout", "4s"].includes(a));
    if (clean[0] === "client" && clean[1] === "ls") return JSON.stringify({ clients: [clientNoSession] });
    if (clean[0] === "block" && clean[1] === "inspect") {
      throw new Error(`Error: block target "${oldBlock}" not found: session scope: session "${closedSession}" not found`);
    }
    callsNoSession.push([file, ...clean]);
    if (clean[0] === "new") {
      return JSON.stringify({
        session_id: createdSession,
        initial_windows: [{ window_id: newWindow, block_ids: [newBlock] }],
      });
    }
    return "";
  };

  const res2 = await openOrReopenJumpTarget(
    { kind: "rex", session: closedSession, id: oldBlock },
    { agent: "codex", sessionId: uuid3, cwd: "/work/repo" },
    { dirExists: () => true, rexCli: "/test/rex", rexExecute: execNoSession },
  );
  assert.deepEqual(res2, {
    opened: true,
    reopened: true,
    updatedTarget: { kind: "rex", session: createdSession, id: newBlock },
  });
  assert.deepEqual(callsNoSession, [
    ["/test/rex", "new", "--interactive", "--keep-open", "-c", "/work/repo", "--json", "--", "codex", "resume", uuid3],
    ["/test/rex", "-C", clientNoSession.client_id, "do", "session.select", "session_id=" + createdSession, "window_id=" + newWindow],
    ["/test/rex", "block", "focus", newBlock, "-s", createdSession, "-w", newWindow],
    ["/usr/bin/open", "-b", "com.superlogical.rex"],
  ]);
});

test("Rex reopen when cwd no longer exists on disk omits -c and launches resume cleanly", async () => {
  const session = "session:" + uuid;
  const oldBlock = "block:" + uuid;
  const newBlock = "block:" + uuid2;
  const newWindow = "window:" + uuid2;
  const client = {
    client_id: "client:" + uuid,
    info: { kind: "app", platform: "macos" },
    principal: { transport: "unix" },
    connection_state: "connected",
    session_ids: [session],
  };
  const calls = [];
  const execute = async (file, args) => {
    const clean = args.filter(a => !["--autostart=false", "--timeout", "4s"].includes(a));
    if (clean[0] === "client" && clean[1] === "ls") return JSON.stringify({ clients: [client] });
    if (clean[0] === "block" && clean[1] === "inspect") throw new Error("not found");
    calls.push([file, ...clean]);
    if (clean[0] === "run") return JSON.stringify({ window_id: newWindow, block_ids: [newBlock] });
    return "";
  };

  const result = await openOrReopenJumpTarget(
    { kind: "rex", session, id: oldBlock },
    { agent: "claude-code", sessionId: uuid3, cwd: "/deleted/directory" },
    { dirExists: () => false, rexCli: "/test/rex", rexExecute: execute },
  );

  assert.equal(result.reopened, true);
  const runCall = calls.find(c => c[1] === "run");
  assert.ok(runCall);
  assert.ok(!runCall.includes("-c"));
  assert.deepEqual(runCall, [
    "/test/rex", "run", "-s", session, "--interactive", "--keep-open", "--json", "--", "claude", "--resume", uuid3,
  ]);
});

test("Rex Remote Control failure neither orphans a duplicate resume pane nor loses a newly created rex new pane on retry", async () => {
  const key = `claude-code::${uuid3}`;
  const session = "session:" + uuid;
  const oldBlock = "block:" + uuid;
  const newBlock = "block:" + uuid2;
  const newWindow = "window:" + uuid2;

  // Case A: Existing Rex session with Remote Control initially OFF -> preflight blocks rex run completely!
  let remoteControlOn = false;
  let runCount = 0;
  let storedTarget = { kind: "rex", session, id: oldBlock };
  const clientWithSession = {
    client_id: "client:" + uuid,
    info: { kind: "app", platform: "macos" },
    principal: { transport: "unix" },
    connection_state: "connected",
    session_ids: [session],
  };

  const execExisting = async (_file, args) => {
    const clean = args.filter(a => !["--autostart=false", "--autostart=true", "--timeout", "4s"].includes(a));
    if (clean[0] === "client" && clean[1] === "ls") return JSON.stringify({ clients: [clientWithSession] });
    if (clean[0] === "block" && clean[1] === "inspect") {
      if (clean[2] === newBlock && runCount > 0) {
        return JSON.stringify({ session_id: session, block: { block_id: newBlock, window_id: newWindow } });
      }
      throw new Error(`Error: block target "${clean[2]}" not found`);
    }
    if (clean[0] === "-C" && clean.includes("session.select")) {
      if (!remoteControlOn) {
        throw new Error("Error: Rex.app is not accepting actions. Turn on Remote Control in its Settings under Rex Server.");
      }
      return "";
    }
    if (clean[0] === "run") {
      runCount++;
      return JSON.stringify({ window_id: newWindow, block_ids: [newBlock] });
    }
    return "";
  };

  const gateA = createSessionOpenGate({
    resolveTarget: async () => storedTarget,
    getResumeContext: () => ({ agent: "claude-code", sessionId: uuid3, cwd: "/work/repo" }),
    openTarget: (target, resume, onTargetUpdated) =>
      openOrReopenJumpTarget(target, resume, {
        dirExists: () => true,
        rexCli: "/test/rex",
        rexExecute: execExisting,
        onTargetUpdated,
      }),
    updateJumpTarget: (_k, next) => { storedTarget = next; },
  });

  const firstAttempt = await gateA(key);
  assert.equal(firstAttempt.opened, false);
  assert.match(firstAttempt.message, /Remote Control/);
  assert.equal(runCount, 0, "preflight must fail before spawning rex run");

  // User enables Remote Control and clicks ↗ again -> spawns once and focuses
  remoteControlOn = true;
  const secondAttempt = await gateA(key);
  assert.deepEqual(secondAttempt, { opened: true });
  assert.equal(runCount, 1);
  assert.deepEqual(storedTarget, { kind: "rex", session, id: newBlock });

  // Case B: No sessions exist at all (`rex new` path), Remote Control OFF during post-creation select ->
  // newly created session & block MUST still be persisted immediately so retry focuses instead of running `rex new` twice!
  let remoteControlOnB = false;
  let newCount = 0;
  const createdSession = "session:" + uuid2;
  let storedTargetB = { kind: "rex", session, id: oldBlock };
  const clientNoSessions = {
    client_id: "client:" + uuid,
    info: { kind: "app", platform: "macos" },
    principal: { transport: "unix" },
    connection_state: "connected",
    session_ids: [],
  };

  const execNew = async (_file, args) => {
    const clean = args.filter(a => !["--autostart=false", "--autostart=true", "--timeout", "4s"].includes(a));
    if (clean[0] === "client" && clean[1] === "ls") {
      return JSON.stringify({
        clients: [{ ...clientNoSessions, session_ids: newCount > 0 ? [createdSession] : [] }],
      });
    }
    if (clean[0] === "block" && clean[1] === "inspect") {
      if (clean[2] === newBlock && newCount > 0) {
        return JSON.stringify({ session_id: createdSession, block: { block_id: newBlock, window_id: newWindow } });
      }
      throw new Error(`Error: block target "${clean[2]}" not found: session scope: session "${session}" not found`);
    }
    if (clean[0] === "new") {
      newCount++;
      return JSON.stringify({
        session_id: createdSession,
        initial_windows: [{ window_id: newWindow, block_ids: [newBlock] }],
      });
    }
    if (clean[0] === "-C" && clean.includes("session.select")) {
      if (!remoteControlOnB) {
        throw new Error("Error: Rex.app is not accepting actions. Turn on Remote Control in its Settings under Rex Server.");
      }
      return "";
    }
    return "";
  };

  const gateB = createSessionOpenGate({
    resolveTarget: async () => storedTargetB,
    getResumeContext: () => ({ agent: "claude-code", sessionId: uuid3, cwd: "/work/repo" }),
    openTarget: (target, resume, onTargetUpdated) =>
      openOrReopenJumpTarget(target, resume, {
        dirExists: () => true,
        rexCli: "/test/rex",
        rexExecute: execNew,
        onTargetUpdated,
      }),
    updateJumpTarget: (_k, next) => { storedTargetB = next; },
  });

  const firstAttemptB = await gateB(key);
  assert.equal(firstAttemptB.opened, false);
  assert.match(firstAttemptB.message, /Remote Control/);
  assert.equal(newCount, 1);
  assert.deepEqual(storedTargetB, { kind: "rex", session: createdSession, id: newBlock }, "created block recorded despite focus failure");

  // User enables Remote Control and retries -> inspects & focuses the already-created block, newCount stays 1!
  remoteControlOnB = true;
  const secondAttemptB = await gateB(key);
  assert.deepEqual(secondAttemptB, { opened: true });
  assert.equal(newCount, 1, "retry must focus existing reopened block without creating a second session");
});

test("Ghostty checks terminal existence in a single AppleScript, reopens when closed, and never spawns a new tab on permission errors", async () => {
  // 1. Existing surface -> focuses without creating a new surface
  const focusCalls = [];
  const focusResult = await openOrReopenJumpTarget(
    { kind: "ghostty", id: uuid },
    { agent: "claude-code", sessionId: uuid3, cwd: "/Users/dev/project's dir" },
    {
      dirExists: () => true,
      exec: (file, args, cb) => {
        focusCalls.push([file, args]);
        cb(null, `focused:${uuid}\n`);
      },
    },
  );
  assert.deepEqual(focusResult, { opened: true });
  assert.equal(focusCalls.length, 1);

  // 2. Closed surface -> single AppleScript creates new surface and returns updatedTarget
  const calls = [];
  const exec = (file, args, cb) => {
    calls.push([file, args]);
    cb(null, `reopened:${uuid2}\n`);
  };

  const result = await openOrReopenJumpTarget(
    { kind: "ghostty", id: uuid },
    { agent: "claude-code", sessionId: uuid3, cwd: "/Users/dev/project's dir" },
    { exec, dirExists: () => true },
  );

  assert.deepEqual(result, {
    opened: true,
    reopened: true,
    updatedTarget: { kind: "ghostty", id: uuid2 },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "/usr/bin/osascript");
  assert.match(calls[0][1][1], /exists \(terminal id surfaceID\)/);
  assert.match(calls[0][1][1], /focus \(terminal id surfaceID\)/);
  assert.match(calls[0][1][1], /new surface configuration/);
  assert.match(calls[0][1][1], /initial working directory of cfg/);
  assert.match(calls[0][1][1], /initial input of cfg/);
  assert.equal(calls[0][1][2], uuid);
  assert.equal(calls[0][1][3], "/Users/dev/project's dir");
  assert.equal(calls[0][1][4], `cd -- '/Users/dev/project'\\''s dir' && 'claude' '--resume' '${uuid3}'`);

  // 3. Automation permission denial (-1743) rejects immediately without firing a second osascript
  let permCalls = 0;
  await assert.rejects(
    openOrReopenJumpTarget(
      { kind: "ghostty", id: uuid },
      { agent: "claude-code", sessionId: uuid3, cwd: "/Users/dev/project's dir" },
      {
        dirExists: () => true,
        exec: (_file, _args, cb) => {
          permCalls++;
          cb(new Error("Not authorized to send Apple events to Ghostty. (-1743)"));
        },
      },
    ),
    /-1743/,
  );
  assert.equal(permCalls, 1);
});

test("Rex reopen when Rex.app and Rex server are completely exited launches Rex, waits for local client, and resumes", async () => {
  const closedSession = "session:" + uuid;
  const oldBlock = "block:" + uuid;
  const bootSession = "session:" + uuid2;
  const newBlock = "block:" + uuid3;
  const newWindow = "window:" + uuid3;
  const client = {
    client_id: "client:" + uuid,
    info: { kind: "app", platform: "macos" },
    principal: { transport: "unix" },
    connection_state: "connected",
    session_ids: [bootSession],
  };

  let appLaunched = false;
  let clientPollCount = 0;
  const rawCalls = [];

  const execute = async (file, args) => {
    rawCalls.push([file, ...args]);
    if (file === "/usr/bin/open" && args[0] === "-b" && args[1] === "com.superlogical.rex") {
      appLaunched = true;
      return "";
    }
    const autostart = args.includes("--autostart=true");
    const clean = args.filter(a => !["--autostart=false", "--autostart=true", "--timeout", "4s"].includes(a));
    if (!appLaunched && !autostart) {
      throw new Error("Error: no Rex server is running at /tmp/rex.sock, and autostart is disabled");
    }
    if (clean[0] === "client" && clean[1] === "ls") {
      clientPollCount++;
      // First poll right after open returns empty while window initializes; second poll returns connected client
      return JSON.stringify({ clients: clientPollCount >= 2 ? [client] : [] });
    }
    if (clean[0] === "block" && clean[1] === "inspect") {
      throw new Error(`Error: block target "${oldBlock}" not found: session scope: session "${closedSession}" not found`);
    }
    if (clean[0] === "run") {
      return JSON.stringify({ window_id: newWindow, block_ids: [newBlock] });
    }
    return "";
  };

  let sleeps = 0;
  const result = await openOrReopenJumpTarget(
    { kind: "rex", session: closedSession, id: oldBlock },
    { agent: "claude-code", sessionId: uuid3, cwd: "/work/app" },
    {
      dirExists: () => true,
      rexCli: "/test/rex",
      rexExecute: execute,
      rexSleep: async () => { sleeps++; },
    },
  );

  assert.equal(appLaunched, true);
  assert.equal(sleeps, 1);
  assert.deepEqual(result, {
    opened: true,
    reopened: true,
    updatedTarget: { kind: "rex", session: bootSession, id: newBlock },
  });
  assert.ok(rawCalls.some(c => c[0] === "/test/rex" && c.includes("--autostart=true") && c.includes("run")));

  // If Rex server kept the original block alive in background while Rex.app window was closed,
  // relaunching Rex.app focuses the existing block instead of creating a duplicate tab!
  let appOpenedForSurviving = false;
  const survivingCalls = [];
  const execSurviving = async (file, args) => {
    if (file === "/usr/bin/open") {
      appOpenedForSurviving = true;
      survivingCalls.push([file, ...args]);
      return "";
    }
    const clean = args.filter(a => !["--autostart=false", "--autostart=true", "--timeout", "4s"].includes(a));
    if (clean[0] === "client" && clean[1] === "ls") {
      return JSON.stringify({ clients: appOpenedForSurviving ? [{ ...client, session_ids: [closedSession] }] : [] });
    }
    if (clean[0] === "block" && clean[1] === "inspect") {
      return JSON.stringify({ session_id: closedSession, block: { block_id: oldBlock, window_id: newWindow } });
    }
    survivingCalls.push([file, ...clean]);
    return "";
  };

  const focusedExisting = await openOrReopenJumpTarget(
    { kind: "rex", session: closedSession, id: oldBlock },
    { agent: "claude-code", sessionId: uuid3, cwd: "/work/app" },
    { dirExists: () => true, rexCli: "/test/rex", rexExecute: execSurviving, rexSleep: async () => {} },
  );
  assert.deepEqual(focusedExisting, { opened: true });
  assert.ok(!survivingCalls.some(c => c.includes("run") || c.includes("new")));
});

test("createSessionOpenGate coalesces concurrent clicks for the same session key and allows independent keys", async () => {
  const keyA = `claude-code::${uuid}`;
  const keyB = `codex::${uuid2}`;
  const targets = new Map([
    [keyA, { kind: "ghostty", id: uuid }],
    [keyB, { kind: "ghostty", id: uuid2 }],
  ]);

  let openCallsA = 0;
  let openCallsB = 0;
  let releaseA;
  const gateA = new Promise(resolve => { releaseA = resolve; });

  const openSession = createSessionOpenGate({
    resolveTarget: async (key) => targets.get(key),
    getResumeContext: (key) => ({ agent: "claude-code", sessionId: key.split("::")[1] }),
    openTarget: async (target) => {
      if (target.id === uuid) {
        openCallsA++;
        await gateA;
        return { opened: true, reopened: true, updatedTarget: { kind: "ghostty", id: uuid3 } };
      }
      openCallsB++;
      return { opened: true };
    },
    updateJumpTarget: (key, updated) => {
      targets.set(key, updated);
    },
  });

  // Triple rapid click on keyA while first reopen is still running, plus concurrent click on keyB
  const p1 = openSession(keyA);
  const p2 = openSession(keyA);
  const p3 = openSession(keyA);
  const pB = openSession(keyB);

  assert.deepEqual(await pB, { opened: true });
  assert.equal(openCallsB, 1);
  assert.equal(openCallsA, 1, "concurrent calls for keyA must share a single openTarget invocation");

  releaseA();
  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
  assert.deepEqual(r1, { opened: true });
  assert.deepEqual(r2, { opened: true });
  assert.deepEqual(r3, { opened: true });
  assert.equal(openCallsA, 1);
  assert.deepEqual(targets.get(keyA), { kind: "ghostty", id: uuid3 });

  // Subsequent click after completion runs fresh against the updated target
  const afterUpdate = await openSession(keyA);
  assert.deepEqual(afterUpdate, { opened: true });
  assert.equal(openCallsB, 2); // target.id is now uuid3 (!== uuid), hitting the fast focus branch
});

test("iTerm2 focus, reopen with shell-quoted command, and strict ResumeSpec UUID validation", async () => {
  const paneId = "w0t1p2:" + uuid;

  // 1. Focus existing session when present
  const focusCalls = [];
  const focusRes = await openOrReopenJumpTarget(
    { kind: "iterm", id: paneId },
    { agent: "claude-code", sessionId: uuid3, cwd: "/Users/dev/app" },
    {
      dirExists: () => true,
      exec: (file, args, cb) => {
        focusCalls.push([file, args]);
        cb(null, `focused:${uuid}\n`);
      },
    },
  );
  assert.deepEqual(focusRes, { opened: true });
  assert.equal(focusCalls.length, 1);
  assert.equal(focusCalls[0][0], "/usr/bin/osascript");
  assert.equal(focusCalls[0][1][2], uuid);

  // 2. Reopen new tab when closed with safely shell-quoted command
  const reopenCalls = [];
  const reopenRes = await openOrReopenJumpTarget(
    { kind: "iterm", id: paneId },
    { agent: "claude-code", sessionId: uuid3, cwd: "/Users/dev/it's here" },
    {
      dirExists: () => true,
      exec: (file, args, cb) => {
        reopenCalls.push([file, args]);
        cb(null, `reopened:w0t0p0:${uuid2}\n`);
      },
    },
  );
  assert.deepEqual(reopenRes, {
    opened: true,
    reopened: true,
    updatedTarget: { kind: "iterm", id: `w0t0p0:${uuid2}` },
  });
  assert.equal(reopenCalls[0][1][2], uuid);
  assert.equal(
    reopenCalls[0][1][3],
    `cd -- '/Users/dev/it'\\''s here' && 'claude' '--resume' '${uuid3}'`,
  );

  // 3. Rejects non-UUID sessionIds (treats resume as undefined -> empty resumeShellCmd)
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
  assert.equal(buildResumeCommand({ agent: "claude-code", sessionId: "not-a-uuid; rm -rf /", cwd: "/tmp" }, () => true), undefined);
  assert.equal(buildResumeCommand({ agent: "other", sessionId: uuid3, cwd: "/tmp" }, () => true), undefined);
  assert.deepEqual(
    buildResumeCommand({ agent: "codex", sessionId: uuid3, cwd: "relative/path" }, () => true),
    { argv: ["codex", "resume", uuid3], cwd: undefined, shellCommand: `'codex' 'resume' '${uuid3}'` },
  );
  assert.deepEqual(
    buildResumeCommand({ agent: "codex", sessionId: uuid3, cwd: "/bad\ncwd" }, () => true),
    { argv: ["codex", "resume", uuid3], cwd: undefined, shellCommand: `'codex' 'resume' '${uuid3}'` },
  );

  const injectionCalls = [];
  await assert.rejects(
    openOrReopenJumpTarget(
      { kind: "iterm", id: paneId },
      { agent: "claude-code", sessionId: "$(whoami)" },
      {
        exec: (file, args, cb) => {
          injectionCalls.push([file, args]);
          // Simulate AppleScript erroring when resumeShellCmd is ""
          if (args[3] === "") cb(new Error("原 iTerm2 分屏已关闭。"));
          else cb(null, `reopened:w0t0p0:${uuid2}`);
        },
      },
    ),
    /原 iTerm2 分屏已关闭/,
  );
  assert.equal(injectionCalls[0][1][3], "");
});
