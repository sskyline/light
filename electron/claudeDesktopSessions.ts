import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { SESSION_UUID } from "./sessionNavigation";

function isClaudeDesktopId(id: unknown): id is string {
  return typeof id === "string" && /^local_[a-zA-Z0-9-]{1,64}$/.test(id);
}

async function entries(dir: string) {
  return readdir(dir, { withFileTypes: true }).catch(() => []);
}

// Claude stores one metadata file per Code conversation, below account/org.
// Share the index across rows and retain only identifiers after reading it.
export function createClaudeDesktopLookup(appSupport = join(homedir(), "Library", "Application Support")) {
  async function buildIndex() {
    const index = new Map<string, string | null>();
    for (const profile of ["Claude", "Claude-3p"]) {
      const root = join(appSupport, profile, "claude-code-sessions");
      for (const account of await entries(root)) {
        if (!account.isDirectory()) continue;
        const accountDir = join(root, account.name);
        for (const org of await entries(accountDir)) {
          if (!org.isDirectory()) continue;
          const orgDir = join(accountDir, org.name);
          for (const file of await entries(orgDir)) {
            if (!file.isFile() || !file.name.endsWith(".json")) continue;
            const id = file.name.slice(0, -5);
            if (!isClaudeDesktopId(id)) continue;
            try {
              const record = JSON.parse(await readFile(join(orgDir, file.name), "utf8"));
              if (record.sessionId !== id || record.isArchived) continue;
              const previous = Array.isArray(record.previousCliSessionIds) ? record.previousCliSessionIds : [];
              for (const cliId of [record.cliSessionId, ...previous]) {
                if (typeof cliId !== "string" || !SESSION_UUID.test(cliId)) continue;
                const key = cliId.toLowerCase();
                index.set(key, index.has(key) && index.get(key) !== id ? null : id);
              }
            } catch {
              // Claude may replace a record while the directory is being read.
            }
          }
        }
      }
    }
    return index;
  }

  let cached: Promise<Map<string, string | null>> | undefined;
  let expires = 0;
  return async (cliId: string, refresh = false): Promise<string | null> => {
    if (!SESSION_UUID.test(cliId)) return null;
    if (!cached || refresh || Date.now() >= expires) {
      expires = Date.now() + 5000;
      cached = buildIndex();
    }
    return (await cached).get(cliId.toLowerCase()) ?? null;
  };
}
