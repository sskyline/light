// Dev-only mock of the Electron `window.light` bridge.
//
// When the renderer runs in a plain browser (e.g. `vite` without Electron),
// there is no preload script, so `window.light` is undefined and the island
// would sit empty forever. This installs a fake bridge that feeds
// representative sessions / media / memos so the UI can be developed and
// visually verified in a normal browser tab.
//
// It is gated behind `import.meta.env.DEV && !window.light` at the call site,
// so it never runs inside the real Electron app (where the preload always
// defines window.light first).

import type {
  AppState,
  LightEvent,
  Memo,
  MediaAction,
  SessionState,
  SystemState,
} from "./types";

type Mode = "working" | "done" | "idle" | "error" | "multi" | "cycle";

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
    seq: 1,
    status: "idle",
    lastEventAt: iso(),
    recent: [
      { agent: "claude-code", type: "tool_use", tool: "Bash", timestamp: iso(-2000) },
      { agent: "claude-code", type: "tool_use", tool: "Edit", timestamp: iso(-9000) },
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
    seq: 1,
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
    case "idle":
      return [claudeSession({ status: "idle" })];
    case "multi":
      return [
        claudeSession({
          status: "working",
          currentTool: "Edit",
          startedAt: iso(-17000),
          lastPrompt: "重构 AgentPill 组件",
        }),
        codexSession({ status: "done" }),
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

export function installMockBridge(): void {
  installBackdrop();

  const mode = param("mock", "cycle") as Mode;

  const stateListeners = new Set<(s: AppState) => void>();
  const systemListeners = new Set<(s: SystemState) => void>();
  const memoListeners = new Set<(m: Memo[]) => void>();
  const eventListeners = new Set<(e: LightEvent) => void>();

  let memos: Memo[] = [
    { id: "m1", text: "把玻璃质感在亮色壁纸下调好", completed: false, createdAt: iso(-60000) },
    { id: "m2", text: "修掉 hover 抖动", completed: false, createdAt: iso(-50000) },
  ];

  const media: SystemState = {
    media: {
      playing: true,
      title: "Weightless",
      artist: "Marconi Union",
      app: "cloudmusic",
      updatedAt: iso(),
    },
    bridgeReady: true,
  };

  let tick = 0;
  const buildState = (): AppState => ({ sessions: sessionsFor(mode, tick) });

  const emitState = () => {
    const s = buildState();
    stateListeners.forEach((cb) => cb(s));
  };
  const emitMemos = () => memoListeners.forEach((cb) => cb([...memos]));

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
    onMemos: (cb) => {
      memoListeners.add(cb);
      return () => memoListeners.delete(cb);
    },
    onSystem: (cb) => {
      systemListeners.add(cb);
      return () => systemListeners.delete(cb);
    },
    onBlur: () => () => {},
    getState: async () => buildState(),
    getMemos: async () => [...memos],
    getSystem: async () => media,
    addMemo: (text: string) => {
      memos = [
        ...memos,
        { id: `m${Date.now()}`, text, completed: false, createdAt: iso() },
      ];
      emitMemos();
    },
    toggleMemo: (id: string) => {
      memos = memos.map((m) =>
        m.id === id
          ? { ...m, completed: !m.completed, completedAt: m.completed ? undefined : iso() }
          : m,
      );
      emitMemos();
    },
    deleteMemo: (id: string) => {
      memos = memos.filter((m) => m.id !== id);
      emitMemos();
    },
    clearEvents: () => {},
    removeSession: () => {},
    mediaControl: (action: MediaAction) => {
      if (media.media && (action === "playpause" || action === "play" || action === "pause")) {
        media.media = { ...media.media, playing: !media.media.playing };
        systemListeners.forEach((cb) => cb(media));
      }
    },
    startWindowDrag: () => {},
    endWindowDrag: () => {},
    setHotZones: () => {},
    quit: () => {},
  };

  window.light = bridge;
}
