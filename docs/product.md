# 产品定义 · Light 桌面状态胶囊

| 项目 | 内容 |
|---|---|
| 产品版本 | 1.0.5 |
| 文档状态 | 当前实现基线 |
| 更新日期 | 2026-09-07 |
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
- 等待审批和错误必须比普通工作状态更醒目。
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

用户提交任务后切到其他应用。Light 显示工作时长与当前工具；任务结束时短暂显示完成态，然后自动回到空闲。

**场景 B：等待审批**

Agent 请求执行敏感命令，Light 以琥珀色显示“等待审批”。如果后续 Hook 丢失，等待状态最多保留一分钟，避免永久占据顶部优先级。

**场景 C：多 Agent / 多会话并行**

Claude Code 与 Codex 同时工作，或同一 Agent 存在多条会话。Light 分 Agent 展示数量和聚合状态，展开面板后可查看并移除单条会话。

**场景 D：跨屏工作**

用户把胶囊拖到目标显示器。Light 保存位置，并在显示器断开、分辨率变化、系统唤醒后修正到可见区域。

**场景 E：快速回看事件**

用户点击胶囊查看最近工具调用、审批请求和完成事件，并展开单条事件查看完整摘要。

## 5. 功能范围

| 模块 | 1.0.5 状态 | 说明 |
|---|---|---|
| 五态状态胶囊 | 已实现 | idle / working / waiting / done / error |
| Claude Code Hooks | 已实现 | 包含会话、任务、工具、审批、完成事件 |
| Codex 官方 Hooks | 已实现 | turn 级任务、工具、审批和完成事件 |
| Antigravity Hooks | 已实现 | 任务计时、工具完成记录、完成/出错；不接管工具权限 |
| 托盘一键安装 Hooks | 部分实现 | macOS 安装版可用；Windows staging 资源路径待修复 |
| 多 Agent / 多会话 | 已实现 | 独立状态、聚合展示、手动移除 |
| 事件流与详情 | 已实现 | 每会话缓存 30 条，面板聚合显示 14 条 |
| 拖动、位置记忆与多屏 | 已实现 | 托盘也可选择目标显示器 |
| 本地备忘录 | 已实现 | 最多 50 条，每条最多 200 字 |
| Windows 媒体控制 | 已实现 | 基于 SMTC；其他平台不提供 |
| macOS DMG | 已实现 | 默认未签名、未公证 |
| Windows 安装器 | 已实现 | staging + Inno Setup 流程 |
| Linux 安装包 | 未实现 | 仅可尝试源码运行 |
| 会话历史持久化 | 未实现 | 当前只保存在内存中 |

## 6. 功能需求

### 6.1 悬浮胶囊

- 窗口必须无边框、透明、始终置顶，并在所有工作区与全屏空间可见。
- 胶囊外区域必须尽量点击穿透，不干扰其下方应用。
- 无 Agent、无媒体内容时显示最小化 Light 标识。
- Hover 时展开任务摘要；点击时打开详情面板；拖动超过阈值时移动窗口而不是触发点击。
- 详情面板在失焦或鼠标离开热区约 1.5 秒后关闭。
- 状态颜色和动效必须一致，文字不应与状态点发生延迟或冲突。

### 6.2 状态模型

Light 支持五种会话状态：

| 状态 | 语义 | 主要视觉 |
|---|---|---|
| `idle` | 当前没有已知活动 | 灰色、静态 |
| `working` | Agent 正在处理任务或调用工具 | 蓝色呼吸/流光 |
| `waiting` | Agent 正在等待用户审批 | 琥珀色强调 |
| `done` | 一轮任务刚刚完成 | 绿色与勾选动画 |
| `error` | 会话报告错误 | 红色强调 |

事件转换规则：

| 事件 | 处理规则 |
|---|---|
| `session_start` | 创建/重置会话为 `idle`，清空工具、计时和任务摘要 |
| `session_end` | 立即删除对应会话及定时器 |
| `user_prompt` | 转为 `working`，更新任务摘要和开始时间 |
| `tool_use` | 转为 `working`，更新当前工具；缺少开始时间时补记 |
| `approval_request` | 转为 `waiting`，记录待审批工具；缺少开始时间时补记 |
| `tool_result` | 转为 `working`，清空当前工具，表示本轮仍未结束 |
| `stop` | 转为 `done`，清空当前工具 |
| `error` | 转为 `error`，清空当前工具 |
| `notification` | 保持当前状态，只追加事件 |

自动收敛规则：

| 当前状态 | 无新事件后的动作 |
|---|---|
| `waiting` | 60 秒后转为 `idle` |
| `working` | 4 分钟后转为 `idle` |
| `done` | 8 秒后转为 `idle` |
| `error` | 5 秒后转为 `idle` |
| `idle` | 最后活动 30 分钟后删除会话 |

