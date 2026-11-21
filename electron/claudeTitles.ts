import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { resolveAgentConfigPaths } from "./hookInstaller";
import { SESSION_UUID } from "./state";

async function findTranscript(projects: string, sessionId: string): Promise<string | undefined> {
  const dirs = await readdir(projects, { withFileTypes: true });
  let latest: { path: string; mtime: number } | undefined;
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const path = join(projects, dir.name, `${sessionId}.jsonl`);
    const info = await lstat(path).catch(() => null);
    if (info?.isFile() && (!latest || info.mtimeMs > latest.mtime)) {
      latest = { path, mtime: info.mtimeMs };
    }
  }
  return latest?.path;
}

export async function readClaudeSessionTitle(
  sessionId: string,
  claudeHome = resolveAgentConfigPaths().claudeDir,
): Promise<string | null> {
  if (!SESSION_UUID.test(sessionId)) return null;

  try {
    const path = await findTranscript(join(claudeHome, "projects"), sessionId);
    if (!path) return null;
    const transcript = await open(path, "r");
    try {
      let customTitle = "";
      let autoTitle = "";
      for await (const line of transcript.readLines()) {
        if (!line.includes('"custom-title"') && !line.includes('"ai-title"')) continue;
        try {
          const entry = JSON.parse(line);
          if (entry?.sessionId !== sessionId) continue;
          if (entry.type === "custom-title" && typeof entry.customTitle === "string") {
            customTitle = entry.customTitle.trim();
          } else if (entry.type === "ai-title" && typeof entry.aiTitle === "string") {
            autoTitle = entry.aiTitle.trim();
          }
        } catch {
          // A title entry can be incomplete while Claude Code appends it.
        }
      }
      return customTitle || autoTitle || null;
    } finally {
      await transcript.close();
    }
  } catch {
    return null;
  }
}
