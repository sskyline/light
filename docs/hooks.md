# Hook 接入与排障

启动 Light，从菜单栏打开「连接与诊断」，点击「接入 Hooks」。安装器会将内置的原生 `light-hook` 可执行文件释放到 `~/Library/Application Support/Light/hooks/light-hook`，自动补齐缺失事件、备份需要修改的配置文件，并更新安装器生成的 `light-hook` 路径（自定义处理器会被保留，目标机器无需安装 Node.js）。

也可以通过命令行直接操作：

```sh
./release/macos/Light.app/Contents/MacOS/Light --install-hooks
./release/macos/Light.app/Contents/MacOS/Light --check-hooks
```

| Agent | 默认目标文件 | 原生 Hook 命令形态 |
| --- | --- | --- |
| Claude Code | `~/.claude/settings.json` | `"$HOME/Library/Application Support/Light/hooks/light-hook" 'claude' '<event>'` |
| Codex | `~/.codex/hooks.json` | `"$HOME/Library/Application Support/Light/hooks/light-hook" 'codex' '<event>'` |
| Antigravity | `~/.gemini/config/hooks.json` | `"$HOME/Library/Application Support/Light/hooks/light-hook" 'antigravity' '<event>'` |

## 验证

在仓库根目录运行以下命令。健康检查应返回 `ok: true`，发送测试提示后胶囊会显示 Claude 工作中：

```sh
curl -fsS http://127.0.0.1:51789/health
printf '%s' '{"session_id":"hook-check","prompt":"检查 Hook 接入"}' | ./release/macos/Light.app/Contents/MacOS/light-hook claude user_prompt
curl -fsS http://127.0.0.1:51789/state
printf '%s' '{"session_id":"hook-check"}' | ./release/macos/Light.app/Contents/MacOS/light-hook claude session_end
```

如果使用自定义端口，应用和 Hook 进程都需要设置相同的 `LIGHT_PORT`。三个适配器的日志位于系统临时目录，文件名分别是 `light-hook.log`、`light-codex-hook.log` 和 `light-antigravity-hook.log`。
