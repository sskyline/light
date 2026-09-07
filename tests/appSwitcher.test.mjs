import assert from "node:assert/strict";
import test from "node:test";
import switcherModule from "../dist-electron/appSwitcher.js";

const { isSwitchTarget, switchToApp } = switcherModule;

function fakeExec(err = null) {
  const calls = [];
  const logs = [];
  return {
    calls,
    logs,
    exec: (cmd, args, cb) => {
      calls.push({ cmd, args });
      cb(err);
    },
    log: (...a) => logs.push(a),
  };
}

const EXPECTED_BUNDLES = {
  antigravity: "com.google.antigravity",
  codex: "com.openai.codex",
  "claude-code": "com.anthropic.claudefordesktop",
};

test("switchToApp runs `open -b` with each target's bundle id", () => {
  for (const [target, bundleId] of Object.entries(EXPECTED_BUNDLES)) {
    const f = fakeExec();
    switchToApp(target, f.exec, f.log);
    assert.equal(f.calls.length, 1, target);
    assert.deepEqual(f.calls[0], { cmd: "open", args: ["-b", bundleId] });
    assert.equal(f.logs.length, 0, target);
  }
});

test("switchToApp logs once and does not throw when open fails", () => {
  const f = fakeExec(new Error("Unable to find application"));
  assert.doesNotThrow(() => switchToApp("codex", f.exec, f.log));
  assert.equal(f.logs.length, 1);
  const message = f.logs[0].join(" ");
  assert.match(message, /codex/);
  assert.match(message, /com\.openai\.codex/);
});

test("isSwitchTarget accepts only the three launch targets", () => {
  for (const target of Object.keys(EXPECTED_BUNDLES)) {
    assert.equal(isSwitchTarget(target), true, target);
  }
  for (const v of ["trae", "unknown", "", null, 42, undefined]) {
    assert.equal(isSwitchTarget(v), false, String(v));
  }
});
