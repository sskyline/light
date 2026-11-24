# 产品定义 · Light 桌面状态胶囊

> 历史版本资料。当前分支的功能和运行方式见 [项目说明](../README.md)。

| 项目 | 内容 |
|---|---|
| 产品版本 | 1.1.1 |
| 文档状态 | 当前实现基线 |
| 更新日期 | 2026-11-22 |
| 支持对象 | Claude Code、Codex CLI、Antigravity；协议层兼容 Trae |
| 核心原则 | 一眼可见、安静常驻、本地优先 |

## 1. 产品定义

Light 是一个始终置顶的桌面悬浮胶囊。它接收本机 AI 编程工具的生命周期事件，把分散在不同终端和会话中的运行状态汇总成一个不抢焦点的桌面状态面板。

产品不是终端替代品，也不展示完整模型输出。Light 只回答几个高频问题：

- AI 还在工作吗？
- 是否正在等待我审批？
- 哪个工具正在运行？
- 哪一轮刚刚完成或出错？
- 多个 Agent、多条会话中，当前最需要关注的是哪一个？

## 2. 背景与问题

用户让 Claude Code 或 Codex 执行长任务后，通常会切到浏览器、文档或其他项目。此时需要反复切回终端，才能判断任务是否仍在执行、是否卡在审批，或者是否已经结束。

现有 CLI 的状态反馈存在三个问题：

1. 状态被限制在各自终端窗口内，跨窗口不可见。
2. 多 Agent、多会话并行时，用户难以快速判断哪个会话需要处理。
3. Agent 异常退出或 Hook 丢失时，最后一个状态可能长期残留。

Light 用统一事件协议、会话状态机和超时看门狗解决这些问题。

## 3. 产品目标与非目标

### 3.1 目标

- 用户无需切换窗口即可在一秒内判断 Agent 的整体状态。
- 错误比普通工作状态更醒目。普通审批请求静默处理，自动审批失败使用琥珀色提示。
- Claude Code 与 Codex 能通过官方 Hooks 自动上报关键生命周期事件。
- Antigravity 通过原生 Hooks 上报任务开始、工具完成、任务完成/出错；暂不检测等待审批和窗口关闭。
- 多条并发会话互相隔离，同时可聚合为 Agent 级与全局状态。
- 应用保持轻量、安静，不抢焦点，不把状态数据上传到云端。
- Hook 接入、升级和故障排查对普通用户足够简单。

### 3.2 非目标

- 不复刻终端，不展示完整对话、推理过程或命令输出。
- 不代替 Agent 自身的审批界面。
- 不提供账号系统、跨设备同步或远程控制。
- 不做通用通知中心，也不在当前版本聚合微信、邮件、Slack 等消息。
- 不保证从异常退出且未发送 Hook 的进程中还原精确生命周期。

## 4. 目标用户与核心场景

### 4.1 目标用户

- 同时使用 Claude Code、Codex 等 CLI Agent 的开发者。
- 会在多个终端或项目中并行执行长任务的用户。
- 希望减少切窗确认、但又不想接收频繁系统通知的用户。

### 4.2 核心场景

**场景 A：单会话长任务**

用户提交任务后切到其他应用。胶囊显示工作状态和时长，展开会话可查看当前工具；任务结束时短暂显示完成态，然后自动回到空闲。

**场景 B：等待审批**

普通审批请求沿用“工作中”，不计入工具活动。Claude Code 的 PermissionDenied、Codex 本地审核记录中的拒绝或超时、Antigravity 明确上报的自动安全检查失败会显示“自动审批失败”。没有新事件时，等待状态在一分钟后转为空闲。

**场景 C：多 Agent / 多会话并行**

Claude Code 与 Codex 同时工作，或同一 Agent 存在多条会话。Light 分 Agent 展示数量和聚合状态，展开面板后可查看并移除单条会话。

**场景 D：跨屏工作**

用户把胶囊拖到目标显示器。Light 保存位置，并在显示器断开、分辨率变化、系统唤醒后修正到可见区域。

