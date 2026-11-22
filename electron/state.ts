import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { resolveJumpTarget, SESSION_UUID, type JumpTarget } from "./sessionNavigation";
export { SESSION_UUID } from "./sessionNavigation";

export type AgentId = "claude-code" | "codex" | "antigravity" | "trae";
type TitledAgent = "claude-code" | "codex" | "antigravity";
type ResumableAgent = "claude-code" | "codex";
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
  jumpTarget?: JumpTarget["kind"];
  pinned?: boolean;
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

export interface ResumeContext {
  agent: ResumableAgent;
  sessionId: string;
  cwd?: string;
}

export interface StateStoreOptions {
  pinnedFilePath?: string;
}

export interface AppState {
  sessions: SessionState[];
}

const STATUS_PRIORITY: Record<AgentStatus, number> = {
  error: -1,
  auto_approval_failed: 0,
  waiting: 1,
  working: 1,
  done: 2,
  idle: 3,
};

const DONE_LINGER_MS = 8_000;
const ERROR_LINGER_MS = 5_000;
// If a session sits in "working" with no new event for this long, assume the
// agent crashed / lost network / was killed, and drop it back to idle so the
// timer stops climbing forever.
const STALE_WORKING_MS = 4 * 60_000;
// Approval requests should not keep an abandoned session at the top forever.
// A later tool event can still move the session back to working as usual.
const STALE_WAITING_MS = 60_000;
const IDLE_GC_MS = 60 * 60_000; // Drop idle sessions one hour after their last event.
const RECENT_CAP = 30;
export const STATE_PUBLISH_INTERVAL_MS = 750;

const VALID_AGENTS = new Set<AgentId>(["claude-code", "codex", "antigravity", "trae"]);
const VALID_TYPES = new Set<EventType>([
  "session_start",
  "session_end",
  "user_prompt",
  "tool_use",
  "approval_request",
  "auto_approval_failed",
  "tool_result",
  "stop",
  "interrupt",
  "notification",
  "error",
]);

export function isValidAgent(x: unknown): x is AgentId {
  return typeof x === "string" && VALID_AGENTS.has(x as AgentId);
}
export function isValidType(x: unknown): x is EventType {
  return typeof x === "string" && VALID_TYPES.has(x as EventType);
}

export function sanitizeCwd(raw: unknown): string | undefined {
  if (typeof raw !== "string" || /[\0\r\n]/.test(raw)) return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 1024 || !path.isAbsolute(trimmed)) return undefined;
  return trimmed;
}

function hasSessionTitles(agent?: AgentId): agent is TitledAgent {
  return agent === "claude-code" || agent === "codex" || agent === "antigravity";
}

function isResumableAgent(agent?: AgentId): agent is ResumableAgent {
  return agent === "claude-code" || agent === "codex";
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
  const cleaned = raw.replace(/[^A-Za-z0-9-]/g, "");
  if (cleaned.startsWith("cw-")) return cleaned.slice(0, 20) || "default";
  if (cleaned.startsWith("codex-wrap-")) return cleaned.slice(0, 24) || "default";
  // Many session IDs are UUIDs; take the first 8 chars as a stable short tag.
  return cleaned.slice(0, 12) || "default";
}

function sameJump(a: JumpTarget | undefined, b: JumpTarget | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind || a.id !== b.id) return false;
  if (a.kind === "rex" && b.kind === "rex") return a.session === b.session;
  return true;
}

function validatePersistedJump(agent: AgentId, rawJump: unknown): JumpTarget | undefined {
  if (process.platform !== "darwin" || !rawJump || typeof rawJump !== "object" || !("kind" in rawJump)) {
    return undefined;
  }
  const candidate = rawJump as { kind?: unknown; id?: unknown; session?: unknown };
  if (candidate.kind === "rex" || candidate.kind === "ghostty" || candidate.kind === "iterm") {
    return resolveJumpTarget(agent, undefined, candidate);
  }
  if (candidate.kind === "codex" && agent === "codex" && typeof candidate.id === "string" && SESSION_UUID.test(candidate.id)) {
    return { kind: "codex", id: candidate.id.toLowerCase() };
  }
  if (
    candidate.kind === "claude-desktop" &&
    agent === "claude-code" &&
    typeof candidate.id === "string" &&
    /^local_[a-zA-Z0-9-]{1,64}$/.test(candidate.id)
  ) {
    return { kind: "claude-desktop", id: candidate.id };
  }
  return undefined;
}

