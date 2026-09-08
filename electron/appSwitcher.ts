import { execFile } from "node:child_process";

export type SwitchTarget = "antigravity" | "codex" | "claude-code";

// codex 的显示名是 ChatGPT.app，bundle id 表明它就是 Codex 桌面版。
export const BUNDLE_IDS: Record<SwitchTarget, string> = {
  antigravity: "com.google.antigravity",
  codex: "com.openai.codex",
  "claude-code": "com.anthropic.claudefordesktop",
};

export function isSwitchTarget(v: unknown): v is SwitchTarget {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(BUNDLE_IDS, v);
}

export type ExecFn = (cmd: string, args: string[], cb: (err: Error | null) => void) => void;

const defaultExec: ExecFn = (cmd, args, cb) => execFile(cmd, args, { timeout: 4000 }, cb);

export function switchToApp(
  target: SwitchTarget,
  exec: ExecFn = defaultExec,
  log: (...args: unknown[]) => void = console.error,
  onError?: (err: Error) => void,
): void {
  const bundleId = BUNDLE_IDS[target];
  exec("open", ["-b", bundleId], (err) => {
    if (err) {
      log(`[appSwitcher] failed to activate ${target} (${bundleId})`, err.message);
      onError?.(err);
    }
  });
}
