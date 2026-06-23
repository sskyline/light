import type { ReactNode } from "react";
import { motion } from "framer-motion";
import type { AgentId, AgentStatus, SessionState } from "../types";

const AGENT_SHORT: Record<AgentId, string> = {
  "claude-code": "Claude",
  codex: "Codex",
  trae: "Trae",
};
const AGENT_FULL: Record<AgentId, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  trae: "Trae",
};

interface Props {
  agent: AgentId;
  sessions: SessionState[];
  expanded: boolean;
}

function aggregateStatus(sessions: SessionState[]): AgentStatus {
  const has = (s: AgentStatus) => sessions.some((x) => x.status === s);
  if (has("error")) return "error";
  if (has("waiting")) return "waiting";
  if (has("working")) return "working";
  if (has("done")) return "done";
  return "idle";
}

function pickActive(sessions: SessionState[]): SessionState | undefined {
  const order = (s: SessionState) => {
    if (s.status === "waiting") return 0;
    if (s.status === "working") return 1;
    if (s.status === "done") return 2;
    if (s.status === "error") return 3;
    return 4;
  };
  return [...sessions].sort((a, b) => {
    const o = order(a) - order(b);
    if (o !== 0) return o;
    return a.lastEventAt < b.lastEventAt ? 1 : -1;
  })[0];
}

function elapsed(fromIso?: string): string {
  if (!fromIso) return "";
  const ms = Date.now() - new Date(fromIso).getTime();
  if (ms < 0) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m${s % 60}s` : `${Math.floor(m / 60)}h${m % 60}m`;
}

function Check() {
  return (
    <svg className="check" viewBox="0 0 24 24" width="11" height="11" aria-hidden="true">
      <motion.path
        d="M5 12.5l4.2 4.2L19 7"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.4, ease: "easeOut" }}
      />
    </svg>
  );
}

export function AgentPill({ agent, sessions, expanded }: Props) {
  const status = aggregateStatus(sessions);
  const active = pickActive(sessions);
  const count = sessions.length;
  const workingCount = sessions.filter((s) => s.status === "working").length;
  const waitingCount = sessions.filter((s) => s.status === "waiting").length;

  const tool = active?.currentTool;
  const timeText =
    status === "working" && active?.startedAt ? elapsed(active.startedAt) : "";

  const countBadge =
    count > 1
      ? waitingCount > 0
        ? `×${count} · ${waitingCount}待批`
        : workingCount > 0
          ? `×${count} · ${workingCount}忙`
          : `×${count}`
      : null;
  const seqTag = count === 1 && active ? `对话 ${active.seq}` : null;

  // The chip text is derived purely from `status`, so it can never lag behind
  // the dot colour (no more "green dot but still Bash · 42s"). The element is
  // keyed by `status` alone — while a task ticks, only the inner time text
  // updates in place, so the chip never remounts or re-animates every second.
  let chip: ReactNode;
  if (status === "done") {
    chip = (
      <>
        <Check />
        完成
      </>
    );
  } else if (status === "error") {
    chip = "出错";
  } else if (status === "waiting") {
    chip = expanded && tool ? `等待审批 · ${tool}` : "等待审批";
  } else if (status === "working") {
    if (expanded && active?.lastPrompt) {
      chip = active.lastPrompt;
    } else {
      chip = (
        <>
          {tool || "工作中"}
          {timeText && (
            <>
              <span className="chip-sep">·</span>
              <span className="chip-time">{timeText}</span>
            </>
          )}
        </>
      );
    }
  } else {
    chip = "空闲";
  }

  return (
    <div className={`agent state-${status}`}>
      <span className={`dot ${status}`} />
      <motion.span layout="position" className="label">
        {expanded ? AGENT_FULL[agent] : AGENT_SHORT[agent]}
      </motion.span>

      {countBadge && <span className="count-badge">{countBadge}</span>}
      {expanded && seqTag && <span className="session-tag">{seqTag}</span>}

      <motion.span
        key={status}
        layout="position"
        className={`state-chip ${status}`}
        initial={{ opacity: 0, y: -3 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, ease: "easeOut" }}
      >
        {chip}
      </motion.span>
    </div>
  );
}