**场景 E：快速回看事件**

用户点击胶囊查看各会话的进展，也可展开工具活动查看命令和审批记录。

## 5. 功能范围

| 模块 | 1.1.1 状态 | 说明 |
|---|---|---|
| 六态状态胶囊 | 已实现 | idle / working / waiting / auto_approval_failed / done / error |
| Claude Code Hooks | 已实现 | 包含会话、任务、工具、审批、自动审批失败、完成事件 |
| Codex 官方 Hooks | 已实现 | turn 级任务、工具、审批、完成、用户取消与本地审核拒绝关联 |
| Antigravity Hooks | 已实现 | 任务计时、工具完成记录、完成/出错；不接管工具权限 |
| 一键安装 Hooks | 部分实现 | macOS 安装版可在「连接与诊断」中一键接入；Windows 安装版当前使用手动配置 |
| 多 Agent / 多会话 | 已实现 | 独立状态、聚合展示、手动移除 |
| 任务进展与详情 | 已实现 | 每会话缓存 30 条事件。默认展开优先会话的最近一轮 |
| 拖动、位置记忆与多屏 | 已实现 | 托盘也可选择目标显示器 |
| 跳回与恢复会话 | 已实现 | macOS 上，点会话右侧的 ↗ 按钮可回到对应对话或终端分屏；若原 Rex/Ghostty/iTerm2 分屏已关闭且存在有效会话 ID，可在原终端自动新建分屏恢复该会话 |
| 会话固定与保留 | 已实现 | 会话行支持固定（图钉），免除 1 小时自动回收与 `session_end` 移除，并持久化到 `userData/pinned-sessions.json` |
| 目标应用安装探测 | 已实现 | macOS 探测目标桌面应用安装态，未安装时隐藏对应跳转入口；展开面板时按需刷新 |
| macOS DMG | 已实现 | 默认未签名、未公证 |
| Windows 安装器 | 已实现 | staging + Inno Setup 流程 |
| Linux 安装包 | 未实现 | 仅可尝试源码运行 |
| 全量历史持久化 | 未实现 | 默认未固定会话只保存在内存中；已固定会话持久化保留 |

## 6. 功能需求

### 6.1 悬浮胶囊

- 窗口必须无边框、透明、始终置顶，并在所有工作区与全屏空间可见。
- 胶囊外区域必须尽量点击穿透，不干扰其下方应用。
- 胶囊隐藏空闲会话。所有会话都空闲或没有会话时，显示最小化 Light 标识。
- 胶囊悬停时仅做轻量背景高亮，不弹出文字提示。点击 Agent 展开对应会话（面板已展开时点击其他 Agent 直接切换对应详情，点击当前 Agent 或空白处收起），拖动超过阈值时移动窗口。
- 详情面板靠近屏幕侧边时向内对齐。下方空间不足且上方更宽裕时向上展开，内容过长时在面板内滚动。
- 详情面板在失焦或鼠标离开热区约 1.5 秒后关闭。
- 状态颜色和动效必须一致，文字不应与状态点发生延迟或冲突。

### 6.2 状态模型

Light 支持六种会话状态：

| 状态 | 语义 | 主要视觉 |
|---|---|---|
| `idle` | 当前没有已知活动 | 灰色、静态 |
| `working` | Agent 正在处理任务或调用工具 | 浅灰色状态和用时文字 |
| `waiting` | Agent 正在等待普通审批 | 静默显示为工作中 |
| `auto_approval_failed` | 确认自动审批被拒绝或超时 | 琥珀色强调与未读提示点 |
| `done` | 一轮任务刚刚完成 | 绿色与勾选动画 |
| `error` | 会话报告错误 | 红色强调 |

事件转换规则：

