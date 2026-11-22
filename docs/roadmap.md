# 待办与路线图 · Light

本文档是 Light 尚未实现事项的**唯一待办清单**。

- 已完成的功能与修复在发布时归档至 [`docs/releases/`](releases/)，并同步进 [`docs/product.md`](product.md) 基线规格，不再保留在此处。
- 当前版本的机制边界与设计取舍见 [`docs/product.md` 第 12 节](product.md#12-已知限制与产品取舍)。

---

## 1. 下一版本重点（Next）

### 1.1 Subagent 生命周期与父子会话展示
- **事件接入**：接入 `SubagentStart`、`SubagentStop` 等子代理生命周期事件，识别子代理身份与所属主会话。
- **状态与进展隔离**：建立父子会话关联，避免后台子代理的工具调用直接混入主会话进展或误重置主会话计时；在胶囊和详情面板中清晰区分主会话与后台 Subagent 的运行状态及进展。
- **涉及模块**：`hooks/claude-hook.mjs`、`hooks/codex-hook.mjs`、`electron/state.ts`、`src/components/ExpandPanel.tsx`、`src/components/TaskProgress.tsx`。

---

## 2. 工程与平台积压（Backlog）

- **Windows 一键接入 Hook 资源路径对齐**：修复 `scripts/stage.mjs` 与 `electron/hookInstaller.ts` 在 Windows 打包产物中的 `hooks` 查找路径不一致问题（当前 staging 输出到 `release/Light/hooks`，而安装器查找 `resources/app/hooks`），让 Windows 安装版也能直接在「连接与诊断」中一键接入。
- **Windows 安装器版本号自动同步**：让 Inno Setup 构建流程从 `package.json` 自动注入或校验 `installer/light.iss` 的 `MyAppVersion`，消除发版时手动同步。
- **应用内基础设置**：提供超时收敛时长、本地监听端口与 macOS 开机自启动开关的轻量设置项。
- **macOS 签名、公证与标准 Release 流水线**：补齐 Apple Developer ID 签名与公证配置，完善跨平台构建与产物发布自动化。
- **Codex 原生会话生命周期评估**：跟进验证新版 Codex CLI 的 `SessionStart` / `SessionEnd` 稳定性与结束语义，评估替代 `codex-wrap` 进程包装脚本。

---

## 3. 远期探索（Later）

- **更多 Agent 接入与扩展机制**：支持更多本地 AI 编程工具适配器及自定义 Agent 注册。
- **可选的本地历史持久化**：在默认仅内存存储之外，提供受控、可选的本地会话历史保留能力。
- **长任务心跳机制**：改进长时间无工具调用阶段的活动信号，降低 4 分钟工作看门狗误收敛为 `idle` 的概率。
- **Linux 桌面适配与打包**：验证主流桌面环境下的透明置顶与点击穿透表现，提供正式安装包。

---

## 4. 明确不做（Non-goals）

- 微信、邮件、Slack、GitHub 等通用消息与通知中心聚合。
- 账号体系、云端状态同步、跨设备同步与远程审批。
- 终端复刻、模型完整输出展示与对话客户端能力。
