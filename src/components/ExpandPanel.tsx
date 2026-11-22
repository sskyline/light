import { ConnectionDiagnostics } from "./ConnectionDiagnostics";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion, type Variants } from "framer-motion";
import { AGENT_LABEL } from "../agents";
import type { SessionState, PresenceState } from "../types";
import { useSessionTitle } from "../hooks/useLightEvents";
import { ActionMenu } from "./ActionMenu";
import { TaskProgress } from "./TaskProgress";
import { currentToolAction } from "../toolActivity";
import { capsuleLayout, collapseTransition } from "./capsuleMotion";

interface Props {
  sessionsByPriority: SessionState[];
  presence: PresenceState | null;
  onClose?: () => void;
  pickedSession: string | null | undefined;
  onPickSession: (key: string | null) => void;
  diagnosticsRequest: number | null;
  onDiagnostics: () => void;
  onBack: () => void;
}

const JUMP_LABEL = {
  codex: "在 Codex 中打开对话",
  "claude-desktop": "在 Claude 桌面版中打开对话",
  iterm: "定位 iTerm2 分屏",
  ghostty: "定位 Ghostty 分屏",
  rex: "定位 Rex 分屏",
};

const IDLE_JUMP_LABEL = {
  ...JUMP_LABEL,
  iterm: "定位或恢复 iTerm2 分屏",
  ghostty: "定位或恢复 Ghostty 分屏",
  rex: "定位或恢复 Rex 分屏",
};

