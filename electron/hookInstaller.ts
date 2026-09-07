import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type HookHandler = {
  type: "command";
  command: string;
  statusMessage?: string;
  timeout?: number;
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
  antigravity: TargetResult;
  hookDir: string;
};

export type TargetResult = {
  target: "Claude Code" | "Codex" | "Antigravity";
  path: string;
  changed: boolean;
  added: number;
  updated: number;
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

// PreToolUse participates in permission decisions in Antigravity. A status
// monitor must not register it or return an allow/deny decision.
const ANTIGRAVITY_EVENTS = ["PreInvocation", "PostToolUse", "Stop"] as const;
const ANTIGRAVITY_HOOK_NAME = "light-antigravity";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function findAntigravityHooks(config: HookConfig, event: string): Record<string, unknown>[] {
  return Object.values(config).flatMap((entry) => {
    if (!isRecord(entry) || !Array.isArray(entry[event])) return [];
    const handlers = entry[event].flatMap((item: unknown) =>
      event === "PostToolUse" && isRecord(item) && Array.isArray(item.hooks) ? item.hooks : [item],
    );
    return handlers.filter((handler: unknown): handler is Record<string, unknown> =>
      isRecord(handler) &&
      (handler.type == null || handler.type === "command") &&
      typeof handler.command === "string" &&
      isEquivalentLightHook(handler.command, "antigravity-hook.mjs"),
    );
  });
}

export function installAntigravityHooks(options: InstallHooksOptions): TargetResult {
  const homeDir = options.homeDir ?? os.homedir();
  const filePath = path.join(homeDir, ".gemini", "config", "hooks.json");
  const result: TargetResult = {
    target: "Antigravity", path: filePath, changed: false, added: 0, updated: 0, skipped: 0,
  };
  try {
    const loaded = readJsonConfig(filePath);
    if (loaded.error) return { ...result, error: loaded.error };
    const existing = loaded.config[ANTIGRAVITY_HOOK_NAME];
    if (existing !== undefined && !isRecord(existing)) {
      return { ...result, error: `${ANTIGRAVITY_HOOK_NAME} 不是 JSON object，未修改` };
    }
    const namedHook = existing ?? {};
    for (const event of ANTIGRAVITY_EVENTS) {
      if (namedHook[event] !== undefined && !Array.isArray(namedHook[event])) {
        return { ...result, error: `${ANTIGRAVITY_HOOK_NAME}.${event} 不是数组，未修改` };
      }
    }
    const scriptPath = copyHookScript(options.appPath, options.userDataPath, "antigravity-hook.mjs");
    for (const event of ANTIGRAVITY_EVENTS) {
      const command = buildCommand(options.execPath, scriptPath, event);
      const existingHandlers = findAntigravityHooks(loaded.config, event);
      if (existingHandlers.length > 0) {
        const updated = refreshManagedCommands(existingHandlers, command, "antigravity-hook.mjs", event);
        if (updated) result.updated += 1;
        else result.skipped += 1;
        continue;
      }
      const handler: HookHandler = {
        type: "command",
        command,
        timeout: 3,
      };
      // Antigravity uses flat handlers for invocation/stop and grouped tool handlers.
      const item = event === "PostToolUse" ? { matcher: "*", hooks: [handler] } : handler;
      const previous = namedHook[event];
      namedHook[event] = [...(Array.isArray(previous) ? previous : []), item];
      result.added += 1;
    }
    if (result.added === 0 && result.updated === 0) return result;
    loaded.config[ANTIGRAVITY_HOOK_NAME] = namedHook;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (loaded.existed) {
      result.backupPath = `${filePath}.light-backup-${timestamp()}-${Date.now()}`;
      fs.copyFileSync(filePath, result.backupPath, fs.constants.COPYFILE_EXCL);
    }
    fs.writeFileSync(filePath, JSON.stringify(loaded.config, null, 2) + "\n", "utf8");
    result.changed = true;
    return result;
  } catch (err) {
    return { ...result, error: err instanceof Error ? err.message : "安装失败" };
  }
}

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

function findLightHooks(groups: HookGroup[] | undefined, scriptName: string): HookHandler[] {
  if (!Array.isArray(groups)) return [];
  return groups.flatMap((group) =>
    Array.isArray(group?.hooks) ? group.hooks.filter((hook) =>
      hook?.type === "command" &&
      typeof hook.command === "string" &&
      isEquivalentLightHook(hook.command, scriptName),
    ) : [],
  );
}

function refreshManagedCommands(
  handlers: { command?: unknown }[], command: string, scriptName: string, arg: string,
): boolean {
  // Only migrate the exact command shape emitted by this installer. Custom
  // wrappers, extra env vars, chained commands and matcher/permission fields stay intact.
  const quoted = String.raw`'(?:[^']|'\\'')*'`;
  const shape = process.platform === "win32"
    ? /^set "ELECTRON_RUN_AS_NODE=1" && "[^"]*" "[^"]*" "[^"]*"$/
    : new RegExp(`^ELECTRON_RUN_AS_NODE=1 ${quoted} ${quoted} ${quoted}$`);
  let updated = false;
  for (const handler of handlers) {
    const old = handler.command;
    if (typeof old === "string" && old !== command && shape.test(old) &&
        old.includes(scriptName) && old.endsWith(` ${quoteArg(arg)}`)) {
      handler.command = command;
      updated = true;
    }
  }
  return updated;
}

