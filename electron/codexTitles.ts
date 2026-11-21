import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export async function readCodexThreadTitle(
  threadId: string,
  codexHome = process.env.CODEX_HOME || join(homedir(), ".codex"),
): Promise<string | null> {
  let index: string;
  try {
    index = await readFile(join(codexHome, "session_index.jsonl"), "utf8");
  } catch {
    return null;
  }

  // Codex appends entries when a thread is named or renamed.
  for (const line of index.trimEnd().split("\n").reverse()) {
    try {
      const entry = JSON.parse(line);
      if (entry?.id !== threadId) continue;
      return typeof entry.thread_name === "string" ? entry.thread_name.trim() || null : null;
    } catch {
      // The last line may still be getting written.
    }
  }
  return null;
}