任何后续有效事件都可以重新激活已经超时的会话。超时只表示“Light 最近没有收到新证据”，不代表 Agent 一定已经停止。

### 6.3 聚合与多会话

- 会话唯一键由 `agent + sessionId` 组成；缺失 session ID 时使用默认会话。
- Claude Code、Codex、Antigravity、Trae 的会话必须互不覆盖。
- 每个 Agent 可以同时存在多条会话，并显示会话数量、繁忙数量或待审批数量。
- 全局胶囊状态优先级为：`error > waiting > working > done > idle`。
- 同一 Agent 的代表会话优先选择待审批、工作中和最近活动的会话。
- 用户可以从详情面板手动移除任意会话；如果该会话之后再次上报事件，应以新序号重新出现。

### 6.4 详情面板与事件流

- 状态区展示 Agent 名称、会话序号、状态、工具与运行时长。
- 事件流合并所有可见会话并按时间倒序排列，最多展示 14 条。
- 点击事件后展示来源 Agent、事件类型、工具和消息详情。
- 每条会话在内存中最多保留最近 30 个事件。
- 用户可以清空事件流；该操作不应删除会话或改变当前状态。

### 6.5 Hook 接入

托盘必须提供“接入 Hooks...”入口，并满足：

- 向 `~/.claude/settings.json` 合并 Claude Code Hooks。
- 向 `~/.codex/hooks.json` 合并 Codex Hooks。
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
PostToolUse       -> tool_result
Stop              -> stop
```

Light 当前的 Codex 默认配置从 `UserPromptSubmit` 创建会话，尚未接入 Codex Session 生命周期事件；如需进程级检测，使用 `codex-wrap` 辅助脚本。

### 6.6 本地备忘录

- 用户可在详情面板输入文字并回车创建备忘录。
- 文本必须去除首尾空格并限制为 200 字。
- 最多保留 50 条；超限时优先移除最早已完成项，否则移除最早项。
- 勾选完成后提供短暂完成反馈，然后从列表删除。
- 备忘录以 JSON 文件保存在 Electron 用户数据目录，写入采用临时文件替换以降低损坏风险。

### 6.7 系统媒体

- Windows 通过 PowerShell bridge 读取 SMTC 媒体会话。
- 有有效标题时，胶囊显示歌曲与艺人；详情面板显示来源应用。
- 控制动作限制为上一首、下一首、播放、暂停和播放/暂停。
- Bridge 异常退出时应自动尝试重启。
- macOS 与 Linux 当前不展示系统媒体，不应在文档或 UI 中承诺跨平台支持。

### 6.8 窗口、托盘与多显示器

- 胶囊可以拖动，停止拖动后保存窗口坐标和目标显示器标识。
- 启动时优先恢复上次位置；位置无效时夹取到可见区域或居中。
- 显示器增加、移除、尺寸变化、系统恢复和解锁后重新校验位置。
- 托盘菜单提供显示/隐藏、安装 Hooks、切换显示器、端口信息和退出。
- Windows 安装器可选创建开机启动快捷方式；macOS 当前没有应用内开机启动开关。

## 7. 技术架构

```text
Claude Code Hooks ─┐
                   ├─ HTTP POST /event ─> Electron main ─> StateStore
Codex Hooks ───────┘        127.0.0.1          │              │
                                                │ IPC          │ timers
Windows SMTC bridge ─────────────────────────> SystemStore     │
                                                │              │
Local memo JSON <──────────────────────────── MemoStore        │
                                                │              │
                                                └──────> React renderer
                                                         胶囊 / 面板
```

### 7.1 技术栈

- Electron 30.5.1
- React 18、TypeScript、Vite
- Framer Motion
- Node.js 内置 HTTP、文件系统和事件模块
- Windows PowerShell bridge
- electron-builder（macOS DMG）
- Inno Setup（Windows 安装器）

### 7.2 进程边界

**Electron 主进程**负责：

- 本地 HTTP 服务与事件校验
- 会话状态、计时器、事件缓存
- 窗口、托盘、点击穿透、拖动和多屏定位
- Hook 安装与配置备份
- 备忘录持久化和 Windows bridge 生命周期

**Preload** 仅暴露明确的查询、订阅和动作 IPC，不向页面暴露通用 Node 能力。

**React 渲染层**负责胶囊、动画、详情面板、备忘录交互和媒体控件。

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
  "type": "session_start | session_end | user_prompt | tool_use | approval_request | tool_result | stop | notification | error",
  "sessionId": "optional string",
  "tool": "optional string",
  "message": "optional string",
  "timestamp": "optional ISO 8601 string"
}
```

服务端限制工具名为 80 字、消息为 400 字，并把用于展示的 session ID 规范化为短标识。

### 8.3 持久化边界

