export type AgentId = "claude-code" | "codex" | "trae";

export type AgentStatus = "idle" | "working" | "waiting" | "done" | "error";

export type EventType =
  | "session_start"
  | "session_end"
  | "user_prompt"
  | "tool_use"
  | "approval_request"
  | "tool_result"
  | "stop"
  | "notification"
  | "error";

export interface LightEvent {
  agent: AgentId;
  type: EventType;
  sessionId?: string;
  tool?: string;
  message?: string;
  timestamp: string;
}

export interface SessionState {
  key: string;
  agent: AgentId;
  sessionId: string;
  seq: number;
  status: AgentStatus;
  currentTool?: string;
  lastPrompt?: string;
  lastEventAt: string;
  startedAt?: string;
  recent: LightEvent[];
}

export interface AppState {
  sessions: SessionState[];
}

export interface Memo {
  id: string;
  text: string;
  completed: boolean;
  createdAt: string;
  completedAt?: string;
}

export interface MediaState {
  playing: boolean;
  title: string;
  artist: string;
  app: string;
  updatedAt: string;
}

export interface SystemState {
  media: MediaState | null;
  bridgeReady: boolean;
}

export type MediaAction = "next" | "prev" | "playpause" | "play" | "pause";

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
      onMemos: (cb: (memos: Memo[]) => void) => () => void;
      onSystem: (cb: (state: SystemState) => void) => () => void;
      onBlur: (cb: () => void) => () => void;
      // Cursor-over-hotzone signal from the main process. Optional: only the
      // real Electron bridge provides it; the browser dev mock relies on DOM
      // mouse events instead.
      onHover?: (cb: (over: boolean) => void) => () => void;
      getState: () => Promise<AppState>;
      getMemos: () => Promise<Memo[]>;
      getSystem: () => Promise<SystemState>;
      addMemo: (text: string) => void;
      toggleMemo: (id: string) => void;
      deleteMemo: (id: string) => void;
      clearEvents: () => void;
      removeSession: (key: string) => void;
      mediaControl: (action: MediaAction) => void;
      startWindowDrag?: () => void;
      endWindowDrag?: () => void;
      setHotZones: (zones: HotZone[]) => void;
      quit: () => void;
    };
  }
}
