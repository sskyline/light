import assert from "node:assert/strict";
import test from "node:test";
import progressOrder from "../dist-electron/progressOrder.js";

const {
  compareEventsDesc,
  formatEventTime,
  selectVisibleProgressEvents,
} = progressOrder;

const makeEvent = (type, timestamp, extra = {}) => ({
  agent: "claude-code",
  type,
  timestamp,
  ...extra,
});

test("sorts mixed UTC and timezone-offset ISO timestamps by epoch milliseconds", () => {
  // 2026-11-21T10:00:00+08:00 === 02:00:00Z (earliest)
  // 2026-11-21T03:00:00Z      === 03:00:00Z (middle)
  // 2026-11-21T00:00:00-04:00 === 04:00:00Z (latest)
  // Note: lexicographically "2026-11-21T10:00:00+08:00" > "2026-11-21T03:00:00Z" > "2026-11-21T00:00:00-04:00"
  // which is completely inverted from chronological order!
  const recent = [
    makeEvent("user_prompt", "2026-11-21T10:00:00+08:00", { message: "start" }),
    makeEvent("tool_use", "2026-11-21T03:00:00.000Z", { message: "middle" }),
    makeEvent("stop", "2026-11-21T00:00:00-04:00", { message: "end" }),
  ];

  const visible = selectVisibleProgressEvents(recent);
  assert.deepEqual(
    visible.map((e) => e.message),
    ["end", "middle", "start"],
  );
});

test("slices the latest turn at user_prompt using true epoch order across timezone offsets", () => {
  // Earlier turn ended at 01:30Z (09:30+08:00).
  // Latest turn started at 02:00Z ("2026-11-21T02:00:00Z") and ran tools at 02:01Z ("2026-11-21T10:01:00+08:00").
  // Lexicographical sort would put "09:30+08:00" ahead of "02:00Z", leaking the previous turn's events into latest!
  const recent = [
    makeEvent("tool_result", "2026-11-21T10:01:00+08:00", { message: "new-tool" }),
    makeEvent("user_prompt", "2026-11-21T02:00:00Z", { message: "new-turn" }),
    makeEvent("stop", "2026-11-21T09:30:00+08:00", { message: "old-stop" }),
    makeEvent("user_prompt", "2026-11-21T09:00:00+08:00", { message: "old-turn" }),
  ];

  const visible = selectVisibleProgressEvents(recent);
  assert.deepEqual(
    visible.map((e) => e.message),
    ["new-tool", "new-turn"],
  );
});

test("preserves StateStore arrival order when timestamps represent the exact same millisecond", () => {
  // StateStore stores recent newest-first: [laterArrival, earlierArrival].
  // 10:00:00+08:00 and 02:00:00.000Z are both epoch 1795226400000.
  const recent = [
    makeEvent("tool_result", "2026-11-21T02:00:00.000Z", { message: "arrived-second" }),
    makeEvent("tool_use", "2026-11-21T10:00:00+08:00", { message: "arrived-first" }),
    makeEvent("user_prompt", "2026-11-21T01:59:59Z", { message: "prompt" }),
  ];

  assert.equal(compareEventsDesc(recent[0], recent[1]), 0);
  const visible = selectVisibleProgressEvents(recent);
  assert.deepEqual(
    visible.map((e) => e.message),
    ["arrived-second", "arrived-first", "prompt"],
  );
});

test("interleaves pinned unread and inspected approvals by epoch milliseconds without duplicating", () => {
  const sharedDenial = makeEvent("auto_approval_failed", "2026-11-21T10:02:00+08:00", {
    approvalId: 2,
    message: "in-turn-denial",
  });
  const olderUnread = makeEvent("auto_approval_failed", "2026-11-21T01:30:00Z", {
    approvalId: 1,
    message: "older-unread",
  });
  const inspectedAcked = makeEvent("auto_approval_failed", "2026-11-21T09:45:00+08:00", {
    approvalId: 3,
    message: "inspected-acked", // 01:45Z: between olderUnread (01:30Z) and prompt (02:00Z)
  });

  const recent = [
    makeEvent("approval_request", "2026-11-21T02:03:00Z", { message: "filtered-out" }),
    sharedDenial, // 02:02Z
    makeEvent("user_prompt", "2026-11-21T02:00:00Z", { message: "prompt" }),
    makeEvent("stop", "2026-11-21T09:50:00+08:00", { message: "old-stop" }),
  ];

  const visible = selectVisibleProgressEvents(recent, [sharedDenial, olderUnread], inspectedAcked);
  assert.deepEqual(
    visible.map((e) => e.message),
    ["in-turn-denial", "prompt", "inspected-acked", "older-unread"],
  );
});

test("handles unparseable timestamps deterministically without NaN comparator or NaN:NaN:NaN labels", () => {
  const events = [
    makeEvent("tool_use", "not-a-timestamp", { message: "bad-1" }),
    makeEvent("tool_result", "2026-11-21T02:00:00Z", { message: "valid-early" }),
    makeEvent("tool_use", "", { message: "bad-2" }),
    makeEvent("stop", "2026-11-21T10:05:00+08:00", { message: "valid-late" }),
  ];

  for (const a of events) {
    for (const b of events) {
      assert.equal(Number.isNaN(compareEventsDesc(a, b)), false);
    }
  }

  const sorted = [...events].sort(compareEventsDesc);
  assert.deepEqual(
    sorted.map((e) => e.message),
    ["valid-late", "valid-early", "bad-1", "bad-2"],
  );

  assert.equal(formatEventTime("not-a-timestamp"), "");
  assert.equal(formatEventTime(""), "");
  assert.match(formatEventTime("2026-11-21T02:05:09Z"), /^\d{2}:\d{2}:\d{2}$/);
});