type StoredSession = SessionState & {
  jump?: JumpTarget;
  cwd?: string;
  resumeId?: string;
  ended?: boolean;
};

interface PersistedPinnedSession {
  key: string;
  agent: AgentId;
  sessionId: string;
  lastPrompt?: string;
  lastEventAt: string;
  turnEnd?: { type: "stop" | "interrupt" | "error"; timestamp: string };
  recent?: LightEvent[];
  cwd?: string;
  resumeId?: string;
  jump?: JumpTarget;
}

export class StateStore extends EventEmitter {
  private sessions = new Map<string, StoredSession>();
  private approvalSequence = 0;
  private timers = new Map<string, NodeJS.Timeout>();
  private gcTimers = new Map<string, NodeJS.Timeout>();
  private publishTimer?: NodeJS.Timeout;
  private lastPublishedAt?: number;
  private pinnedFilePath?: string;

  constructor(options?: StateStoreOptions) {
    super();
    this.pinnedFilePath = options?.pinnedFilePath;
    if (this.pinnedFilePath) {
      this.loadPinnedSessions();
    }
  }

  configurePersistence(pinnedFilePath: string): void {
    this.pinnedFilePath = pinnedFilePath;
    this.loadPinnedSessions();
  }

  // Ingest every event immediately, but only serialize/push the latest snapshot
  // once per interval during tool bursts. This is a throttle, not a debounce:
  // continuous output must keep updating the UI, and the final update must land.
  private publishState(immediate = false): void {
    const remaining = this.lastPublishedAt === undefined
      ? 0
      : STATE_PUBLISH_INTERVAL_MS - (Date.now() - this.lastPublishedAt);
    if (immediate || remaining <= 0) {
      if (this.publishTimer) clearTimeout(this.publishTimer);
      this.publishTimer = undefined;
      this.lastPublishedAt = Date.now();
      this.emit("state", this.getState());
    } else if (!this.publishTimer) {
      this.publishTimer = setTimeout(() => this.publishState(true), remaining);
    }
  }

