// Dev-only mock of the Electron `window.light` bridge.
//
// When the renderer runs in a plain browser (e.g. `vite` without Electron),
// there is no preload script, so `window.light` is undefined and the island
// would sit empty forever. This installs a fake bridge that feeds
// representative sessions for UI development in a browser tab.
//
// It is gated behind `import.meta.env.DEV && !window.light` at the call site,
// so it never runs inside the real Electron app (where the preload always
// defines window.light first).

import type {
  AppState,
  LightEvent,
  PresenceState,
  SessionState,
} from "./types";

type Mode = "working" | "done" | "idle" | "error" | "multi" | "antigravity" | "cycle";

function param(name: string, fallback: string): string {
  const v = new URLSearchParams(window.location.search).get(name);
  return v ?? fallback;
}

function iso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function claudeSession(over: Partial<SessionState>): SessionState {
  return {
    key: "claude-code::demo",
    agent: "claude-code",
    sessionId: "demo",
    status: "idle",
    lastEventAt: iso(),
    recent: [
      { agent: "claude-code", type: "tool_use", tool: "Bash", message: "Bash: npm test", timestamp: iso(-2000) },
      { agent: "claude-code", type: "tool_result", tool: "Edit", message: "completed: Edit: src/styles.css", timestamp: iso(-9000) },
      { agent: "claude-code", type: "user_prompt", message: "修复灵动岛的玻璃质感", timestamp: iso(-42000) },
    ] as LightEvent[],
    ...over,
  };
}

function codexSession(over: Partial<SessionState>): SessionState {
  return {
    key: "codex::demo",
    agent: "codex",
    sessionId: "demo",
    status: "idle",
    lastEventAt: iso(),
    recent: [],
    ...over,
  };
}

// startedAt is pinned in the past so the working timer shows a realistic value
// immediately and then keeps climbing (great for confirming the timer ticks in
// place without re-animating the chip).
const WORK_STARTED = iso(-42000);

function sessionsFor(mode: Mode, t: number): SessionState[] {
  switch (mode) {
    case "working":
      return [
        claudeSession({
          status: "working",
          currentTool: "Bash",
          startedAt: WORK_STARTED,
          lastPrompt: "修复灵动岛的液态玻璃质感，并解决悬停时字体抖动的问题",
        }),
      ];
    case "done":
      return [claudeSession({ status: "done" })];
    case "error":
      return [claudeSession({ status: "error" })];
    case "antigravity":
      return [{
        key: "antigravity::demo",
        agent: "antigravity",
        sessionId: "demo",
        status: "working",
        startedAt: WORK_STARTED,
        lastEventAt: iso(),
        recent: [],
      }];
    case "idle":
      return [claudeSession({ status: "idle" })];
    case "multi":
      return [
        claudeSession({
          status: "working",
          jumpTarget: "rex",
          currentTool: "Edit",
          startedAt: iso(-17000),
          lastPrompt: "重构 AgentPill 组件",
        }),
        codexSession({ status: "done", jumpTarget: "codex" }),
        claudeSession({
          key: "claude-code::idle-recent",
          sessionId: "idle-recent",
          status: "idle",
          jumpTarget: "ghostty",
          lastEventAt: iso(-5 * 60_000),
          turnEnd: { type: "stop", timestamp: iso(-5 * 60_000) },
          lastPrompt: "核对安装器路径与签名配置",
        }),
        claudeSession({
          key: "claude-code::pinned",
          sessionId: "pinned",
          status: "idle",
          jumpTarget: "rex",
          lastEventAt: iso(-38 * 60_000),
          turnEnd: { type: "stop", timestamp: iso(-38 * 60_000) },
          lastPrompt: "跟进空闲会话保留与恢复拉起",
        }),
      ];
    case "cycle":
    default: {
      // working (0-6s) -> done (6-11s) -> idle (11-13s) -> repeat.
      const phase = t % 13;
      if (phase < 6) {
        return [
          claudeSession({
            status: "working",
            currentTool: "Bash",
            startedAt: iso(-phase * 1000),
            lastPrompt: "运行测试并提交",
          }),
        ];
      }
      if (phase < 11) return [claudeSession({ status: "done" })];
      return [claudeSession({ status: "idle" })];
    }
  }
}

