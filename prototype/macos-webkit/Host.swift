import AppKit
import WebKit

private struct PanelLayout: Encodable, Equatable {
    let capsuleX: CGFloat
    let capsuleY: CGFloat
    let panelShiftX: CGFloat
    let panelWidth: CGFloat
    let above: Bool
    let panelMaxHeight: CGFloat
}

private final class CapsulePanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

@MainActor
private final class Prototype: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    private let smokeTest = CommandLine.arguments.contains("--smoke-test")
    private var didStartSmokeTest = false
    private var panel: CapsulePanel!
    private var webView: WKWebView!
    private var tray: NSStatusItem?
    private var pageURL: URL!
    private var pointerTimer: Timer?
    private var hotZones: [CGRect] = []
    private var lastHover = false
    private var layout: PanelLayout?
    private var anchor = CGPoint.zero
    private var dragOffset: CGPoint?
    private var transparentWebView = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard let resources = Bundle.main.resourceURL,
              let bridge = try? String(contentsOf: resources.appendingPathComponent("host/bridge.js"), encoding: .utf8)
        else { fail("找不到原型界面。请重新运行 npm run prototype:macos。"); return }

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.userContentController.add(self, name: "light")
        config.userContentController.addUserScript(WKUserScript(source: bridge, injectionTime: .atDocumentStart, forMainFrameOnly: true))

        // The public underPageBackgroundColor only applies outside the page.
        // Keep this WebKit SPI isolated to the prototype and check availability.
        if config.responds(to: NSSelectorFromString("_setDrawsBackground:")) {
            config.setValue(false, forKey: "drawsBackground")
            transparentWebView = true
        }
        webView = WKWebView(frame: .zero, configuration: config)
        webView.underPageBackgroundColor = .clear
        webView.navigationDelegate = self

        panel = CapsulePanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.delegate = self
        panel.contentView = webView
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .screenSaver
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.hidesOnDeactivate = false
        panel.ignoresMouseEvents = true
        panel.alphaValue = 0

        addTray(resources: resources)
        centerCapsule()
        panel.orderFrontRegardless()
        let renderer = resources.appendingPathComponent("renderer", isDirectory: true)
        pageURL = renderer.appendingPathComponent("index.html")
        webView.loadFileURL(pageURL, allowingReadAccessTo: renderer)

        let timer = Timer(timeInterval: 1 / 30, target: self, selector: #selector(trackPointer), userInfo: nil, repeats: true)
        pointerTimer = timer
        RunLoop.main.add(timer, forMode: .common)
        if smokeTest {
            DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [self] in
                webView.evaluateJavaScript("[document.readyState, typeof window.light, document.querySelector('#root')?.childElementCount ?? -1]") { [self] value, error in
                    fail("原型启动或渲染超时。WebKit 状态：\(String(describing: value)) \(String(describing: error))")
                }
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        pointerTimer?.invalidate()
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "light")
    }

    private func addTray(resources: URL) {
        let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        tray = statusItem
        let image = NSImage(contentsOf: resources.appendingPathComponent("tray.png"))
        image?.isTemplate = true
        image?.size = NSSize(width: 18, height: 18)
        statusItem.button?.image = image
        statusItem.button?.toolTip = "Light WebKit 原型"
        statusItem.button?.setAccessibilityLabel("Light WebKit 原型")
        let menu = NSMenu()
        menu.addItem(withTitle: "胶囊移到当前显示器", action: #selector(centerCapsule), keyEquivalent: "").target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "退出 Light WebKit 原型", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q").target = NSApp
        statusItem.menu = menu
    }

    @objc private func centerCapsule() {
        guard let screen = screen(at: NSEvent.mouseLocation) else { return }
        let area = screen.visibleFrame
        anchor = CGPoint(x: area.midX, y: area.maxY - 64)
        placeCapsule(in: area)
    }

    private func screen(at point: CGPoint) -> NSScreen? {
        NSScreen.screens.first { $0.frame.contains(point) } ?? NSScreen.main
    }

    private func placeCapsule(in area: CGRect) {
        let edge: CGFloat = 8
        let gap: CGFloat = 9
        let capsuleHeight: CGFloat = 36
        let width = min(880, area.width)
        let height = min(520, area.height)
        func clamp(_ value: CGFloat, _ low: CGFloat, _ high: CGFloat) -> CGFloat { max(low, min(value, high)) }

        let halfCapsule = min((hotZones.first?.width ?? 64) / 2, area.width / 2)
        anchor.x = clamp(anchor.x, area.minX + halfCapsule, area.maxX - halfCapsule)
        anchor.y = clamp(anchor.y, area.minY + capsuleHeight + edge, area.maxY - edge)
        let bottom = anchor.y - capsuleHeight
        let roomBelow = bottom - area.minY - gap - edge
        let roomAbove = area.maxY - anchor.y - gap - edge
        let above = roomBelow < 452 && roomAbove > roomBelow
        let top = clamp(above ? bottom + height + edge : anchor.y + 10, area.minY + height, area.maxY)
        let left = clamp(anchor.x - width / 2, area.minX, area.maxX - width)
        let frame = CGRect(x: left, y: top - height, width: width, height: height)
        if frame != panel.frame { panel.setFrame(frame, display: true) }

        let panelWidth = min(384, area.width - 2 * edge)
        let panelLeft = clamp(anchor.x - panelWidth / 2, area.minX + edge, area.maxX - edge - panelWidth)
        let roomInWindow = above ? top - anchor.y - gap - edge : bottom - frame.minY - gap - edge
        let next = PanelLayout(capsuleX: anchor.x - frame.midX, capsuleY: top - anchor.y - 10,
                               panelShiftX: panelLeft + panelWidth / 2 - anchor.x, panelWidth: panelWidth, above: above,
                               panelMaxHeight: max(0, min(above ? roomAbove : roomBelow, roomInWindow)))
        if next != layout {
            layout = next
            emit("layout", next)
        }
    }

    @objc private func trackPointer() {
        let mouse = NSEvent.mouseLocation
        if let offset = dragOffset {
            if NSEvent.pressedMouseButtons & 1 != 0, let screen = screen(at: mouse) {
                anchor = CGPoint(x: mouse.x + offset.x, y: mouse.y + offset.y)
                placeCapsule(in: screen.visibleFrame)
            } else {
                dragOffset = nil
            }
        }
        updateHover(at: CGPoint(x: mouse.x - panel.frame.minX, y: panel.frame.maxY - mouse.y))
    }

    private func updateHover(at point: CGPoint) {
        let inside = dragOffset != nil || hotZones.contains { $0.contains(point) }
        panel.ignoresMouseEvents = !inside
        if inside != lastHover {
            lastHover = inside
            emit("hover", inside)
        }
    }

    private func emit<Value: Encodable>(_ name: String, _ value: Value) {
        guard let bytes = try? JSONEncoder().encode(value), let json = String(data: bytes, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.lightNative?.('\(name)', \(json))", completionHandler: nil)
    }

    func windowDidResignKey(_ notification: Notification) { emit("blur", false) }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if let layout { emit("layout", layout) }
        emit("hover", lastHover)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        fail("WebKit 无法加载原型界面：\(error.localizedDescription)")
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let allowed = action.targetFrame?.isMainFrame != false && isRendererURL(action.request.url)
        if smokeTest, !allowed {
            print("WebKit 取消导航：\(action.request.url?.absoluteString ?? "无地址")")
        }
        decisionHandler(allowed ? .allow : .cancel)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, isRendererURL(message.frameInfo.request.url),
              let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "hotZones":
            guard let zones = body["value"] as? [[String: Double]] else { return }
            hotZones = zones.prefix(12).compactMap { zone in
                guard let x = zone["x"], let y = zone["y"], let w = zone["w"], let h = zone["h"],
                      x.isFinite, y.isFinite, w.isFinite, h.isFinite, w > 0, h > 0 else { return nil }
                return CGRect(x: x, y: y, width: w, height: h)
            }
            panel.alphaValue = hotZones.isEmpty ? 0 : 1
            trackPointer()
            if smokeTest, !didStartSmokeTest, let capsule = hotZones.first {
                didStartSmokeTest = true
                runSmokeTest(capsule)
            }
        case "startDrag":
            let mouse = NSEvent.mouseLocation
            dragOffset = CGPoint(x: anchor.x - mouse.x, y: anchor.y - mouse.y)
        case "endDrag":
            dragOffset = nil
        case "quit":
            NSApp.terminate(nil)
        default:
            break
        }
    }

    private func isRendererURL(_ url: URL?) -> Bool {
        guard let url, url.isFileURL, let pageURL else { return false }
        return url.standardizedFileURL.path == pageURL.standardizedFileURL.path
    }

    private func runSmokeTest(_ capsule: CGRect) {
        updateHover(at: CGPoint(x: -100, y: -100))
        guard panel.ignoresMouseEvents else { return fail("透明区域应该允许点击穿透。") }
        updateHover(at: CGPoint(x: capsule.midX, y: capsule.midY))
        guard !panel.ignoresMouseEvents, !panel.isOpaque, transparentWebView,
              panel.collectionBehavior.contains(.fullScreenAuxiliary)
        else { return fail("浮窗交互或透明背景配置不符合预期。") }

        webView.callAsyncJavaScript("""
            const agentCount = () => document.querySelectorAll('.island .agent').length;
            for (let retry = 0; retry < 20 && agentCount() < 2; retry++) {
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            document.querySelector('.island').click();
            await new Promise(resolve => setTimeout(resolve, 200));
            return {
                backdrop: !!document.querySelector('#mock-bg'),
                styled: getComputedStyle(document.querySelector('.island')).display === 'flex',
                agents: agentCount(),
                rows: document.querySelectorAll('.panel .session-card').length,
            };
            """, arguments: [:], in: nil, in: .page) { [self] result in
            guard case .success(let value) = result, let view = value as? [String: Any],
                  view["backdrop"] as? Bool == false, view["styled"] as? Bool == true,
                  view["agents"] as? Int == 2, view["rows"] as? Int == 4
            else { return fail("WebKit 没有渲染预期的会话列表：\(result)") }
            print("WebKit 原型通过检查：胶囊、四条示例会话、透明窗口配置和点击区域。")
            NSApp.terminate(nil)
        }
    }

    private func fail(_ message: String) {
        FileHandle.standardError.write(Data((message + "\n").utf8))
        exit(1)
    }
}

@main
private enum Main {
    @MainActor static func main() {
        let app = NSApplication.shared
        let prototype = Prototype()
        app.setActivationPolicy(.accessory)
        app.delegate = prototype
        app.run()
    }
}
