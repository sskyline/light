import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const idPattern = /^(session|block|window|client):[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;

export function isRexId(value: unknown, kind: string): value is string {
  return typeof value === "string" && value.startsWith(kind + ":") && idPattern.test(value);
}

function installedRexCli(): string {
  for (const dir of ["/Applications", join(homedir(), "Applications")]) {
    for (const app of ["Rex.app", "Rex Beta.app"]) {
      const path = join(dir, app, "Contents/Helpers/Rex Server.rex/Contents/MacOS/rex");
      if (existsSync(path)) return path;
    }
  }
  throw new Error("未找到 Rex 应用内的命令行工具。");
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 5000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim().split("\n")[0] || "Rex 未能定位分屏。"));
      else resolve(stdout);
    });
  });
}

const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

interface RexClient {
  client_id: string;
  connection_state: string;
  info?: { kind: string; platform: string };
  principal?: { transport: string };
  session_ids?: string[];
}

export interface RexResumeCommand {
  argv: string[];
  cwd?: string;
}

export interface RexOpenResult {
  reopened: boolean;
  session: string;
  id: string;
}

function listLocalRexClients(inventory: string): RexClient[] {
  const { clients } = JSON.parse(inventory) as { clients?: RexClient[] };
  if (!Array.isArray(clients)) return [];
  return clients.filter(c => c.info?.kind === "app" && c.info.platform === "macos" &&
    c.principal?.transport === "unix" && c.connection_state === "connected" && isRexId(c.client_id, "client"));
}

async function selectRexSession(
  rex: (...args: string[]) => Promise<string>,
  clientId: string,
  session: string,
  windowId?: string,
): Promise<void> {
  const args = ["-C", clientId, "do", "session.select", "session_id=" + session];
  if (windowId) args.push("window_id=" + windowId);
  try {
    await rex(...args);
  } catch (error) {
    if (error instanceof Error && /turn on remote control|remote control is disabled/i.test(error.message)) {
      throw new Error("请在 Rex → Settings → Server 页底部的 Client Info 中开启 Remote Control，然后再点会话右侧的 ↗ 按钮。");
    }
    throw error;
  }
}

function isRexServerOfflineError(error: unknown): boolean {
  return error instanceof Error &&
    (/no rex server is running|autostart is disabled|connection refused|connect: no such file or directory/i.test(error.message));
}

function isClosedRexPaneError(error: unknown): boolean {
  return error instanceof Error && (/not found/i.test(error.message) || /原 Rex 分屏已关闭/.test(error.message));
}

function isMissingRexSessionError(error: unknown): boolean {
  return error instanceof Error && /session\b.*not found/i.test(error.message);
}

