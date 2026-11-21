# Hooks 接入与排障

Light 通过本地 HTTP 服务（`127.0.0.1:51789`）接收状态事件。本目录提供三类接入脚本：

在「连接与诊断」中点「接入 Hooks」或「重新接入」，即可同步适配器和 `terminal-source.mjs`。手动复制脚本时，建议将 `terminal-source.mjs` 放在适配器旁边以启用终端分屏定位（若遗漏该文件，Hook 仍能正常上报状态事件，仅降级略过分屏标识；通过软链调用 `.sh` 或 `.mjs` 脚本时也会自动按真实路径查找）。

在 Light 中，点会话标题或左侧箭头可以展开或收起进展。macOS 上，iTerm2 和 Ghostty 的新版 Hook 会随新事件上报可用的分屏标识。会话右侧出现 ↗ 时，点它可以回到原分屏。首次跳转到 Ghostty 时，macOS 可能请求自动化权限。

在本机 Rex 分屏中运行 Claude Code 或 Codex 时，Hook 读取 `REX_SESSION` 和 `REX_BLOCK`。Light 通过 Rex 自带的 CLI 选择对应标签页并聚焦原分屏。请在 Rex → Settings → Server 页底部的 Client Info 中启用 Remote Control，然后点 Light 会话右侧的 ↗ 按钮。嵌套 tmux、screen 或 SSH 的会话不使用外层 Rex 分屏标识。

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
    "PermissionDenied": [
      { "matcher": "*", "hooks": [{ "type": "command",
        "command": "node <LIGHT_DIR>/hooks/claude-hook.mjs auto_approval_failed" }] }
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

`SessionStart` 创建空闲会话。会话开始工作后会出现在胶囊里，`SessionEnd` 会移除会话。

**关键提醒：**

- 改完 `settings.json` 必须**彻底重启 Claude Code 进程**（不是切会话）才会重新读取。
- 进新窗口先敲 `/hooks` 确认这些 hook 已注册；如有"信任此 hook"提示，确认放行。
- `claude-hook.mjs` 读取 Claude 通过 stdin 推来的 JSON（`session_id`、`tool_name`、`prompt`），提取后 POST 给 Light，并在 `%TEMP%\light-hook.log` 留一行调用日志（排错用）。
- Light 没启动时脚本静默退出，不会阻塞 Claude 的 hook 流水线。
- macOS / Linux 也可以直接使用上面的 `node .../claude-hook.mjs`；如需 shell 入口，可使用 `claude-hook.sh`（先 `chmod +x`）。

## 2. Codex

Codex CLI 现在支持官方 lifecycle hooks。推荐用官方 hooks 接入，这样 Light 能在
**每一轮 Codex turn 结束**时收到 `Stop`，不会等到整个 Codex CLI 进程退出才变回
done。

### 推荐：Codex 官方 hooks

把 [Codex Hooks 示例](../hooks/codex-hooks.example.json) 里的内容合并到：

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
`Stop`、`Interrupt` 已加载，并信任这些 hook。

这些事件会映射成 Light 事件：

| Codex hook | Light 事件 | 效果 |
|---|---|---|
| `UserPromptSubmit` | `user_prompt` | 创建会话、切到 working，并从这一刻开始计时 |
| `PreToolUse` | `tool_use` | 显示当前工具 |
| `PermissionRequest` | `approval_request` | 静默等待审批，显示为工作中，1 分钟无新事件转 idle |
| `PostToolUse` | `tool_result` | 工具完成，清掉 waiting 并回到 working |
| `Stop` | `stop` | 本轮完成，显示 done |
| `Interrupt` | `interrupt` | 用户中断当前轮次，立即回到 idle，清除工具和计时 |

按 Esc 取消正在运行的 Codex 轮次时，通过 `Interrupt` 上报取消事件；会话保留，
下一次真实提问重新开始计时。该 hook 只在主会话的活动轮次被中断时运行，空闲时按 Esc
不会触发，也不用于子代理。脚本静默退出，不阻止取消或重新启动任务，超时配置为 3 秒。
已有安装需要用新版 Light 在「连接与诊断」中重新接入一次 Hooks，重启 Codex 并审核、信任新增 hook。
参考：[OpenAI 官方 Hooks 文档](https://learn.chatgpt.com/docs/hooks#interrupt)。

Codex 适配器会上报当前轮次 ID。Light 通过只读 sqlite3 按会话和轮次读取本机 `state_5.sqlite` 的 Guardian 审核结论；确认拒绝或自动审核超时才提示，原因可在进展中查看。需要该版本 Codex 写入审核记录且系统有 sqlite3。数据库缺失或结构不兼容时，常规 Hook 继续工作。

Light 当前的 Codex 默认配置以 turn 事件为主，只进入一个空 CLI 时通常不会创建
Light 会话；会话从 `UserPromptSubmit` 开始计时，本轮结束后短暂展示 done/error，
然后回到“空闲”。

适配器会忽略以 `This is an app-generated request for a suggested next user message.
The user did not write this message.` 开头的输入框建议后台请求，以及同一轮次的后续工具
和结束事件，避免生成虚假会话。正常用户消息（包括在正文中引用这段说明）照常转发。

`codex-cli 0.146.0` 已能触发 `SessionStart`，并声明了 `SessionEnd` 事件，但 Light 当前
尚未把它们加入默认安装配置。适配器会忽略 `SessionStart`，`SessionEnd` 的实际结束语义
仍需验证。因此这里不把它们作为稳定的进程生命周期能力承诺。

`codex-hook.mjs` 会在 `%TEMP%/light-codex-hook.log`（macOS/Linux 为系统临时目录）
记录调用和转发结果。若要排查 Codex 传入的原始 JSON，可临时设置：

```bash
LIGHT_HOOK_DEBUG=1
```

注意：原始 JSON 可能包含 prompt、命令或参数，只建议本机短时间排查时开启。

### 进程级检测：包装脚本

要让 Light 在 Codex CLI 进程退出时立即移除会话，把 `codex <args>` 换成
`codex-wrap.cmd <args>`。

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

## 3. Antigravity

支持 Antigravity 原生 lifecycle hooks，已在 macOS Antigravity 2.12.2 上验证。
「连接与诊断」中的“接入 Hooks”会合并配置，也可以把 [配置示例](../hooks/antigravity-hooks.example.json)
中的 `<LIGHT_DIR>` 换成本机 Light 项目的绝对路径后，合并到：

```text
~/.gemini/config/hooks.json
```

项目级配置可以放在 `<项目目录>/.agents/hooks.json`。全局和项目级任选一处，避免重复上报。
需要手动运行脚本时使用 `node "<LIGHT_DIR>/hooks/antigravity-hook.mjs" <事件名>`。

Antigravity 的 JSON 顶层是具名 hook（示例为 `light-antigravity`），不是 Claude/Codex
的 `hooks` 字段。`PreInvocation` 和 `Stop` 使用平铺的处理器数组，`PostToolUse` 使用
`matcher` / `hooks` 包装。托盘安装会保留其他 hook、已有处理器及 `enabled: false` 设置，
重复安装会补齐缺少的事件，并把安装器生成的旧执行路径更新到当前 Light 应用。
自定义包装命令不会被替换；配置无法解析时会报错并保留原文件。

| Antigravity hook | Light 事件 | 效果 |
|---|---|---|
| `PreInvocation`，`invocationNum = 0` | `user_prompt` | 开始本轮任务、从零计时 |
| `PreInvocation`，`invocationNum > 0` | `tool_result` | 继续 working，保留本轮计时 |
| `PostToolUse` | `tool_result` | 记录已完成的工具，继续 working |
| `Stop`，无错误且 `fullyIdle` 不为 false | `stop` | 本轮完成，显示 done |
| `Stop`，`fullyIdle = false` 且无错误 | `tool_result` | 后台仍有工作，暂不显示完成 |
| `Stop`，非空 `error` 或原因是 `ERROR` | `error` | 本轮异常，显示 error |

`conversationId` 用于区分会话；每轮 `invocationNum` 从 0 开始，避免工具调用后的模型
循环反复重置计时。工具自身的错误写入事件详情，由后续 `Stop` 决定整个任务是否失败。
Antigravity 的 `PostToolUse.error` 或 `Stop.error` 明确上报自动安全检查失败或内置 Mango / Remy 策略阻断时，Light 记录自动审批失败。只有普通运行错误、手动拒绝或缺少原因时，不会推断自动审批结论。

`PostToolUse` 从 `toolCall.args` 提取读写、编辑操作的文件名，或命令的简短摘要，例如「编辑文件 · main.ts」「运行测试 · npm test」。缺少这些参数时仍可按工具名显示，工具失败原因可在详情中查看。

**接入范围：**

- 默认不注册 `PreToolUse`：它的返回值参与权限控制，实测空对象也可能影响工具执行；
  不要把此适配器挂到该事件，更不要为状态采集返回自动授权的 `allow`。
- 不注册 `PostInvocation`：模型调用结束不等于整个任务完成。
- 没有独立的等待审批、会话打开/关闭事件，不能准确显示这些状态，也不显示执行中的工具。
  完成/出错后按 Light 的通用规则回到空闲，长期空闲会话自动回收。
- 文件操作只上报文件名；命令只上报程序名或简短子命令。文件内容、完整命令行和原始参数不进入活动记录。
- 标准输出始终是 `{}`，不注入步骤或强制继续；Light 离线、输入异常或传输超时均正常退出。
  接入脚本的网络等待最多 800ms，安装配置的总超时为 3 秒。

日志位于系统临时目录下的 `light-antigravity-hook.log`，只记录事件类型和转发状态，
不记录原始输入。配置会在新一轮对话加载；未生效时按原有方式重启 Antigravity。
需要代理的用户继续使用原来的代理启动方式，Hook 安装不修改 VPN、`.zshrc` 或应用启动配置。

参考：[Antigravity 官方 Hooks 文档](https://antigravity.google/docs/hooks)。

## 4. 自定义环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code 自定义配置目录；Light 的连接诊断、一键接入与标题读取同步使用 |
| `CODEX_HOME` | `~/.codex` | Codex 自定义主目录；Light 的连接诊断、一键接入、标题读取与审核关联同步使用 |
| `LIGHT_PORT` | `51789` | 仅改变 Hook/包装脚本的目标端口；Light 主进程当前固定监听 51789，通常不要修改 |
| `CODEX_BIN` | `codex` | Codex 二进制路径（PATH 里没有 codex 时用） |

## 5. 手动测试

不装 hook 也可以直接 POST 事件验证 Light 是否工作：

```powershell
$body = @{ agent = 'claude-code'; type = 'user_prompt'; message = 'hello' } | ConvertTo-Json
Invoke-RestMethod -Uri http://127.0.0.1:51789/event -Method POST -Body $body -ContentType 'application/json'
```
