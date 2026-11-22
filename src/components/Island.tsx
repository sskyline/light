import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PanelLayout } from "../../electron/panelPlacement";
import type { CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import type { AgentId, HotZone, PresenceState, SessionState } from "../types";
import { AgentPill } from "./AgentPill";
import { HoverHint } from "./HoverHint";
import { ExpandPanel } from "./ExpandPanel";
import { capsuleContent, capsuleLayout } from "./capsuleMotion";

interface Props {
  sessions: SessionState[];
  presence: PresenceState | null;
}

const AGENT_ORDER: AgentId[] = ["claude-code", "codex", "antigravity", "trae"];
const DRAG_THRESHOLD_PX = 5;

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  dragging: boolean;
}

function groupByAgent(sessions: SessionState[]): Map<AgentId, SessionState[]> {
  const map = new Map<AgentId, SessionState[]>();
  for (const s of sessions) {
    if (!map.has(s.agent)) map.set(s.agent, []);
    map.get(s.agent)!.push(s);
  }
  return map;
}

// Tighten spacing before hiding timers when several agents share the capsule.
function fitAgentPills(island: HTMLDivElement | null, stage: HTMLDivElement | null) {
  if (!island || !stage || island.classList.contains("minimal")) return;
  const row = island.querySelector<HTMLElement>(".agents");
  if (!row) return;
  const style = getComputedStyle(island);
  const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  const border = parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
  const available = stage.clientWidth - padding - border;
  const fits = () => row.offsetWidth <= available;
  island.dataset.density = "full";
  if (fits()) return;
  island.dataset.density = "compact";
  if (!fits()) island.dataset.density = "status";
}

