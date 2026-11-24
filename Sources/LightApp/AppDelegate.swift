import AppKit
import LightCore
import SwiftUI

private final class CapsuleHostingView: NSHostingView<CapsuleView> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

private final class FloatingPanel: NSPanel {
    var onEscape: (() -> Void)?

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    override func cancelOperation(_ sender: Any?) {
        onEscape?()
    }

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 { // Escape
            onEscape?()
            return
        }
        super.keyDown(with: event)
    }
}

@main
struct LightMain {
    static func main() {
        let args = CommandLine.arguments
        if args.contains("--install-hooks") {
            runCLIInstallHooks()
            return
        }
        if args.contains("--check-hooks") {
            runCLICheckHooks()
            return
        }

        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let delegate = AppDelegate()
        app.delegate = delegate
        withExtendedLifetime(delegate) {
            app.run()
        }
    }

    private static func runCLIInstallHooks() {
        let dataDir = ProcessInfo.processInfo.environment["LIGHT_DATA_DIR"] ?? DataMigration.defaultDataDir()
        let port = Int(ProcessInfo.processInfo.environment["LIGHT_PORT"] ?? "\(LocalHTTPServer.defaultPort)") ?? Int(LocalHTTPServer.defaultPort)
        guard let hookBinary = resolveHookBinary() else {
            fputs("Error: could not locate light-hook binary\n", stderr)
            exit(1)
        }
        let res = HookInstaller.installHooks(sourceHookBinary: hookBinary, userDataPath: dataDir, port: port)
        print(HookInstaller.formatInstallResult(res))
        let hasError = res.claude.error != nil || res.codex.error != nil || res.antigravity.error != nil
        exit(hasError ? 1 : 0)
    }

    private static func runCLICheckHooks() {
        let connections = HookInstaller.readHookConnections()
        for c in connections {
            print("\(c.name): \(c.status) (\(c.configPath ?? ""))")
        }
        exit(0)
    }

