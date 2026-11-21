import { execFile } from "node:child_process";
import { BUNDLE_IDS } from "./appPresence";
import { focusRexPane, isRexId } from "./rexNavigation";

export type ExecFn = (cmd: string, args: string[], cb: (err: Error | null) => void) => void;

export const SESSION_UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export type JumpTarget = { kind: "codex" | "claude-desktop" | "iterm" | "ghostty"; id: string } | { kind: "rex"; session: string; id: string };

export function resolveJumpTarget(agent: string, id: string | undefined, terminal: unknown): JumpTarget | undefined {
  if (terminal && typeof terminal === "object" && "kind" in terminal && "id" in terminal && typeof terminal.id === "string") {
    const pane = terminal.id;
    if (terminal.kind === "rex" && "session" in terminal && isRexId(terminal.session, "session") && isRexId(pane, "block")) {
      return { kind: "rex", session: terminal.session, id: pane };
    }
    if (terminal.kind === "ghostty" && SESSION_UUID.test(pane)) return { kind: "ghostty", id: pane };
    const match = /^w\d+t\d+p\d+:([\da-f-]+)$/i.exec(pane);
    if (terminal.kind === "iterm" && match && SESSION_UUID.test(match[1])) return { kind: "iterm", id: pane };
  }
  if (agent === "codex" && id && SESSION_UUID.test(id)) return { kind: "codex", id };
}

const focusGhostty = `on run argv
  set surfaceID to item 1 of argv
  if application id "com.mitchellh.ghostty" is not running then error "Ghostty is closed"
  tell application id "com.mitchellh.ghostty" to focus (terminal id surfaceID)
end run`;

const run: ExecFn = (file, args, cb) => execFile(file, args, { timeout: 15000 }, (error, _stdout, stderr) => {
  const reason = stderr.trim() || error?.code || "系统未能打开目标。";
  cb(error ? new Error(String(reason).slice(0, 500)) : null);
});

export function openJumpTarget(target: JumpTarget, exec: ExecFn = run): Promise<boolean> {
  if (target.kind === "rex") return focusRexPane(target.session, target.id);
  return new Promise((resolve, reject) => {
    const done = (error: Error | null) => error ? reject(error) : resolve(true);
    switch (target.kind) {
      case "claude-desktop":
        exec("/usr/bin/open", ["-b", BUNDLE_IDS["claude-code"], `claude://claude.ai/epitaxy/${encodeURIComponent(target.id)}`], done);
        break;
      case "codex":
        exec("/usr/bin/open", ["-b", BUNDLE_IDS.codex, `codex://threads/${target.id}`], done);
        break;
      case "iterm":
        exec("/usr/bin/open", ["-b", "com.googlecode.iterm2", `iterm2:reveal?sessionid=${encodeURIComponent(target.id)}`], done);
        break;
      case "ghostty":
        exec("/usr/bin/osascript", ["-e", focusGhostty, target.id], done);
        break;
    }
  });
}
