import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { SESSION_UUID } from "./state";

const DATA_DIRS = ["antigravity", "antigravity-ide", "antigravity-cli"];

export async function readAntigravitySessionTitle(
  sessionId: string,
  geminiHome = join(homedir(), ".gemini"),
): Promise<string | null> {
  if (!SESSION_UUID.test(sessionId)) return null;

  for (const dir of DATA_DIRS) {
    try {
      const file = join(geminiHome, dir, "annotations", sessionId + ".pbtxt");
      const annotation = await readFile(file, "utf8");
      // The title is a quoted string, followed by other annotation fields.
      const [, quotedTitle] = /^title:[ \t]*("(?:[^"\\\r\n]|\\.)*")/m.exec(annotation) ?? [];
      if (!quotedTitle) continue;
      const title = (JSON.parse(quotedTitle) as string).trim();
      if (title) return title;
    } catch {
      // This client may have no annotation yet, or may be writing it.
    }
  }
  return null;
}
