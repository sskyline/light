import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type HookHandler = {
  type: "command";
  command: string;
  statusMessage?: string;
};

type HookGroup = {
  matcher?: string;
  hooks: HookHandler[];
};

type HookConfig = {
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
};

type HookSpec = {
  event: string;
  arg: string;
  matcher?: string;
  statusMessage?: string;
};

export type InstallHooksResult = {
  claude: TargetResult;
  codex: TargetResult;
  hookDir: string;
};

export type TargetResult = {
  target: "Claude Code" | "Codex";
  path: string;
  changed: boolean;
  added: number;
  skipped: number;
  backupPath?: string;
  error?: string;
};

type InstallHooksOptions = {
  appPath: string;
  execPath: string;
  userDataPath: string;
  homeDir?: string;
};

const CLAUDE_SPECS: HookSpec[] = [
  { event: "SessionStart", arg: "session_start" },
  { event: "SessionEnd", arg: "session_end" },
  { event: "UserPromptSubmit", arg: "user_prompt" },
  { event: "PreToolUse", arg: "tool_use", matcher: "*" },
  { event: "PermissionRequest", arg: "approval_request", matcher: "*" },
  { event: "PostToolUse", arg: "tool_result", matcher: "*" },
  { event: "Stop", arg: "stop" },
];

const CODEX_SPECS: HookSpec[] = [
  { event: "UserPromptSubmit", arg: "UserPromptSubmit", statusMessage: "Light: Codex working" },
  { event: "PreToolUse", arg: "PreToolUse", matcher: "*", statusMessage: "Light: Codex tool started" },
  { event: "PermissionRequest", arg: "PermissionRequest", matcher: "*", statusMessage: "Light: Codex approval requested" },
  { event: "PostToolUse", arg: "PostToolUse", matcher: "*", statusMessage: "Light: Codex tool finished" },
  { event: "Stop", arg: "Stop", statusMessage: "Light: Codex turn finished" },
];

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return [
    d.getFullYear(),
    pad(d.getMonth() + 1),
    pad(d.getDate()),
    "-",
    pad(d.getHours()),
    pad(d.getMinutes()),
    pad(d.getSeconds()),
  ].join("");
}

function quoteArg(value: string): string {
  if (process.platform === "win32") {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function buildCommand(execPath: string, scriptPath: string, arg: string): string {
  if (process.platform === "win32") {
    return `set "ELECTRON_RUN_AS_NODE=1" && ${quoteArg(execPath)} ${quoteArg(scriptPath)} ${quoteArg(arg)}`;
  }
  return `ELECTRON_RUN_AS_NODE=1 ${quoteArg(execPath)} ${quoteArg(scriptPath)} ${quoteArg(arg)}`;
}

function readJsonConfig(filePath: string): { config: HookConfig; existed: boolean; error?: string } {
  if (!fs.existsSync(filePath)) return { config: {}, existed: false };
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { config: {}, existed: true, error: "配置文件顶层不是 JSON object" };
    }
    return { config: parsed as HookConfig, existed: true };
  } catch (err) {
    return {
      config: {},
      existed: true,
      error: err instanceof Error ? err.message : "JSON 解析失败",
    };
  }
}

function ensureHooks(config: HookConfig): Record<string, HookGroup[]> {
  if (!config.hooks || typeof config.hooks !== "object" || Array.isArray(config.hooks)) {
    config.hooks = {};
  }
  return config.hooks;
}

function isEquivalentLightHook(command: string, scriptName: string): boolean {
  return command.includes(scriptName);
}

function hasLightHook(groups: HookGroup[] | undefined, scriptName: string): boolean {
  if (!Array.isArray(groups)) return false;
  return groups.some((group) =>
    Array.isArray(group?.hooks) &&
    group.hooks.some((hook) =>
      hook?.type === "command" &&
      typeof hook.command === "string" &&
      isEquivalentLightHook(hook.command, scriptName),
    ),
  );
}

