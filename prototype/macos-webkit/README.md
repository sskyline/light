# Light macOS WebKit 原型

这个原型用 AppKit 托管透明浮窗和菜单栏图标，用系统 WKWebView 渲染 Light 现有的 React 界面。会话来自前端已有的示例数据。原型包有独立的应用标识，可以和正式版 Light 同时运行。

本地运行需要 macOS 14 或更新版本、Xcode Command Line Tools 和项目的 npm 依赖。

```sh
npm run prototype:macos
open 'release/macos-webkit/Light WebKit Prototype.app'
```

点击胶囊查看会话，拖动胶囊试试定位，在浮窗空白处点击验证穿透。用菜单栏的原型图标可以把胶囊移到当前显示器或退出。

```sh
'release/macos-webkit/Light WebKit Prototype.app/Contents/MacOS/LightWebKitPrototype' --smoke-test
```

透明网页背景使用 WebKit 的非公开配置。试验用途限于本地构建。真实 Hook、会话恢复和状态持久化留待后续迁移。全屏 Space、Stage Manager 和多屏行为需要用实际桌面验证。