    private static func resolveHookBinary() -> String? {
        let fm = FileManager.default
        if let execURL = Bundle.main.executableURL {
            let sibling = execURL.deletingLastPathComponent().appendingPathComponent("light-hook").path
            if fm.isExecutableFile(atPath: sibling) { return sibling }
        }
        let argv0 = CommandLine.arguments.first ?? ""
        if !argv0.isEmpty {
            let dir = (argv0 as NSString).deletingLastPathComponent
            let candidate = (dir as NSString).appendingPathComponent("light-hook")
            if fm.isExecutableFile(atPath: candidate) { return candidate }
        }
        return nil
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, NSMenuDelegate {
    private let smokeTest = CommandLine.arguments.contains("--smoke-test")
    private let vm: LightViewModel

    private var capsulePanel: FloatingPanel!
    private var capsuleSize = CGSize(width: 56, height: 36)

    private let dropdownMotion = DropdownMotion()
    private var dropdownTransition = 0
    private var dropdownPanel: FloatingPanel?
    private var dropdownHostingView: NSHostingView<ExpandPanelView>?

    private var tray: NSStatusItem?
    private var menuLocation = CGPoint.zero
    private var selectedDisplayID: Int?
    private var selectedDisplayKey: String?
    private var anchor = CGPoint.zero

    private var dragOffset: CGPoint?
    private var globalClickMonitor: Any?
    private var ignoreBlurUntil: Date = .distantPast
    private var currentPanelMaxHeight: CGFloat = 452
    private var currentPanelWidth: CGFloat = 384

    override init() {
        self.vm = LightViewModel(smokeTest: CommandLine.arguments.contains("--smoke-test"))
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        setupCapsulePanel()
        addTray()
        restorePosition()

        vm.onPanelOpenChanged = { [weak self] open in
            if open {
                self?.showDropdownPanel()
            } else {
                self?.hideDropdownPanel()
            }
        }
        vm.onPanelContentChanged = { [weak self] in
            self?.scheduleDropdownResize()
        }

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(displaysChanged),
            name: NSApplication.didChangeScreenParametersNotification,
            object: nil
        )
        for name in [NSWorkspace.didWakeNotification, NSWorkspace.sessionDidBecomeActiveNotification] {
            NSWorkspace.shared.notificationCenter.addObserver(
                self,
                selector: #selector(displaysChanged),
                name: name,
                object: nil
            )
        }

        capsulePanel.orderFrontRegardless()
        vm.configureEnvironment(ProcessInfo.processInfo.environment)
        vm.startServices()
        if smokeTest {
            runSmokeSelfCheck()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        vm.stopServices()
        removeGlobalClickMonitor()
        NotificationCenter.default.removeObserver(self)
        NSWorkspace.shared.notificationCenter.removeObserver(self)
    }

    // MARK: - Capsule Panel

    private func setupCapsulePanel() {
        let capsuleView = CapsuleView(
            vm: vm,
            onSizeChanged: { [weak self] size in self?.updateCapsuleSize(size) }
        )
        let hosting = CapsuleHostingView(rootView: capsuleView)
        hosting.sizingOptions = []
        let drag = CapsuleDragRecognizer(target: nil, action: nil)
        drag.delaysPrimaryMouseButtonEvents = true
        drag.onDrag = { [weak self] event in self?.handleCapsuleDrag(event) }
        hosting.addGestureRecognizer(drag)

        let panel = FloatingPanel(
            contentRect: NSRect(x: 0, y: 0, width: 64, height: 40),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.delegate = self
        panel.onEscape = { [weak self] in self?.vm.closePanel() }
        panel.contentView = hosting
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = .screenSaver
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.hidesOnDeactivate = false
        panel.isMovable = false
        panel.isMovableByWindowBackground = false
        self.capsulePanel = panel
    }

    private func updateCapsuleSize(_ measured: CGSize) {
        let size = CGSize(width: max(56, ceil(measured.width)), height: max(36, ceil(measured.height)))
        guard size != capsuleSize else { return }
        capsuleSize = size
        DispatchQueue.main.async { [weak self] in
            guard let self, let screen = self.screen(at: self.anchor) else { return }
            self.placeCapsule(in: screen.visibleFrame)
            if self.vm.isPanelOpen {
                self.repositionDropdownPanel()
            }
        }
    }

    private func placeCapsule(in area: CGRect) {
        let placement = computeCapsulePlacement(anchor: anchor, area: area, capsuleSize: capsuleSize)
        anchor = placement.anchor
        if capsulePanel.frame != placement.frame {
            capsulePanel.setFrame(placement.frame, display: true)
        }
    }

    // MARK: - Dropdown Panel (on-demand)

    private func showDropdownPanel() {
        guard let screen = screen(at: anchor) else { return }
        let area = screen.visibleFrame
        let placement = computeCapsulePlacement(anchor: anchor, area: area, capsuleSize: capsuleSize)
        currentPanelMaxHeight = placement.layout.panelMaxHeight
        currentPanelWidth = placement.layout.panelWidth

        let panelView = ExpandPanelView(
            motion: dropdownMotion,
            vm: vm,
            maxHeight: currentPanelMaxHeight,
            panelWidth: currentPanelWidth
        )

        let panel: FloatingPanel
        if let existing = dropdownPanel, let hosting = dropdownHostingView {
            hosting.rootView = panelView
            panel = existing
        } else {
            let hosting = NSHostingView(rootView: panelView)
            hosting.sizingOptions = [.intrinsicContentSize]
            self.dropdownHostingView = hosting

            panel = FloatingPanel(
                contentRect: NSRect(x: 0, y: 0, width: currentPanelWidth, height: 200),
                styleMask: [.borderless, .nonactivatingPanel],
                backing: .buffered,
                defer: false
            )
            panel.delegate = self
            panel.onEscape = { [weak self] in self?.vm.closePanel() }
            panel.contentView = hosting
            panel.isOpaque = false
            panel.backgroundColor = .clear
            panel.hasShadow = true
            panel.level = .screenSaver
            panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
            panel.hidesOnDeactivate = false
            panel.animationBehavior = .none
            dropdownMotion.expanded = false
            self.dropdownPanel = panel
        }

        repositionDropdownPanel()
        panel.displayIfNeeded()
        panel.ignoresMouseEvents = false
        panel.orderFrontRegardless()
        panel.makeKey()
        animateDropdown(panel, opening: true)
        installGlobalClickMonitor()
    }

    private func hideDropdownPanel() {
        removeGlobalClickMonitor()
        guard let panel = dropdownPanel else { return }
        panel.ignoresMouseEvents = true
        animateDropdown(panel, opening: false)
    }

    private func animateDropdown(_ panel: FloatingPanel, opening: Bool) {
        dropdownTransition += 1
        let transition = dropdownTransition
        let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        let animation: Animation = opening
            ? .smooth(duration: 0.24)
            : .easeOut(duration: 0.14)
        withAnimation(reduceMotion ? nil : animation, completionCriteria: .removed) {
            dropdownMotion.expanded = opening
        } completion: { [weak self, weak panel] in
            guard let self, let panel, !opening, transition == self.dropdownTransition,
                  self.dropdownPanel === panel, !self.vm.isPanelOpen else { return }
            panel.orderOut(nil)
            self.dropdownPanel = nil
            self.dropdownHostingView = nil
        }
    }

    private func scheduleDropdownResize() {
        guard vm.isPanelOpen else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self, self.vm.isPanelOpen else { return }
            self.repositionDropdownPanel()
        }
    }

    private func repositionDropdownPanel() {
        guard let panel = dropdownPanel, let hosting = dropdownHostingView,
              let screen = screen(at: anchor) else { return }
        let area = screen.visibleFrame
        let placement = computeCapsulePlacement(anchor: anchor, area: area, capsuleSize: capsuleSize)
        let newMaxHeight = placement.layout.panelMaxHeight
        let newWidth = placement.layout.panelWidth
        if newMaxHeight != currentPanelMaxHeight || newWidth != currentPanelWidth {
            currentPanelMaxHeight = newMaxHeight
            currentPanelWidth = newWidth
            hosting.rootView = ExpandPanelView(
                motion: dropdownMotion,
                vm: vm,
                maxHeight: currentPanelMaxHeight,
                panelWidth: currentPanelWidth
            )
        }
        hosting.layoutSubtreeIfNeeded()
        let fit = hosting.intrinsicContentSize
        let desiredHeight = vm.showingDiagnostics ? min(452, currentPanelMaxHeight) : min(max(fit.height, 84), currentPanelMaxHeight)
        let dropdown = computeDropdownFrame(
            capsuleFrame: capsulePanel.frame,
            panelSize: CGSize(width: currentPanelWidth, height: desiredHeight),
            area: area,
            preferredAbove: placement.layout.above
        )
        let anchorX = (capsulePanel.frame.midX - dropdown.frame.minX) / dropdown.frame.width
        let pivot = UnitPoint(x: min(1, max(0, anchorX)), y: dropdown.above ? 1 : 0)
        if dropdownMotion.anchor != pivot { dropdownMotion.anchor = pivot }
        if panel.frame != dropdown.frame {
            panel.setFrame(dropdown.frame, display: true)
        }
    }

    private func installGlobalClickMonitor() {
        removeGlobalClickMonitor()
        globalClickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, self.vm.isPanelOpen else { return }
                guard Date() >= self.ignoreBlurUntil else { return }
                let mouse = NSEvent.mouseLocation
                if self.capsulePanel.frame.contains(mouse) { return }
                if let dp = self.dropdownPanel, dp.frame.contains(mouse) { return }
                self.vm.closePanel()
            }
        }
    }

