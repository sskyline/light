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
- 进新窗口先敲 `/hooks` 确认这四项已注册；如有"信任此 hook"提示，确认放行。
- `claude-hook.mjs` 读取 Claude 通过 stdin 推来的 JSON（`session_id`、`tool_name`、`prompt`），提取后 POST 给 Light，并在 `%TEMP%\light-hook.log` 留一行调用日志（排错用）。
- Light 没启动时脚本静默退出，不会阻塞 Claude 的 hook 流水线。
- Mac / Linux 用 `claude-hook.sh`（`chmod +x`），命令写 `bash /path/claude-hook.sh user_prompt`。

## 2. Codex CLI

Codex CLI 当前没有官方 hooks。MVP 通过包装脚本实现：

**用法：** 把 `codex <args>` 换成 `codex-wrap.cmd <args>` 即可。

```cmd
codex-wrap.cmd "explain this repo"
```

它会在启动时推送 `session_start` + `user_prompt`，退出时推 `stop`（或 `error`）。

**进阶：** 给它做 alias / 加到 PATH，常用方式：

```powershell
# PowerShell profile
Set-Alias codex 'C:\path\to\light\hooks\codex-wrap.cmd'
```

后续若 Codex 推出官方 hooks，会改成与 Claude 一致的事件级上报。

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