export async function openOrReopenRexPane(
  session: string,
  block: string,
  resume?: RexResumeCommand,
  cli = installedRexCli(),
  execute = run,
  sleep = defaultSleep,
  onPaneReopened?: (reopened: { session: string; id: string }) => void,
): Promise<RexOpenResult> {
  const rexNoAutostart = (...args: string[]) => execute(cli, ["--autostart=false", "--timeout", "4s", ...args]);
  const rexAutostart = (...args: string[]) => execute(cli, ["--autostart=true", "--timeout", "4s", ...args]);
  const hasResume = Boolean(resume && resume.argv.length > 0);

  let rex = rexNoAutostart;
  let launchedRexApp = false;
  let localClients: RexClient[] = [];

  try {
    const inventory = await rex("client", "ls", "--json");
    localClients = listLocalRexClients(inventory);
  } catch (error) {
    if (!hasResume || !isRexServerOfflineError(error)) throw error;
    rex = rexAutostart;
  }

  if (localClients.length > 1) {
    throw new Error("无法唯一确定本机 Rex 客户端，请检查已连接的 Rex 窗口。");
  }

  if (localClients.length === 0) {
    if (!hasResume) {
      throw new Error("无法唯一确定本机 Rex 客户端，请检查已连接的 Rex 窗口。");
    }
    await execute("/usr/bin/open", ["-b", "com.superlogical.rex"]);
    launchedRexApp = true;
    for (let attempt = 0; attempt < 25; attempt++) {
      if (attempt > 0) await sleep(200);
      try {
        const inventory = await rex("client", "ls", "--json");
        localClients = listLocalRexClients(inventory);
        if (localClients.length > 0) break;
      } catch (error) {
        if (rex === rexNoAutostart && isRexServerOfflineError(error)) {
          rex = rexAutostart;
          continue;
        }
        throw error;
      }
    }
    if (localClients.length !== 1) {
      throw new Error("无法唯一确定本机 Rex 客户端，请检查已连接的 Rex 窗口。");
    }
  }

  const client = localClients[0];

  // Always check whether the original block survived (even after relaunching Rex.app,
  // because Rex Server may have kept the original session & block alive in the background).
  let inspectError: unknown;
  try {
    const location = await rex("block", "inspect", block, "-s", session, "--json");
    const info = JSON.parse(location);
    if (info.session_id === session && info.block?.block_id === block && isRexId(info.block?.window_id, "window")) {
      const windowId: string = info.block.window_id;
      await selectRexSession(rex, client.client_id, session, windowId);
      await rex("block", "focus", block, "-s", session, "-w", windowId);
      if (!launchedRexApp) {
        await execute("/usr/bin/open", ["-b", "com.superlogical.rex"]);
      }
      return { reopened: false, session, id: block };
    }
    inspectError = new Error("原 Rex 分屏已关闭或不属于这条会话。");
  } catch (error) {
    inspectError = error;
  }

  if (!resume || resume.argv.length === 0 || !isClosedRexPaneError(inspectError)) {
    throw inspectError instanceof Error ? inspectError : new Error("原 Rex 分屏已关闭或不属于这条会话。");
  }

  let sessionExists = !isMissingRexSessionError(inspectError);
  if (sessionExists && Array.isArray(client.session_ids) && !client.session_ids.includes(session)) {
    try {
      const listRaw = await rex("ls", "--short=false", "--json");
      const { sessions } = JSON.parse(listRaw) as { sessions?: Array<{ session_id?: string }> };
      if (Array.isArray(sessions)) {
        sessionExists = sessions.some(s => s.session_id === session);
      }
    } catch {
      /* fall through and try running in session */
    }
  }

  const runFlags = ["--interactive", "--keep-open", ...(resume.cwd ? ["-c", resume.cwd] : []), "--json", "--", ...resume.argv];

  // Preflight Remote Control before spawning a new block whenever a target session
  // already exists: if Rex.app has Remote Control turned off, fail cleanly here
  // instead of leaving an unfocused duplicate resume pane behind.
  const preflightSession = sessionExists
    ? session
    : client.session_ids?.find(id => isRexId(id, "session"));
  if (preflightSession) {
    try {
      await selectRexSession(rex, client.client_id, preflightSession);
    } catch (error) {
      if (!isMissingRexSessionError(error)) throw error;
      if (preflightSession === session) sessionExists = false;
    }
  }

  const runInExistingSession = async (targetSession: string): Promise<RexOpenResult> => {
    const createdRaw = await rex("run", "-s", targetSession, ...runFlags);
    const created = (createdRaw ? JSON.parse(createdRaw) : {}) as { window_id?: string; block_ids?: string[] };
    const windowId = isRexId(created.window_id, "window") ? created.window_id : undefined;
    const newBlockId = Array.isArray(created.block_ids) && isRexId(created.block_ids[0], "block") ? created.block_ids[0] : undefined;
    if (newBlockId) {
      onPaneReopened?.({ session: targetSession, id: newBlockId });
    }
    await selectRexSession(rex, client.client_id, targetSession, windowId);
    if (windowId && newBlockId) {
      await rex("block", "focus", newBlockId, "-s", targetSession, "-w", windowId);
    }
    await execute("/usr/bin/open", ["-b", "com.superlogical.rex"]);
    return { reopened: true, session: targetSession, id: newBlockId ?? block };
  };

  if (sessionExists) {
    try {
      return await runInExistingSession(session);
    } catch (error) {
      if (!isMissingRexSessionError(error)) throw error;
    }
  }

  const fallbackSession = client.session_ids?.find(id => isRexId(id, "session"));
  if (fallbackSession) {
    return runInExistingSession(fallbackSession);
  }

  const createdRaw = await rex("new", ...runFlags);
  const created = (createdRaw ? JSON.parse(createdRaw) : {}) as {
    session_id?: string;
    initial_windows?: Array<{ window_id?: string; block_ids?: string[] }>;
  };
  const newSession = isRexId(created.session_id, "session") ? created.session_id : session;
  const firstWindow = created.initial_windows?.[0];
  const windowId = isRexId(firstWindow?.window_id, "window") ? firstWindow.window_id : undefined;
  const newBlockId = Array.isArray(firstWindow?.block_ids) && isRexId(firstWindow.block_ids[0], "block")
    ? firstWindow.block_ids[0]
    : undefined;
  if (newBlockId || newSession !== session) {
    onPaneReopened?.({ session: newSession, id: newBlockId ?? block });
  }
  await selectRexSession(rex, client.client_id, newSession, windowId);
  if (windowId && newBlockId) {
    await rex("block", "focus", newBlockId, "-s", newSession, "-w", windowId);
  }
  await execute("/usr/bin/open", ["-b", "com.superlogical.rex"]);
  return { reopened: true, session: newSession, id: newBlockId ?? block };
}

export async function focusRexPane(session: string, block: string, cli = installedRexCli(), execute = run): Promise<boolean> {
  await openOrReopenRexPane(session, block, undefined, cli, execute);
  return true;
}
