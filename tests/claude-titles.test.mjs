import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import titlesModule from "../dist-electron/claudeTitles.js";
import stateModule from "../dist-electron/state.js";

const { readClaudeSessionTitle } = titlesModule;
const { StateStore } = stateModule;

test("Claude Code titles use matching transcript metadata and prefer the latest custom title", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "light-claude-title-"));
  const store = new StateStore();
  t.after(async () => {
    store.clearAll();
    await rm(home, { recursive: true, force: true });
  });

  const id = "2ed0a14b-80e0-4123-8b02-0ef9d7fa3001";
  const otherId = "2ed0a14b-80e0-4123-8b02-0ef9d7fa3002";
  store.ingest({ agent: "claude-code", sessionId: id, type: "user_prompt", message: "最新问题" });
  const [session] = store.getState().sessions;
  assert.deepEqual(store.getTitleSession(session.key), { agent: "claude-code", id });
  assert.equal(await readClaudeSessionTitle(id, home), null);

  const dir = join(home, "projects", "sample-project");
  await mkdir(dir, { recursive: true });
  const transcript = join(dir, `${id}.jsonl`);
  const lines = (entries) => entries.map((entry) => JSON.stringify(entry) + "\n").join("");
  await writeFile(transcript, lines([
    { type: "user", sessionId: id, message: { content: "最新问题" } },
    { type: "ai-title", sessionId: otherId, aiTitle: "别的会话" },
  ]));
  assert.equal(await readClaudeSessionTitle(id, home), null);

  await appendFile(transcript, lines([{ type: "ai-title", sessionId: id, aiTitle: "自动标题" }]));
  assert.equal(await readClaudeSessionTitle(id, home), "自动标题");

  await appendFile(transcript, lines([
    { type: "custom-title", sessionId: id, customTitle: "旧标题" },
    { type: "custom-title", sessionId: id, customTitle: "已重命名" },
    { type: "ai-title", sessionId: id, aiTitle: "较新的自动标题" },
  ]) + '{"type":"custom-title"');
  assert.equal(await readClaudeSessionTitle(id, home), "已重命名");
  assert.equal(await readClaudeSessionTitle(otherId, home), null);
});
