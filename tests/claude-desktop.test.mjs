import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import desktop from "../dist-electron/claudeDesktopSessions.js";
import navigation from "../dist-electron/sessionNavigation.js";

const cli = "01234567-1234-4123-8123-123456789abc";
const previous = "01234567-1234-4123-8123-123456789def";
const id = "local_22222222-2222-4222-8222-222222222222";

test("Claude desktop matches unique current and previous hook IDs across both profiles", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "light-claude-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lookup = desktop.createClaudeDesktopLookup(root);
  const put = async (profile, name, record) => {
    const dir = join(root, profile, "claude-code-sessions", "account", "org");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name + ".json"), JSON.stringify(record));
  };
  assert.equal(await lookup(cli), null);
  const record = { sessionId: id, cliSessionId: cli, previousCliSessionIds: [previous] };
  await put("Claude-3p", id, record);
  assert.equal(await lookup(cli, true), id);
  assert.equal(await lookup(previous.toUpperCase()), id);
  assert.equal(await lookup(cli.slice(0, 12)), null);
  const other = "local_33333333-3333-4333-8333-333333333333";
  await put("Claude", other, record);
  assert.equal(await lookup(cli, true), id);
  await put("Claude", other, { sessionId: other, cliSessionId: previous });
  assert.equal(await lookup(previous, true), null);
  assert.equal(await lookup(cli), id);
  await put("Claude-3p", id, { ...record, isArchived: true });
  assert.equal(await lookup(cli, true), null);
  assert.equal(await lookup(previous), other);
});

test("Claude desktop opens the Code conversation using its desktop ID", async () => {
  const opened = await navigation.openJumpTarget({ kind: "claude-desktop", id }, (file, args, done) => {
    assert.equal(file, "/usr/bin/open");
    assert.deepEqual(args, ["-b", "com.anthropic.claudefordesktop", "claude://claude.ai/epitaxy/" + id]);
    done(null);
  });
  assert.equal(opened, true);
});
