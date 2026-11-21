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

interface RexClient {
  client_id: string;
  connection_state: string;
  info?: { kind: string; platform: string };
  principal?: { transport: string };
}

export async function focusRexPane(session: string, block: string, cli = installedRexCli(), execute = run): Promise<boolean> {
  const rex = (...args: string[]) => execute(cli, ["--autostart=false", "--timeout", "4s", ...args]);
  const [inventory, location] = await Promise.all([
    rex("client", "ls", "--json"), rex("block", "inspect", block, "-s", session, "--json"),
  ]);
  const { clients } = JSON.parse(inventory) as { clients: RexClient[] };
  const local = clients.filter(c => c.info?.kind === "app" && c.info.platform === "macos" &&
    c.principal?.transport === "unix" && c.connection_state === "connected" && isRexId(c.client_id, "client"));
  if (local.length !== 1) throw new Error("无法唯一确定本机 Rex 客户端，请检查已连接的 Rex 窗口。");
  const info = JSON.parse(location);
  if (info.session_id !== session || info.block?.block_id !== block || !isRexId(info.block?.window_id, "window")) {
    throw new Error("原 Rex 分屏已关闭或不属于这条会话。");
  }
  const windowId: string = info.block.window_id;
  try {
    await rex("-C", local[0].client_id, "do", "session.select", "session_id=" + session, "window_id=" + windowId);
  } catch (error) {
    if (error instanceof Error && /turn on remote control|remote control is disabled/i.test(error.message)) {
      throw new Error("请在 Rex → Settings → Server 页底部的 Client Info 中开启 Remote Control，然后再点会话右侧的 ↗ 按钮。");
    }
    throw error;
  }
  await rex("block", "focus", block, "-s", session, "-w", windowId);
  await execute("/usr/bin/open", ["-b", "com.superlogical.rex"]);
  return true;
}
