import type { LightEvent, SessionState } from "./types";

const FILE_ACTIONS: Record<string, string> = {
  read: "读取文件", read_file: "读取文件", view_file: "读取文件",
  edit: "编辑文件", multiedit: "编辑文件", replace_file_content: "编辑文件", multi_replace_file_content: "编辑文件",
  write: "写入文件", write_to_file: "写入文件",
};

function fileName(path: string): string | undefined {
  if (!path || /[\r\n<>{}|;]/.test(path)) return undefined;
  const leaf = path.trim().split(/[\\/]/).pop();
  return leaf && /^[\p{L}\p{N}._()@+ -]+$/u.test(leaf) ? leaf : undefined;
}

function shellAction(command: string): string {
  const program = command.match(/^(?:[\w./-]*\/)?([\w.-]+)(?=\s|$)/)?.[1];
  if (!program) return "运行命令";
  if (!/[;&|`$<>\r\n]/.test(command)) {
    if (/^git\s+status\b/.test(command)) return "查看 Git 状态";
    if (/^git\s+diff\b/.test(command)) return "查看代码差异";
    if (/^(?:npm|pnpm|yarn)\s+(?:run\s+)?test(?:\s|$)/.test(command)) return "运行测试";
    if (/^(?:npm|pnpm|yarn)\s+(?:run\s+)?build(?:\s|$)/.test(command)) return "构建项目";
    if (program === "rg" || program === "grep") return "搜索文件";
  }
  return `运行命令 · ${program}`;
}

function knownAction({ tool, message, toolTarget }: Pick<LightEvent, "tool" | "message" | "toolTarget">): string | undefined {
  const name = tool?.split(/\.|__/).pop()?.toLowerCase() || "";
  let input = message?.replace(/^completed: /, "").trim() || "";
  if (tool && input.startsWith(`${tool}: `)) input = input.slice(tool.length + 2);
  if (input === tool || /^(?:\S+ )?(?:completed|approval requested)$/.test(input)) input = "";
  const fileAction = Object.hasOwn(FILE_ACTIONS, name) ? FILE_ACTIONS[name] : undefined;
  if (fileAction) {
    const target = toolTarget ?? fileName(input);
    return target ? `${fileAction} · ${target}` : fileAction;
  }
  if (name === "apply_patch") {
    const path = input.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/m)?.[1];
    const target = path && fileName(path);
    return target ? `修改文件 · ${target}` : "修改文件";
  }
  if (["bash", "shell", "exec_command", "run_command", "powershell"].includes(name)) {
    if (toolTarget) {
      const action = shellAction(toolTarget).split(" · ")[0];
      return `${action} · ${toolTarget}`;
    }
    return shellAction(input);
  }
  if (["exec", "js", "python"].includes(name)) return "运行脚本";
  if (name === "grep" || name === "glob") return "搜索文件";
}

export function currentToolAction(session: SessionState): string | undefined {
  if (!session.currentTool) return undefined;
  // Notifications can arrive while a tool is running. Only use the latest
  // lifecycle event, so an earlier call to the same tool cannot supply its command.
  const event = session.recent.find((item) => item.type !== "notification");
  if (event && (event.type === "tool_use" || event.type === "approval_request") &&
      (event.tool ?? event.message) === session.currentTool) {
    return knownAction(event) ?? "调用工具";
  }
  return knownAction({ tool: session.currentTool }) ?? "调用工具";
}

export function toolActivityLabel(event: LightEvent): string {
  const action = knownAction(event);
  if (action) return action;
  const shortName = event.tool?.split(/__|\./).pop();
  return shortName && /^[\w-]+$/.test(shortName) ? `使用工具 · ${shortName}` : "工具操作";
}

export interface ActivityRow {
  key: string;
  event: LightEvent;
  call?: LightEvent;
}

// Each block belongs to one session and arrives newest first. Keep unpaired
// records visible, including a return whose call fell outside the history cap.
export function activityRows(events: LightEvent[]): ActivityRow[] {
  const rows: ActivityRow[] = [];
  const pending = new Map<string, { count: number; candidate?: ActivityRow }>();
  const occurrences = new Map<string, number>();
  for (const event of [...events].reverse()) {
    const identity = JSON.stringify([event.type, event.timestamp, event.toolCallId, event.tool, event.message]);
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    const row: ActivityRow = { key: identity + ":" + occurrence, event };
    const group = JSON.stringify([event.tool, event.toolCallId]);
    const outstanding = pending.get(group);
    if (event.type === "tool_use" && (event.tool || event.toolCallId)) {
      // Multiple legacy calls to the same tool are ambiguous until all return.
      pending.set(group, { count: (outstanding?.count ?? 0) + 1, candidate: outstanding ? undefined : row });
    } else if (event.type === "tool_result" && outstanding) {
      const candidate = outstanding.candidate;
      outstanding.count--;
      if (outstanding.count === 0) pending.delete(group);
      if (candidate && (event.toolCallId || (rows.at(-1) === candidate && compatibleLegacyCall(candidate.event, event)))) {
        rows.splice(rows.indexOf(candidate), 1);
        row.key = candidate.key;
        row.call = candidate.event;
      }
    }
    rows.push(row);
  }
  return rows.reverse();
}

function compatibleLegacyCall(call: LightEvent, result: LightEvent): boolean {
  const input = call.message?.trim();
  const output = result.message?.replace(/^completed: /, "").trim();
  return !input || !output || input === call.tool || output === `${result.tool} completed` || input === output;
}

export function activityRowLabel({ event, call }: ActivityRow): string {
  const label = toolActivityLabel(event);
  // Some adapters only provide the command or path on the call side.
  return call && (event.message?.startsWith("工具失败：") || label === toolActivityLabel({ ...event, message: undefined }))
    ? toolActivityLabel(call) : label;
}