| 事件 | 处理规则 |
|---|---|
| `session_start` | 创建/重置会话为 `idle`，清空工具、计时和任务摘要 |
| `session_end` | 未固定会话立即删除（若有未读自动审批失败则保留为 `idle`）；已固定会话转为 `idle` 并保留分屏与恢复上下文 |
| `user_prompt` | 转为 `working`，更新任务摘要和开始时间 |
| `tool_use` | 转为 `working`，更新当前工具；缺少开始时间时补记 |
| `approval_request` | 转为 `waiting`，记录待审批工具；缺少开始时间时补记 |
| `auto_approval_failed` | 转为 `auto_approval_failed`，清空当前工具并记入未读提示 |
| `tool_result` | 转为 `working`，清空当前工具，表示本轮仍未结束 |
| `stop` | 转为 `done`，清空当前工具 |
| `interrupt` | 用户取消本轮任务，立即转为 `idle`，清空当前工具和任务计时 |
| `error` | 转为 `error`，清空当前工具 |
| `notification` | 保持当前状态，只追加事件 |

自动收敛规则：

| 当前状态 | 无新事件后的动作 |
|---|---|
| `waiting` / `auto_approval_failed` | 60 秒后转为 `idle` |
| `working` | 4 分钟后转为 `idle` |
| `done` | 8 秒后转为 `idle` |
| `error` | 5 秒后转为 `idle` |
| `idle` | 未固定会话在最后活动 1 小时后删除；已固定会话免自动清理 |

任何后续有效事件都可以重新激活已经超时的会话。超时只表示“Light 最近没有收到新证据”，不代表 Agent 一定已经停止。

### 6.3 聚合与多会话

- 会话唯一键由 `agent + sessionId` 组成；缺失 session ID 时使用默认会话。
- Claude Code、Codex、Antigravity、Trae 的会话必须互不覆盖。
- 每个 Agent 可以同时存在多条会话。胶囊的会话数只统计非空闲会话，运行中和等待审批的会话都计入繁忙数量。
- 全局胶囊状态优先级为 `error > auto_approval_failed > (working / waiting) > done > idle`。
- 同一 Agent 的状态和标题取自优先级最高的会话。同一优先级内按会话首次接入的顺序显示，工具事件只更新对应会话的内容。
- 用户可以从详情面板手动移除会话。会话之后再次上报事件时可以重新出现。

### 6.4 详情面板与任务进展

- 会话列表在面板顶部，按状态优先级排列，展示会话标题、Agent 名称、状态与运行时长，展开后显示当前工具。空闲会话在列表下方单独分组（已固定会话置顶，同组按时间从近到远排列），默认展开，可手动收起。活动和空闲会话同时存在时，两组之间显示分隔线。
- 每条会话行右侧提供图钉固定按钮（未固定时静息隐藏、悬停/展开显现；固定后常驻暖金色高亮）。固定后的会话免除 1 小时自动回收与 `session_end` 清理，直至手动取消固定或从列表移除。
- 每张会话卡片只展示最近一轮进展。优先会话默认展开，其他会话默认折叠。
- 连续的工具活动合成一条，自动审批失败单独列出。展开后显示具体事件、工具与消息。
- 每条会话在内存中最多保留最近 30 个事件。
- 用户可以清空事件流；该操作不应删除会话或改变当前状态。

### 6.5 Hook 接入

托盘菜单与展开面板均提供「连接与诊断」入口，面板内支持一键“接入 Hooks”并满足：

- 向 `~/.claude/settings.json`（或 `CLAUDE_CONFIG_DIR/settings.json`）合并 Claude Code Hooks。
- 向 `~/.codex/hooks.json`（或 `CODEX_HOME/hooks.json`）合并 Codex Hooks。
- 向 `~/.gemini/config/hooks.json` 合并 Antigravity Hooks。
- 只追加缺失的 Light Hook，不覆盖其他 Hook。
- 修改已有配置前创建时间戳备份。
- 把适配脚本复制到 Light 用户数据目录，避免升级或 DMG 卸载后路径失效。
- 安装版使用 Electron 的 Node 模式运行脚本，不依赖用户额外配置 Node 可执行文件。
- 如果 Light 正从 macOS DMG 挂载盘运行，应要求用户先安装到 Applications。
- 安装完成后提示用户重启 CLI，并通过 `/hooks` 审核与信任配置。

