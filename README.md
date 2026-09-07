# Light · 桌面状态胶囊

Light 是一个常驻桌面的 Electron 悬浮胶囊，通过 Claude Code、Codex CLI 与 Antigravity 的生命周期 Hooks，实时显示 AI 会话的工作、完成和出错状态；Claude Code 与 Codex 还支持等待审批状态。

当前版本：`1.0.5`。详细资料统一收录在 [docs/](docs/README.md)：包括 [产品定义](docs/product.md)、[Hooks 接入与排障](docs/hooks.md)和 [Windows 打包](docs/windows-packaging.md)。

## 能做什么

- 实时展示 `idle`、`working`、`waiting`、`done`、`error` 五种状态。
- 同时跟踪 Claude Code、Codex、Antigravity 和多个并发会话，按各工具支持的事件显示状态、工具记录与运行时长。
- 点击展开状态列表、最近事件流和事件详情；异常残留会话可以手动移除。
- 在托盘中一键把 Light Hooks 安全合并到 Claude Code、Codex 与 Antigravity 配置。
- 支持拖动胶囊、记住位置、切换显示器，并在显示器变化或系统唤醒后修正位置。
- 提供本地备忘录；Windows 还可显示并控制系统媒体播放。
- 所有状态通过 `127.0.0.1:51789` 在本机传递，不依赖云端服务。

## 界面与交互

```text
╭──────────────────────────────────────────────╮
│ ● Claude  工作中 · Edit  │ ● Codex  等待审批 │
╰──────────────────────────────────────────────╯
       hover 展开摘要 · click 打开详情 · drag 移动
```

状态颜色：

- 灰色：空闲 `idle`
- 蓝色：进行中 `working`
- 琥珀色：等待审批 `waiting`
- 绿色：完成 `done`
- 红色：错误 `error`

点击胶囊后可以查看：

- 每个会话的状态、编号、工具和持续时间
- 最近 14 条聚合事件；点击单条事件可展开来源、类型、工具和详情
- 本地备忘录
- Windows 当前媒体和上一首、播放/暂停、下一首控制

面板在鼠标离开后约 1.5 秒自动收起。拖动胶囊可以调整位置，位置会保存在本机。

## 平台支持

| 能力 | macOS | Windows | Linux |
|---|---:|---:|---:|
| 状态胶囊、Hooks、多会话、备忘录 | 支持 | 支持 | 源码运行，未完整验证 |
| 拖动与多显示器定位 | 支持 | 支持 | 未完整验证 |
| 系统媒体展示与控制 | 不支持 | 支持（SMTC） | 不支持 |
| 安装产物 | DMG | Inno Setup | 暂无 |

当前公开 Release 只提供 Apple Silicon (`arm64`) DMG，且未配置 Apple Developer ID 签名与公证。Windows 安装器代码已经具备，但目前需要从源码构建，可选创建桌面快捷方式和开机自启。

## 安装

### macOS

1. 打开 `Light-<version>-<arch>.dmg`。
2. 把 `Light.app` 拖入“应用程序”。升级时直接选择“替换”，不需要先卸载。
3. 启动 Light；未签名构建首次运行时可能需要在系统安全设置中确认。

### Windows

当前尚未发布 Windows EXE。需要在 Windows 上从源码构建；安装器默认安装到当前用户目录，不需要管理员权限，流程见 [Windows 打包与安装器](docs/windows-packaging.md)。

如果没有对应平台的 Release，可以按下文“开发与打包”从源码运行或构建。

## 接入 Claude Code、Codex 与 Antigravity

### 推荐：托盘一键接入（macOS 安装版）

1. 先把 Light 安装到本机并启动，不要直接从 macOS DMG 挂载盘配置 Hook。
2. 点击系统托盘中的 Light 图标，选择“接入 Hooks...”。
3. Light 会把 Hook 脚本复制到自己的用户数据目录，并安全合并到：
   - Claude Code：`~/.claude/settings.json`
   - Codex：`~/.codex/hooks.json`
   - Antigravity：`~/.gemini/config/hooks.json`
4. 如果原配置发生修改，Light 会先创建带时间戳的备份；已有安装器生成的 Hook 会更新到当前应用路径，自定义命令及其他 Hook 保持不变。
5. 完全重启 Claude Code / Codex，在 CLI 中执行 `/hooks`，确认并信任新增 Hook。
6. Antigravity 在新一轮对话加载配置；如果未生效，按原有启动方式完全退出并重新打开。

macOS 安装版使用 Electron 自身执行 Hook 脚本，因此不要求另外为 Hook 配置 Node 路径。当前 Windows staging 的 Hook 资源路径仍待修复，请先按手动方式接入。

从开发版升级到 DMG 安装版时，先退出开发版 Light，把新版拖入“应用程序”，启动后再点一次“接入 Hooks...”。安装器会将自己生成的开发版执行路径迁移到安装版，保留其他处理器、matcher 和禁用设置。

### 手动接入

需要 Windows 接入、项目级配置、自定义脚本路径、Codex 进程级包装或排查 Hook 日志时，请阅读 [Hooks 接入与排障](docs/hooks.md)。

Claude Code 使用 `SessionStart` 与 `SessionEnd` 管理会话。Light 当前的 Codex 默认配置从 `UserPromptSubmit` 开始上报，尚未接入 Codex 的 Session 生命周期事件；如需进程级检测，可使用 `hooks/codex-wrap.*`。

