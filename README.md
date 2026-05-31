# Light · 桌面状态胶囊

> 屏幕顶部常驻的悬浮胶囊，实时展示 Claude Code 与 Codex CLI 的工作状态。
> 磨砂玻璃质感，余光一瞥就知道 AI 在干活、做完了还是出错了，不用切窗口。

详细的产品设计见 [PRD.md](PRD.md)。

## 功能

- **状态一目了然**：工作中泛蓝光呼吸、完成变绿打勾、出错变红，还显示当前工具与用时。
- **多会话 / 多 agent**：Claude Code 与 Codex 同时跑也能分栏显示，互不打架。
- **顺手的小工具**：桌面备忘录、当前播放的音乐（可上一首 / 下一首 / 暂停）。
- **磨砂玻璃 UI**：任何壁纸下都清晰；鼠标移上去展开详情面板。
- **纯本地**：只监听 `127.0.0.1`，不联网、不上传任何数据。

## 下载安装（Windows）

去 [Releases](../../releases) 下载 `Light-Setup-x.y.z.exe`，双击安装即可
（按当前用户安装，免管理员、不弹 UAC）。

> 想自己从源码打包安装包？见 [installer/README.md](installer/README.md)。

## 截图（示意）

```
       ╭──────────────────────────────────╮
       │  ● Claude  Edit  │  ● Codex  idle │
       ╰──────────────────────────────────╯
              hover → 展开当前任务摘要
              click → 展开事件流面板
```

- `●` 灰：idle
- `●` 蓝（呼吸光晕）：working
- `●` 绿（勾选动画）：done
- `●` 红（抖动）：error

## 快速开始

依赖：Node 18+、Windows / macOS / Linux。

```bash
# 1. 装依赖（首次约 5 分钟，Electron 30.5.1 会优先用本地缓存）
npm install

# 2. 启动开发模式（Vite + Electron）
npm run dev
```

启动成功后，你的屏幕顶部中央会出现一个深色的胶囊条。把鼠标移上去会展开摘要，点击会展开事件面板。

## 验证一下没装 hook 时也能看到效果

打开一个新终端，发个测试事件：

```powershell
# Windows PowerShell
Invoke-RestMethod -Uri http://127.0.0.1:51789/event -Method POST -ContentType 'application/json' -Body (@{
  agent = 'claude-code'
  type = 'user_prompt'
  message = 'Refactor the auth middleware'
} | ConvertTo-Json)
```

```bash
# macOS / Linux
curl -X POST http://127.0.0.1:51789/event \
  -H "Content-Type: application/json" \
  -d '{"agent":"claude-code","type":"user_prompt","message":"Refactor the auth middleware"}'
```

胶囊会切换到蓝色 "working" 状态。再发 `{"agent":"claude-code","type":"stop"}` 会变绿，8 秒后回灰。

## 接入 Claude Code / Codex

见 [hooks/README.md](hooks/README.md)。

最关键的一步：把以下内容合并到你的 `~/.claude/settings.json`，并把 `<LIGHT_DIR>`
换成你本机 light 项目的绝对路径（Windows 上用正斜杠 `/` 即可，例如
`C:/Users/你的用户名/light`）：

```json
{
  "hooks": {
    "SessionStart":    [{ "hooks": [{ "type": "command", "command": "node <LIGHT_DIR>/hooks/claude-hook.mjs session_start" }] }],
    "SessionEnd":      [{ "hooks": [{ "type": "command", "command": "node <LIGHT_DIR>/hooks/claude-hook.mjs session_end" }] }],
    "UserPromptSubmit":[{ "hooks": [{ "type": "command", "command": "node <LIGHT_DIR>/hooks/claude-hook.mjs user_prompt" }] }],
    "PreToolUse":      [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node <LIGHT_DIR>/hooks/claude-hook.mjs tool_use" }] }],
    "Stop":            [{ "hooks": [{ "type": "command", "command": "node <LIGHT_DIR>/hooks/claude-hook.mjs stop" }] }]
  }
}
```

