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

for (const [type, status] of [
  ["approval_request", "waiting"],
  ["error", "error"],
  ["stop", "done"],
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