Claude Code 映射：

```text
SessionStart      -> session_start
SessionEnd        -> session_end
UserPromptSubmit  -> user_prompt
PreToolUse        -> tool_use
PermissionRequest -> approval_request
PermissionDenied  -> auto_approval_failed
PostToolUse       -> tool_result
Stop              -> stop
```

Light 当前的 Codex 默认配置从 `UserPromptSubmit` 创建会话，尚未接入 Codex Session 生命周期事件；如需进程级检测，使用 `codex-wrap` 辅助脚本。

Codex 的 `Interrupt` 映射为 Light `interrupt`：用户中断活动轮次（如按 Esc）后立即回到空闲，保留会话及任务摘要，下次提问重新计时。该 hook 不在空闲会话或子代理上触发，超时为 3 秒。

### 6.6 窗口、托盘与多显示器

- 胶囊可以拖动，停止拖动后保存窗口坐标和目标显示器标识。
- 启动时优先恢复上次位置；位置无效时夹取到可见区域或居中。
- 显示器增加、移除、尺寸变化、系统恢复和解锁后重新校验位置。
- 托盘菜单提供版本号、显示/隐藏胶囊、移动到显示器（多屏时）、连接与诊断和退出。
- Windows 安装器可选创建开机启动快捷方式；macOS 当前没有应用内开机启动开关。

## 7. 技术架构

```text
Claude Code Hooks ─┐
Codex Hooks ───────┼─ HTTP POST /event ─> Electron main ─> StateStore
Antigravity Hooks ─┘        127.0.0.1          │              │
                                                │ IPC          │ timers
                                                └──────> React renderer
                                                         胶囊 / 面板
```

### 7.1 技术栈

- Electron 30.5.1
- React 18、TypeScript、Vite
- Framer Motion
- Node.js 内置 HTTP、文件系统和事件模块
- electron-builder（macOS DMG）
- Inno Setup（Windows 安装器）

### 7.2 进程边界

**Electron 主进程**负责：

- 本地 HTTP 服务与事件校验
- 会话状态、计时器、事件缓存
- 窗口、托盘、点击穿透、拖动和多屏定位
- Hook 安装、配置备份与连接诊断
- macOS 会话跳转与目标应用安装态探测

**Preload** 仅暴露明确的查询、订阅和动作 IPC，不向页面暴露通用 Node 能力。

**React 渲染层**负责胶囊、动画和详情面板。

## 8. 本地协议与数据模型

### 8.1 端点

| 方法与路径 | 用途 |
|---|---|
| `GET /health` | 进程健康检查 |
| `GET /state` | 获取当前内存状态，供调试使用 |
| `POST /event` | 上报 Agent 生命周期事件 |

服务只监听 `127.0.0.1:51789`，单个请求体上限 32 KiB。

### 8.2 事件格式

```json
{
  "agent": "claude-code | codex | antigravity | trae",
  "type": "session_start | session_end | user_prompt | tool_use | approval_request | auto_approval_failed | tool_result | stop | interrupt | notification | error",
  "sessionId": "optional string",
  "cwd": "optional absolute path string",
  "tool": "optional string",
  "message": "optional string",
  "timestamp": "optional ISO 8601 string"
}
```

服务端限制工具名为 80 字、消息为 400 字，并把用于展示的 session ID 规范化为短标识。

### 8.3 持久化边界

| 数据 | 是否持久化 | 位置/说明 |
|---|---|---|
| 未固定会话状态与事件 | 否 | 仅内存；退出 Light 后清空 |
| 已固定会话及恢复上下文 | 是 | Electron `userData/pinned-sessions.json`（取消固定或手动移除时清除） |
| 窗口位置 | 是 | Electron `userData/window-position.json` |
| Hook 配置 | 是 | Claude/Codex/Antigravity 用户配置目录与 Light `userData/hooks` |
| Hook 调试日志 | 是，临时 | 系统临时目录中的 `light-hook.log` 等 |