改完后**彻底重启 Claude Code 进程**才会生效。详见 [hooks/README.md](hooks/README.md)。

Codex 用 `hooks/codex-wrap.cmd` 包装调用（详见 hooks 文档）。

## 目录结构

```
light/
├── PRD.md                 # 产品需求文档
├── package.json
├── tsconfig.json          # 渲染层 TS 配置
├── tsconfig.electron.json # 主进程 TS 配置
├── vite.config.ts
├── index.html
├── scripts/
│   └── dev.mjs            # 开发启动脚本（先 Vite 后 Electron）
├── electron/              # 主进程（Node）
│   ├── main.ts            # 入口：窗口 / 托盘 / IPC
│   ├── preload.ts         # 安全 bridge
│   ├── server.ts          # 本地 HTTP 服务
│   └── state.ts           # 事件状态机
├── src/                   # 渲染层（React + Framer Motion）
│   ├── App.tsx
│   ├── main.tsx
│   ├── styles.css
│   ├── types.ts
│   ├── hooks/useLightEvents.ts
│   └── components/
│       ├── Island.tsx
│       ├── AgentPill.tsx
│       └── ExpandPanel.tsx
└── hooks/                 # 注入 Claude Code / Codex 的脚本
    ├── claude-hook.mjs    # Node 适配器
    ├── claude-hook.cmd    # Windows 入口
    ├── claude-hook.sh     # Unix 入口
    ├── codex-wrap.mjs     # Codex 包装
    ├── codex-wrap.cmd     # Windows 入口
    ├── settings.example.json
    └── README.md
```

## HTTP API

`POST http://127.0.0.1:51789/event`

```json
{
  "agent": "claude-code" | "codex",
  "type": "session_start" | "user_prompt" | "tool_use" | "stop" | "notification" | "error",
  "sessionId": "可选",
  "tool": "可选，PreToolUse 时填工具名",
  "message": "可选，文本摘要",
  "timestamp": "可选，ISO8601"
}
```

`GET /health` 健康检查；`GET /state` 拿当前状态（调试用）。

## 隐私与安全

- **纯本地运行**：HTTP 服务只绑定 `127.0.0.1`，不监听公网，外部机器无法访问。
- **不联网、不收集数据**：没有任何遥测 / 上报；备忘录只存在本机
  `%AppData%\light\memos.json`。
- **渲染层隔离**：`contextIsolation: true`、`nodeIntegration: false`，页面拿不到
  Node 能力。
- **不执行任意命令**：`/event` 只接收字符串字段用于显示，服务端不会据此执行 shell；
  媒体控制只接受固定的枚举动作。
- 本地端口 `51789` 无鉴权（按设计——只有本机程序能访问）。如果你介意同机其他程序
  往里发"假状态"，可自行加 token 校验。

## 状态机

| 事件 | 状态变化 |
|---|---|
| `session_start` | → `idle`，清空 currentTool |
| `user_prompt` | → `working`，记录 startedAt 与 lastPrompt |
| `tool_use` | → `working`，更新 currentTool |
| `stop` | → `done`，8 秒后自动转 `idle` |
| `error` | → `error`，5 秒后自动转 `idle` |
| `notification` | 不改状态，只入事件流 |

## 路线图

v1（当前）：状态展示、双 agent、hover/click 展开、事件流。
v2：通知聚合（微信 / 邮件 / Slack / GitHub）、打包发布、多屏支持。

## 已知限制

- Codex 还没正式 hooks，目前只能拿到 start / stop，中间 tool 调用看不到（用包装脚本兜底）。
- 仅在 Windows 11 上做过完整验证，macOS / Linux 的透明窗口表现可能有差异。
- 安装包通过 `npm run dist` + Inno Setup 生成（见 [installer/README.md](installer/README.md)）。

## 许可

[MIT](LICENSE)
