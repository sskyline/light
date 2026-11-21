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

const { StateStore } = stateModule;
const { startServer } = serverModule;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hooksDir = path.join(root, "hooks");

async function serverFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "light-hook-resilience-"));
  const store = new StateStore();
  const ingested = [];
  const origIngest = store.ingest.bind(store);
  store.ingest = (rawEvent) => {
    ingested.push(rawEvent);
    return origIngest(rawEvent);
  };
  const server = startServer(store, 0);
  await once(server, "listening");
  t.after(async () => {
    store.clearAll();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, store, ingested, port: server.address().port };
}

function baseEnv(dir, port, extraEnv = {}) {
  const env = {
    ...process.env,
    LIGHT_PORT: String(port),
    TMPDIR: dir,
    TMP: dir,
    TEMP: dir,
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
  delete env.NODE_OPTIONS;
  return { ...env, ...extraEnv };
}

function runProcess(command, args, { env, stdin, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`command timed out: ${command} ${args.join(" ")}`));
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
      resolve({ code, stdout, stderr });
    });
    child.stdin.on("error", () => {});
    if (stdin !== undefined) {
      child.stdin.end(typeof stdin === "string" ? stdin : JSON.stringify(stdin));
    } else {
      child.stdin.end();
    }
  });
}

test("standalone copied .mjs hook scripts degrade cleanly without terminal-source.mjs", async (t) => {
  const { dir, store, ingested, port } = await serverFixture(t);
  const isolatedDir = path.join(dir, "isolated-hooks");
  fs.mkdirSync(isolatedDir, { recursive: true });

  for (const name of ["claude-hook.mjs", "codex-hook.mjs", "antigravity-hook.mjs", "codex-wrap.mjs"]) {
    fs.copyFileSync(path.join(hooksDir, name), path.join(isolatedDir, name));
  }
  assert.equal(fs.existsSync(path.join(isolatedDir, "terminal-source.mjs")), false);

  const rexEnv = {
    REX_SESSION: "session:11111111-1111-4111-8111-111111111111",
    REX_BLOCK: "block:22222222-2222-4222-8222-222222222222",
  };

  // 1. claude-hook.mjs
  const claudeId = "c1111111-1111-4111-8111-111111111111";
  const claudeRes = await runProcess(
    process.execPath,
    [path.join(isolatedDir, "claude-hook.mjs"), "user_prompt"],
    { env: baseEnv(dir, port, rexEnv), stdin: { session_id: claudeId, prompt: "standalone claude" } },
  );
  assert.equal(claudeRes.code, 0, claudeRes.stderr);
  assert.equal(claudeRes.stdout, "");
  assert.equal(claudeRes.stderr, "");

  // 2. codex-hook.mjs
  const codexId = "d1111111-1111-4111-8111-111111111111";
  const codexRes = await runProcess(
    process.execPath,
    [path.join(isolatedDir, "codex-hook.mjs"), "UserPromptSubmit"],
    { env: baseEnv(dir, port, rexEnv), stdin: { session_id: codexId, prompt: "standalone codex" } },
  );
  assert.equal(codexRes.code, 0, codexRes.stderr);
  assert.equal(codexRes.stdout, "");
  assert.equal(codexRes.stderr, "");

  // 3. antigravity-hook.mjs
  const agyId = "a1111111-1111-4111-8111-111111111111";
  const agyRes = await runProcess(
    process.execPath,
    [path.join(isolatedDir, "antigravity-hook.mjs"), "PreInvocation"],
    { env: baseEnv(dir, port, rexEnv), stdin: { conversationId: agyId, invocationNum: 0 } },
  );
  assert.equal(agyRes.code, 0, agyRes.stderr);
  assert.equal(agyRes.stdout, "{}\n");
  assert.equal(agyRes.stderr, "");

  // 4. codex-wrap.mjs (with a dummy zero-exit child command)
  const wrapRes = await runProcess(
    process.execPath,
    [path.join(isolatedDir, "codex-wrap.mjs"), "-e", "process.exit(0)"],
    { env: baseEnv(dir, port, { ...rexEnv, CODEX_BIN: process.execPath }) },
  );
  assert.equal(wrapRes.code, 0, wrapRes.stderr);
  assert.equal(wrapRes.stdout, "");
  assert.equal(wrapRes.stderr, "");

  // Verify events reached Light server with degraded terminal = null
  const sessions = store.getState().sessions;
  assert.equal(sessions.find((s) => s.agent === "claude-code")?.lastPrompt, "standalone claude");
  assert.equal(sessions.find((s) => s.agent === "codex" && s.lastPrompt === "standalone codex")?.status, "working");
  assert.equal(sessions.find((s) => s.agent === "antigravity")?.status, "working");
  assert.equal(ingested.length, 6); // 1 claude + 1 codex + 1 agy + 3 codex-wrap (session_start, user_prompt, session_end)
  for (const raw of ingested) {
    assert.equal(raw.terminal, null);
  }
});

