import { forwardRef, type ReactNode } from "react";
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from "framer-motion";
import type { AgentId, SessionState } from "../types";
import { capsuleContent, capsuleLayout } from "./capsuleMotion";

const AGENT_SHORT: Record<AgentId, string> = {
  "claude-code": "Claude",
  codex: "Codex",
  antigravity: "Antigravity",
  trae: "Trae",
};

interface Props {
  agent: AgentId;
  sessionsByPriority: SessionState[];
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

export const AgentPill = forwardRef<HTMLButtonElement, Props>(function AgentPill({ agent, sessionsByPriority }, ref) {
  const present = useIsPresent();
  const reduceMotion = useReducedMotion();
  const active = sessionsByPriority[0];
  const status = active?.status ?? "idle";

  const count = sessionsByPriority.length;
  const busyCount = sessionsByPriority.filter((s) => s.status === "working" || s.status === "waiting" || s.status === "auto_approval_failed").length;

  const timeText =
    (status === "working" || status === "waiting") && active?.startedAt ? elapsed(active.startedAt) : "";

  const countBadge = count > 1 ? `×${count}${busyCount > 0 && busyCount < count ? ` · ${busyCount}忙` : ""}` : null;

  // Key the chip by status so updates to the timer don't replay its animation.
  let chip: ReactNode;
  if (status === "done") {
    chip = "完成";
  } else if (status === "error") {
    chip = "出错";
  } else if (status === "auto_approval_failed") {
    chip = "自动审批失败";
  } else if (status === "working" || status === "waiting") {
    chip = (
      <>
        <span className="chip-status">工作中</span>
        {timeText && (
          <>
            <span className="chip-sep">·</span>
            <span className="chip-time">{timeText}</span>
          </>
        )}
      </>
    );
  } else {
    chip = "空闲";
  }

  return (
    <motion.button
      type="button"
      tabIndex={present ? 0 : -1}
      ref={ref}
      className={`agent state-${status}`}
      data-agent={present ? agent : undefined}
      aria-hidden={!present || undefined}
      layout={reduceMotion ? false : "position"}
      {...capsuleContent(reduceMotion)}
      transition={{ layout: capsuleLayout }}
    >
      <AnimatePresence initial={false}>
        {status !== "working" && status !== "waiting" && (
          <motion.span
            key="mark"
            layout={reduceMotion ? false : "position"}
            className={`status-mark ${status}`}
            aria-hidden="true"
            initial={reduceMotion ? false : { opacity: 0, width: 0, marginRight: -8 }}
            animate={{ opacity: 1, width: 10, marginRight: 0 }}
            exit={{ opacity: 0, width: 0, marginRight: -8 }}
            transition={reduceMotion ? { duration: 0 } : { duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          />
        )}
      </AnimatePresence>
      <motion.span layout={reduceMotion ? false : "position"} className="label">
        {AGENT_SHORT[agent]}
      </motion.span>

      {countBadge && <span className="count-badge">{countBadge}</span>}

      <AnimatePresence initial={false}>
        <motion.span
          key={status}
          layout={reduceMotion ? false : "position"}
          className={`state-chip ${status}`}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: reduceMotion ? 0 : 0.14 }}
        >
          {chip}
        </motion.span>
      </AnimatePresence>
    </motion.button>
  );
});
