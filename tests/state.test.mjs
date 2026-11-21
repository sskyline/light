import assert from "node:assert/strict";
import test from "node:test";
import stateModule from "../dist-electron/state.js";

const { StateStore, STATE_PUBLISH_INTERVAL_MS: INTERVAL } = stateModule;

function setup(t) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000 });
  const store = new StateStore();
  const states = [];
  const events = [];
  store.on("state", (state) => states.push(state));
  store.on("event", (event) => events.push(event));
  t.after(() => store.clearAll());
  const ingest = (type, message = type, sessionId = "session-a") => store.ingest({
    agent: "claude-code",
    sessionId,
    type,
    tool: "Bash",
    message,
    timestamp: new Date().toISOString(),
  });
  return { store, states, events, ingest };
}

test("Bash bursts publish only the first and latest snapshot, retaining every event", (t) => {
  const { store, states, events, ingest } = setup(t);
  ingest("tool_use", "first");
  for (let i = 0; i < 20; i++) {
    ingest(i % 2 ? "tool_use" : "tool_result", `command-${i}`);
  }
  assert.equal(states.length, 1);
  assert.equal(events.length, 21);
  assert.equal(store.getState().sessions[0].recent.length, 21);
  assert.equal(states[0].sessions[0].recent.length, 1, "published snapshots stay immutable");

  t.mock.timers.tick(INTERVAL - 1);
  assert.equal(states.length, 1);
  t.mock.timers.tick(1);
  assert.equal(states.length, 2);
  assert.deepEqual(states[1], store.getState());
  assert.equal(states[1].sessions[0].recent[0].message, "command-19");
  t.mock.timers.tick(INTERVAL * 2);
  assert.equal(states.length, 2, "no periodic redraw after the burst ends");
});

test("continuous output cannot postpone refreshes indefinitely", (t) => {
  const { states, ingest } = setup(t);
  ingest("tool_use");
  for (let i = 1; i <= 30; i++) {
    ingest("tool_result", `result-${i}`);
    t.mock.timers.tick(INTERVAL / 10);
    assert.equal(states.length, 1 + Math.floor(i / 10));
  }
  assert.equal(states.at(-1).sessions[0].recent[0].message, "result-30");
});

test("concurrent sessions keep their display order until their priority changes", (t) => {
  const { store } = setup(t);
  const send = (agent, sessionId, type) => {
    t.mock.timers.tick(10);
    store.ingest({ agent, sessionId, type, timestamp: new Date().toISOString() });
  };
  const order = () => store.getState().sessions.map((session) => session.sessionId);

  send("codex", "first", "user_prompt");
  send("claude-code", "second", "user_prompt");
  send("codex", "third", "user_prompt");
  for (const [agent, id, type] of [
    ["claude-code", "second", "tool_use"],
    ["codex", "third", "approval_request"],
    ["codex", "first", "tool_result"],
    ["codex", "third", "tool_use"],
  ]) {
    send(agent, id, type);
    assert.deepEqual(order(), ["first", "second", "third"]);
  }
  send("codex", "third", "error");
  assert.deepEqual(order(), ["third", "first", "second"]);
  send("codex", "third", "tool_use");
  send("codex", "first", "stop");
  assert.deepEqual(order(), ["second", "third", "first"]);
  send("claude-code", "second", "session_end");
  assert.deepEqual(order(), ["third", "first"]);
});

for (const [type, status] of [
  ["approval_request", "waiting"],
  ["error", "error"],
  ["stop", "done"],
  ["interrupt", "idle"],
  ["user_prompt", "working"],
]) {
  test(`${type} flushes immediately and cancels the older pending update`, (t) => {
    const { store, states, ingest } = setup(t);
    ingest("tool_use");
    ingest("tool_result");
    t.mock.timers.tick(100);
    ingest(type);
    assert.equal(states.length, 2);
    assert.equal(states[1].sessions[0].status, status);
    assert.deepEqual(states[1], store.getState());
    t.mock.timers.tick(INTERVAL);
    assert.equal(states.length, 2);
  });
}

test("manual clear and removal take effect immediately during a pending burst", (t) => {
  const { store, states, ingest } = setup(t);
  ingest("tool_use");
  ingest("tool_result");
  store.clearEvents();
  assert.equal(states.length, 2);
  assert.deepEqual(states.at(-1).sessions[0].recent, []);
  t.mock.timers.tick(INTERVAL);
  assert.equal(states.length, 2);

  ingest("tool_use");
  ingest("tool_result");
  store.removeSession(store.getState().sessions[0].key);
  assert.deepEqual(states.at(-1).sessions, []);
  const count = states.length;
  t.mock.timers.tick(INTERVAL);
  assert.equal(states.length, count, "removed sessions must not reappear");
});