    private func removeGlobalClickMonitor() {
        if let monitor = globalClickMonitor {
            NSEvent.removeMonitor(monitor)
            globalClickMonitor = nil
        }
    }

    func windowDidResignKey(_ notification: Notification) {
        guard vm.isPanelOpen else { return }
        guard Date() >= ignoreBlurUntil else { return }
        // Keep panel open if focus moved between capsulePanel and dropdownPanel or an open NSMenu.
        DispatchQueue.main.async { [weak self] in
            guard let self, self.vm.isPanelOpen else { return }
            let keyWin = NSApp.keyWindow
            if keyWin === self.capsulePanel || keyWin === self.dropdownPanel { return }
            let mouse = NSEvent.mouseLocation
            if self.capsulePanel.frame.contains(mouse) { return }
            if let dp = self.dropdownPanel, dp.frame.contains(mouse) { return }
            self.vm.closePanel()
        }
    }

    // MARK: - Dragging

    private func handleCapsuleDrag(_ event: CapsuleDragEvent) {
        switch event {
        case .began(let point):
            dragOffset = CGPoint(x: anchor.x - point.x, y: anchor.y - point.y)
            vm.isDraggingCapsule = true
            vm.closePanel()
        case .moved(let point):
            guard let offset = dragOffset, let screen = screen(at: point) else { return }
            anchor = CGPoint(x: point.x + offset.x, y: point.y + offset.y)
            placeCapsule(in: screen.visibleFrame)
        case .ended:
            vm.isDraggingCapsule = false
            guard dragOffset != nil else { return }
            dragOffset = nil
            if let screen = screen(at: anchor) {
                rememberPosition(on: screen)
            }
        }
    }