Antigravity 使用 `PreInvocation`、`PostToolUse` 和 `Stop`，支持任务计时、工具完成记录及完成/出错状态。当前不检测等待审批、执行中的工具或窗口关闭，也不采集 prompt。安装不会配置 VPN 或更改启动方式，详见 [Antigravity 接入说明](docs/hooks.md#3-antigravity)。

## 状态机

| 事件 | 状态变化 |
|---|---|
| `session_start` | 转为 `idle`，清空当前工具和任务计时 |
| `session_end` | 立即移除对应会话 |
| `user_prompt` | 转为 `working`，记录任务摘要和开始时间 |
| `tool_use` | 保持/转为 `working`，更新当前工具 |
| `approval_request` | 转为 `waiting`，显示待审批工具 |
| `tool_result` | 转为 `working`，清除当前工具 |
| `stop` | 转为 `done` |
| `error` | 转为 `error` |
| `notification` | 不改变状态，只写入事件流 |

自动收敛规则：

- `waiting` 1 分钟无新事件后转为 `idle`
- `working` 4 分钟无新事件后转为 `idle`
- `done` 展示 8 秒后转为 `idle`
- `error` 展示 5 秒后转为 `idle`
- 空闲会话最后一次活动 30 分钟后从列表回收

如果超时后又收到同一会话的新事件，状态会正常恢复。多个会话聚合展示时，整体状态优先级为 `error > waiting > working > done > idle`。

## 本地 HTTP API

Light 启动后监听 `127.0.0.1:51789`。

### 健康检查

```bash
curl http://127.0.0.1:51789/health
```

### 当前状态

```bash
curl http://127.0.0.1:51789/state
```

### 上报事件

```bash
curl -X POST http://127.0.0.1:51789/event \
  -H 'Content-Type: application/json' \
  -d '{"agent":"claude-code","type":"user_prompt","message":"Refactor auth middleware"}'
```

请求体：

```json
{
  "agent": "claude-code | codex | antigravity | trae",
  "type": "session_start | session_end | user_prompt | tool_use | approval_request | tool_result | stop | notification | error",
  "sessionId": "可选；区分同一 agent 的并发会话",
  "tool": "可选；工具名",
  "message": "可选；任务或事件摘要",
  "timestamp": "可选；ISO 8601 时间"
}
```

请求体上限为 32 KiB。服务端只接受已知 agent 与事件枚举；`tool` 和 `message` 仅用于状态推导与显示，不会作为命令执行。

## 开发

依赖：Node.js 18+、npm，以及当前平台可用的 Electron 运行环境。

```bash
npm install
npm run dev
```

常用命令：

| 命令 | 作用 |
|---|---|
| `npm run dev` | 启动 Vite 与 Electron 开发环境 |
| `npm run start` | 使用已有构建产物启动 Electron |
| `npm run typecheck` | 检查渲染层和主进程 TypeScript |
| `npm run build` | 构建渲染层与 Electron 主进程 |
| `npm run dist:mac` | 生成 macOS DMG 到 `release/mac/` |
| `npm run dist` | 在 Windows 上生成 Inno Setup 所需的 `release/Light/` 目录 |

### macOS 打包

```bash
npm run dist:mac
```

产物为 `release/mac/Light-<version>-<arch>.dmg`。创建 DMG 需要 macOS 的 `hdiutil`；未配置 Developer ID 时产物不会签名或公证。

### Windows 打包

在 Windows 上运行：

```bash
npm run dist
```

然后使用 Inno Setup 6 编译 `installer/light.iss`。发布前需要同步其中的 `MyAppVersion`；完整流程见 [Windows 打包与安装器](docs/windows-packaging.md)。

## 项目结构

```text
light/
├── electron/
│   ├── main.ts          # 窗口、托盘、拖动、多屏和 IPC
│   ├── state.ts         # 会话状态机与超时回收
│   ├── server.ts        # 127.0.0.1 HTTP API
│   ├── hookInstaller.ts # 托盘一键安装 Hooks
│   ├── memos.ts         # 本地备忘录持久化
│   ├── system.ts        # 系统媒体状态
│   ├── winbridge.ts     # Windows SMTC bridge
│   └── preload.ts       # 隔离的渲染层 IPC bridge
├── src/                 # React + Framer Motion 界面
├── hooks/               # Claude Code / Codex / Antigravity Hook 与包装脚本
├── bridge/              # Windows PowerShell 媒体桥接
├── installer/           # macOS/Windows 图标与 Inno Setup 配置
├── scripts/             # 开发启动和 Windows staging
├── docs/                # 产品、Hooks 与打包文档
└── package.json
```

## 数据、隐私与安全

- HTTP 服务只绑定回环地址 `127.0.0.1`，不会监听局域网或公网。
- 应用没有遥测、账号系统或云端状态同步。
- 会话状态和事件流仅保存在内存中，退出 Light 后清空。
- 备忘录与窗口位置保存在 Electron 用户数据目录；卸载应用通常不会自动删除这些文件。
- 渲染层启用 `contextIsolation` 且禁用 `nodeIntegration`，只通过受限 preload API 与主进程交互。
- `/event` 不执行请求中的命令文本；Windows 媒体控制只接受固定动作枚举。
- 本地 HTTP API 当前没有鉴权。同一台机器上的其他进程可以读取状态或伪造事件，不应向接口发送密码、令牌等敏感信息。

## 已知限制

- 状态准确性依赖 CLI Hook 是否触发、被信任并成功发送；异常退出可能缺少结束事件。
- 看门狗会把长时间没有事件的真实任务显示为空闲：审批 1 分钟、工作 4 分钟。
- Light 当前未接入 Codex Session 生命周期事件；进程级状态仍使用包装脚本兜底。
- 会话历史不持久化，事件流只保留每个会话最近 30 条，面板聚合展示最近 14 条。
- Windows 媒体能力不适用于 macOS/Linux。
- macOS DMG 默认未签名、未公证；Linux 暂无正式安装包。

## 许可

[MIT](LICENSE)