function appendHook(
  hooks: Record<string, HookGroup[]>,
  spec: HookSpec,
  command: string,
  scriptName: string,
): "added" | "updated" | "skipped" {
  const existing = hooks[spec.event];
  const handlers = findLightHooks(existing, scriptName);
  if (handlers.length > 0) {
    return refreshManagedCommands(handlers, command, scriptName, spec.arg) ? "updated" : "skipped";
  }
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
      updated: 0,
      skipped: 0,
      error: loaded.error,
    };
  }

  const hooks = ensureHooks(loaded.config);
  let added = 0;
  let updated = 0;
  let skipped = 0;

  for (const spec of specs) {
    const command = buildCommand(execPath, scriptPath, spec.arg);
    const result = appendHook(hooks, spec, command, scriptName);
    if (result === "added") added += 1;
    else if (result === "updated") updated += 1;
    else skipped += 1;
  }

  if (added === 0 && updated === 0) {
    return { target, path: filePath, changed: false, added, updated, skipped };
  }

  let backupPath: string | undefined;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (loaded.existed) {
    backupPath = `${filePath}.light-backup-${timestamp()}-${Date.now()}`;
    fs.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL);
  }
  fs.writeFileSync(filePath, JSON.stringify(loaded.config, null, 2) + "\n", "utf8");
  return { target, path: filePath, changed: true, added, updated, skipped, backupPath };
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
    antigravity: installAntigravityHooks(options),
  };
}

export function formatInstallHooksResult(result: InstallHooksResult): string {
  const lines = [
    "已安全合并 Hooks",
    "补齐缺失事件，并更新安装器生成的旧执行路径；自定义命令和其他 hook 保持不变。",
    "",
    formatTargetResult(result.claude),
    formatTargetResult(result.codex),
    formatTargetResult(result.antigravity),
    "",
    `Hook 脚本目录: ${result.hookDir}`,
    "",
    "下一步: 重启 Claude Code / Codex，并在 CLI 里运行 /hooks 信任新增 hook。",
    "Antigravity: 新一轮对话会加载配置；若未生效，按原有方式完全退出并重新启动。",
    "Antigravity 支持工作、工具完成、完成/出错；暂不检测等待审批或窗口关闭。",
  ];
  return lines.join("\n");
}

function formatTargetResult(result: TargetResult): string {
  if (result.error) {
    return `${result.target}: 失败，未修改\n  ${result.path}\n  ${result.error}`;
  }
  const status = result.changed
    ? `补齐 ${result.added} 项，更新路径 ${result.updated} 项，跳过 ${result.skipped} 项`
    : `无需修改，已有 Light hook ${result.skipped} 项`;
  const backup = result.backupPath ? `\n  备份: ${result.backupPath}` : "";
  return `${result.target}: ${status}\n  ${result.path}${backup}`;
}
