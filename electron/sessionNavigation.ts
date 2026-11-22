import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { BUNDLE_IDS } from "./appPresence";
import { focusRexPane, isRexId, openOrReopenRexPane } from "./rexNavigation";

export type ExecFn = (cmd: string, args: string[], cb: (err: Error | null, stdout?: string) => void) => void;

export const SESSION_UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export type JumpTarget = { kind: "codex" | "claude-desktop" | "iterm" | "ghostty"; id: string } | { kind: "rex"; session: string; id: string };

export interface ResumeSpec {
  agent: "claude-code" | "codex";
  sessionId: string;
  cwd?: string;
}

export interface OpenJumpResult {
  opened: boolean;
  reopened?: boolean;
  updatedTarget?: JumpTarget;
}

export interface OpenJumpOptions {
  exec?: ExecFn;
  dirExists?: (dir: string) => boolean;
  rexCli?: string;
  rexExecute?: (file: string, args: string[]) => Promise<string>;
  rexSleep?: (ms: number) => Promise<void>;
  onTargetUpdated?: (target: JumpTarget) => void;
}

export interface ValidatedResumeCommand {
  argv: string[];
  cwd?: string;
  shellCommand: string;
}

export function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export function buildResumeCommand(resume: ResumeSpec | undefined, dirExists: (dir: string) => boolean = existsSync): ValidatedResumeCommand | undefined {
  if (!resume || typeof resume !== "object") return undefined;
  if (resume.agent !== "claude-code" && resume.agent !== "codex") return undefined;
  if (typeof resume.sessionId !== "string" || !SESSION_UUID.test(resume.sessionId)) return undefined;

  const argv = resume.agent === "claude-code"
    ? ["claude", "--resume", resume.sessionId]
    : ["codex", "resume", resume.sessionId];

  let cwd: string | undefined;
  if (typeof resume.cwd === "string" && resume.cwd.length > 0 && path.isAbsolute(resume.cwd) && !/[\0\r\n]/.test(resume.cwd)) {
    try {
      if (dirExists(resume.cwd)) cwd = resume.cwd;
    } catch {
      cwd = undefined;
    }
  }

  const quotedArgv = argv.map(shellQuote).join(" ");
  const shellCommand = cwd ? `cd -- ${shellQuote(cwd)} && ${quotedArgv}` : quotedArgv;
  return { argv, cwd, shellCommand };
}

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
  tell application id "com.mitchellh.ghostty"
    focus (terminal id surfaceID)
    activate
  end tell
end run`;

const openOrReopenGhostty = `on run argv
  set surfaceID to item 1 of argv
  set workDir to item 2 of argv
  set resumeShellCmd to item 3 of argv
  if application id "com.mitchellh.ghostty" is running then
    tell application id "com.mitchellh.ghostty"
      if (exists (terminal id surfaceID)) then
        focus (terminal id surfaceID)
        activate
        return "focused:" & surfaceID
      end if
    end tell
  end if
  if resumeShellCmd is "" then error "原 Ghostty 分屏已关闭。"
  tell application id "com.mitchellh.ghostty"
    activate
    set cfg to new surface configuration
    if workDir is not "" then set initial working directory of cfg to workDir
    set initial input of cfg to resumeShellCmd & linefeed
    if (count of windows) > 0 then
      set t to new tab in front window with configuration cfg
      return "reopened:" & (id of focused terminal of t)
    else
      set w to new window with configuration cfg
      return "reopened:" & (id of focused terminal of selected tab of w)
    end if
  end tell
end run`;

const openOrReopenIterm = `on run argv
  set targetGuid to item 1 of argv
  set resumeShellCmd to item 2 of argv
  if application id "com.googlecode.iterm2" is running then
    tell application id "com.googlecode.iterm2"
      repeat with w in windows
        repeat with t in tabs of w
          repeat with s in sessions of t
            if id of s is targetGuid then
              select w
              select t
              select s
              activate
              return "focused:" & (id of s)
            end if
          end repeat
        end repeat
      end repeat
    end tell
  end if
  if resumeShellCmd is "" then error "原 iTerm2 分屏已关闭。"
  tell application id "com.googlecode.iterm2"
    activate
    if (count of windows) > 0 then
      set newTab to (create tab with default profile in current window)
      set newSession to current session of newTab
    else
      set newWin to (create window with default profile)
      set newSession to current session of newWin
    end if
    tell newSession to write text resumeShellCmd
    return "reopened:w0t0p0:" & (id of newSession)
  end tell
