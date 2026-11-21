import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import installerModule from "../dist-electron/hookInstaller.js";

const { installHooks, readHookConnections, resolveAgentConfigPaths } = installerModule;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function makeSandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "light-hook-config-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const homeDir = path.join(dir, "home");
  const userDataPath = path.join(dir, "userData");
  fs.mkdirSync(homeDir, { recursive: true });
  return { dir, homeDir, userDataPath };
}

test("installHooks and readHookConnections share absolute custom CLAUDE_CONFIG_DIR and CODEX_HOME", (t) => {
  const { dir, homeDir, userDataPath } = makeSandbox(t);
  const customClaudeDir = path.join(dir, "external-claude");
  const customCodexDir = path.join(dir, "external-codex");
  const env = {
    CLAUDE_CONFIG_DIR: `  ${customClaudeDir}  `,
    CODEX_HOME: `  ${customCodexDir}  `,
  };

  const preClaudePath = path.join(customClaudeDir, "settings.json");
  const preCodexPath = path.join(customCodexDir, "hooks.json");
  fs.mkdirSync(customClaudeDir, { recursive: true });
  fs.mkdirSync(customCodexDir, { recursive: true });
  const existingClaude = JSON.stringify({ permissions: { allow: ["Read"] } }, null, 2);
  const existingCodex = JSON.stringify({ model: "gpt-5" }, null, 2);
  fs.writeFileSync(preClaudePath, existingClaude);
  fs.writeFileSync(preCodexPath, existingCodex);

  const beforeConnections = readHookConnections(homeDir, env);
  assert.deepEqual(
    beforeConnections.map((c) => ({ agent: c.agent, status: c.status, configPath: c.configPath, configured: c.configured })),
    [
      { agent: "claude-code", status: "未找到 Light Hook", configPath: preClaudePath, configured: false },
      { agent: "codex", status: "未找到 Light Hook", configPath: preCodexPath, configured: false },
      { agent: "antigravity", status: "未找到 Light Hook", configPath: "~/.gemini/config/hooks.json", configured: false },
    ],
  );

  const first = installHooks({
    appPath: root,
    execPath: process.execPath,
    userDataPath,
    homeDir,
    env,
  });

  assert.equal(first.claude.path, preClaudePath);
  assert.equal(first.codex.path, preCodexPath);
  assert.equal(first.antigravity.path, path.join(homeDir, ".gemini", "config", "hooks.json"));
  assert.equal(first.claude.added, 8);
  assert.equal(first.codex.added, 6);
  assert.equal(first.antigravity.added, 3);
  assert.ok(first.claude.backupPath?.startsWith(preClaudePath + ".light-backup-"));
  assert.ok(first.codex.backupPath?.startsWith(preCodexPath + ".light-backup-"));
  assert.equal(fs.readFileSync(first.claude.backupPath, "utf8"), existingClaude);
  assert.equal(fs.readFileSync(first.codex.backupPath, "utf8"), existingCodex);
  assert.equal(fs.existsSync(path.join(homeDir, ".claude", "settings.json")), false);
  assert.equal(fs.existsSync(path.join(homeDir, ".codex", "hooks.json")), false);

  const afterConnections = readHookConnections(homeDir, env);
  for (const conn of afterConnections) {
    assert.equal(conn.status, "Hook 已配置");
    assert.equal(conn.configured, true);
  }
  assert.equal(afterConnections[0].configPath, preClaudePath);
  assert.equal(afterConnections[1].configPath, preCodexPath);
  assert.equal(afterConnections[2].configPath, "~/.gemini/config/hooks.json");

  // Idempotent repeat install
  const second = installHooks({
    appPath: root,
    execPath: process.execPath,
    userDataPath,
    homeDir,
    env,
  });
  assert.equal(second.claude.changed, false);
  assert.equal(second.claude.skipped, 8);
  assert.equal(second.codex.changed, false);
  assert.equal(second.codex.skipped, 6);

  // Path migration in custom config directories
  const migratedExec = "/Applications/Light.app/Contents/MacOS/Light";
  const migrated = installHooks({
    appPath: root,
    execPath: migratedExec,
    userDataPath,
    homeDir,
    env,
  });
  assert.equal(migrated.claude.changed, true);
  assert.equal(migrated.claude.updated, 8);
  assert.equal(migrated.codex.changed, true);
  assert.equal(migrated.codex.updated, 6);
  const migratedClaude = JSON.parse(fs.readFileSync(preClaudePath, "utf8"));
  assert.deepEqual(migratedClaude.permissions, { allow: ["Read"] });
  assert.match(migratedClaude.hooks.SessionStart[0].hooks[0].command, /\/Applications\/Light\.app\/Contents\/MacOS\/Light/);
});