  private loadPinnedSessions(): void {
    if (!this.pinnedFilePath) return;
    let parsed: unknown;
    try {
      if (!fs.existsSync(this.pinnedFilePath)) return;
      parsed = JSON.parse(fs.readFileSync(this.pinnedFilePath, "utf8"));
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { sessions?: unknown }).sessions)) {
      return;
    }

    for (const item of (parsed as { sessions: unknown[] }).sessions) {
      if (!item || typeof item !== "object") continue;
      const raw = item as Record<string, unknown>;
      if (!isValidAgent(raw.agent)) continue;
      const agent = raw.agent;
      if (typeof raw.key !== "string" || !raw.key.startsWith(`${agent}::`)) continue;
      const keySuffix = raw.key.slice(agent.length + 2);
      if (!keySuffix) continue;
      if (typeof raw.sessionId !== "string" || !raw.sessionId) continue;

      const isUuidKey = hasSessionTitles(agent) && SESSION_UUID.test(keySuffix) && keySuffix === keySuffix.toLowerCase();
      const expectedShortId = shortSessionId(keySuffix);
      const normalizedSessionId = isUuidKey ? raw.sessionId.toLowerCase() : raw.sessionId;
      if (isUuidKey) {
        if (normalizedSessionId !== expectedShortId) continue;
      } else {
        if (keySuffix !== expectedShortId || normalizedSessionId !== expectedShortId) continue;
      }

      if (typeof raw.lastEventAt !== "string" || Number.isNaN(Date.parse(raw.lastEventAt))) continue;

      // Reject explicitly malformed fields on corrupted records rather than accepting tampered shapes.
      if (raw.cwd !== undefined && sanitizeCwd(raw.cwd) === undefined) continue;
      if (raw.resumeId !== undefined && (!isResumableAgent(agent) || typeof raw.resumeId !== "string" || !SESSION_UUID.test(raw.resumeId))) {
        continue;
      }
      if (process.platform === "darwin" && raw.jump !== undefined && raw.jump !== null && validatePersistedJump(agent, raw.jump) === undefined) {
        continue;
      }

      const cwd = sanitizeCwd(raw.cwd);
      const resumeId = isResumableAgent(agent)
        ? (typeof raw.resumeId === "string" && SESSION_UUID.test(raw.resumeId)
            ? raw.resumeId.toLowerCase()
            : (isUuidKey ? keySuffix : undefined))
        : undefined;
      if (resumeId && isUuidKey && resumeId !== keySuffix) continue;

      const jump = validatePersistedJump(agent, raw.jump);
      const lastPrompt = typeof raw.lastPrompt === "string" ? truncate(raw.lastPrompt, 400) : undefined;

      let turnEnd: SessionState["turnEnd"];
      if (raw.turnEnd && typeof raw.turnEnd === "object") {
        const te = raw.turnEnd as { type?: unknown; timestamp?: unknown };
        if (
          (te.type === "stop" || te.type === "interrupt" || te.type === "error") &&
          typeof te.timestamp === "string" &&
          !Number.isNaN(Date.parse(te.timestamp))
        ) {
          turnEnd = { type: te.type, timestamp: te.timestamp };
        }
      }

      const recent: LightEvent[] = [];
      if (Array.isArray(raw.recent)) {
        for (const entry of raw.recent) {
          if (recent.length >= RECENT_CAP) break;
          if (!entry || typeof entry !== "object") continue;
          const ev = entry as Record<string, unknown>;
          if (!isValidAgent(ev.agent) || !isValidType(ev.type)) continue;
          if (typeof ev.timestamp !== "string" || Number.isNaN(Date.parse(ev.timestamp))) continue;
          const reconstructed: LightEvent = {
            agent: ev.agent,
            type: ev.type,
            sessionId: typeof ev.sessionId === "string"
              ? (isUuidKey ? shortSessionId(ev.sessionId).toLowerCase() : shortSessionId(ev.sessionId))
              : normalizedSessionId,
            timestamp: ev.timestamp,
          };
          if (typeof ev.toolCallId === "string" && ev.toolCallId.length > 0 && ev.toolCallId.length <= 256) {
            reconstructed.toolCallId = ev.toolCallId;
          }
          if (typeof ev.approvalId === "number" && Number.isInteger(ev.approvalId) && ev.approvalId > 0) {
            reconstructed.approvalId = ev.approvalId;
            if (ev.approvalId > this.approvalSequence) this.approvalSequence = ev.approvalId;
          }
          if (typeof ev.tool === "string") reconstructed.tool = truncate(ev.tool, 80);
          if (typeof ev.toolTarget === "string") reconstructed.toolTarget = truncate(ev.toolTarget, 160);
          if (typeof ev.message === "string") reconstructed.message = truncate(ev.message, 400);
          recent.push(reconstructed);
        }
      }

      const restored: StoredSession = {
        key: raw.key,
        agent,
        sessionId: normalizedSessionId,
        status: "idle",
        pinned: true,
        lastPrompt,
        lastEventAt: raw.lastEventAt,
        turnEnd,
        recent,
        jump,
        cwd,
        resumeId,
        ended: true,
      };
      if (this.sessions.has(restored.key)) continue;
      this.sessions.set(restored.key, restored);
    }
  }

  private savePinnedSessions(): void {
    if (!this.pinnedFilePath) return;
    const sessions: PersistedPinnedSession[] = [];
    for (const s of this.sessions.values()) {
      if (!s.pinned) continue;
      const entry: PersistedPinnedSession = {
        key: s.key,
        agent: s.agent,
        sessionId: s.sessionId,
        lastEventAt: s.lastEventAt,
        recent: s.recent.slice(0, RECENT_CAP),
      };
      if (s.lastPrompt !== undefined) entry.lastPrompt = s.lastPrompt;
      if (s.turnEnd !== undefined) entry.turnEnd = s.turnEnd;
      if (s.cwd !== undefined) entry.cwd = s.cwd;
      if (s.resumeId !== undefined) entry.resumeId = s.resumeId;
      if (s.jump !== undefined) entry.jump = s.jump;
      sessions.push(entry);
    }
    const payload = JSON.stringify({ version: 1, sessions }, null, 2);
    try {
      fs.mkdirSync(path.dirname(this.pinnedFilePath), { recursive: true });
      const tmpPath = `${this.pinnedFilePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmpPath, payload, "utf8");
      fs.renameSync(tmpPath, this.pinnedFilePath);
    } catch {
      try {
        fs.writeFileSync(this.pinnedFilePath, payload, "utf8");
      } catch {
        /* ignore persistence write errors */
      }
    }
  }

  getState(): AppState {
    // Stable sort keeps the Map's insertion order within each priority.
    const arr = Array.from(this.sessions.values()).sort(
      (a, b) => STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status],
    );
    const sessions = arr.map(({ jump, cwd: _cwd, resumeId: _resumeId, ended: _ended, pinned, ...session }) => ({
      ...session,
      ...(pinned ? { pinned: true } : {}),
      jumpTarget: jump?.kind,
    }));
    return JSON.parse(JSON.stringify({ sessions }));
  }

  getJumpTarget(key: string): JumpTarget | undefined {
    return this.sessions.get(key)?.jump;
  }

  isSessionEnded(key: string): boolean {
    return this.sessions.get(key)?.ended === true;
  }

  getResumeContext(key: string): ResumeContext | undefined {
    const s = this.sessions.get(key);
    if (!s || !isResumableAgent(s.agent) || !s.resumeId || !SESSION_UUID.test(s.resumeId)) {
      return undefined;
    }
    return {
      agent: s.agent,
      sessionId: s.resumeId,
      ...(s.cwd ? { cwd: s.cwd } : {}),
    };
  }

  setPinned(key: string, pinned: boolean): boolean {
    const s = this.sessions.get(key);
    if (!s) return false;
    if (pinned) {
      s.pinned = true;
      const g = this.gcTimers.get(key);
      if (g) {
        clearTimeout(g);
        this.gcTimers.delete(key);
      }
    } else {
      delete s.pinned;
      this.scheduleGc(key);
    }
    this.savePinnedSessions();
    this.publishState(true);
    return true;
  }

  updateJumpTarget(key: string, jump: JumpTarget): void {
    const s = this.sessions.get(key);
    if (!s) return;
    s.jump = jump;
    s.ended = false;
    if (s.pinned) this.savePinnedSessions();
    this.publishState(true);
  }

  getTitleSession(key: string): { agent: TitledAgent; id: string } | undefined {
    const agent = this.sessions.get(key)?.agent;
    if (!hasSessionTitles(agent)) return undefined;
    const id = key.slice(agent.length + 2);
    return SESSION_UUID.test(id) ? { agent, id } : undefined;
  }

  ingest(rawEvent: LightEvent & { cwd?: unknown; terminal?: unknown; autoApprovalFailed?: boolean }): LightEvent {
    // Use the full UUID for title lookups and to avoid prefix collisions.
    const rawSessionId = rawEvent.sessionId;
    const titleSessionId = hasSessionTitles(rawEvent.agent) && rawSessionId && SESSION_UUID.test(rawSessionId)
      ? rawSessionId.toLowerCase()
      : undefined;
    const sessionId = shortSessionId(titleSessionId ?? rawSessionId);
    const evt: LightEvent = {
      agent: rawEvent.agent,
      type: rawEvent.type,
      sessionId,
      toolCallId: typeof rawEvent.toolCallId === "string" && rawEvent.toolCallId.length <= 256
        ? rawEvent.toolCallId || undefined : undefined,
      tool: typeof rawEvent.tool === "string" ? truncate(rawEvent.tool, 80) : undefined,
      toolTarget: typeof rawEvent.toolTarget === "string" ? truncate(rawEvent.toolTarget, 160) : undefined,
      message: typeof rawEvent.message === "string" ? truncate(rawEvent.message, 400) : undefined,
      timestamp: rawEvent.timestamp ?? new Date().toISOString(),
    };

    const key = keyOf(evt.agent, titleSessionId ?? sessionId);

    const prev = this.sessions.get(key);
    const validCwd = sanitizeCwd(rawEvent.cwd) ?? prev?.cwd;
    const resumeId = isResumableAgent(evt.agent) && rawSessionId && SESSION_UUID.test(rawSessionId)
      ? rawSessionId.toLowerCase()
      : prev?.resumeId;

    if (evt.type === "session_end") {
      const t = this.timers.get(key);
      if (t) clearTimeout(t);
      const g = this.gcTimers.get(key);
      if (g) clearTimeout(g);
      this.timers.delete(key);
      this.gcTimers.delete(key);
      if (prev?.pinned) {
        prev.status = "idle";
        prev.currentTool = undefined;
        prev.startedAt = undefined;
        prev.cwd = validCwd;
        prev.resumeId = resumeId;
        prev.ended = true;
        if (process.platform === "darwin" && !prev.jump && rawEvent.terminal !== undefined) {
          prev.jump = resolveJumpTarget(evt.agent, titleSessionId, rawEvent.terminal);
        }
        this.savePinnedSessions();
      } else if (prev?.unreadApprovals?.length) {
        prev.status = "idle";
        prev.currentTool = undefined;
        prev.startedAt = undefined;
        prev.jump = undefined;
        prev.cwd = validCwd;
        prev.resumeId = resumeId;
        prev.ended = true;
      } else {
        this.sessions.delete(key);
      }
      this.publishState(true);
      this.emit("event", evt);
      return evt;
    }

    const recent = prev?.recent ?? [];
    // Stop can be the only Antigravity hook that carries the policy failure.
    // Preserve the end of the turn and its cause together in one snapshot.
    const finalDenial = evt.agent === "antigravity" && evt.type === "error" && rawEvent.autoApprovalFailed &&
      !(recent[0]?.type === "auto_approval_failed" && recent[0].message === evt.message);
    const denial = finalDenial ? { ...evt, type: "auto_approval_failed" as const } :
      evt.type === "auto_approval_failed" ? evt : undefined;
    if (denial) denial.approvalId = ++this.approvalSequence;
    const history = finalDenial && denial ? [denial, ...recent] : recent;
    const newRecent = evt.type === "approval_request" ? recent : [evt, ...history].slice(0, RECENT_CAP);

    const next: SessionState = {
      key,
      agent: evt.agent,
      sessionId,
      ...(prev?.pinned ? { pinned: true } : {}),
      status: prev?.status ?? "idle",
      currentTool: prev?.currentTool,
      lastPrompt: prev?.lastPrompt,
      lastEventAt: evt.timestamp,
      startedAt: prev?.startedAt,
      recent: newRecent,
      unreadApprovals: denial ? [denial, ...(prev?.unreadApprovals ?? [])] : prev?.unreadApprovals,
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
      case "approval_request":
        next.status = "waiting";
        next.currentTool = evt.tool ?? evt.message;
        if (!next.startedAt) next.startedAt = evt.timestamp;
        break;
      case "auto_approval_failed":
        next.status = "auto_approval_failed";
        next.currentTool = undefined;
        break;
      case "tool_result":
        next.status = "working";
        next.currentTool = undefined;
        if (!next.startedAt) next.startedAt = evt.timestamp;
        break;
      case "stop":
        next.status = "done";
        next.turnEnd = { type: evt.type, timestamp: evt.timestamp };
        next.currentTool = undefined;
        break;
      case "interrupt":
        next.status = "idle";
        next.turnEnd = { type: evt.type, timestamp: evt.timestamp };
        next.currentTool = undefined;
        next.startedAt = undefined;
        break;
      case "error":
        next.status = "error";
        next.turnEnd = { type: evt.type, timestamp: evt.timestamp };
        next.currentTool = undefined;
        break;
      case "notification":
        next.turnEnd = prev?.turnEnd;
        break;
    }

    let jump: JumpTarget | undefined;
    if (process.platform === "darwin") {
      const previous = rawEvent.terminal === undefined && evt.type !== "session_start" ? prev?.jump : undefined;
      jump = previous ?? resolveJumpTarget(evt.agent, titleSessionId, rawEvent.terminal);
    }
    this.sessions.set(key, {
      ...next,
      jump,
      cwd: validCwd,
      resumeId,
      ended: false,
    });
    if (
      next.pinned &&
      (evt.type === "session_start" ||
        evt.type === "user_prompt" ||
        evt.type === "stop" ||
        evt.type === "interrupt" ||
        evt.type === "error" ||
        prev?.cwd !== validCwd ||
        prev?.resumeId !== resumeId ||
        !sameJump(prev?.jump, jump))
    ) {
      this.savePinnedSessions();
    }
    this.scheduleAutoReset(key);
    this.scheduleGc(key);
    this.publishState(
      evt.type === "approval_request" || evt.type === "auto_approval_failed" || evt.type === "error" ||
      evt.type === "stop" || evt.type === "interrupt" || evt.type === "user_prompt",
    );
    this.emit("event", evt);
    return evt;
  }

  recordCodexDenial(thread: string, reason?: string): void {
    const session = this.sessions.get(keyOf("codex", thread.toLowerCase()));
    if (!session) return;
    const event: LightEvent = { agent: "codex", sessionId: thread, type: "auto_approval_failed",
      timestamp: new Date().toISOString(), message: truncate(reason, 400) };
    if (session.status === "idle" || session.turnEnd) {
      // A late disk write belongs in the completed turn, without restarting it.
      event.timestamp = session.turnEnd?.timestamp ?? session.lastEventAt;
      event.sessionId = session.sessionId;
      event.approvalId = ++this.approvalSequence;
      session.unreadApprovals = [event, ...(session.unreadApprovals ?? [])];
      const end = session.recent.findIndex(e => e.type === session.turnEnd?.type && e.timestamp === event.timestamp);
      session.recent.splice(end + 1, 0, event);
      session.recent = session.recent.slice(0, RECENT_CAP);
      if (session.pinned) this.savePinnedSessions();
      this.publishState(true);
      return;
    }
    this.ingest(event);
  }

  acknowledgeApproval(key: string, id: number): void {
    const session = this.sessions.get(key);
    const pending = session?.unreadApprovals;
    if (!session || !pending?.some(event => event.approvalId === id)) return;
    session.unreadApprovals = pending.filter(event => event.approvalId !== id);
    if (!session.unreadApprovals.length) {
      delete session.unreadApprovals;
      if (!this.gcTimers.has(key)) this.scheduleGc(key);
    }
    this.publishState(true);
  }

  clearEvents(): void {
    let anyPinned = false;
    for (const s of this.sessions.values()) {
      s.recent = (s.unreadApprovals ?? []).slice(0, RECENT_CAP);
      if (s.pinned) anyPinned = true;
    }
    if (anyPinned) this.savePinnedSessions();
    this.publishState(true);
  }

  // Remove a session. A later hook event can add it back.
  removeSession(key: string): void {
    const t = this.timers.get(key);
    if (t) clearTimeout(t);
    const g = this.gcTimers.get(key);
    if (g) clearTimeout(g);
    this.timers.delete(key);
    this.gcTimers.delete(key);
    const existing = this.sessions.get(key);
    if (this.sessions.delete(key)) {
      if (existing?.pinned) this.savePinnedSessions();
      this.publishState(true);
    }
  }

  clearAll(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    for (const t of this.gcTimers.values()) clearTimeout(t);
    this.timers.clear();
    this.gcTimers.clear();
    this.sessions.clear();
    this.publishState(true);
  }

  private scheduleAutoReset(key: string): void {
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);

    const cur = this.sessions.get(key);
    if (!cur) return;

    // done/error linger briefly then settle to idle. Active states use
    // watchdogs so a crashed/disconnected agent cannot remain visible forever.
    let delay = 0;
    if (cur.status === "done") delay = DONE_LINGER_MS;
    else if (cur.status === "error") delay = ERROR_LINGER_MS;
    else if (cur.status === "working") delay = STALE_WORKING_MS;
    else if (cur.status === "waiting" || cur.status === "auto_approval_failed") delay = STALE_WAITING_MS;
    else return;

    const timer = setTimeout(() => {
      const c = this.sessions.get(key);
      if (!c) return;
      if (
        c.status === "done" ||
        c.status === "error" ||
        c.status === "working" ||
        c.status === "auto_approval_failed" ||
        c.status === "waiting"
      ) {
        c.status = "idle";
        c.startedAt = undefined;
        c.currentTool = undefined;
        if (c.pinned) this.savePinnedSessions();
        this.publishState(true);
      }
    }, delay);
    this.timers.set(key, timer);
  }

  private scheduleGc(key: string): void {
    const existing = this.gcTimers.get(key);
    if (existing) {
      clearTimeout(existing);
      this.gcTimers.delete(key);
    }
    const current = this.sessions.get(key);
    if (!current || current.pinned) return;
    const t = setTimeout(() => {
      const cur = this.sessions.get(key);
      if (!cur) return;
      this.gcTimers.delete(key);
      if (cur.status === "idle" && !cur.pinned && !cur.unreadApprovals?.length) {
        this.sessions.delete(key);
        this.timers.delete(key);
        this.publishState(true);
      }
    }, IDLE_GC_MS);
    this.gcTimers.set(key, t);
  }
}