function appendHook(
  hooks: Record<string, HookGroup[]>,
  spec: HookSpec,
  command: string,
  scriptName: string,
): "added" | "skipped" {
  const existing = hooks[spec.event];
  if (hasLightHook(existing, scriptName)) return "skipped";
  const group: HookGroup = {
    hooks: [
      {
        type: "command",
        command,
        ...(spec.statusMessage ? { statusMessage: spec.statusMessage } : {}),
      },
    ],
  };
  if (spec.matcher != null) group.matcher = spec.matcher;
  hooks[spec.event] = Array.isArray(existing) ? [...existing, group] : [group];
  return "added";
}

function copyHookScript(appPath: string, userDataPath: string, scriptName: string): string {
  const source = path.join(appPath, "hooks", scriptName);
  const hookDir = path.join(userDataPath, "hooks");
  const target = path.join(hookDir, scriptName);
  const contents = fs.readFileSync(source, "utf8");
  fs.mkdirSync(hookDir, { recursive: true });
  if (!fs.existsSync(target) || fs.readFileSync(target, "utf8") !== contents) {
    fs.writeFileSync(target, contents, "utf8");
  }
  return target;
}

function installTarget(
  target: TargetResult["target"],
  filePath: string,
  specs: HookSpec[],
  execPath: string,
  scriptPath: string,
  scriptName: string,
): TargetResult {
  const loaded = readJsonConfig(filePath);
  if (loaded.error) {
    return {
      target,
      path: filePath,
      changed: false,
      added: 0,
      skipped: 0,
      error: loaded.error,
    };
  }

  const hooks = ensureHooks(loaded.config);
  let added = 0;
  let skipped = 0;

  for (const spec of specs) {
    const command = buildCommand(execPath, scriptPath, spec.arg);
    const result = appendHook(hooks, spec, command, scriptName);
    if (result === "added") added += 1;
    else skipped += 1;
  }

  if (added === 0) {
    return { target, path: filePath, changed: false, added, skipped };
  }

  let backupPath: string | undefined;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (loaded.existed) {
    backupPath = `${filePath}.light-backup-${timestamp()}`;
    fs.copyFileSync(filePath, backupPath);
  }
  fs.writeFileSync(filePath, JSON.stringify(loaded.config, null, 2) + "\n", "utf8");
  return { target, path: filePath, changed: true, added, skipped, backupPath };
}

export function installHooks(options: InstallHooksOptions): InstallHooksResult {
  const homeDir = options.homeDir ?? os.homedir();
  const claudeScript = copyHookScript(options.appPath, options.userDataPath, "claude-hook.mjs");
  const codexScript = copyHookScript(options.appPath, options.userDataPath, "codex-hook.mjs");

  return {
    hookDir: path.dirname(claudeScript),
    claude: installTarget(
      "Claude Code",
      path.join(homeDir, ".claude", "settings.json"),
      CLAUDE_SPECS,
      options.execPath,
      claudeScript,
      "claude-hook.mjs",
    ),
    codex: installTarget(
      "Codex",
      path.join(homeDir, ".codex", "hooks.json"),
      CODEX_SPECS,
      options.execPath,
      codexScript,
      "codex-hook.mjs",
    ),
  };
}

export function formatInstallHooksResult(result: InstallHooksResult): string {
  const lines = [
    "已安全合并 Hooks",
    "已有 Light hook 的事件会跳过，只补齐缺失事件；其他 hook 保持不变。",
    "",
    formatTargetResult(result.claude),
    formatTargetResult(result.codex),
    "",
    `Hook 脚本目录: ${result.hookDir}`,
    "",
    "下一步: 重启 Claude Code / Codex，并在 CLI 里运行 /hooks 信任新增 hook。",
  ];
  return lines.join("\n");
}

function formatTargetResult(result: TargetResult): string {
  if (result.error) {
    return `${result.target}: 失败，未修改\n  ${result.path}\n  ${result.error}`;
  }
  const status = result.changed
    ? `补齐 ${result.added} 项，跳过已有 Light hook ${result.skipped} 项`
    : `无需修改，已有 Light hook ${result.skipped} 项`;
  const backup = result.backupPath ? `\n  备份: ${result.backupPath}` : "";
  return `${result.target}: ${status}\n  ${result.path}${backup}`;
}
