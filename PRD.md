# Light · 桌面灵动岛 PRD

> 一个常驻屏幕顶部的悬浮胶囊，实时展示 Claude Code 与 Codex CLI 的工作状态。
> 设计灵感：iPhone 灵动岛。

## 1. 背景与目标

日常用 Claude Code / Codex 编程时，agent 在终端里跑，用户切到浏览器或文档后无法立即感知它"还在干活"还是"已经停下来"。Light 提供一个屏幕顶部的胶囊状悬浮岛，远远一瞥就能知道 agent 的状态，无需切窗。

**MVP 不解决：** 微信、邮件、第三方应用通知聚合 —— 这些来源差异大、接入复杂，留给 v2。

## 2. 用户场景

- **场景 A：单 agent 跑长任务。** 用户启动 Claude Code 后切到浏览器查资料，胶囊保持"工作中"脉动；任务完成时胶囊短暂展开露出"✓ Done · 12s ago"，并伴随轻微动画。
- **场景 B：双 agent 并行。** Claude Code 和 Codex 同时在跑，胶囊分裂成左右两半，分别显示两个 agent 的状态；点击胶囊展开为详情面板。
- **场景 C：tool 调用瞬时反馈。** Claude Code 调 `Bash` 或 `Edit` 时，胶囊右侧短暂闪一下 tool 图标，让用户能感知"它在做事"而非卡死。

## 3. 功能需求（MVP）

### 3.1 状态展示（必做）

四种核心状态，对应不同颜色与动效：

| 状态 | 触发条件 | 视觉 |
|---|---|---|
| `idle` | 无 agent 活动，或最后一次 done 已超过 8 秒 | 暗灰胶囊，仅显示一个静态圆点 |
| `working` | 收到 `UserPromptSubmit` 后、`Stop` 之前 | 蓝色胶囊 + 呼吸光晕 + 当前 tool 名 |
| `done` | 收到 `Stop` 事件后的 8 秒内 | 绿色胶囊 + 一次性勾选动画 + "Done" 文字 |
| `error` | 收到 `error` 事件 | 红色胶囊 + 抖动动画 |

### 3.2 多 agent 支持（必做）

- 同时只显示 1 个胶囊，但内部分两栏（左 = Claude Code、右 = Codex），各自独立状态。
- 仅当某 agent 至少触发过一次事件后才显示该栏，避免无意义占位。

### 3.3 展开面板（必做）

- 鼠标 hover 胶囊 → 胶囊横向扩张，露出"当前任务摘要"（最近一次 UserPromptSubmit 的前 60 字）。
- 鼠标点击胶囊 → 向下展开为面板，显示：
  - 每个 agent 的当前状态与已运行时长
  - 最近 10 条事件流（tool 名 + 时间戳）
  - 一个"静音/隐藏"按钮
- 再次点击或鼠标离开 1.5s 后自动收起。

### 3.4 系统集成（必做）

- 开机随系统启动（提供开关，默认关）。
- 任务栏托盘图标，右键菜单：显示/隐藏、退出、关于。
- 窗口始终置顶，无边框、透明背景、不抢焦点（点击穿透除胶囊本体外的区域）。

### 3.5 提示音（可选）

- `done` 状态触发时播放一段 200ms 的短音（可在设置中关闭）。

### 3.6 不做（v1 排除）

- 通知中心、消息列表聚合（用户暂不知如何接入微信/邮件，留给 v2）。
- 跨设备同步。
- agent 输出全文展示（只展示状态摘要，不复刻终端）。

## 4. 技术架构

```
┌────────────────────────────────────────────────┐
│  Claude Code  ──hooks──┐                       │
│                        │                       │
│  Codex CLI    ──hooks──┼──> HTTP POST          │
│                        │    localhost:51789    │
│                        ▼                       │
│        ┌─────────────────────────┐             │
│        │  Light (Electron)       │             │
│        │  ┌────────────────────┐ │             │
│        │  │ Main Process       │ │             │
│        │  │  - HTTP server     │ │             │
│        │  │  - State manager   │ │             │
│        │  │  - Tray, window    │ │             │
│        │  └─────────┬──────────┘ │             │
│        │            │ IPC        │             │
│        │  ┌─────────▼──────────┐ │             │
│        │  │ Renderer (React)   │ │             │
│        │  │  - 灵动岛 UI       │ │             │
│        │  │  - Framer Motion   │ │             │
│        │  └────────────────────┘ │             │
│        └─────────────────────────┘             │
└────────────────────────────────────────────────┘
```

### 4.1 技术栈

- **Electron 30.5.1**（用户本地缓存已有，避免重新下载）
- **Vite + React 18 + TypeScript**（渲染层）
- **Framer Motion**（动画）
- **Node.js 内置 `http`**（不引入 express，减小依赖）
- **electron-builder**（v2 再做打包，MVP 只跑 dev）

### 4.2 进程划分

**主进程 `electron/main.ts`：**
- 启动 HTTP server 监听 `127.0.0.1:51789`
- 维护 `AgentStateMap`：`{ "claude-code": {...}, "codex": {...} }`
- 创建悬浮窗（`BrowserWindow`，`frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true`）
- 创建 Tray
- 把事件通过 `webContents.send('event', ...)` 推给渲染层

**预加载 `electron/preload.ts`：**
- 暴露 `window.light.onEvent(callback)` 与 `window.light.getState()`

**渲染进程 `src/`：**
- React 应用，订阅事件，渲染胶囊与展开面板

### 4.3 HTTP 协议

**端点：** `POST http://127.0.0.1:51789/event`

