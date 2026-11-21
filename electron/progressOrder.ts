export interface ProgressOrderEvent {
  type: string;
  timestamp: string;
  approvalId?: number;
}

/**
 * Compare two events newest-first by epoch milliseconds.
 * Equal instants return 0 so ES2019+ stable sort preserves arrival order;
 * unparseable timestamps sort after valid ones without producing NaN.
 */
export function compareEventsDesc(
  a: Pick<ProgressOrderEvent, "timestamp">,
  b: Pick<ProgressOrderEvent, "timestamp">,
): number {
  const ta = Date.parse(a.timestamp);
  const tb = Date.parse(b.timestamp);
  const aValid = Number.isFinite(ta);
  const bValid = Number.isFinite(tb);
  if (aValid && bValid) return tb - ta;
  if (aValid !== bValid) return aValid ? -1 : 1;
  return 0;
}

export function formatEventTime(timestamp: string): string {
  const time = new Date(timestamp);
  if (Number.isNaN(time.getTime())) return "";
  return [time.getHours(), time.getMinutes(), time.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

export function selectVisibleProgressEvents<T extends ProgressOrderEvent>(
  recent: T[],
  unread: T[] = [],
  inspected?: T,
): T[] {
  const ordered = recent.filter((event) => event.type !== "approval_request").sort(compareEventsDesc);
  const latestStart = ordered.findIndex((event) => event.type === "user_prompt");
  const latest = latestStart < 0 ? ordered : ordered.slice(0, latestStart + 1);
  // Unread reasons may predate this turn or have rolled out of its 30-event history.
  // Keep the opened reason mounted after its acknowledgement arrives from main.
  const ids = new Set(latest.map((event) => event.approvalId));
  const pinned = unread.filter((event) => !ids.has(event.approvalId));
  if (
    inspected &&
    !ids.has(inspected.approvalId) &&
    !pinned.some((e) => e.approvalId === inspected.approvalId)
  ) {
    pinned.push(inspected);
  }
  return [...latest, ...pinned].sort(compareEventsDesc);
}
