import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { StateStore } from "../state";
import type { LightEvent } from "../state";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<LightEvent> = {}): LightEvent {
  return {
    agent: "claude-code",
    type: "user_prompt",
    sessionId: "test-session-1",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// ─── state transition tests ───────────────────────────────────────────────────

describe("StateStore – state transitions", () => {
  let store: StateStore;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new StateStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts with no sessions", () => {
    expect(store.getState().sessions).toHaveLength(0);
  });

  it("user_prompt sets status to working", () => {
    store.ingest(makeEvent({ type: "user_prompt", message: "hello" }));
    const [s] = store.getState().sessions;
    expect(s.status).toBe("working");
    expect(s.lastPrompt).toBe("hello");
  });

  it("tool_use sets status to working and records current tool", () => {
    store.ingest(makeEvent({ type: "user_prompt" }));
    store.ingest(makeEvent({ type: "tool_use", tool: "Bash" }));
    const [s] = store.getState().sessions;
    expect(s.status).toBe("working");
    expect(s.currentTool).toBe("Bash");
  });

  it("approval_request sets status to waiting", () => {
    store.ingest(makeEvent({ type: "user_prompt" }));
    store.ingest(makeEvent({ type: "approval_request", tool: "Bash" }));
    const [s] = store.getState().sessions;
    expect(s.status).toBe("waiting");
  });

  it("stop sets status to done then reverts to idle after linger", () => {
    store.ingest(makeEvent({ type: "user_prompt" }));
    store.ingest(makeEvent({ type: "stop" }));
    expect(store.getState().sessions[0].status).toBe("done");

    // DONE_LINGER_MS = 8_000
    vi.advanceTimersByTime(8_001);
    expect(store.getState().sessions[0].status).toBe("idle");
  });

  it("error sets status to error then reverts to idle after linger", () => {
    store.ingest(makeEvent({ type: "user_prompt" }));
    store.ingest(makeEvent({ type: "error" }));
    expect(store.getState().sessions[0].status).toBe("error");

    // ERROR_LINGER_MS = 5_000
    vi.advanceTimersByTime(5_001);
    expect(store.getState().sessions[0].status).toBe("idle");
  });

  it("stale working session reverts to idle after STALE_WORKING_MS", () => {
    store.ingest(makeEvent({ type: "user_prompt" }));
    expect(store.getState().sessions[0].status).toBe("working");

    // STALE_WORKING_MS = 4 * 60_000 = 240_000
    vi.advanceTimersByTime(240_001);
    expect(store.getState().sessions[0].status).toBe("idle");
  });

  it("session_end removes the session", () => {
    store.ingest(makeEvent({ type: "user_prompt" }));
    expect(store.getState().sessions).toHaveLength(1);

    store.ingest(makeEvent({ type: "session_end" }));
    expect(store.getState().sessions).toHaveLength(0);
  });
});

// ─── multi-session isolation ──────────────────────────────────────────────────

describe("StateStore – multi-session isolation", () => {
  let store: StateStore;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new StateStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("tracks two sessions for the same agent independently", () => {
    store.ingest(makeEvent({ sessionId: "sess-A", type: "user_prompt", message: "A" }));
    store.ingest(makeEvent({ sessionId: "sess-B", type: "user_prompt", message: "B" }));

    const sessions = store.getState().sessions;
    expect(sessions).toHaveLength(2);

    const a = sessions.find((s) => s.lastPrompt === "A");
    const b = sessions.find((s) => s.lastPrompt === "B");
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!.key).not.toBe(b!.key);
  });

  it("tracks sessions for different agents independently", () => {
    store.ingest(makeEvent({ agent: "claude-code", sessionId: "s1", type: "user_prompt" }));
    store.ingest(makeEvent({ agent: "codex", sessionId: "s1", type: "user_prompt" }));

    const sessions = store.getState().sessions;
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.agent).sort()).toEqual(["claude-code", "codex"]);
  });

  it("stopping one session does not affect another", () => {
    store.ingest(makeEvent({ sessionId: "sess-A", type: "user_prompt" }));
    store.ingest(makeEvent({ sessionId: "sess-B", type: "user_prompt" }));
    store.ingest(makeEvent({ sessionId: "sess-A", type: "stop" }));

    const sessions = store.getState().sessions;
    const a = sessions.find((s) => s.sessionId === "sess-A");
    const b = sessions.find((s) => s.sessionId === "sess-B");
    expect(a?.status).toBe("done");
    expect(b?.status).toBe("working");
  });
});

// ─── removeSession / clearAll ─────────────────────────────────────────────────

describe("StateStore – housekeeping", () => {
  let store: StateStore;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new StateStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("removeSession drops only the targeted session", () => {
    store.ingest(makeEvent({ sessionId: "sess-A", type: "user_prompt" }));
    store.ingest(makeEvent({ sessionId: "sess-B", type: "user_prompt" }));
    const keyA = store.getState().sessions.find((s) => s.sessionId === "sess-A")!.key;
    store.removeSession(keyA);
    const sessions = store.getState().sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe("sess-B");
  });

  it("clearAll empties every session", () => {
    store.ingest(makeEvent({ sessionId: "sess-A", type: "user_prompt" }));
    store.ingest(makeEvent({ sessionId: "sess-B", type: "user_prompt" }));
    store.clearAll();
    expect(store.getState().sessions).toHaveLength(0);
  });
});

// ─── event emission ───────────────────────────────────────────────────────────

describe("StateStore – event emission", () => {
  it("emits 'state' after every ingest", () => {
    const store = new StateStore();
    const listener = vi.fn();
    store.on("state", listener);
    store.ingest(makeEvent({ type: "user_prompt" }));
    expect(listener).toHaveBeenCalledOnce();
  });

  it("emits 'event' with the normalised event", () => {
    const store = new StateStore();
    const listener = vi.fn();
    store.on("event", listener);
    store.ingest(makeEvent({ type: "user_prompt", message: "hi" }));
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0][0].type).toBe("user_prompt");
  });
});