test("symlinked .mjs hook scripts resolve terminal-source.mjs across chained relative symlinks and --preserve-symlinks", {
  skip: process.platform === "win32",
}, async (t) => {
  const { dir, store, ingested, port } = await serverFixture(t);
  const realHooks = path.join(dir, "real", "hooks");
  const middleBin = path.join(dir, "middle", "links");
  const finalBin = path.join(dir, "usr", "local", "bin");
  fs.mkdirSync(realHooks, { recursive: true });
  fs.mkdirSync(middleBin, { recursive: true });
  fs.mkdirSync(finalBin, { recursive: true });

  for (const name of ["terminal-source.mjs", "claude-hook.mjs", "codex-hook.mjs", "antigravity-hook.mjs"]) {
    fs.copyFileSync(path.join(hooksDir, name), path.join(realHooks, name));
  }

  // Create direct symlinks in middleBin (relative) and chained relative symlinks in finalBin
  for (const [script, alias] of [
    ["claude-hook.mjs", "claude-hook-link.mjs"],
    ["codex-hook.mjs", "codex-hook-link.mjs"],
    ["antigravity-hook.mjs", "antigravity-hook-link.mjs"],
  ]) {
    const midTarget = path.relative(middleBin, path.join(realHooks, script));
    const midLink = path.join(middleBin, alias);
    fs.symlinkSync(midTarget, midLink);

    const finalTarget = path.relative(finalBin, midLink);
    const finalLink = path.join(finalBin, alias);
    fs.symlinkSync(finalTarget, finalLink);
  }

  const rexSession = "session:aaaaaaaa-1111-4111-8111-111111111111";
  const rexBlock = "block:bbbbbbbb-2222-4222-8222-222222222222";
  const itermPane = "w0t1p2:cccccccc-3333-4333-8333-333333333333";

  // Test both default resolution (direct symlink) and --preserve-symlinks (chained relative symlink)
  for (const [mode, binDir, extraEnv] of [
    ["direct", middleBin, {}],
    ["chained-preserve", finalBin, { NODE_OPTIONS: "--preserve-symlinks" }],
  ]) {
    const suffix = mode === "direct" ? "1" : "2";
    const claudeSession = `1111111${suffix}-1111-4111-8111-111111111111`;
    const codexSession = `2222222${suffix}-2222-4222-8222-222222222222`;
    const agySession = `3333333${suffix}-3333-4333-8333-333333333333`;

    const claudeRes = await runProcess(
      process.execPath,
      [path.join(binDir, "claude-hook-link.mjs"), "user_prompt"],
      {
        env: baseEnv(dir, port, { ...extraEnv, REX_SESSION: rexSession, REX_BLOCK: rexBlock }),
        stdin: { session_id: claudeSession, prompt: `claude-${mode}` },
      },
    );
    assert.equal(claudeRes.code, 0, claudeRes.stderr);
    assert.equal(claudeRes.stdout, "");
    assert.equal(claudeRes.stderr, "");

    const codexRes = await runProcess(
      process.execPath,
      [path.join(binDir, "codex-hook-link.mjs"), "UserPromptSubmit"],
      {
        env: baseEnv(dir, port, { ...extraEnv, TERM_PROGRAM: "iTerm.app", ITERM_SESSION_ID: itermPane }),
        stdin: { session_id: codexSession, prompt: `codex-${mode}` },
      },
    );
    assert.equal(codexRes.code, 0, codexRes.stderr);
    assert.equal(codexRes.stdout, "");
    assert.equal(codexRes.stderr, "");

    const agyRes = await runProcess(
      process.execPath,
      [path.join(binDir, "antigravity-hook-link.mjs"), "PreInvocation"],
      {
        env: baseEnv(dir, port, { ...extraEnv, REX_SESSION: rexSession, REX_BLOCK: rexBlock }),
        stdin: { conversationId: agySession, invocationNum: 0 },
      },
    );
    assert.equal(agyRes.code, 0, agyRes.stderr);
    assert.equal(agyRes.stdout, "{}\n");
    assert.equal(agyRes.stderr, "");

    if (process.platform === "darwin") {
      assert.deepEqual(store.getJumpTarget(`claude-code::${claudeSession}`), {
        kind: "rex",
        session: rexSession,
        id: rexBlock,
      });
      assert.deepEqual(store.getJumpTarget(`codex::${codexSession}`), {
        kind: "iterm",
        id: itermPane,
      });
      assert.deepEqual(store.getJumpTarget(`antigravity::${agySession}`), {
        kind: "rex",
        session: rexSession,
        id: rexBlock,
      });
    }
  }

  assert.equal(ingested.length, 6);
  assert.deepEqual(ingested[0].terminal, { kind: "rex", session: rexSession, id: rexBlock });
  assert.deepEqual(ingested[1].terminal, { kind: "iterm", id: itermPane });
  assert.deepEqual(ingested[2].terminal, { kind: "rex", session: rexSession, id: rexBlock });
  assert.deepEqual(ingested[3].terminal, { kind: "rex", session: rexSession, id: rexBlock });
  assert.deepEqual(ingested[4].terminal, { kind: "iterm", id: itermPane });
  assert.deepEqual(ingested[5].terminal, { kind: "rex", session: rexSession, id: rexBlock });
});