function installBackdrop(): void {
  if (document.getElementById("mock-bg")) return;
  const bg = document.createElement("div");
  bg.id = "mock-bg";
  Object.assign(bg.style, {
    position: "fixed",
    inset: "0",
    zIndex: "-1",
  } as CSSStyleDeclaration);
  const kind = param("bg", "photo");
  if (kind === "white") {
    bg.style.background = "#f4f4f6";
  } else if (kind === "dark") {
    bg.style.background = "#0a0a0c";
  } else {
    // A bright, saturated, varied "wallpaper" — the worst case for the old
    // plastic look. If the glass reads well here it reads well anywhere.
    bg.style.background =
      "linear-gradient(120deg, #ffd27a 0%, #ff7eb3 28%, #6a5bff 60%, #2bd6c8 100%)";
  }
  document.body.appendChild(bg);
}

export function installMockBridge({ backdrop = true, defaultMode = "cycle" }: {
  backdrop?: boolean;
  defaultMode?: Mode;
} = {}): void {
  if (backdrop) installBackdrop();

  const mode = param("mock", defaultMode) as Mode;

  const stateListeners = new Set<(s: AppState) => void>();
  const eventListeners = new Set<(e: LightEvent) => void>();
  const presenceListeners = new Set<(p: PresenceState | null) => void>();

  // ?noinstall=codex,antigravity 可以把对应 app 模拟成未安装(跳转按钮应隐藏)。
  const noInstall = new Set(param("noinstall", "").split(",").filter(Boolean));
  const presence: PresenceState = {
    antigravity: { installed: !noInstall.has("antigravity") },
    codex: { installed: !noInstall.has("codex") },
    "claude-code": { installed: !noInstall.has("claude-code") },
  };

  let tick = 0;
  const pinnedKeys = new Set<string>(mode === "multi" ? ["claude-code::pinned"] : []);
  const removedKeys = new Set<string>();
  const buildState = (): AppState => ({
    sessions: sessionsFor(mode, tick)
      .filter((s) => !removedKeys.has(s.key))
      .map((s) => (pinnedKeys.has(s.key) ? { ...s, pinned: true } : s)),
  });

  const emitState = () => {
    const s = buildState();
    stateListeners.forEach((cb) => cb(s));
  };

  // Drive the clock so the working timer climbs and `cycle` mode advances.
  window.setInterval(() => {
    tick += 1;
    emitState();
  }, 1000);

  const bridge: Window["light"] = {
    onEvent: (cb) => {
      eventListeners.add(cb);
      return () => eventListeners.delete(cb);
    },
    onState: (cb) => {
      stateListeners.add(cb);
      return () => stateListeners.delete(cb);
    },
    onPresence: (cb) => {
      presenceListeners.add(cb);
      return () => presenceListeners.delete(cb);
    },
    onBlur: () => () => {},
    getDiagnostics: async () => ({
      service: { running: false, status: "浏览器预览", address: "127.0.0.1:51789" },
      adapters: [],
    }),
    getState: async () => buildState(),
    getSessionTitle: async (key) => {
      if (key === "codex::demo") return "整理桌面状态面板";
      if (key === "claude-code::demo") return "调整胶囊样式";
      if (key === "claude-code::pinned") return "空闲会话保留与恢复拉起";
      if (key === "claude-code::idle-recent") return "核对安装器路径与签名配置";
      if (key === "antigravity::demo") return "检查项目构建流程";
      return null;
    },
    getPresence: async () => ({ ...presence }),
    acknowledgeApproval: () => {},
    clearEvents: () => {},
    removeSession: (key) => {
      removedKeys.add(key);
      pinnedKeys.delete(key);
      emitState();
    },
    setSessionPinned: (key, pinned) => {
      if (pinned) pinnedKeys.add(key);
      else pinnedKeys.delete(key);
      emitState();
    },
    openSession: async () => ({ opened: false }),
    getSessionJumpKind: async () => undefined,
    panelOpened: () => {},
    startWindowDrag: () => {},
    endWindowDrag: () => {},
    setHotZones: () => {},
    quit: () => {},
  };

  window.light = bridge;
}
