import { execFile } from "node:child_process";
import { join } from "node:path";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import { resolveAgentConfigPaths } from "./hookInstaller";
import { SESSION_UUID, type EventType } from "./state";

const execute = promisify(execFile);
const pollMs = 1500;

interface Turn {
  id: string;
  expires: number;
}

interface Denial {
  thread: string;
  turn: string;
  id: string;
  reason: string | null;
}

// Only project the verdict and explanation. Guardian records also contain
// unrelated conversation history, which should never leave SQLite.
export async function readCodexDenials(db: string, turns: Map<string, Turn>): Promise<Denial[]> {
  const pairs = [...turns].filter(([thread, turn]) => SESSION_UUID.test(thread) && SESSION_UUID.test(turn.id));
  if (!pairs.length) return [];
  const ids = pairs.map(([thread, turn]) => `('${thread}', '${turn.id}')`).join(",");
  const query = `WITH tracked(thread, turn) AS (VALUES ${ids}), reviews AS (
    SELECT id, thread_id AS thread, CASE WHEN json_valid(CAST(record AS TEXT))
      THEN CAST(record AS TEXT) END AS data
    FROM guardian_review_feedback WHERE thread_id IN (SELECT thread FROM tracked)
  ), denied AS (
    SELECT id, thread, json_extract(data, '$.reviewed_turn_id') AS turn, json_extract(data, '$.status') AS status,
           json_extract(data, '$.decision') AS decision
    FROM reviews WHERE json_extract(data, '$.reviewed_thread_id') = thread
      AND (thread, turn) IN (SELECT thread, turn FROM tracked)
      AND status IN ('denied', 'timedOut', 'timed_out')
  )
  SELECT id, thread, turn, CASE WHEN status IN ('timedOut', 'timed_out') THEN '自动审批超时'
    WHEN json_valid(decision)
    THEN substr(json_extract(decision, '$.rationale'), 1, 400) END AS reason FROM denied`;
  const executable = process.platform === "darwin" ? "/usr/bin/sqlite3" : "sqlite3";
  const { stdout } = await execute(executable, ["-batch", "-readonly", "-json", db, query], {
    timeout: 2000, maxBuffer: 512 * 1024, windowsHide: true,
  });
  const rows: Denial[] = JSON.parse(stdout.trim() || "[]");
  return rows.filter(row => typeof row.id === "string" && turns.get(row.thread)?.id === row.turn);
}

export class CodexReviewWatcher {
  private readonly turns = new Map<string, Turn>();
  private timer?: NodeJS.Timeout;
  private busy = false;
  private readonly reported = new Set<string>();
  private revision = "";
  private generation = 0;

  constructor(private readonly onDenied: (thread: string, reason?: string) => void,
    private readonly db = join(resolveAgentConfigPaths().codexDir, "state_5.sqlite")) {}

  track(thread: unknown, turn: unknown, event: EventType): void {
    if (typeof thread !== "string" || !SESSION_UUID.test(thread)) return;
    if (event === "session_end" || (typeof turn !== "string" || !SESSION_UUID.test(turn))) {
      if (event === "session_end" || event === "user_prompt") this.turns.delete(thread);
      return;
    }
    let tracked = this.turns.get(thread);
    if (tracked?.id !== turn) {
      if (tracked && event !== "user_prompt") return;
      tracked = { id: turn, expires: 0 };
      this.turns.set(thread, tracked);
      this.generation++;
    }
    // Allow a final verdict to reach disk shortly after the terminal hook.
    const ended = event === "stop" || event === "interrupt" || event === "error";
    tracked.expires = Date.now() + (ended ? 12_000 : 5 * 60_000);
    if (!this.timer) this.timer = setInterval(() => { void this.poll(); }, pollMs);
  }

  async poll(): Promise<void> {
    if (this.busy) return;
    for (const [key, turn] of this.turns) if (Date.now() >= turn.expires) this.turns.delete(key);
    if (!this.turns.size) { this.stop(); return; }
    this.busy = true;
    try {
      const generation = this.generation;
      const [db, wal] = await Promise.all([stat(this.db), stat(this.db + "-wal").catch(() => undefined)]);
      const revision = [generation, db.ino, db.mtimeMs, wal?.mtimeMs, wal?.size].join("/");
      if (revision === this.revision) return;
      const turns = new Map(this.turns);
      for (const row of await readCodexDenials(this.db, turns)) {
        const tracked = this.turns.get(row.thread);
        if (!tracked || tracked !== turns.get(row.thread) || this.reported.has(row.id)) continue;
        this.reported.add(row.id);
        if (this.reported.size > 1024) this.reported.delete(this.reported.values().next().value!);
        this.onDenied(row.thread, typeof row.reason === "string" ? row.reason : undefined);
      }
      this.revision = revision;
    } catch {
      // Older Codex versions may not have this table. Ordinary hooks still work.
    } finally { this.busy = false; }
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.turns.clear();
    this.revision = "";
  }
}
