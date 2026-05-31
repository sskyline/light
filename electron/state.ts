import { EventEmitter } from "node:events";

export type AgentId = "claude-code" | "codex" | "trae";
export type AgentStatus = "idle" | "working" | "done" | "error";
export type EventType =
  | "session_start"
  | "session_end"
  | "user_prompt"
  | "tool_use"
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
  seq: number; // human-friendly per-agent index ("第 N 个对话")
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

const DONE_LINGER_MS = 8_000;
const ERROR_LINGER_MS = 5_000;
// If a session sits in "working" with no new event for this long, assume the
// agent crashed / lost network / was killed, and drop it back to idle so the
// timer stops climbing forever.
const STALE_WORKING_MS = 4 * 60_000;
const IDLE_GC_MS = 30 * 60_000; // drop idle sessions after 30 min of no activity
const RECENT_CAP = 30;

const VALID_AGENTS = new Set<AgentId>(["claude-code", "codex", "trae"]);
const VALID_TYPES = new Set<EventType>([
  "session_start",
  "session_end",
  "user_prompt",
  "tool_use",
  "stop",
  "notification",
  "error",
]);

export function isValidAgent(x: unknown): x is AgentId {
  return typeof x === "string" && VALID_AGENTS.has(x as AgentId);
}
export function isValidType(x: unknown): x is EventType {
  return typeof x === "string" && VALID_TYPES.has(x as EventType);
}

function truncate(s: string | undefined, max = 200): string | undefined {
  if (s == null) return s;
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function keyOf(agent: AgentId, sessionId: string): string {
  return `${agent}::${sessionId}`;
}

function shortSessionId(raw: string | undefined): string {
  if (!raw) return "default";
  // Many session IDs are UUIDs; take the first 8 chars as a stable short tag.
  return raw.replace(/[^A-Za-z0-9-]/g, "").slice(0, 12) || "default";
}

export class StateStore extends EventEmitter {
  private sessions = new Map<string, SessionState>();
  private timers = new Map<string, NodeJS.Timeout>();
  private gcTimers = new Map<string, NodeJS.Timeout>();
  private seqCounters = new Map<AgentId, number>();

  private nextSeq(agent: AgentId): number {
    const n = (this.seqCounters.get(agent) ?? 0) + 1;
    this.seqCounters.set(agent, n);
    return n;
  }

  getState(): AppState {
    const arr = Array.from(this.sessions.values()).sort(
      (a, b) => (a.lastEventAt < b.lastEventAt ? 1 : -1),
    );
    return JSON.parse(JSON.stringify({ sessions: arr }));
  }

  ingest(rawEvent: LightEvent): LightEvent {
    const sessionId = shortSessionId(rawEvent.sessionId);
    const evt: LightEvent = {
      agent: rawEvent.agent,
      type: rawEvent.type,
      sessionId,
      tool: typeof rawEvent.tool === "string" ? truncate(rawEvent.tool, 80) : undefined,
      message: typeof rawEvent.message === "string" ? truncate(rawEvent.message, 400) : undefined,
      timestamp: rawEvent.timestamp ?? new Date().toISOString(),
    };

    const key = keyOf(evt.agent, sessionId);

    // session_end removes the session entirely (the agent window closed).
    if (evt.type === "session_end") {
      const t = this.timers.get(key);
      if (t) clearTimeout(t);
      const g = this.gcTimers.get(key);
      if (g) clearTimeout(g);
      this.timers.delete(key);
      this.gcTimers.delete(key);
      this.sessions.delete(key);
      this.emit("state", this.getState());
      this.emit("event", evt);
      return evt;
    }

    const prev = this.sessions.get(key);
    const recent = prev?.recent ?? [];
    const newRecent = [evt, ...recent].slice(0, RECENT_CAP);

    let next: SessionState = {
      key,
      agent: evt.agent,
      sessionId,
      seq: prev?.seq ?? this.nextSeq(evt.agent),
      status: prev?.status ?? "idle",
      currentTool: prev?.currentTool,
      lastPrompt: prev?.lastPrompt,
      lastEventAt: evt.timestamp,
      startedAt: prev?.startedAt,
      recent: newRecent,
    };

    switch (evt.type) {
      case "session_start":
        next.status = "idle";
        next.currentTool = undefined;
        next.startedAt = undefined;
        next.lastPrompt = undefined;
        break;
      case "user_prompt":
        next.status = "working";
        next.startedAt = evt.timestamp;
        next.lastPrompt = evt.message;
        next.currentTool = undefined;
        break;
      case "tool_use":
        next.status = "working";
        next.currentTool = evt.tool ?? evt.message;
        if (!next.startedAt) next.startedAt = evt.timestamp;
        break;
      case "stop":
        next.status = "done";
        next.currentTool = undefined;
        break;
      case "error":
        next.status = "error";
        next.currentTool = undefined;
        break;
      case "notification":
        break;
    }

    this.sessions.set(key, next);
    this.scheduleAutoReset(key);
    this.scheduleGc(key);
    this.emit("state", this.getState());
    this.emit("event", evt);
    return evt;
  }

  clearEvents(): void {
    for (const s of this.sessions.values()) {
      s.recent = [];
    }
    this.emit("state", this.getState());
  }

  // Manually drop a single session from the island (user housekeeping).
  // If that agent window is still alive and fires another hook later, the
  // session simply reappears with a fresh seq — nothing breaks.
  removeSession(key: string): void {
    const t = this.timers.get(key);
    if (t) clearTimeout(t);
    const g = this.gcTimers.get(key);
    if (g) clearTimeout(g);
    this.timers.delete(key);
    this.gcTimers.delete(key);
    if (this.sessions.delete(key)) {
      this.emit("state", this.getState());
    }
  }

  clearAll(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    for (const t of this.gcTimers.values()) clearTimeout(t);
    this.timers.clear();
    this.gcTimers.clear();
    this.sessions.clear();
    this.emit("state", this.getState());
  }

  private scheduleAutoReset(key: string): void {
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);

    const cur = this.sessions.get(key);
    if (!cur) return;

    // done/error linger briefly then settle to idle. "working" gets a much
    // longer watchdog so a crashed/disconnected agent doesn't climb forever.
    let delay = 0;
    if (cur.status === "done") delay = DONE_LINGER_MS;
    else if (cur.status === "error") delay = ERROR_LINGER_MS;
    else if (cur.status === "working") delay = STALE_WORKING_MS;
    else return;

    const timer = setTimeout(() => {
      const c = this.sessions.get(key);
      if (!c) return;
      if (c.status === "done" || c.status === "error" || c.status === "working") {
        c.status = "idle";
        c.startedAt = undefined;
        c.currentTool = undefined;
        this.emit("state", this.getState());
      }
    }, delay);
    this.timers.set(key, timer);
  }

  private scheduleGc(key: string): void {
    const existing = this.gcTimers.get(key);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      const cur = this.sessions.get(key);
      if (!cur) return;
      if (cur.status === "idle") {
        this.sessions.delete(key);
        this.gcTimers.delete(key);
        this.timers.delete(key);
        this.emit("state", this.getState());
      }
    }, IDLE_GC_MS);
    this.gcTimers.set(key, t);
  }
}
