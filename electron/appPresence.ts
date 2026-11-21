import { execFile } from "node:child_process";

export type SwitchTarget = "antigravity" | "codex" | "claude-code";

// codex 的显示名是 ChatGPT.app，bundle id 表明它就是 Codex 桌面版。
export const BUNDLE_IDS: Record<SwitchTarget, string> = {
  antigravity: "com.google.antigravity",
  codex: "com.openai.codex",
  "claude-code": "com.anthropic.claudefordesktop",
};

export interface AppPresence {
  installed: boolean;
}

export type PresenceState = Record<SwitchTarget, AppPresence>;

export type ProbeExec = (
  cmd: string,
  args: string[],
  cb: (err: Error | null, stdout: string) => void,
) => void;

const PROBE_TIMEOUT_MS = 4000;

// JXA 在同一个 osascript 进程里查 LaunchServices 安装态。
// 注意:JXA 把 ObjC 的 nil 桥接成一个 truthy 的函数对象(对它发任何消息都再
// 返回 nil),所以判断安装与否必须取 absoluteString 再 ObjC.unwrap——直接判
// URLForApplicationWithBundleIdentifier 的返回值是否为 undefined 会把未安装
// 的应用误判成已安装(2026-09-07 真机验证)。
const PROBE_SCRIPT = `
ObjC.import('AppKit');
const ws = $.NSWorkspace.sharedWorkspace;
const out = {};
${JSON.stringify(Object.values(BUNDLE_IDS))}.forEach((id) => {
  let path;
  try {
    path = ObjC.unwrap(ws.URLForApplicationWithBundleIdentifier(id).absoluteString);
  } catch (e) {
    path = undefined;
  }
  out[id] = { installed: typeof path === "string" && path.length > 0 };
});
JSON.stringify(out);
`;

const defaultExec: ProbeExec = (cmd, args, cb) =>
  execFile(cmd, args, { timeout: PROBE_TIMEOUT_MS }, (err, stdout) => cb(err, stdout ?? ""));

// 首次探测完成前的乐观默认:视为已安装,保持跳转按钮可见。
export function defaultPresence(): PresenceState {
  const out = {} as PresenceState;
  for (const target of Object.keys(BUNDLE_IDS) as SwitchTarget[]) {
    out[target] = { installed: true };
  }
  return out;
}

export function parseProbeOutput(stdout: string): PresenceState | null {
  try {
    const raw = JSON.parse(stdout.trim());
    if (!raw || typeof raw !== "object") return null;
    const out = {} as PresenceState;
    for (const target of Object.keys(BUNDLE_IDS) as SwitchTarget[]) {
      const v = raw[BUNDLE_IDS[target]];
      // 单个 bundle id 缺键时按未探测处理:宁可多显示按钮也不误隐藏。
      out[target] = {
        installed: typeof v?.installed === "boolean" ? v.installed : true,
      };
    }
    return out;
  } catch {
    return null;
  }
}

function presenceEqual(a: PresenceState, b: PresenceState): boolean {
  return (Object.keys(BUNDLE_IDS) as SwitchTarget[]).every(
    (t) => a[t].installed === b[t].installed,
  );
}

export interface PresenceWatcherOptions {
  onChange: (state: PresenceState) => void;
  intervalMs?: number | null;
  exec?: ProbeExec;
  log?: (...args: unknown[]) => void;
}

export class PresenceWatcher {
  private state: PresenceState = defaultPresence();
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private started = false;
  private readonly intervalMs: number | null;
  private readonly exec: ProbeExec;
  private readonly log: (...args: unknown[]) => void;
  private readonly onChange: (state: PresenceState) => void;

  constructor(opts: PresenceWatcherOptions) {
    this.onChange = opts.onChange;
    this.intervalMs = opts.intervalMs ?? null;
    this.exec = opts.exec ?? defaultExec;
    this.log = opts.log ?? console.error;
  }

  getState(): PresenceState {
    return { ...this.state };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.probe();
  }

  stop(): void {
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  probeNow(): void {
    if (!this.started) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.probe();
  }

  // open -b 失败是 LaunchServices 给的权威答案:未安装。
  markNotInstalled(target: SwitchTarget): void {
    this.apply({ ...this.state, [target]: { installed: false } });
  }

  private probe(): void {
    if (this.inFlight) return;
    this.inFlight = true;
    this.exec("osascript", ["-l", "JavaScript", "-e", PROBE_SCRIPT], (err, stdout) => {
      this.inFlight = false;
      if (err) {
        this.log("[appPresence] probe failed:", err.message);
      } else {
        const parsed = parseProbeOutput(stdout);
        if (parsed) this.apply(parsed);
        else this.log("[appPresence] probe output unparsable");
      }
      this.schedule();
    });
  }

  private schedule(): void {
    if (!this.started || this.intervalMs == null || this.intervalMs <= 0) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.probe();
    }, this.intervalMs);
  }

  private apply(next: PresenceState): void {
    if (presenceEqual(this.state, next)) return;
    this.state = next;
    this.onChange(this.getState());
  }
}