    // MARK: - Tray & Multi-Display

    private func addTray() {
        let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        tray = statusItem
        if let resources = Bundle.main.resourceURL {
            let tiff = resources.appendingPathComponent("tray.tiff")
            let png = resources.appendingPathComponent("tray.png")
            let image = NSImage(contentsOf: tiff) ?? NSImage(contentsOf: png)
            if let image {
                image.isTemplate = true
                image.size = NSSize(width: 20, height: 20)
                statusItem.button?.image = image
            }
        }
        if statusItem.button?.image == nil {
            statusItem.button?.image = NSImage(systemSymbolName: "capsule.fill", accessibilityDescription: "Light")
        }
        statusItem.button?.toolTip = "Light"
        statusItem.button?.setAccessibilityLabel("Light")
        rebuildMenu()
    }

    private func rebuildMenu() {
        let menu = NSMenu()
        menu.delegate = self
        let displays = NSScreen.screens
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
        menu.addItem(withTitle: "Light \(version)", action: nil, keyEquivalent: "")
        menu.addItem(withTitle: capsulePanel.isVisible ? "隐藏胶囊" : "显示胶囊", action: #selector(toggleCapsuleVisibility), keyEquivalent: "").target = self
        menu.addItem(withTitle: "重置胶囊位置", action: #selector(centerCapsule), keyEquivalent: "").target = self

        if displays.count > 1 {
            let screensMenu = NSMenu()
            for (index, screen) in displays.enumerated() {
                let item = screensMenu.addItem(withTitle: "\(index + 1) · \(screen.localizedName)", action: #selector(chooseDisplay(_:)), keyEquivalent: "")
                item.target = self
                let id = displayID(screen)
                item.representedObject = id.map { NSNumber(value: $0) }
                item.state = (id != nil && id == selectedDisplayID) ? .on : .off
            }
            menu.addItem(withTitle: "移动到显示器", action: nil, keyEquivalent: "").submenu = screensMenu
        }

        menu.addItem(.separator())
        menu.addItem(withTitle: "连接与诊断…", action: #selector(showDiagnostics), keyEquivalent: "").target = self
        menu.addItem(withTitle: "退出 Light", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q").target = NSApp
        tray?.menu = menu
    }

    func menuWillOpen(_ menu: NSMenu) {
        menuLocation = NSEvent.mouseLocation
    }

    @objc private func toggleCapsuleVisibility() {
        if capsulePanel.isVisible {
            vm.closePanel()
            capsulePanel.orderOut(nil)
        } else {
            capsulePanel.orderFrontRegardless()
        }
        rebuildMenu()
    }

    @objc private func showDiagnostics() {
        ignoreBlurUntil = Date().addingTimeInterval(0.35)
        capsulePanel.orderFrontRegardless()
        vm.openDiagnostics()
        rebuildMenu()
    }

    @objc private func centerCapsule() {
        guard let screen = screen(at: menuLocation) else { return }
        capsulePanel.orderFrontRegardless()
        move(to: screen)
    }

    @objc private func chooseDisplay(_ item: NSMenuItem) {
        guard let targetID = (item.representedObject as? NSNumber)?.intValue,
              let screen = NSScreen.screens.first(where: { displayID($0) == targetID })
        else { return }
        move(to: screen)
    }

    @objc private func displaysChanged() {
        if dragOffset == nil {
            restorePosition()
        }
        rebuildMenu()
    }

    private func displayID(_ screen: NSScreen) -> Int? {
        (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.intValue
    }

    private func descriptor(for screen: NSScreen) -> DisplayDescriptor {
        DisplayDescriptor(
            id: displayID(screen),
            key: makeDisplayKey(localizedName: screen.localizedName, size: screen.frame.size, scale: screen.backingScaleFactor),
            frame: screen.frame,
            visibleFrame: screen.visibleFrame
        )
    }

    private func screen(at point: CGPoint) -> NSScreen? {
        NSScreen.screens.first { $0.frame.contains(point) } ?? NSScreen.main ?? NSScreen.screens.first
    }

    private func move(to screen: NSScreen) {
        let area = screen.visibleFrame
        anchor = CGPoint(x: area.midX, y: area.maxY - 64)
        placeCapsule(in: area)
        rememberPosition(on: screen)
        if vm.isPanelOpen {
            repositionDropdownPanel()
        }
    }

    private func rememberPosition(on screen: NSScreen) {
        let desc = descriptor(for: screen)
        selectedDisplayID = desc.id
        selectedDisplayKey = desc.key
        if !smokeTest {
            let area = screen.visibleFrame
            var record: [String: Any] = [
                "displayKey": desc.key,
                "x": anchor.x - area.minX,
                "top": area.maxY - anchor.y,
            ]
            if let id = desc.id { record["display"] = id }
            UserDefaults.standard.set(record, forKey: "capsulePosition")
        }
        rebuildMenu()
    }

    private func readSavedPosition() -> SavedCapsulePosition? {
        guard !smokeTest,
              let saved = UserDefaults.standard.dictionary(forKey: "capsulePosition"),
              let x = (saved["x"] as? NSNumber)?.doubleValue,
              let top = (saved["top"] as? NSNumber)?.doubleValue
        else { return nil }
        let displayID = (saved["display"] as? NSNumber)?.intValue
        let displayKey = saved["displayKey"] as? String
        return SavedCapsulePosition(displayID: displayID, displayKey: displayKey, x: CGFloat(x), top: CGFloat(top))
    }

    private func restorePosition() {
        let screens = NSScreen.screens
        let descriptors = screens.map(descriptor(for:))
        let saved = readSavedPosition()
        let mainID = NSScreen.main.flatMap(displayID)
        guard let resolved = resolveDisplay(
            saved: saved,
            displays: descriptors,
            mouseLocation: NSEvent.mouseLocation,
            mainDisplayID: mainID
        ) else { return }

        selectedDisplayID = resolved.display.id
        selectedDisplayKey = resolved.display.key
        let area = resolved.display.visibleFrame
        if resolved.matchedSaved, let saved {
            anchor = CGPoint(x: area.minX + saved.x, y: area.maxY - saved.top)
        } else {
            anchor = CGPoint(x: area.midX, y: area.maxY - 64)
        }
        placeCapsule(in: area)
    }

    // MARK: - Smoke Test

    private func postSmokeMouse(_ type: NSEvent.EventType, at location: CGPoint) {
        guard let event = NSEvent.mouseEvent(with: type, location: location, modifierFlags: [],
            timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: capsulePanel.windowNumber,
            context: nil, eventNumber: 0, clickCount: 1, pressure: type == .leftMouseUp ? 0 : 1) else {
            fatalError("Could not create smoke-test mouse event")
        }
        NSApp.postEvent(event, atStart: false)
    }

    private func smokeButton(_ id: String, in node: AnyObject) -> AnyObject? {
        if node.accessibilityIdentifier?() == id { return node }
        for child in node.accessibilityChildren?() ?? [] {
            if let button = smokeButton(id, in: child as AnyObject) { return button }
        }
        return nil
    }

    private func runSmokeSelfCheck() {
        // Ignore unrelated desktop clicks while this instance drives its own windows.
        ignoreBlurUntil = .distantFuture
        Task { @MainActor in
            @MainActor func waitFor(_ description: String, _ ready: () -> Bool) async {
                let clock = ContinuousClock()
                let deadline = clock.now + .seconds(2)
                while !ready() {
                    guard clock.now < deadline else {
                        fputs("Smoke test failed: \(description), capsule \(capsulePanel.frame.size)\n", stderr)
                        exit(1)
                    }
                    try? await Task.sleep(for: .milliseconds(30))
                }
            }

            // A query for our own windows makes SwiftUI materialize its accessibility tree.
            var windows: CFTypeRef?
            let ownApp = AXUIElementCreateApplication(getpid())
            guard AXUIElementCopyAttributeValue(ownApp, kAXWindowsAttribute as CFString, &windows) == .success else {
                fputs("Smoke test failed: could not query the test app's own windows\n", stderr)
                exit(1)
            }
            await waitFor("idle capsule") { capsulePanel.isVisible && capsulePanel.frame.width == 56 }
            let initialOrigin = capsulePanel.frame.origin
            let center = CGPoint(x: capsulePanel.frame.width / 2, y: capsulePanel.frame.height / 2)
            postSmokeMouse(.leftMouseDown, at: center)
            postSmokeMouse(.leftMouseDragged, at: CGPoint(x: center.x + 12, y: center.y))
            postSmokeMouse(.leftMouseDragged, at: CGPoint(x: center.x + 14, y: center.y))
            postSmokeMouse(.leftMouseUp, at: center)
            await waitFor("capsule drag moves and releases without opening a panel") {
                abs(capsulePanel.frame.minX - initialOrigin.x - 26) < 1 &&
                dragOffset == nil && !vm.isDraggingCapsule && !vm.isPanelOpen
            }
            postSmokeMouse(.leftMouseDown, at: center)
            postSmokeMouse(.leftMouseUp, at: center)
            await waitFor("normal capsule click after dragging") { vm.isPanelOpen }
            vm.closePanel()
            await waitFor("panel closes after the click") { dropdownPanel == nil }
            let id = "smoke-capsule"
            vm.store.ingest(RawIncomingEvent(agent: .codex, type: .userPrompt, sessionId: id))
            await waitFor("Codex working label fits") { capsulePanel.frame.width > 110 }
            let singleWidth = capsulePanel.frame.width
            vm.now = Date().addingTimeInterval(12 * 60 + 34)
            await waitFor("longer elapsed time fits") { capsulePanel.frame.width > singleWidth }
            vm.now = Date()
            vm.store.ingest(RawIncomingEvent(agent: .claudeCode, type: .userPrompt, sessionId: id))
            await waitFor("two agent labels fit") { capsulePanel.frame.width > singleWidth + 65 }
            let twoAgentWidth = capsulePanel.frame.width
            vm.store.ingest(RawIncomingEvent(agent: .codex, type: .toolUse, sessionId: id,
                                             tool: "bash", message: "test command with details"))
            try? await Task.sleep(for: .milliseconds(260)) // Allow the capsule width transition to finish.
            let codexButton = CGPoint(x: twoAgentWidth - singleWidth / 2, y: capsulePanel.frame.height / 2)
            postSmokeMouse(.leftMouseDown, at: codexButton)
            postSmokeMouse(.leftMouseUp, at: codexButton)
            await waitFor("session list is visible") {
                guard let panel = dropdownPanel else { return false }
                return panel.isVisible && panel.frame.height > 100
            }
            guard let panel = dropdownPanel else { fatalError("Smoke panel missing") }
            await waitFor("tool activity group") { smokeButton("activity-group", in: panel) != nil }
            _ = smokeButton("activity-group", in: panel)?.accessibilityPerformPress?()
            await waitFor("tool detail button") { smokeButton("tool-detail", in: panel) != nil }
            try? await Task.sleep(for: .milliseconds(220))
            let collapsedHeight = panel.frame.height
            _ = smokeButton("tool-detail", in: panel)?.accessibilityPerformPress?()
            await waitFor("tool detail grows its window") { panel.frame.height > collapsedHeight + 2 }
            _ = smokeButton("tool-detail", in: panel)?.accessibilityPerformPress?()
            await waitFor("tool detail shrinks its window") { abs(panel.frame.height - collapsedHeight) < 1 }
            try? await Task.sleep(for: .milliseconds(350))
            vm.closePanel()
            try? await Task.sleep(for: .milliseconds(45))
            let closingPanel = dropdownPanel
            vm.openDiagnostics()
            try? await Task.sleep(for: .milliseconds(250))
            guard let reopened = dropdownPanel, reopened.isVisible, !reopened.ignoresMouseEvents,
                  dropdownMotion.expanded, vm.showingDiagnostics else {
                fputs("Smoke test failed: reopen, visible=\(dropdownPanel?.isVisible == true), open=\(vm.isPanelOpen), expanded=\(dropdownMotion.expanded), diagnostics=\(vm.showingDiagnostics)\n", stderr)
                exit(1)
            }
            if let closingPanel, reopened !== closingPanel {
                fputs("Smoke test failed: interrupted close replaced the panel\n", stderr)
                exit(1)
            }
            vm.closePanel()
            await waitFor("closing animation releases the panel") { dropdownPanel == nil }
            vm.store.ingest(RawIncomingEvent(agent: .codex, type: .sessionEnd, sessionId: id))
            vm.store.ingest(RawIncomingEvent(agent: .claudeCode, type: .sessionEnd, sessionId: id))
            await waitFor("capsule shrinks after sessions end") { capsulePanel.frame.width == 56 }
            FileHandle.standardOutput.write(Data("LIGHT_SMOKE_WIDTHS=56,\(singleWidth),\(twoAgentWidth),56\nLIGHT_SMOKE_UI_OK=1\n".utf8))
        }
    }
}