test("symlinked .sh wrappers resolve real script directory and preserve stdin, args and terminal source", {
  skip: process.platform === "win32",
}, async (t) => {
  const { dir, store, ingested, port } = await serverFixture(t);
  const realHooks = path.join(dir, "opt", "light", "hooks");
  const hopDir = path.join(dir, "opt", "links");
  const pathBin = path.join(dir, "bin");
  const workDir = path.join(dir, "workspace");
  fs.mkdirSync(realHooks, { recursive: true });
  fs.mkdirSync(hopDir, { recursive: true });
  fs.mkdirSync(pathBin, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });

  for (const name of [
    "terminal-source.mjs",
    "claude-hook.mjs",
    "claude-hook.sh",
    "codex-hook.mjs",
    "codex-hook.sh",
  ]) {
    const dest = path.join(realHooks, name);
    fs.copyFileSync(path.join(hooksDir, name), dest);
    if (name.endsWith(".sh") || name.endsWith(".mjs")) {
      fs.chmodSync(dest, 0o755);
    }
  }

  // Ensure `node` is discoverable on PATH even when process.execPath lives outside /usr/bin
  const nodeDir = path.dirname(process.execPath);

  // Chained relative symlinks: pathBin/<cmd> -> ../../opt/links/<cmd>-hop -> ../light/hooks/<cmd>.sh
  for (const [shName, binName] of [
    ["claude-hook.sh", "claude-hook"],
    ["codex-hook.sh", "codex-hook"],
  ]) {
    const hopLink = path.join(hopDir, `${binName}-hop`);
    fs.symlinkSync(path.relative(hopDir, path.join(realHooks, shName)), hopLink);
    fs.symlinkSync(path.relative(pathBin, hopLink), path.join(pathBin, binName));
  }

  const rexSession = "session:44444444-4444-4444-8444-444444444444";
  const rexBlock = "block:55555555-5555-4555-8555-555555555555";
  const itermPane = "w1t0p0:66666666-6666-4666-8666-666666666666";
  const pathEnv = `${pathBin}${path.delimiter}${nodeDir}${path.delimiter}${process.env.PATH || ""}`;

  const claudeSession = "77777777-7777-4777-8777-777777777777";
  const claudeRes = await runProcess(
    "claude-hook",
    ["tool_use"],
    {
      cwd: workDir,
      env: baseEnv(dir, port, { PATH: pathEnv, REX_SESSION: rexSession, REX_BLOCK: rexBlock }),
      stdin: {
        session_id: claudeSession,
        tool_name: "Bash",
        tool_use_id: "call-sh-1",
        tool_input: { command: "git status" },
      },
    },
  );
  assert.equal(claudeRes.code, 0, claudeRes.stderr);
  assert.equal(claudeRes.stdout, "");
  assert.equal(claudeRes.stderr, "");

  const codexSession = "88888888-8888-4888-8888-888888888888";
  const codexRes = await runProcess(
    "codex-hook",
    ["UserPromptSubmit"],
    {
      cwd: workDir,
      env: baseEnv(dir, port, { PATH: pathEnv, TERM_PROGRAM: "iTerm.app", ITERM_SESSION_ID: itermPane }),
      stdin: { session_id: codexSession, prompt: "via symlinked shell wrapper" },
    },
  );
  assert.equal(codexRes.code, 0, codexRes.stderr);
  assert.equal(codexRes.stdout, "");
  assert.equal(codexRes.stderr, "");

  // Also verify non-zero exit code propagation via `exec node`
  const invalidRes = await runProcess(
    "claude-hook",
    ["invalid_event_name"],
    { cwd: workDir, env: baseEnv(dir, port, { PATH: pathEnv }) },
  );
  assert.equal(invalidRes.code, 2);

  const sessions = store.getState().sessions;
  const claudeState = sessions.find((s) => s.agent === "claude-code");
  const codexState = sessions.find((s) => s.agent === "codex");
  assert.equal(claudeState?.currentTool, "Bash");
  assert.equal(claudeState?.recent[0]?.toolCallId, "call-sh-1");
  assert.match(claudeState?.recent[0]?.message ?? "", /git status/);
  assert.equal(codexState?.lastPrompt, "via symlinked shell wrapper");

  assert.deepEqual(ingested[0].terminal, { kind: "rex", session: rexSession, id: rexBlock });
  assert.deepEqual(ingested[1].terminal, { kind: "iterm", id: itermPane });
  if (process.platform === "darwin") {
    assert.deepEqual(store.getJumpTarget(`claude-code::${claudeSession}`), {
      kind: "rex",
      session: rexSession,
      id: rexBlock,
    });
    assert.deepEqual(store.getJumpTarget(`codex::${codexSession}`), {
      kind: "iterm",
      id: itermPane,
    });
  }
});
