export type AgentId = "claude-code" | "codex" | "antigravity" | "trae";

export type AgentStatus = "idle" | "working" | "waiting" | "auto_approval_failed" | "done" | "error";

export type EventType =
  | "session_start"
  | "session_end"
  | "user_prompt"
  | "tool_use"
  | "approval_request"
  | "auto_approval_failed"
  | "tool_result"
  | "stop"
  | "interrupt"
  | "notification"
  | "error";

export interface LightEvent {
  toolTarget?: string;
  toolCallId?: string;
  approvalId?: number;
  agent: AgentId;
  type: EventType;
  sessionId?: string;
  tool?: string;
  message?: string;
  timestamp: string;
}

export interface SessionState {
  jumpTarget?: "codex" | "claude-desktop" | "iterm" | "ghostty" | "rex";
  key: string;
  agent: AgentId;
  sessionId: string;
  status: AgentStatus;
  currentTool?: string;
  lastPrompt?: string;
  lastEventAt: string;
  startedAt?: string;
  turnEnd?: { type: "stop" | "interrupt" | "error"; timestamp: string };
  unreadApprovals?: LightEvent[];
  recent: LightEvent[];
}

export interface AppState {
  sessions: SessionState[];
}

export interface AppPresence {
  installed: boolean;
}

// 键只会出现 antigravity/codex/claude-code;null 表示平台不支持探测(非 macOS),
// 此时 UI 视为全部已安装。
export type PresenceState = Partial<Record<AgentId, AppPresence>>;

export interface HotZone {
  x: number;
  y: number;
  w: number;
  h: number;
}

declare global {
  interface Window {
    light: {
      onEvent: (cb: (evt: LightEvent) => void) => () => void;
      onState: (cb: (state: AppState) => void) => () => void;
      onPresence: (cb: (state: PresenceState | null) => void) => () => void;
      onBlur: (cb: () => void) => () => void;
      // Cursor-over-hotzone signal from the main process. Optional: only the
      // real Electron bridge provides it; the browser dev mock relies on DOM
      // mouse events instead.
      onHover?: (cb: (over: boolean) => void) => () => void;
      onPanelLayout?: (cb: (layout: import("../electron/panelPlacement").PanelLayout) => void) => () => void;
      onOpenDiagnostics?: (cb: () => void) => () => void;
      installHooks?: () => Promise<void>;
      getDiagnostics: () => Promise<import("../shared/diagnostics").ConnectionReport>;
      getState: () => Promise<AppState>;
      getSessionTitle: (key: string) => Promise<string | null>;
      openSession: (key: string) => Promise<{ opened: boolean; message?: string }>;
      getSessionJumpKind: (key: string) => Promise<SessionState["jumpTarget"]>;
      getPresence: () => Promise<PresenceState | null>;
      acknowledgeApproval: (key: string, id: number) => void;
      clearEvents: () => void;
      removeSession: (key: string) => void;
      panelOpened: () => void;
      startWindowDrag?: () => void;
      endWindowDrag?: () => void;
      setHotZones: (zones: HotZone[]) => void;
      quit: () => void;
    };
  }
}