| 数据 | 是否持久化 | 位置/说明 |
|---|---|---|
| 会话状态与事件 | 否 | 仅内存；退出 Light 后清空 |
| 备忘录 | 是 | Electron `userData/memos.json` |
| 窗口位置 | 是 | Electron `userData/window-position.json` |
| Hook 配置 | 是 | Claude/Codex 用户配置目录 |
| Hook 调试日志 | 是，临时 | 系统临时目录中的 `light-hook.log` 等 |

## 9. 安全与隐私

- Light 不提供遥测、登录、云同步或远程服务。
- HTTP 服务绑定回环地址，外部设备无法直接访问。
- `contextIsolation` 开启，`nodeIntegration` 关闭。
- `/event` 中的命令和消息只作为文本处理，不传给 shell 执行。
- 媒体控制只接受固定动作枚举。
- Hook 配置安装采用追加策略，并在修改既有文件前备份。

当前风险：本机 HTTP API 没有鉴权，同机其他进程可以读取状态或伪造事件。Light 不应接收密码、访问令牌或其他敏感内容。未来若扩展到非回环地址，必须先加入认证、来源校验与传输加密。

## 10. 平台与发布

| 平台 | 当前发布方式 | 限制 |
|---|---|---|
| macOS | `npm run dist:mac` 生成 DMG | 默认按宿主架构构建；未签名、未公证 |
| Windows | `npm run dist` staging，再由 Inno Setup 编译 | 暂无公开 EXE；Inno 版本号需手动同步；托盘 Hook 安装路径待修复 |
| Linux | 源码运行 | 未完整验证，无正式安装包 |

版本号以 `package.json` 与 `package-lock.json` 为应用构建来源。发布 Windows 安装包时还需同步 `installer/light.iss`。

## 11. 验收标准

### 11.1 状态与 API

1. `GET /health` 返回成功，且服务只监听本机回环地址。
2. 有效 `user_prompt` 事件创建对应会话并进入 `working`。
3. `tool_use` 显示工具，`tool_result` 清空工具但保持 `working`。
4. `approval_request` 进入 `waiting`，60 秒无事件后回到 `idle`。
5. `stop` 显示 `done` 8 秒，`error` 显示 5 秒，然后回到 `idle`。
6. `working` 4 分钟无事件后回到 `idle`，空闲会话 30 分钟后删除。
7. `session_end` 立即删除会话；后续事件可以重新创建它。
8. 非法 Agent、非法事件类型和超过 32 KiB 的请求被拒绝。

### 11.2 UI 与多会话

1. Claude Code 与 Codex 同时上报时均可见，状态互不覆盖。
2. 同一 Agent 的多个 session ID 显示为不同会话。
3. 全局状态遵循错误、审批、工作、完成、空闲的优先级。
4. Hover 可读摘要，点击可开关面板，离开热区后自动关闭。
5. 事件可以展开详情，清空事件不改变状态，移除会话后界面立即更新。
6. 拖动后重启仍恢复位置；显示器变化后胶囊保持可见。

### 11.3 集成与发布

1. 托盘安装 Hook 不删除现有配置，并在需要修改时生成备份。
2. 重启并信任 Hook 后，Claude Code 与 Codex 的关键事件可到达 Light。
3. `npm run typecheck` 与 `npm run build` 通过。
4. macOS 构建生成带当前版本号的 DMG；Windows staging 包含渲染层、主进程、bridge 和 Hook 脚本。

## 12. 已知限制与产品取舍

- Hook 是状态事实来源；Hook 被拒绝、进程崩溃或 CLI 改变事件格式时，Light 只能依靠超时收敛。
- 一分钟审批超时和四分钟工作超时优先避免陈旧状态，代价是极长静默任务可能被提前显示为空闲。
- 会话和事件不持久化，降低了隐私与存储复杂度，但无法跨重启回看历史。
- Agent 级聚合会突出最紧急状态，旧会话在超时前可能暂时覆盖新会话的普通工作状态。
- macOS 未签名构建适合本地使用，不适合无提示公开分发。
- Windows 媒体通过系统媒体会话获得信息，播放器不接入 SMTC 时无法显示。

## 13. 后续路线

### 近期

- 为状态机、Hook 安装合并和多会话聚合补自动化测试。
- 让 Windows 安装器版本自动读取 `package.json`，消除手动同步。
- 完成 macOS 签名、公证和标准 Release 流程。
- 增加应用内版本与诊断信息，包括 Hook 最近成功时间。
- 提供超时时长、端口和开机启动的设置界面。

### 中期

- 增加更多 Agent 适配器和自定义 Agent 注册机制。
- 提供可选、受控的本地历史记录。
- 改进长任务心跳，降低看门狗误判。
- 完善 Linux 适配与安装包。

### 暂不承诺

- 微信、邮件、Slack、GitHub 等通用通知聚合
- 跨设备同步与远程审批
- Agent 输出全文与对话客户端能力
