# Hooks 接入说明

Light 通过本地 HTTP 服务（`127.0.0.1:51789`）接收状态事件。本目录提供两类接入脚本：

## 1. Claude Code

Claude Code 内置 hooks 机制。把以下内容合并到 `~/.claude/settings.json`（推荐 **node 直调 + 正斜杠路径**，规避 Windows 上 `.cmd`/shell 解析问题）：

把下面的 `<LIGHT_DIR>` 换成你本机 light 项目的绝对路径（正斜杠 `/` 在 Windows 上
node 也认，例如 `C:/Users/你的用户名/light`）：

```jsonc
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command",
        "command": "node <LIGHT_DIR>/hooks/claude-hook.mjs session_start" }] }
    ],
    "SessionEnd": [
      { "hooks": [{ "type": "command",
        "command": "node <LIGHT_DIR>/hooks/claude-hook.mjs session_end" }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command",
        "command": "node <LIGHT_DIR>/hooks/claude-hook.mjs user_prompt" }] }
    ],
    "PreToolUse": [
      { "matcher": "*", "hooks": [{ "type": "command",
        "command": "node <LIGHT_DIR>/hooks/claude-hook.mjs tool_use" }] }
    ],
    "PermissionRequest": [
      { "matcher": "*", "hooks": [{ "type": "command",
        "command": "node <LIGHT_DIR>/hooks/claude-hook.mjs approval_request" }] }
    ],
    "PostToolUse": [
      { "matcher": "*", "hooks": [{ "type": "command",
        "command": "node <LIGHT_DIR>/hooks/claude-hook.mjs tool_result" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command",
        "command": "node <LIGHT_DIR>/hooks/claude-hook.mjs stop" }] }
    ]
  }
}
```

`SessionStart`/`SessionEnd` 让 Claude Code 一开窗就显示"空闲"、关窗就消失。

**关键提醒：**

- 改完 `settings.json` 必须**彻底重启 Claude Code 进程**（不是切会话）才会重新读取。
- 进新窗口先敲 `/hooks` 确认这些 hook 已注册；如有"信任此 hook"提示，确认放行。
- `claude-hook.mjs` 读取 Claude 通过 stdin 推来的 JSON（`session_id`、`tool_name`、`prompt`），提取后 POST 给 Light，并在 `%TEMP%\light-hook.log` 留一行调用日志（排错用）。
- Light 没启动时脚本静默退出，不会阻塞 Claude 的 hook 流水线。
- Mac / Linux 用 `claude-hook.sh`（`chmod +x`），命令写 `bash /path/claude-hook.sh user_prompt`。

## 2. Codex CLI

Codex CLI 现在支持官方 lifecycle hooks。推荐用官方 hooks 接入，这样 Light 能在
**每一轮 Codex turn 结束**时收到 `Stop`，不会等到整个 Codex CLI 进程退出才变回
done。

### 推荐：Codex 官方 hooks

把 [codex-hooks.example.json](codex-hooks.example.json) 里的内容合并到：

```text
~/.codex/hooks.json
```

或者放到项目级：

```text
<LIGHT_DIR>/.codex/hooks.json
```

把里面的 `<LIGHT_DIR>` 换成本机 light 项目的绝对路径。Windows 上也建议用正斜杠
`/`，例如：

```text
C:/Users/你的用户名/light
```

配置后打开一个新的 Codex CLI，会提示 hook 需要审核。输入：

```text
/hooks
```

确认 `UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`PermissionRequest`、
`Stop` 已加载，并信任这些 hook。

这些事件会映射成 Light 事件：

| Codex hook | Light 事件 | 效果 |
|---|---|---|
| `UserPromptSubmit` | `user_prompt` | 创建会话、切到 working，并从这一刻开始计时 |
| `PreToolUse` | `tool_use` | 显示当前工具 |
| `PermissionRequest` | `approval_request` | 切到 waiting，提示返回审批 |
| `PostToolUse` | `tool_result` | 工具完成，清掉 waiting 并回到 working |
| `Stop` | `stop` | 本轮完成，显示 done |

Codex 官方 hooks 是 thread/turn 级事件，不是 CLI 进程级事件。只进入一个空 CLI 时
通常不会给 Light 任何事件；Light 从 `UserPromptSubmit` 开始创建会话并计时。

Codex 当前没有进程退出/窗口关闭 hook，所以打开 `/hooks` 时不会出现 `SessionEnd`。
本轮结束后，Light 会短暂展示 done/error，然后回到“空闲”。
旧配置里如果还保留 `SessionStart`，`codex-hook.mjs` 会直接忽略它，避免它和
`UserPromptSubmit` 连续触发时把 working 状态重置成 idle。

`codex-hook.mjs` 会在 `%TEMP%/light-codex-hook.log`（macOS/Linux 为系统临时目录）
记录调用和转发结果。若要排查 Codex 传入的原始 JSON，可临时设置：

```bash
LIGHT_HOOK_DEBUG=1
```

注意：原始 JSON 可能包含 prompt、命令或参数，只建议本机短时间排查时开启。

### 进程级检测：包装脚本

官方 hooks 能检测 turn 和工具调用，但当前没有进程退出 hook。如果要让 Light 在你
**刚打开 Codex 交互式壳子、还没发 prompt** 时就显示 Codex，并在退出 Codex 时立即移除，
把 `codex <args>` 换成 `codex-wrap.cmd <args>`。

```cmd
codex-wrap.cmd
codex-wrap.cmd "explain this repo"
```

无参数启动时，它只推送 `session_start`，表示 Codex 壳子已打开；真正发 prompt 后，
官方 `UserPromptSubmit` hook 会切到 working。退出时 wrapper 只推 `session_end`，
把会话直接从 Light 里移除，不再显示 done/error。

**进阶：** 给它做 alias / 加到 PATH，常用方式：

```powershell
# PowerShell profile
Set-Alias codex 'C:\path\to\light\hooks\codex-wrap.cmd'
```

包装脚本只感知 Codex CLI 进程生命周期。交互式 Codex 回答完后进程还在等待下一轮输入，
所以只有退出 Codex CLI 后才会收到 wrapper 的 `session_end`。如果使用包装脚本跑一次性
任务，建议用：

```cmd
codex-wrap.cmd exec "explain this repo"
```

## 3. 自定义环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `LIGHT_PORT` | `51789` | Light HTTP 端口（如改了主进程端口需同步） |
| `CODEX_BIN` | `codex` | Codex 二进制路径（PATH 里没有 codex 时用） |

## 4. 手动测试

不装 hook 也可以直接 POST 事件验证 Light 是否工作：

```powershell
$body = @{ agent = 'claude-code'; type = 'user_prompt'; message = 'hello' } | ConvertTo-Json
Invoke-RestMethod -Uri http://127.0.0.1:51789/event -Method POST -Body $body -ContentType 'application/json'
```