function formatDuration(fromIso?: string): string {
  if (!fromIso) return "";
  const ms = Date.now() - new Date(fromIso).getTime();
  if (ms < 0) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function idleTimestamp(session: SessionState): number {
  return Date.parse(session.turnEnd?.timestamp ?? session.lastEventAt);
}

function idleTimeLabel(session: SessionState): string {
  const end = session.turnEnd;
  const elapsed = Date.now() - idleTimestamp(session);
  if (!Number.isFinite(elapsed)) return "";
  const minutes = Math.max(0, Math.floor(elapsed / 60000));
  const ago = minutes === 0 ? "刚刚" : minutes < 60 ? `${minutes} 分钟前` : `${Math.floor(minutes / 60)} 小时前`;
  switch (end?.type) {
    case "interrupt": return `${ago}中断`;
    case "error": return `${ago}出错`;
    default: return ago;
  }
}

function statusLine(a: SessionState, expanded: boolean): string {
  const action = expanded ? currentToolAction(a) : undefined;
  switch (a.status) {
    case "idle":
      return "空闲";
    case "working":
      return action ?? "工作中";
    case "waiting":
      return "工作中";
    case "auto_approval_failed":
      return "自动审批失败";
    case "done":
      return "刚完成";
    case "error":
      return "出错";
  }
}

export function ExpandPanel({ sessionsByPriority, presence, onClose, pickedSession, onPickSession, diagnosticsRequest, onDiagnostics, onBack }: Props) {
  const reduceMotion = useReducedMotion();
  const [showIdle, setShowIdle] = useState(true);
  const diagnosing = diagnosticsRequest !== null;
  const listRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (diagnosing || !pickedSession) return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-session-key="${CSS.escape(pickedSession)}"] .session-summary`);
    row?.scrollIntoView({ block: "nearest" });
  }, [pickedSession, diagnosing]);

  const activeSessions = sessionsByPriority.filter((session) => session.status !== "idle");
  const idleSessions = sessionsByPriority.filter((session) => session.status === "idle")
    .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || (idleTimestamp(b) || 0) - (idleTimestamp(a) || 0));
  const visibleSessions = showIdle ? sessionsByPriority : activeSessions;
  const expandedKey = pickedSession === null || visibleSessions.some((session) => session.key === pickedSession)
    ? pickedSession
    : activeSessions[0]?.key;

  const renderSession = (session: SessionState) => (
    <SessionRow
      key={session.key}
      session={session}
      lookupDesktop={session.agent === "claude-code" && !session.jumpTarget && presence?.["claude-code"]?.installed !== false}
      jumpTarget={session.jumpTarget === "codex" && presence?.codex?.installed === false ? undefined : session.jumpTarget}
      onClose={onClose}
      expanded={expandedKey === session.key}
      onToggle={() => onPickSession(expandedKey === session.key ? null : session.key)}
    />
  );

  return (
    <motion.div
      className={diagnosing ? "panel diagnostics-panel" : "panel"}
      aria-label={diagnosing ? "连接与诊断" : "会话"}
      variants={PANEL}
      initial={reduceMotion ? false : "hidden"}
      animate="show"
    >
      {diagnosing ? <ConnectionDiagnostics request={diagnosticsRequest} onBack={onBack} /> : <>
        <motion.div className="section-head" variants={ITEM}>
          <h2>会话</h2>
          <button className="link-btn diagnostics-button" type="button" onClick={onDiagnostics}
            aria-label="连接与诊断">
            <span className="diagnostics-hint" aria-hidden="true">连接与诊断</span>
            <span className="sliders-icon" aria-hidden="true"><i /><i /></span>
          </button>
          <ActionMenu label="会话列表更多操作" action="清空进展"
            disabled={!sessionsByPriority.some(session => session.recent.some(event =>
              !event.approvalId || !session.unreadApprovals?.some(unread => unread.approvalId === event.approvalId)))}
            onAction={() => window.light.clearEvents()} />
        </motion.div>
        <motion.div ref={listRef} className="panel-sessions" variants={ITEM} layoutScroll>
          {activeSessions.length > 0 && <div className="card">{activeSessions.map(renderSession)}</div>}
          {sessionsByPriority.length === 0 && <div className="empty">暂无活动会话</div>}
          {idleSessions.length > 0 && (
            <div className="idle-sessions">
              <button
                className="idle-toggle"
                type="button"
                aria-label={`空闲会话，${idleSessions.length} 条`}
                aria-expanded={showIdle}
                onClick={() => setShowIdle((expanded) => !expanded)}
              >
                <span>空闲</span>
                <span className="idle-count" aria-hidden="true">· {idleSessions.length}</span>
              </button>
              <AnimatePresence initial={false}>
                {showIdle && (
                  <motion.div
                    key="idle-list"
                    className="collapse-clip"
                    initial={reduceMotion ? false : { height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={collapseTransition(reduceMotion)}
                  >
                    <div className="card idle-list-inner">
                      {idleSessions.map(renderSession)}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}
        </motion.div>
      </>}
    </motion.div>
  );
}

// Staggered section reveal coordinated with Island's panel-shell spring.
const PANEL: Variants = {
  hidden: {},
  show: {
    transition: {
      staggerChildren: 0.05,
      delayChildren: 0.05,
    },
  },
};

const ITEM: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.32, ease: [0.22, 1, 0.36, 1] } },
};

function SessionRow({
  session,
  jumpTarget,
  lookupDesktop,
  onClose,
  expanded,
  onToggle,
}: {
  session: SessionState;
  jumpTarget?: SessionState["jumpTarget"];
  lookupDesktop: boolean;
  onClose?: () => void;
  expanded: boolean;
  onToggle: () => void;
}) {
  const progressId = useId();
  const [jumpError, setJumpError] = useState("");
  const [opening, setOpening] = useState(false);
  const openingRef = useRef(false);
  const [hasDesktopSession, setHasDesktopSession] = useState(false);
  useEffect(() => {
    if (!lookupDesktop) return;
    let cancelled = false;
    const lookup = async () => {
      const kind = await window.light?.getSessionJumpKind?.(session.key).catch(() => undefined);
      if (!cancelled) setHasDesktopSession(kind === "claude-desktop");
      return kind;
    };
    // The first hook can arrive before Claude writes its desktop record.
    let retry: ReturnType<typeof setTimeout>;
    void lookup().then(kind => {
      if (!kind && !cancelled) retry = setTimeout(lookup, 5500);
    });
    return () => { cancelled = true; clearTimeout(retry); };
  }, [lookupDesktop, session.key, session.lastEventAt]);
  const reduceMotion = useReducedMotion();
  const sessionTitle = useSessionTitle(session.key);
  const title = sessionTitle?.trim() || session.lastPrompt?.trim().split(/[\r\n]/, 1)[0] || undefined;
  const agentName = AGENT_LABEL[session.agent];
  const idle = session.status === "idle";
  const target = jumpTarget ?? (lookupDesktop && hasDesktopSession ? "claude-desktop" : undefined);
  const jumpLabel = target && (idle ? IDLE_JUMP_LABEL : JUMP_LABEL)[target];
  async function openSession() {
    if (openingRef.current) return;
    openingRef.current = true;
    setOpening(true);
    setJumpError("");
    try {
      const { opened, message } = await window.light.openSession(session.key).catch(() => ({ opened: false, message: "" }));
      if (opened) onClose?.();
      else setJumpError(message || "打开失败，请检查应用、分屏或系统自动化权限。");
    } finally {
      openingRef.current = false;
      setOpening(false);
    }
  }
  const timeLabel = session.status === "working" || session.status === "waiting"
    ? formatDuration(session.startedAt)
    : session.status === "idle" ? idleTimeLabel(session) : "";

  return (
    <motion.div
      className={`session-card ${session.status}`}
      data-session-key={session.key}
      layout={reduceMotion ? false : "position"}
      transition={{ layout: capsuleLayout }}
    >
      <div className="panel-row">
        <button
          className="session-summary"
          type="button"
          aria-label={`${expanded ? "收起" : "展开"}进展 · ${title ?? agentName}${session.unreadApprovals?.length ? " · 有未读的自动审批失败" : ""}`}
          aria-expanded={expanded}
          aria-controls={progressId}
          onClick={onToggle}
        >
          <span className="panel-title">
            {!!session.unreadApprovals?.length && <span className="approval-dot" aria-hidden="true" data-hint="有未读的自动审批失败" />}
            {title && <span className="panel-name" data-hint={title} data-truncated-only>{title}</span>}
            {(idle || !title) && <span className="session-agent">{agentName}</span>}
          </span>
          {!idle && <span className="panel-session-detail">
            {title && <span className="session-agent">{agentName}</span>}
            <span className={`panel-status ${session.status}`}>
              {(session.status === "done" || session.status === "error" || session.status === "auto_approval_failed") && (
                <span className={`status-mark ${session.status}`} aria-hidden="true" />
              )}
              {statusLine(session, expanded)}
            </span>
            {timeLabel && <span className="session-duration">{timeLabel}</span>}
          </span>}
          {idle && timeLabel && (
            <span className="panel-meta" data-hint={session.status === "idle" && !session.turnEnd ? "最后活动时间" : undefined}>
              {timeLabel}
            </span>
          )}
          <span className="session-chevron" aria-hidden="true" />
        </button>
        <div className="session-actions">
          {expanded && <ActionMenu label={`${title ?? agentName}的更多操作`} action="从列表移除"
            onAction={() => window.light.removeSession(session.key)} />}
          <button
            className={session.pinned ? "session-pin is-pinned" : "session-pin"}
            type="button"
            aria-pressed={Boolean(session.pinned)}
            aria-label={`${session.pinned ? "取消固定会话" : "固定会话（免自动清理）"} · ${title ?? agentName}`}
            data-hint={session.pinned ? "取消固定" : "固定会话"}
            onClick={() => window.light.setSessionPinned(session.key, !session.pinned)}
          >
            <svg className="pin-icon" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path
                className="pin-head"
                d="M4 1.75H8L7.5 4.75L9 6.25V7H3V6.25L4.5 4.75L4 1.75Z"
                fill={session.pinned ? "currentColor" : "none"}
                stroke="currentColor"
                strokeWidth="1.35"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M6 7V10.5"
                stroke="currentColor"
                strokeWidth="1.35"
                strokeLinecap="round"
              />
            </svg>
          </button>
          {jumpLabel && (
            <button
              className="session-jump"
              type="button"
              disabled={opening}
              aria-label={`${jumpLabel} · ${title ?? agentName}`}
              data-hint={jumpLabel}
              onClick={openSession}
            >
              <span className="jump-mark" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
      {jumpError && <div className="session-jump-error" role="status">{jumpError}</div>}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            id={progressId}
            key="progress"
            className="collapse-clip session-progress-clip"
            initial={reduceMotion ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={collapseTransition(reduceMotion)}
          >
            <TaskProgress
              recent={session.recent}
              unread={session.unreadApprovals}
              onRead={id => window.light.acknowledgeApproval(session.key, id)}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