## 9. 安全与隐私

- Light 不提供遥测、登录、云同步或远程服务。
- HTTP 服务绑定回环地址，外部设备无法直接访问。
- `contextIsolation` 开启，`nodeIntegration` 关闭。
- `/event` 中的命令和消息只作为文本处理，不传给 shell 执行。
- Hook 配置安装采用追加策略，并在修改既有文件前备份。

当前风险：本机 HTTP API 没有鉴权，同机其他进程可以读取状态或伪造事件。Light 不应接收密码、访问令牌或其他敏感内容。未来若扩展到非回环地址，必须先加入认证、来源校验与传输加密。

## 10. 平台与发布

| 平台 | 当前发布方式 | 限制 |
|---|---|---|
| macOS | `npm run dist:mac` 生成 DMG | 默认按宿主架构构建；未签名、未公证 |
| Windows | `npm run dist` staging，再由 Inno Setup 编译 | 暂无公开 EXE；Inno 版本号需手动同步；Windows 安装版当前需手动配置 Hook |
| Linux | 源码运行 | 未完整验证，无正式安装包 |

版本号以 `package.json` 与 `package-lock.json` 为应用构建来源。发布 Windows 安装包时还需同步 `installer/light.iss`。

## 11. 验收标准

### 11.1 状态与 API

1. `GET /health` 返回成功，且服务只监听本机回环地址。
2. 有效 `user_prompt` 事件创建对应会话并进入 `working`。
3. `tool_use` 显示工具，`tool_result` 清空工具但保持 `working`。
4. `approval_request` 进入 `waiting`，60 秒无事件后回到 `idle`。
5. `stop` 显示 `done` 8 秒，`error` 显示 5 秒，然后回到 `idle`。
6. `working` 4 分钟无事件后回到 `idle`，空闲会话在最后一次活动 1 小时后删除。
7. `session_end` 立即删除会话；后续事件可以重新创建它。
8. 非法 Agent、非法事件类型和超过 32 KiB 的请求被拒绝。

### 11.2 UI 与多会话

1. Claude Code 与 Codex 同时上报时均可见，状态互不覆盖。
2. 同一 Agent 的多个 session ID 显示为不同会话。
3. 错误优先显示，其次是自动审批失败，工作和等待审批同级，最后是完成和空闲。
4. 悬停胶囊仅高亮不弹出文字，点击可开关面板（点击不同 Agent 切换对应详情），离开热区后自动关闭。
5. 事件可以展开详情，清空事件不改变状态，移除会话后界面立即更新。
6. 拖动后重启仍恢复位置；显示器变化后胶囊保持可见。

### 11.3 集成与发布

1. 托盘安装 Hook 不删除现有配置，并在需要修改时生成备份。
2. 重启并信任 Hook 后，Claude Code、Codex 与 Antigravity 的关键事件可到达 Light。
3. `npm run typecheck` 与 `npm run build` 通过。
4. macOS 构建生成带当前版本号的 DMG；Windows staging 包含渲染层、主进程和 Hook 脚本。

## 12. 已知限制与产品取舍

- Hook 是状态事实来源；Hook 被拒绝、进程崩溃或 CLI 改变事件格式时，Light 只能依靠超时收敛。
- 一分钟审批超时和四分钟工作超时用于清理陈旧状态。长时间没有上报事件的任务可能提前从胶囊隐藏。
- 默认未固定会话和事件不持久化，降低了隐私与存储复杂度；仅被用户主动固定的会话会保存在本地 `pinned-sessions.json` 中以便跨重启跟进与恢复拉起。
- Agent 级聚合会突出最紧急状态，旧会话在超时前可能暂时覆盖新会话的普通工作状态。
- macOS 未签名构建适合本地使用，不适合无提示公开分发。

## 13. 后续路线

未实现功能、工程积压与演进计划统一维护在 [待办与路线图](roadmap.md)，本文档仅记录当前已落地的产品基线。