test("interrupt clears task timing and watchdogs without affecting another session", (t) => {
  const { store, states, ingest } = setup(t);
  ingest("user_prompt");
  ingest("approval_request");
  ingest("user_prompt", "another task", "session-b");
  ingest("interrupt");
  const session = () => store.getState().sessions.find((s) => s.sessionId === "session-a");
  assert.equal(session().status, "idle");
  assert.equal(session().startedAt, undefined);
  assert.equal(session().currentTool, undefined);
  assert.equal(session().lastPrompt, "user_prompt");
  assert.equal(store.getState().sessions.find((s) => s.sessionId === "session-b").status, "working");
  const count = states.length;
  t.mock.timers.tick(60_000);
  assert.equal(states.length, count, "cancelled approval watchdog must not publish again");
  ingest("user_prompt", "retry");
  assert.equal(session().status, "working");
  assert.equal(session().startedAt, new Date().toISOString());
  assert.equal(session().lastPrompt, "retry");
});

test("a shared batch includes every session and preserves the existing history cap", (t) => {
  const { store, states, events, ingest } = setup(t);
  for (let i = 0; i < 200; i++) {
    ingest("tool_use", `command-${i}`, i % 2 ? "session-a" : "session-b");
  }
  assert.equal(states.length, 1);
  assert.equal(events.length, 200);
  t.mock.timers.tick(INTERVAL);
  assert.equal(states.length, 2);
  assert.deepEqual(states[1], store.getState());
  assert.equal(states[1].sessions.length, 2);
  assert.ok(states[1].sessions.every((session) => session.recent.length === 30));
});

test("idle sessions remember when the turn ended until another turn starts", (t) => {
  const { store, ingest } = setup(t);
  const session = () => store.getState().sessions[0];
  for (const type of ["stop", "interrupt", "error"]) {
    ingest("user_prompt");
    assert.equal(session().turnEnd, undefined);
    ingest(type);
    const endedAt = new Date().toISOString();
    t.mock.timers.tick(8_000);
    assert.equal(session().status, "idle");
    ingest("notification");
    store.clearEvents();
    assert.deepEqual(session().turnEnd, { type, timestamp: endedAt });
  }
  ingest("tool_use");
  t.mock.timers.tick(4 * 60_000);
  assert.equal(session().status, "idle");
  assert.equal(session().turnEnd, undefined);
});

test("session end and clearAll cancel pending publication without restoring stale data", (t) => {
  const { store, states, ingest } = setup(t);
  ingest("tool_use");
  ingest("tool_result");
  ingest("session_end");
  assert.equal(states.length, 2);
  assert.deepEqual(states.at(-1).sessions, []);
  t.mock.timers.tick(INTERVAL);
  assert.equal(states.length, 2);

  ingest("tool_use");
  ingest("tool_result");
  store.clearAll();
  assert.deepEqual(states.at(-1).sessions, []);
  const count = states.length;
  t.mock.timers.tick(INTERVAL * 2);
  assert.equal(states.length, count);
});

test("only confirmed automatic denials appear in progress and a later tool can continue the turn", (t) => {
  const { store, ingest } = setup(t);
  ingest("user_prompt");
  ingest("approval_request");
  const snapshot = () => store.getState().sessions[0];
  assert.deepEqual(snapshot().recent.map(event => event.type), ["user_prompt"]);
  ingest("auto_approval_failed", "Classifier unavailable");
  assert.equal(snapshot().status, "auto_approval_failed");
  assert.equal(snapshot().recent[0].message, "Classifier unavailable");
  assert.equal(snapshot().turnEnd, undefined);
  ingest("notification");
  assert.equal(snapshot().status, "auto_approval_failed");
  ingest("tool_use");
  assert.equal(snapshot().status, "working");
  assert.ok(snapshot().recent.some(event => event.type === "auto_approval_failed"));
});

test("unread denials survive later turns, cleared history, session end and idle expiry until each reason is opened", (t) => {
  const { store, ingest } = setup(t);
  const session = () => store.getState().sessions[0];
  ingest("approval_request");
  assert.equal(session().unreadApprovals, undefined);
  ingest("auto_approval_failed", "First");
  ingest("auto_approval_failed", "Second");
  const [second, first] = session().unreadApprovals;
  assert.notEqual(first.approvalId, second.approvalId);
  ingest("user_prompt");
  for (let i = 0; i < 35; i++) ingest("tool_use");
  assert.ok(session().recent.every(e => !e.approvalId));
  assert.equal(session().unreadApprovals.length, 2);
  store.clearEvents();
  ingest("stop");
  t.mock.timers.tick(60 * 60_000);
  assert.equal(session().status, "idle");
  ingest("session_end");
  store.acknowledgeApproval(session().key, first.approvalId);
  store.acknowledgeApproval(session().key, first.approvalId);
  assert.deepEqual(session().unreadApprovals, [second]);
  store.acknowledgeApproval(session().key, second.approvalId);
  assert.equal(session().unreadApprovals, undefined);
  t.mock.timers.tick(60 * 60_000);
  assert.equal(session(), undefined);
});
