import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { EventType, LightEvent } from "../types";
import { formatEventTime, selectVisibleProgressEvents } from "../../electron/progressOrder";
import { activityRows, activityRowLabel, type ActivityRow } from "../toolActivity";
import { collapseTransition } from "./capsuleMotion";

const EVENT_LABEL: Record<EventType, string> = {
  session_start: "会话开始",
  session_end: "会话结束",
  user_prompt: "开始处理",
  tool_use: "调用工具",
  approval_request: "审批请求",
  auto_approval_failed: "自动审批失败",
  tool_result: "工具返回",
  stop: "本轮结束",
  interrupt: "已中断",
  notification: "通知",
  error: "出错",
};

const MILESTONES = new Set<EventType>(["user_prompt", "stop", "interrupt", "error", "auto_approval_failed"]);

interface ProgressEntry {
  key: string;
  kind: EventType | "activity";
  events: LightEvent[];
}

function toProgressEntries(recent: LightEvent[]): ProgressEntry[] {
  const entries: ProgressEntry[] = [];
  const occurrences = new Map<string, number>();
  let activityAnchor = "initial";

  // Anchor each activity block to the preceding milestone so new tool events
  // can extend an open block without remounting it.
  for (const event of [...recent].reverse()) {
    if (MILESTONES.has(event.type)) {
      const identity = JSON.stringify([event.type, event.timestamp, event.tool, event.message]);
      const occurrence = (occurrences.get(identity) ?? 0) + 1;
      occurrences.set(identity, occurrence);
      activityAnchor = `${identity}:${occurrence}`;
      entries.push({ key: event.approvalId ? `approval-${event.approvalId}` : activityAnchor, kind: event.type, events: [event] });
      continue;
    }

    const last = entries.at(-1);
    if (last?.kind === "activity") {
      last.events.unshift(event);
    } else {
      entries.push({ key: `activity:${activityAnchor}`, kind: "activity", events: [event] });
    }
  }

  return entries.reverse();
}

function isToolEvent(type: EventType): boolean {
  return type === "tool_use" || type === "tool_result" || type === "approval_request";
}

function EventTime({ timestamp, prefix }: { timestamp: string; prefix?: string }) {
  const label = formatEventTime(timestamp);
  if (!label) return <span className="evt-time" />;
  return (
    <>
      {prefix}
      <time className="evt-time" dateTime={timestamp}>{label}</time>
    </>
  );
}

export function TaskProgress({ recent, unread = [], onRead }: {
  recent: LightEvent[];
  unread?: LightEvent[];
  onRead: (id: number) => void;
}) {
  const [inspected, setInspected] = useState<LightEvent>();
  const visible = selectVisibleProgressEvents(recent, unread, inspected);

  return (
    <div className="session-progress">
      {visible.length === 0 ? <div className="progress-heading">暂无任务进展</div> : <ProgressTimeline recent={visible} onInspect={event => {
        setInspected(event?.approvalId ? event : undefined);
        if (event?.approvalId && unread.some(e => e.approvalId === event.approvalId)) onRead(event.approvalId);
      }} />}
    </div>
  );
}

function ProgressTimeline({ recent, onInspect }: { recent: LightEvent[]; onInspect: (event?: LightEvent) => void }) {
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  return (
    <ol className="event-timeline" role="list">
      {toProgressEntries(recent).map((entry) => (
        <ProgressRow
          key={entry.key}
          entry={entry}
          expanded={expandedKey === entry.key}
          onToggle={() => {
            const opening = expandedKey !== entry.key;
            setExpandedKey(opening ? entry.key : null);
            onInspect(opening ? entry.events[0] : undefined);
          }}
        />
      ))}
    </ol>
  );
}

function ProgressRow({
  entry,
  expanded,
  onToggle,
}: {
  entry: ProgressEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  const reduceMotion = useReducedMotion();
  const { kind, events } = entry;
  const [event] = events;
  const activity = kind === "activity";
  const rows = activity ? activityRows(events) : [];
  const fallback = kind === "auto_approval_failed" ? [event.tool, "客户端未提供具体原因。"].filter(Boolean).join(" · ") : event.tool;
  const detail = activity ? undefined : event.message || fallback;
  const preview = kind === "error" ? detail : undefined;
  const canExpand = activity || Boolean(detail);
  const label = activity
    ? (events.every((item) => isToolEvent(item.type)) ? "工具活动" : "运行日志")
    : EVENT_LABEL[kind];
  const heading = (
    <span className="evt-heading">
      <span className="evt-action">
        {label}
        {activity && <span className="evt-count" data-hint={`${rows.length} 项活动`}>· {rows.length}</span>}
      </span>
      {!(activity && expanded) && <EventTime timestamp={event.timestamp} />}
      <span className="evt-chevron" aria-hidden="true" />
    </span>
  );

  return (
    <li className="evt-wrap" data-event-type={kind}>
      {canExpand ? (
        <button className="evt" type="button" onClick={onToggle} aria-expanded={expanded}>
          {heading}
          {!expanded && preview && <span className="evt-preview">{preview}</span>}
        </button>
      ) : (
        <div className="evt">{heading}</div>
      )}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="detail"
            className="collapse-clip"
            initial={reduceMotion ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={collapseTransition(reduceMotion)}
          >
            {activity ? <ActivityLog rows={rows} /> : <div className="evt-detail">{detail}</div>}
          </motion.div>
        )}
      </AnimatePresence>
    </li>
  );
}

function toolPhase({ event, call }: ActivityRow): string {
  if (event.type !== "tool_result") return "已调用";
  if (event.message?.startsWith("工具失败：")) return "工具失败";
  if (!call) return "已返回";
  const ms = Date.parse(event.timestamp) - Date.parse(call.timestamp);
  if (!Number.isFinite(ms) || ms < 0) return "已返回";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function ActivityLog({ rows }: { rows: ActivityRow[] }) {
  return (
    <ol className="progress-log" role="list">
      {rows.map(row => {
        const { event, call, key } = row;
        if (isToolEvent(event.type)) {
          const heading = (
            <>
              <span className="tool-action">{activityRowLabel(row)}</span>
              <span className="tool-phase">{toolPhase(row)}</span>
              <EventTime timestamp={event.timestamp} />
            </>
          );
          return (
            <li key={key}>
              {call || event.tool || event.message ? (
                <details>
                  <summary className="tool-summary">{heading}</summary>
                  <div className="tool-original">
                    {(call ? [call, event] : [event]).map(record => (
                      <div key={record.type}>
                        <div className="tool-source">{EVENT_LABEL[record.type]}<EventTime timestamp={record.timestamp} prefix=" · " />{record.tool && ` · ${record.tool}`}</div>
                        {record.message && record.message !== record.tool && <pre>{record.message}</pre>}
                      </div>
                    ))}
                  </div>
                </details>
              ) : <div className="tool-summary">{heading}</div>}
            </li>
          );
        }
        const detail = event.message || event.tool;
        return (
          <li key={key}>
            <div className="progress-log-head">
              <span>{EVENT_LABEL[event.type]}</span>
              <EventTime timestamp={event.timestamp} />
            </div>
            {detail && <div className="evt-detail">{detail}</div>}
          </li>
        );
      })}
    </ol>
  );
}
