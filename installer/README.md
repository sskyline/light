# 打包 Light 安装包（Inno Setup）

整个流程不需要 electron-builder，也不会重新下载 Electron —— 直接复用
`node_modules` 里已缓存的 Electron 运行时。

## 一次性准备

1. 安装 [Inno Setup 6](https://jrsoftware.org/isdl.php)（免费）。
2. 确保项目依赖已安装：`npm install`。

## 每次发版

```bash
# 1) 构建渲染层 + 主进程，并把可运行的 App 拼装到 release\Light\
npm run dist

# 2) 用 Inno Setup 编译安装包
#    方式 A：双击打开 installer\light.iss，点工具栏的 ▶ Compile
#    方式 B：命令行（把路径换成你本机的 ISCC.exe）
"C:\Program Files (x86)\Inno Setup 6\ISCC.exe" installer\light.iss
```

产物：`release\Light-Setup-1.0.0.exe` —— 这就是发给别人下载的安装包。

## 安装包特性

- **免管理员**：默认按"当前用户"安装到 `%LocalAppData%\Programs\Light`，不弹 UAC。
- **开始菜单 / 桌面 / 开机自启** 快捷方式可在安装时勾选。
- 升级时自动结束正在运行的 `Light.exe`，覆盖安装不报错。
- 卸载时自动关闭程序；用户数据（备忘录）在 `%AppData%\light`，卸载不动它。

## 目录约定（stage 脚本生成）

```
release/Light/
├── Light.exe              ← 重命名自 electron.exe
├── *.dll / *.pak / ...    ← Electron 运行时
├── resources/app/         ← 真正的 App 代码（无需 node_modules）
│   ├── package.json
│   ├── dist/              ← 渲染层（Vite 产物）
│   ├── dist-electron/     ← 主进程 + preload
│   ├── bridge/            ← 媒体/通知 PowerShell 脚本
│   └── icon.ico           ← 托盘/窗口图标
├── hooks/                 ← Claude Code / Codex 接入脚本
└── light.ico
```

## 常见问题

- **编译报错找不到 `..\release\Light\*`**：先跑 `npm run dist`。
- **想要中文安装界面**：编辑 `light.iss`，取消 `[Languages]` 里中文那一行的注释
  （需要 Inno Setup 的 `ChineseSimplified.isl` 语言包）。
- **想换图标**：替换 `installer\light.ico` 后重新 `npm run dist`。
