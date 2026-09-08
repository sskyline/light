import assert from "node:assert/strict";
import test from "node:test";
import presenceModule from "../dist-electron/appPresence.js";

const { PresenceWatcher, parseProbeOutput } = presenceModule;

const OUT = JSON.stringify({
  "com.google.antigravity": { installed: true, running: false },
  "com.openai.codex": { installed: true, running: true },
  "com.anthropic.claudefordesktop": { installed: false, running: false },
});

function fakeExec() {
  const f = {
    calls: [],
    pending: null,
    exec(cmd, args, cb) {
      f.calls.push({ cmd, args });
      f.pending = cb;
    },
    flush(err = null, stdout = "") {
      const cb = f.pending;
      f.pending = null;
      cb(err, stdout);
    },
  };
  return f;
}

function makeWatcher(exec, events) {
  return new PresenceWatcher({
    exec: exec ?? fakeExec().exec,
    intervalMs: 60 * 60 * 1000,
    log: () => {},
    onChange: (s) => events.push(s),
  });
}

test("parseProbeOutput maps bundle ids back to launch targets", () => {
  const parsed = parseProbeOutput(OUT);
  assert.deepEqual(parsed.antigravity, { installed: true, running: false });
  assert.deepEqual(parsed.codex, { installed: true, running: true });
  assert.deepEqual(parsed["claude-code"], { installed: false, running: false });
});

test("parseProbeOutput treats missing bundle ids as installed-but-unknown and rejects garbage", () => {
  const partial = parseProbeOutput(JSON.stringify({ "com.openai.codex": { installed: false, running: false } }));
  assert.deepEqual(partial.codex, { installed: false, running: false });
  assert.equal(partial.antigravity.installed, true, "missing key must fail open");
  assert.equal(partial.antigravity.running, false);
  assert.equal(parseProbeOutput("not json"), null);
  assert.equal(parseProbeOutput("42"), null);
});

test("watcher probes immediately on start and emits only the parsed change", () => {
  const f = fakeExec();
  const events = [];
  const w = makeWatcher(f.exec, events);
  w.start();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].cmd, "osascript");
  assert.deepEqual(f.calls[0].args.slice(0, 2), ["-l", "JavaScript"]);
  assert.equal(events.length, 0, "no emit before first probe resolves");

  f.flush(null, OUT);
  assert.equal(events.length, 1);
  assert.equal(events[0].codex.running, true);
  assert.equal(events[0]["claude-code"].installed, false);
  w.stop();
});

test("watcher does not re-emit when consecutive probes return the same state", () => {
  const f = fakeExec();
  const events = [];
  const w = makeWatcher(f.exec, events);
  w.start();
  f.flush(null, OUT);
  assert.equal(events.length, 1);

  w.probeNow();
  assert.equal(f.calls.length, 2);
  f.flush(null, OUT);
  assert.equal(events.length, 1, "identical probe must not emit");

  w.probeNow();
  f.flush(null, JSON.stringify({
    "com.google.antigravity": { installed: true, running: true },
    "com.openai.codex": { installed: true, running: true },
    "com.anthropic.claudefordesktop": { installed: false, running: false },
  }));
  assert.equal(events.length, 2, "real change emits exactly once");
  assert.equal(events[1].antigravity.running, true);
  w.stop();
});

test("probe failure keeps the last known state and stays silent", () => {
  const f = fakeExec();
  const events = [];
  const w = makeWatcher(f.exec, events);
  w.start();
  f.flush(null, OUT);
  assert.equal(events.length, 1);

  w.probeNow();
  assert.doesNotThrow(() => f.flush(new Error("osascript timed out")));
  assert.equal(events.length, 1);
  assert.equal(w.getState().codex.running, true, "state preserved across failed probe");

  w.probeNow();
  f.flush(null, "garbage");
  assert.equal(events.length, 1, "unparsable output must not blank the state");
  w.stop();
});

test("overlapping probes are skipped while one is in flight", () => {
  const f = fakeExec();
  const events = [];
  const w = makeWatcher(f.exec, events);
  w.start();
  w.probeNow();
  w.probeNow();
  assert.equal(f.calls.length, 1, "in-flight guard collapses concurrent probes");
  f.flush(null, OUT);
  w.stop();
});

test("markRunning and markNotInstalled emit immediately and imply each other", () => {
  const events = [];
  const w = makeWatcher(undefined, events);
  w.start();

  w.markRunning("antigravity");
  assert.deepEqual(w.getState().antigravity, { installed: true, running: true });
  w.markNotInstalled("codex");
  assert.deepEqual(w.getState().codex, { installed: false, running: false });
  assert.equal(events.length, 2);
  w.stop();
});