**请求体：**
```json
{
  "agent": "claude-code" | "codex",
  "type": "session_start" | "user_prompt" | "tool_use" | "stop" | "notification" | "error",
  "sessionId": "可选，区分多会话",
  "tool": "可选，tool_use 时填工具名",
  "message": "可选，文本摘要",
  "timestamp": "可选，ISO8601，缺省取服务端时间"
}
```

**响应：** `{ "ok": true }` 或 `{ "ok": false, "error": "..." }`

**状态机推导规则**（主进程维护）：

```
user_prompt    → working
tool_use       → working（更新 currentTool 字段）
stop           → done（8s 后自动转 idle）
error          → error（5s 后自动转 idle）
session_start  → idle（清空 currentTool）
notification   → 不改状态，仅插入事件流
```

### 4.4 钩子接入方案

**Claude Code（官方 hooks）：** 在 `~/.claude/settings.json` 配置：

```json
{
  "hooks": {
    "UserPromptSubmit": [{
      "matcher": "",
      "hooks": [{"type": "command", "command": "<light_post> user_prompt"}]
    }],
    "PreToolUse": [{
      "matcher": "",
      "hooks": [{"type": "command", "command": "<light_post> tool_use"}]
    }],
    "Stop": [{
      "matcher": "",
      "hooks": [{"type": "command", "command": "<light_post> stop"}]
    }],
    "Notification": [{
      "matcher": "",
      "hooks": [{"type": "command", "command": "<light_post> notification"}]
    }]
  }
}
```

其中 `<light_post>` 是 light 项目仓库里提供的 `hooks/claude-post.cmd`（Windows）或 `hooks/claude-post.sh`（Unix）脚本，内部调用 PowerShell `Invoke-RestMethod` 把 stdin 的 hook 数据转 POST 到 `http://127.0.0.1:51789/event`，并附带 `agent: "claude-code"`。

**Codex CLI：** 当前版本暂无统一 hooks。MVP 采用兜底方案：
- 启动后立即触发 `session_start`
- 退出时触发 `stop`
- 中间状态通过 watcher 监听 stdout 关键字（包装一个 `codex-wrap.cmd`）

提供 `hooks/codex-wrap.cmd <args>`，包装 codex 调用，简单地在开始和结束时上报状态。后续若 Codex 推出 hooks，再升级。

### 4.5 安全与隔离

- HTTP server 只监听 `127.0.0.1`，不对外暴露。
- 不接受任何会触发 shell 执行的事件字段。
- 窗口 `contextIsolation: true`、`nodeIntegration: false`。

## 5. UI 细节

### 5.1 胶囊形态

- 默认尺寸：宽 220px × 高 36px，圆角 18px。
- 屏幕顶部居中，距顶 10px。
- 背景：`rgba(20, 20, 22, 0.85)` + 8px 高斯模糊。
- 字体：系统默认 sans-serif，14px。
- 透明背景 + 阴影：`0 8px 24px rgba(0,0,0,0.35)`。

### 5.2 动效

- 状态切换：`spring(stiffness: 260, damping: 22)`。
- working 呼吸：`opacity 0.6 ↔ 1`，周期 1.6s。
- done 勾选：SVG path 描边动画，400ms。
- error 抖动：`x: [-4, 4, -3, 3, 0]`，250ms。
- hover 扩张：宽度从 220 → 340px，spring。

### 5.3 展开面板

- 从胶囊正下方展开，宽 360px、高自适应、最高 420px。
- 同样的暗背景 + 模糊。
- 内部分两栏（双 agent 时），单 agent 时撑满。
- 事件流用单色文字 + 时间戳，无滚动条样式。

## 6. 目录结构

```
light/
├── PRD.md
├── README.md
├── package.json
├── tsconfig.json
├── tsconfig.node.json
├── vite.config.ts
├── index.html
├── electron/
│   ├── main.ts          # 主进程入口
│   ├── preload.ts       # 预加载脚本
│   ├── server.ts        # HTTP server
│   ├── state.ts         # 状态机
│   └── tray.ts          # 托盘
├── src/
│   ├── main.tsx         # React 入口
│   ├── App.tsx          # 根组件
│   ├── components/
│   │   ├── Island.tsx       # 胶囊本体
│   │   ├── AgentPill.tsx    # 单 agent 子栏
│   │   ├── ExpandPanel.tsx  # 展开面板
│   │   └── icons.tsx        # 图标
│   ├── hooks/
│   │   └── useLightEvents.ts
│   ├── types.ts
│   └── styles.css
└── hooks/
    ├── claude-post.cmd      # Windows 转发脚本
    ├── claude-post.sh       # Unix 转发脚本
    ├── codex-wrap.cmd
    └── README.md            # 钩子安装说明
```

## 7. 验收标准（MVP）

1. `npm install && npm run dev` 能跑起来，屏幕顶部出现胶囊。
2. 用 `curl -X POST http://127.0.0.1:51789/event -d '{"agent":"claude-code","type":"user_prompt"}'` 能让胶囊切到 working 状态。
3. 发送 `stop` 事件后胶囊切到 done 状态，8s 后回到 idle。
4. 同时给 `claude-code` 与 `codex` 发事件，胶囊分裂为两栏。
5. hover 胶囊能看到当前任务摘要；点击展开能看到事件流。
6. 关闭终端、退出应用、重启都不丢配置。

## 8. 后续路线（v2+）

- 通知聚合：微信、邮件、Slack、GitHub PR
- 自定义 agent 接入（OpenAI、Cursor、其他 CLI）
- 历史记录持久化（SQLite）
- 多屏幕支持、可拖拽位置
- 打包发布（electron-builder）+ 自启