end run`;

const run: ExecFn = (file, args, cb) => execFile(file, args, { timeout: 15000 }, (error, stdout, stderr) => {
  const reason = stderr.trim() || error?.code || "系统未能打开目标。";
  cb(error ? new Error(String(reason).slice(0, 500)) : null, stdout);
});

function execAsync(exec: ExecFn, cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, args, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout ?? "");
    });
  });
}

export async function openOrReopenJumpTarget(
  target: JumpTarget,
  resume?: ResumeSpec,
  options: OpenJumpOptions = {},
): Promise<OpenJumpResult> {
  const exec = options.exec ?? run;
  const validatedResume = buildResumeCommand(resume, options.dirExists);

  if (target.kind === "rex") {
    const rexResult = await openOrReopenRexPane(
      target.session,
      target.id,
      validatedResume ? { argv: validatedResume.argv, cwd: validatedResume.cwd } : undefined,
      options.rexCli,
      options.rexExecute,
      options.rexSleep,
      reopened => {
        if (reopened.session !== target.session || reopened.id !== target.id) {
          options.onTargetUpdated?.({ kind: "rex", session: reopened.session, id: reopened.id });
        }
      },
    );
    const updatedTarget: JumpTarget | undefined =
      rexResult.reopened || rexResult.session !== target.session || rexResult.id !== target.id
        ? { kind: "rex", session: rexResult.session, id: rexResult.id }
        : undefined;
    if (updatedTarget) options.onTargetUpdated?.(updatedTarget);
    return {
      opened: true,
      ...(rexResult.reopened ? { reopened: true } : {}),
      ...(updatedTarget ? { updatedTarget } : {}),
    };
  }

  switch (target.kind) {
    case "claude-desktop":
      await execAsync(exec, "/usr/bin/open", ["-b", BUNDLE_IDS["claude-code"], `claude://claude.ai/epitaxy/${encodeURIComponent(target.id)}`]);
      return { opened: true };

    case "codex":
      await execAsync(exec, "/usr/bin/open", ["-b", BUNDLE_IDS.codex, `codex://threads/${target.id}`]);
      return { opened: true };

    case "ghostty": {
      const stdout = await execAsync(exec, "/usr/bin/osascript", [
        "-e",
        openOrReopenGhostty,
        target.id,
        validatedResume?.cwd ?? "",
        validatedResume ? validatedResume.shellCommand : "",
      ]);
      const trimmed = stdout.trim();
      if (trimmed.startsWith("reopened:")) {
        const newSurfaceId = trimmed.slice("reopened:".length).trim();
        const updatedTarget: JumpTarget | undefined = SESSION_UUID.test(newSurfaceId)
          ? { kind: "ghostty", id: newSurfaceId }
          : undefined;
        if (updatedTarget) options.onTargetUpdated?.(updatedTarget);
        return {
          opened: true,
          reopened: true,
          ...(updatedTarget ? { updatedTarget } : {}),
        };
      }
      return { opened: true };
    }

    case "iterm": {
      const guid = target.id.includes(":") ? target.id.split(":")[1] : target.id;
      if (!SESSION_UUID.test(guid)) {
        throw new Error("无效的 iTerm2 会话标识。");
      }
      const stdout = await execAsync(exec, "/usr/bin/osascript", [
        "-e",
        openOrReopenIterm,
        guid,
        validatedResume ? validatedResume.shellCommand : "",
      ]);
      const trimmed = stdout.trim();
      if (trimmed.startsWith("reopened:")) {
        const newPaneId = trimmed.slice("reopened:".length).trim();
        const match = /^w\d+t\d+p\d+:([\da-f-]+)$/i.exec(newPaneId);
        const updatedTarget: JumpTarget | undefined = match && SESSION_UUID.test(match[1])
          ? { kind: "iterm", id: newPaneId }
          : undefined;
        if (updatedTarget) options.onTargetUpdated?.(updatedTarget);
        return {
          opened: true,
          reopened: true,
          ...(updatedTarget ? { updatedTarget } : {}),
        };
      }
      return { opened: true };
    }
  }
}

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
