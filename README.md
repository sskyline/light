# Light

Light 是一个常驻菜单栏的原生 macOS 桌面状态胶囊。全量采用 Swift（SwiftUI + AppKit + Network.framework + SQLite3）构建，单进程零浏览器引擎、零 Node.js 运行时依赖，实时显示 Claude Code、Codex 和 Antigravity 的会话进展。

需要 macOS 14 或更新版本以及 Xcode Command Line Tools。在仓库根目录运行：

```sh
make run
```

日常开发使用 `make run`。它会启动 `.build/dev/Light.app`。代码、资源和工具链都相同时直接复用已有的 Debug 包。修改 Swift 代码后，在终端按 `Ctrl+C`，再运行一次 `make run`，SwiftPM 会增量编译。

或使用 SwiftPM / 脚本命令：

- `make test` — 增量编译后运行核心逻辑、HTTP 服务、SQLite 查询、终端导航与 `light-hook` 端到端测试。
- `make build`（或 `./scripts/build.sh release`）— 编译并打包 `release/macos/Light.app`（内置原生 `light-hook` CLI）。
- `make smoke`（或 `./scripts/smoke.sh`）— 启动 `Light.app --smoke-test`，验证浮窗渲染、`/health`、`/event`、`/state` 及内存占用。

点击菜单栏中的 Light 图标，选择「连接与诊断」即可一键接入 Hooks（将原生 `light-hook` 释放至 `~/Library/Application Support/Light/hooks/light-hook`，目标机器无需安装 Node.js）。展开桌面胶囊可查看工具活动和审批失败原因、固定会话或跳回原应用和终端。

[接入 Hooks](docs/hooks.md) · [产品说明](docs/product.md) · [MIT 许可](LICENSE)