export function Island({ sessions, presence }: Props) {
  const reduceMotion = useReducedMotion();
  const [layout, setLayout] = useState<PanelLayout>();
  useLayoutEffect(() => window.light?.onPanelLayout?.(setLayout), []);
  const [hover, setHover] = useState(false);
  const [panelPhase, setPanelPhase] = useState<"closed" | "open" | "closing">("closed");
  const [pickedSession, setPickedSession] = useState<string | null>();
  const [diagnosticsRequest, setDiagnosticsRequest] = useState<number | null>(null);
  const [waitingForTrayHover, setWaitingForTrayHover] = useState(false);
  const open = panelPhase === "open";
  const closePanel = useCallback(() => {
    for (const popup of document.querySelectorAll<HTMLElement>(".action-popup:popover-open")) {
      popup.hidePopover();
    }
    setPanelPhase(phase => phase === "open" ? "closing" : phase);
  }, []);
  const [dragging, setDragging] = useState(false);

  const islandRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const lastHotZonesKeyRef = useRef("");
  const suppressNextClickRef = useRef(false);

  const activeSessions = sessions.filter((session) => session.status !== "idle");
  const hasRunningTimers = activeSessions.some((s) => (s.status === "working" || s.status === "waiting") && s.startedAt);
  const hasIdleSessions = sessions.some((s) => s.status === "idle" && (Boolean(s.pinned) || s.recent.length > 0 || s.unreadApprovals?.length));
  const [, force] = useState(0);
  useEffect(() => {
    if (!hasRunningTimers && !(open && hasIdleSessions)) return;
    const intervalMs = hasRunningTimers ? 1000 : 30_000;
    const id = setInterval(() => force((n) => n + 1), intervalMs);
    return () => clearInterval(id);
  }, [hasRunningTimers, open, hasIdleSessions]);

  // Close the panel when the window loses focus (user clicked another app).
  useEffect(() => {
    return window.light?.onBlur(closePanel);
  }, [closePanel]);

  useEffect(() => window.light?.onOpenDiagnostics?.(() => {
    setDiagnosticsRequest(n => (n ?? 0) + 1);
    setWaitingForTrayHover(true);
    setPanelPhase("open");
  }), []);

  // Hover source of truth. In the real app, the main process cursor poll is
  // authoritative (DOM mouseenter/leave are unreliable under the click-through
  // window). In the browser dev mock there's no onHover, so we fall back to DOM
  // events on the island/panel.
  const bridgeDrivesHover = typeof window !== "undefined" && !!window.light?.onHover;
  useEffect(() => {
    if (!window.light?.onHover) return;
    return window.light.onHover(over => setHover(over));
  }, []);

  const [menuOpen, setMenuOpen] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);

  useEffect(() => {
    if (!open) {
      setMenuOpen(false);
      setHasSelection(false);
      return;
    }
    const syncSelection = () => {
      const sel = window.getSelection();
      const panel = panelRef.current;
      const active = Boolean(
        sel && !sel.isCollapsed && sel.toString().trim().length > 0 &&
        panel && ((sel.anchorNode && panel.contains(sel.anchorNode)) || (sel.focusNode && panel.contains(sel.focusNode))),
      );
      setHasSelection(active);
    };
    document.addEventListener("selectionchange", syncSelection);
    return () => document.removeEventListener("selectionchange", syncSelection);
  }, [open]);

  // Auto-collapse the panel a beat after the cursor leaves the island+panel
  // hot zone — the reliable replacement for "click outside to dismiss" (the
  // window never takes focus, so outside clicks can't blur it). Staying inside
  // keeps it open; returning cancels the close. Pause while a menu is open or
  // the user holds a text selection inside the panel.
  useEffect(() => {
    if (hover) {
      setWaitingForTrayHover(false);
      return;
    }
    if (!open || waitingForTrayHover || menuOpen || hasSelection) return;
    const t = setTimeout(closePanel, 1500);
    return () => clearTimeout(t);
  }, [open, hover, waitingForTrayHover, menuOpen, hasSelection, closePanel]);

  // Report island, panel & open popover rects to main process for cursor-based hover detection.
  const reportHotZones = useCallback(() => {
    const bridge = window.light;
    if (!bridge) return;
    const zones: HotZone[] = [];
    const padding = 6;
    const islandElement = islandRef.current;
    const island = islandElement?.getBoundingClientRect();
    if (islandElement && island && island.width > 0) {
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
    for (const popup of document.querySelectorAll<HTMLElement>(".action-popup:popover-open")) {
      const rect = popup.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        zones.push({
          x: rect.left - padding,
          y: rect.top - padding,
          w: rect.width + padding * 2,
          h: rect.height + padding * 2,
        });
      }
    }
    const key = zones.map((z) => `${Math.round(z.x)},${Math.round(z.y)},${Math.round(z.w)},${Math.round(z.h)}`).join("|");
    if (key === lastHotZonesKeyRef.current) return;
    lastHotZonesKeyRef.current = key;
    bridge.setHotZones(zones);
  }, []);

  useLayoutEffect(() => {
    fitAgentPills(islandRef.current, stageRef.current);
    reportHotZones();
  });

  useEffect(() => {
    const ro = new ResizeObserver(() => reportHotZones());
    if (islandRef.current) ro.observe(islandRef.current);
    if (stageRef.current) ro.observe(stageRef.current);
    if (panelRef.current) ro.observe(panelRef.current);
    const onResize = () => {
      fitAgentPills(islandRef.current, stageRef.current);
      reportHotZones();
    };
    const onToggle = (event: Event) => {
      if (event.target instanceof HTMLElement && event.target.classList.contains("action-popup")) {
        setMenuOpen(document.querySelectorAll(".action-popup:popover-open").length > 0);
        reportHotZones();
      }
    };
    window.addEventListener("resize", onResize);
    document.addEventListener("toggle", onToggle, true);
    // Only poll briefly while the panel is open or animating; ResizeObserver +
    // Framer layout completion cover steady-state idle without background wakes.
    const id = panelPhase !== "closed" || activeSessions.length > 0
      ? setInterval(reportHotZones, 250)
      : undefined;
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onResize);
      document.removeEventListener("toggle", onToggle, true);
      if (id) clearInterval(id);
    };
  }, [panelPhase, activeSessions.length, reportHotZones]);

  const grouped = groupByAgent(activeSessions);
  const agents = AGENT_ORDER.filter((a) => grouped.has(a));

  const isMinimal = agents.length === 0;
  const status = activeSessions[0]?.status ?? "idle";

  const handleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      return;
    }
    // Pointer capture can retarget the click to the island after a drag gesture.
    const target = event.detail > 0
      ? document.elementFromPoint(event.clientX, event.clientY)
      : event.target;
    const agent = target instanceof Element ? target.closest<HTMLElement>("[data-agent]")?.dataset.agent as AgentId | undefined : undefined;
    const session = agent && grouped.get(agent)?.[0];
    const expandedKey = pickedSession === null || sessions.some(s => s.key === pickedSession)
      ? pickedSession : activeSessions[0]?.key;
    if (open && (!session || expandedKey === session.key || diagnosticsRequest !== null)) {
      closePanel();
      return;
    }
    setPickedSession(session?.key);
    setDiagnosticsRequest(null);
    setWaitingForTrayHover(false);
    if (!open) window.light?.panelOpened?.();
    setPanelPhase("open");
  };
  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !window.light?.startWindowDrag) return;
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.screenX,
      startY: e.screenY,
      dragging: false,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;

    const totalDx = e.screenX - drag.startX;
    const totalDy = e.screenY - drag.startY;
    if (!drag.dragging) {
      if (Math.hypot(totalDx, totalDy) < DRAG_THRESHOLD_PX) return;
      drag.dragging = true;
      suppressNextClickRef.current = true;
      setDragging(true);
      closePanel();
      window.light?.startWindowDrag?.();
    }
    e.preventDefault();
  };
  const finishDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const wasDragging = drag.dragging;
    if (wasDragging) e.preventDefault();
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    dragRef.current = null;
    setDragging(false);
    if (wasDragging) window.light?.endWindowDrag?.();
    if (wasDragging) {
      window.setTimeout(() => {
        suppressNextClickRef.current = false;
      }, 0);
    }
  };
  useEffect(() => {
    const finishAnyDrag = () => {
      if (!dragRef.current?.dragging) return;
      dragRef.current = null;
      setDragging(false);
      window.light?.endWindowDrag?.();
      window.setTimeout(() => {
        suppressNextClickRef.current = false;
      }, 0);
    };
    window.addEventListener("blur", finishAnyDrag);
    window.addEventListener("mouseup", finishAnyDrag);
    return () => {
      window.removeEventListener("blur", finishAnyDrag);
      window.removeEventListener("mouseup", finishAnyDrag);
      finishAnyDrag();
    };
  }, []);
  // In the browser mock, use DOM events for the hot zone.
  const handleEnter = bridgeDrivesHover ? undefined : () => setHover(true);
  const handleLeave = bridgeDrivesHover ? undefined : () => setHover(false);

  // The island hugs its content and Framer's layout animates size changes.
  return (
    <div className="stage" ref={stageRef} data-panel-above={layout?.above || undefined}
      style={layout && {
        left: layout.capsuleX, top: layout.capsuleY,
        "--panel-shift": `${layout.panelShiftX}px`,
        "--panel-width": `${layout.panelWidth}px`,
        "--panel-max-height": `${layout.panelMaxHeight}px`,
      } as CSSProperties}>
      <motion.div
        ref={islandRef}
        className={`island s-${status} ${isMinimal ? "minimal" : ""} ${open ? "open" : ""} ${dragging ? "dragging" : ""}`}
        onClick={handleClick}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onMouseEnter={handleEnter}
        onMouseLeave={handleLeave}
        onLayoutAnimationComplete={reportHotZones}
        layout={reduceMotion || dragging ? false : "size"}
        whileTap={reduceMotion || dragging ? undefined : { scale: 0.985 }}
        transition={{
          type: "spring", stiffness: 300, damping: 26,
          layout: capsuleLayout,
        }}
      >
        <AnimatePresence initial={false}>
          {isMinimal && <motion.span key="idle" className="idle-grip" aria-hidden="true" {...capsuleContent(reduceMotion)} />}
        </AnimatePresence>
        {sessions.some(s => s.unreadApprovals?.length) && <span className="approval-dot capsule-approval-dot" role="img" aria-label="有未读的自动审批失败" />}
        <motion.div className="agents" layout={reduceMotion ? false : "position"} transition={{ layout: capsuleLayout }}>
          <AnimatePresence initial={false} mode="popLayout">
            {agents.map((a) => (
              <AgentPill
                key={a}
                agent={a}
                sessionsByPriority={grouped.get(a)!}
              />
            ))}
          </AnimatePresence>
        </motion.div>
      </motion.div>
      {open && <HoverHint key={diagnosticsRequest === null ? "sessions" : "diagnostics"} over={hover} />}
      {panelPhase !== "closed" && (
        <motion.div
          className="panel-shell"
          ref={panelRef}
          onMouseEnter={handleEnter}
          onMouseLeave={handleLeave}
          initial={reduceMotion ? false : "closing"}
          animate={panelPhase}
          variants={{
            open: {
              opacity: 1,
              y: 0,
              scale: 1,
              transition: reduceMotion
                ? { duration: 0 }
                : { type: "spring", stiffness: 330, damping: 27 },
            },
            closing: {
              opacity: 0,
              y: reduceMotion ? 0 : layout?.above ? 10 : -10,
              scale: reduceMotion ? 1 : 0.965,
              transition: { duration: reduceMotion ? 0 : 0.16, ease: "easeOut" },
            },
          }}
          onAnimationComplete={phase => {
            if (phase === "closing") setPanelPhase(current => current === "closing" ? "closed" : current);
            reportHotZones();
          }}
        >
          <ExpandPanel
            pickedSession={pickedSession}
            onPickSession={setPickedSession}
            diagnosticsRequest={diagnosticsRequest}
            onDiagnostics={() => setDiagnosticsRequest(0)}
            onBack={() => setDiagnosticsRequest(null)}
            sessionsByPriority={sessions.filter((s) => s.status !== "idle" || Boolean(s.pinned) || s.recent.length > 0 || s.unreadApprovals?.length)}
            presence={presence}
            onClose={closePanel}
          />
        </motion.div>
      )}
    </div>
  );
}