test("leading tilde in CLAUDE_CONFIG_DIR and CODEX_HOME expands against homeDir and shortens configPath", (t) => {
  const { homeDir, userDataPath } = makeSandbox(t);
  const env = {
    CLAUDE_CONFIG_DIR: "~/.config/claude-custom",
    CODEX_HOME: "~\\codex-custom",
  };

  const resolved = resolveAgentConfigPaths({ homeDir, env });
  assert.equal(resolved.claudeFile, path.join(homeDir, ".config", "claude-custom", "settings.json"));
  assert.equal(resolved.codexFile, path.join(homeDir, "codex-custom", "hooks.json"));

  const bareTilde = resolveAgentConfigPaths({
    homeDir,
    env: { CLAUDE_CONFIG_DIR: "~", CODEX_HOME: "  ~  " },
  });
  assert.equal(bareTilde.claudeFile, path.join(homeDir, "settings.json"));
  assert.equal(bareTilde.codexFile, path.join(homeDir, "hooks.json"));

  const result = installHooks({
    appPath: root,
    execPath: process.execPath,
    userDataPath,
    homeDir,
    env,
  });
  assert.equal(result.claude.path, resolved.claudeFile);
  assert.equal(result.codex.path, resolved.codexFile);

  const connections = readHookConnections(homeDir, env);
  assert.deepEqual(
    connections.map((c) => ({ agent: c.agent, configured: c.configured, configPath: c.configPath })),
    [
      { agent: "claude-code", configured: true, configPath: "~/.config/claude-custom/settings.json" },
      { agent: "codex", configured: true, configPath: "~/codex-custom/hooks.json" },
      { agent: "antigravity", configured: true, configPath: "~/.gemini/config/hooks.json" },
    ],
  );
});

test("empty or whitespace-only CLAUDE_CONFIG_DIR and CODEX_HOME fall back to default ~/.claude and ~/.codex", (t) => {
  const { homeDir, userDataPath } = makeSandbox(t);
  const env = {
    CLAUDE_CONFIG_DIR: "   \t  ",
    CODEX_HOME: "",
  };

  const result = installHooks({
    appPath: root,
    execPath: process.execPath,
    userDataPath,
    homeDir,
    env,
  });
  assert.equal(result.claude.path, path.join(homeDir, ".claude", "settings.json"));
  assert.equal(result.codex.path, path.join(homeDir, ".codex", "hooks.json"));

  const connections = readHookConnections(homeDir, env);
  assert.deepEqual(
    connections.map((c) => ({ agent: c.agent, configured: c.configured, configPath: c.configPath })),
    [
      { agent: "claude-code", configured: true, configPath: "~/.claude/settings.json" },
      { agent: "codex", configured: true, configPath: "~/.codex/hooks.json" },
      { agent: "antigravity", configured: true, configPath: "~/.gemini/config/hooks.json" },
    ],
  );
});

test("passing homeDir without env isolates calls from ambient process.env.CLAUDE_CONFIG_DIR and CODEX_HOME", (t) => {
  const { dir, homeDir, userDataPath } = makeSandbox(t);
  const ambientClaude = path.join(dir, "ambient-claude");
  const ambientCodex = path.join(dir, "ambient-codex");

  const prevClaude = process.env.CLAUDE_CONFIG_DIR;
  const prevCodex = process.env.CODEX_HOME;
  process.env.CLAUDE_CONFIG_DIR = ambientClaude;
  process.env.CODEX_HOME = ambientCodex;
  t.after(() => {
    if (prevClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevClaude;
    if (prevCodex === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodex;
  });

  // When homeDir is omitted, ambient process.env is respected.
  const ambientPaths = resolveAgentConfigPaths();
  assert.equal(ambientPaths.claudeFile, path.join(ambientClaude, "settings.json"));
  assert.equal(ambientPaths.codexFile, path.join(ambientCodex, "hooks.json"));

  // When homeDir is explicitly provided without env, ambient process.env must NOT hijack paths.
  const isolatedResult = installHooks({
    appPath: root,
    execPath: process.execPath,
    userDataPath,
    homeDir,
  });
  assert.equal(isolatedResult.claude.path, path.join(homeDir, ".claude", "settings.json"));
  assert.equal(isolatedResult.codex.path, path.join(homeDir, ".codex", "hooks.json"));
  assert.equal(fs.existsSync(ambientClaude), false);
  assert.equal(fs.existsSync(ambientCodex), false);

  const isolatedConnections = readHookConnections(homeDir);
  assert.deepEqual(
    isolatedConnections.map((c) => ({ agent: c.agent, status: c.status, configPath: c.configPath })),
    [
      { agent: "claude-code", status: "Hook 已配置", configPath: "~/.claude/settings.json" },
      { agent: "codex", status: "Hook 已配置", configPath: "~/.codex/hooks.json" },
      { agent: "antigravity", status: "Hook 已配置", configPath: "~/.gemini/config/hooks.json" },
    ],
  );
});

test("example hook configuration files satisfy readHookConnections with full coverage", (t) => {
  const { homeDir } = makeSandbox(t);
  const lightDirForward = root.split(path.sep).join("/");

  const writeExample = (exampleRelPath, targetRelPath) => {
    const raw = fs.readFileSync(path.join(root, exampleRelPath), "utf8");
    const hydrated = raw.replaceAll("<LIGHT_DIR>", lightDirForward);
    // Ensure hydrated file is valid JSON
    JSON.parse(hydrated);
    const targetPath = path.join(homeDir, targetRelPath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, hydrated, "utf8");
  };

  writeExample("hooks/settings.example.json", ".claude/settings.json");
  writeExample("hooks/codex-hooks.example.json", ".codex/hooks.json");
  writeExample("hooks/antigravity-hooks.example.json", ".gemini/config/hooks.json");

  const connections = readHookConnections(homeDir);
  assert.deepEqual(
    connections.map((c) => ({
      agent: c.agent,
      status: c.status,
      configured: c.configured,
      configPath: c.configPath,
    })),
    [
      { agent: "claude-code", status: "Hook 已配置", configured: true, configPath: "~/.claude/settings.json" },
      { agent: "codex", status: "Hook 已配置", configured: true, configPath: "~/.codex/hooks.json" },
      { agent: "antigravity", status: "Hook 已配置", configured: true, configPath: "~/.gemini/config/hooks.json" },
    ],
  );
});
