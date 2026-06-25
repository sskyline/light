import { useState } from "react";
import { motion, AnimatePresence, type Variants } from "framer-motion";
import type { SessionState, AgentId, LightEvent, Memo, SystemState } from "../types";
import { MediaFull } from "./MediaCard";

const AGENT_LABEL: Record<AgentId, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  trae: "Trae",
};

const EVENT_TAG: Record<LightEvent["type"], string> = {
  session_start: "start",
  session_end: "end",
  user_prompt: "prompt",
  tool_use: "tool",
  approval_request: "approve",
  tool_result: "result",
  stop: "stop",
  notification: "note",
  error: "err",
};

interface Props {
  sessions: SessionState[];
  memos: Memo[];
  system: SystemState;
}

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

function formatTime(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function eventIdentity(e: LightEvent & { _key: string; _agent: AgentId }): string {
  return [
    e._key,
    e.timestamp,
    e.type,
    e.tool ?? "",
    e.message ?? "",
  ].join("|");
}

function statusLine(a: SessionState): string {
  switch (a.status) {
    case "idle":
      return "空闲";
    case "working":
      return a.currentTool ? `工作中 · ${a.currentTool}` : "工作中";
    case "waiting":
      return a.currentTool ? `等待审批 · ${a.currentTool}` : "等待审批";
    case "done":
      return "刚完成";
    case "error":
      return "出错";
  }
}

export function ExpandPanel({ sessions, memos, system }: Props) {
  const [draft, setDraft] = useState("");
  const [expandedEventKey, setExpandedEventKey] = useState<string | null>(null);

  const allEvents = sessions
    .flatMap((s) => s.recent.map((e) => ({ ...e, _key: s.key, _agent: s.agent })))
    .sort((x, y) => (x.timestamp < y.timestamp ? 1 : -1))
    .slice(0, 14);

  const visibleMemos = memos;

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const t = draft.trim();
    if (!t) return;
    window.light?.addMemo(t);
    setDraft("");
  };

  return (
    <motion.div
      className="panel"
      variants={PANEL}
      initial="hidden"
      animate="show"
      exit="exit"
    >
      <span className="glass-sheen" aria-hidden="true" />

      <motion.div className="section" variants={ITEM}>
        <div className="section-head">
          <span>状态</span>
        </div>
        <div className="card">
          {sessions.length === 0 ? (
            <div className="empty">暂无活动会话</div>
          ) : (
            sessions.map((a) => (
              <div key={a.key} className="panel-row">
                <span className={`dot ${a.status}`} />
                <span className="panel-name">{AGENT_LABEL[a.agent]}</span>
                <span className="session-tag">对话 {a.seq}</span>
                <span className="sub">{statusLine(a)}</span>
                <span className="panel-meta">
                  {(a.status === "working" || a.status === "waiting") && a.startedAt
                    ? formatDuration(a.startedAt)
                    : ""}
                </span>
                <button
                  className="row-x"
                  onClick={() => window.light?.removeSession(a.key)}
                  title="从列表移除这个对话"
                  aria-label="移除"
                >
                  ×
                </button>
              </div>
            ))
          )}
        </div>
      </motion.div>

      {system.media && system.media.title && (
        <motion.div className="section" variants={ITEM}>
          <div className="section-head">
            <span>正在播放</span>
          </div>
          <div className="card">
            <MediaFull media={system.media} />
          </div>
        </motion.div>
      )}

      <motion.div className="section" variants={ITEM}>
        <div className="section-head">
          <span>备忘录</span>
          <span className="section-meta">
            {visibleMemos.filter((m) => !m.completed).length} 待办
          </span>
        </div>
        <form className="memo-input" onSubmit={onSubmit}>
          <input
            type="text"
            placeholder="写点什么 · 回车添加"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={200}
          />
        </form>
        <div className="memos">
          <AnimatePresence initial={false}>
            {visibleMemos.map((m) => (
              <MemoRow key={m.id} memo={m} />
            ))}
          </AnimatePresence>
          {visibleMemos.length === 0 && <div className="empty">没有备忘</div>}
        </div>
      </motion.div>

      <motion.div className="section" variants={ITEM}>
        <div className="section-head">
          <span>事件流</span>
          <button
            className="link-btn"
            onClick={() => window.light?.clearEvents()}
            disabled={allEvents.length === 0}
          >
            清空
          </button>
        </div>
        <div className="card">
          <div className="events">
            {allEvents.length === 0 ? (
              <div className="empty">暂无事件</div>
            ) : (
              allEvents.map((e) => {
                const eventKey = eventIdentity(e);
                const expanded = expandedEventKey === eventKey;
                return (
                  <div className={`evt-wrap ${expanded ? "expanded" : ""}`} key={eventKey}>
                    <button
                      className="evt"
                      type="button"
                      onClick={() => setExpandedEventKey(expanded ? null : eventKey)}
                      aria-expanded={expanded}
                    >
                      <span className="evt-time">{formatTime(e.timestamp)}</span>
                      <span className="evt-tag">{EVENT_TAG[e.type]}</span>
                      <span className="evt-text">
                        {e.message ?? e.tool ?? AGENT_LABEL[e._agent as AgentId]}
                      </span>
                    </button>
                    {expanded && (
                      <div className="evt-detail">
                        <DetailRow label="来源" value={AGENT_LABEL[e._agent as AgentId]} />
                        <DetailRow label="事件" value={e.type} />
                        <DetailRow label="工具" value={e.tool} />
                        <DetailRow label="详情" value={e.message} />
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

// Staggered spring reveal: the panel springs down, then each section settles
// in just behind it. Keeps the open feel "alive" without being slow.
const PANEL: Variants = {
  hidden: { opacity: 0, y: -10, scale: 0.965 },
  show: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: {
      type: "spring",
      stiffness: 330,
      damping: 27,
      staggerChildren: 0.05,
      delayChildren: 0.05,
    },
  },
  exit: { opacity: 0, y: -10, scale: 0.965, transition: { duration: 0.16 } },
};

const ITEM: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.32, ease: [0.22, 1, 0.36, 1] } },
};

function DetailRow({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div className="evt-detail-row">
      <span className="evt-detail-label">{label}</span>
      <span className="evt-detail-value">{value}</span>
    </div>
  );
}

function MemoRow({ memo }: { memo: Memo }) {
  const handleToggle = () => {
    window.light?.toggleMemo(memo.id);
    if (!memo.completed) {
      setTimeout(() => window.light?.deleteMemo(memo.id), 1200);
    }
  };

  return (
    <motion.div
      className={`memo ${memo.completed ? "completed" : ""}`}
      layout
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: memo.completed ? 0.45 : 1, height: "auto" }}
      exit={{ opacity: 0, height: 0, x: 40 }}
      transition={{ duration: 0.25, ease: "easeOut" }}
    >
      <button
        className={`memo-check ${memo.completed ? "on" : ""}`}
        onClick={handleToggle}
        aria-label={memo.completed ? "uncheck" : "complete"}
      >
        {memo.completed && (
          <svg viewBox="0 0 24 24" width="11" height="11">
            <path
              d="M5 12.5l4.2 4.2L19 7"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </button>
      <span className="memo-text">{memo.text}</span>
      <button className="memo-x" onClick={() => window.light?.deleteMemo(memo.id)} title="删除">
        ×
      </button>
    </motion.div>
  );
}
