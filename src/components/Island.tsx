import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { AgentId, AgentStatus, HotZone, Memo, SessionState, SystemState } from "../types";
import { AgentPill } from "./AgentPill";
import { ExpandPanel } from "./ExpandPanel";
import { MediaCompact } from "./MediaCard";

interface Props {
  sessions: SessionState[];
  memos: Memo[];
  system: SystemState;
}

const AGENT_ORDER: AgentId[] = ["claude-code", "codex", "trae"];

function groupByAgent(sessions: SessionState[]): Map<AgentId, SessionState[]> {
  const map = new Map<AgentId, SessionState[]>();
  for (const s of sessions) {
    if (!map.has(s.agent)) map.set(s.agent, []);
    map.get(s.agent)!.push(s);
  }
  return map;
}

// The single state the *whole* capsule reacts to (halo + aurora sweep). Most
// urgent wins: an error anywhere should colour the island red even if another
// session is happily working.
function overallStatus(sessions: SessionState[]): AgentStatus {
  const has = (s: AgentStatus) => sessions.some((x) => x.status === s);
  if (has("error")) return "error";
  if (has("working")) return "working";
  if (has("done")) return "done";
  return "idle";
}

export function Island({ sessions, memos, system }: Props) {
  const [hover, setHover] = useState(false);
  const [open, setOpen] = useState(false);

  const islandRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);

  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // Close the panel when the window loses focus (user clicked another app).
  useEffect(() => {
    return window.light?.onBlur(() => setOpen(false));
  }, []);

  // Hover source of truth. In the real app, the main process cursor poll is
  // authoritative (DOM mouseenter/leave are unreliable under the click-through
  // window). In the browser dev mock there's no onHover, so we fall back to DOM
  // events on the island/panel.
  const bridgeDrivesHover = typeof window !== "undefined" && !!window.light?.onHover;
  useEffect(() => {
    if (!window.light?.onHover) return;
    return window.light.onHover((over) => setHover(over));
  }, []);

  // Auto-collapse the panel a beat after the cursor leaves the island+panel
  // hot zone — the reliable replacement for "click outside to dismiss" (the
  // window never takes focus, so outside clicks can't blur it). Staying inside
  // keeps it open; returning cancels the close.
  useEffect(() => {
    if (!open || hover) return;
    const t = setTimeout(() => setOpen(false), 1500);
    return () => clearTimeout(t);
  }, [open, hover]);

  // Report island & panel rects to main process for cursor-based hover detection.
  const reportHotZones = () => {
    const bridge = window.light;
    if (!bridge) return;
    const zones: HotZone[] = [];
    const padding = 6;
    const island = islandRef.current?.getBoundingClientRect();
    if (island && island.width > 0) {
      zones.push({
        x: island.left - padding,
        y: island.top - padding,
        w: island.width + padding * 2,
        h: island.height + padding * 2,
      });
    }
    const panel = panelRef.current?.getBoundingClientRect();
    if (panel && panel.width > 0) {
      zones.push({
        x: panel.left - padding,
        y: panel.top - padding,
        w: panel.width + padding * 2,
        h: panel.height + padding * 2,
      });
    }
    bridge.setHotZones(zones);
  };

  useLayoutEffect(() => {
    reportHotZones();
  });

  useEffect(() => {
    const ro = new ResizeObserver(() => reportHotZones());
    if (islandRef.current) ro.observe(islandRef.current);
    if (stageRef.current) ro.observe(stageRef.current);
    const onResize = () => reportHotZones();
    window.addEventListener("resize", onResize);
    const id = setInterval(reportHotZones, 200);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onResize);
      clearInterval(id);
    };
  }, []);

  // Show every agent that has a live session — including idle ones, so Claude
  // Code stays visible with its idle/working/done state. Sessions are removed
  // on session_end (window closed) or GC'd after their idle timeout.
  const grouped = groupByAgent(sessions);
  const agents = AGENT_ORDER.filter((a) => grouped.has(a));

  const media = system.media;
  const musicOn = Boolean(media && media.title);

  const hasContent = agents.length > 0 || musicOn;
  const isMinimal = !hasContent;
  const status = overallStatus(sessions);

  const handleClick = () => setOpen((v) => !v);
  // Hover expands the pill and keeps the panel alive. When the main process
  // drives hover (real app), ignore DOM enter/leave so the two can't fight
  // (which is what left the pill stuck "expanded"). In the mock, DOM events
  // are the only signal, so use them.
  const handleEnter = bridgeDrivesHover ? undefined : () => setHover(true);
  const handleLeave = bridgeDrivesHover ? undefined : () => setHover(false);

  // The island hugs its content (width:auto via .island-row) and framer's
  // `layout` animates size changes — so there's never empty space on the right.
  return (
    <div className="stage" ref={stageRef}>
      <motion.div
        ref={islandRef}
        className={`island s-${status} ${isMinimal ? "minimal" : ""} ${open ? "open" : ""}`}
        onClick={handleClick}
        onMouseEnter={handleEnter}
        onMouseLeave={handleLeave}
        layout
        whileHover={{ y: -2 }}
        whileTap={{ scale: 0.985 }}
        transition={{ type: "spring", stiffness: 300, damping: 26 }}
      >
        <span className="aurora" aria-hidden="true" />
        <span className="glass-sheen" aria-hidden="true" />
        <AnimatePresence mode="wait" initial={false}>
          {isMinimal ? (
            <motion.div
              key="minimal"
              className="agents minimal-inner"
              layout
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <span className="dot idle" />
              <span className="sub" style={{ opacity: hover || open ? 0.7 : 0 }}>
                Light
              </span>
            </motion.div>
          ) : (
            <motion.div
              key="content"
              className="island-row"
              layout
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <div className="agents">
                {agents.map((a) => (
                  <AgentPill
                    key={a}
                    agent={a}
                    sessions={grouped.get(a)!}
                    expanded={hover || open}
                  />
                ))}
              </div>
              {musicOn && agents.length > 0 && <span className="vsep" />}
              {musicOn && <MediaCompact media={media!} />}
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
      <AnimatePresence>
        {open && (
          <div ref={panelRef} onMouseEnter={handleEnter} onMouseLeave={handleLeave}>
            <ExpandPanel
              sessions={sessions.filter((s) => s.status !== "idle" || s.recent.length > 0)}
              memos={memos}
              system={system}
            />
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
