import Foundation
import LightCore
import SwiftUI

@MainActor
final class LightViewModel: ObservableObject {
    @Published var sessions: [SessionState] = []
    @Published var presence: PresenceState = PresenceState()
    @Published var serviceStatus: ServiceStatus = ServiceStatus(running: false, status: "正在启动", address: "127.0.0.1:51789")
    @Published var isPanelOpen: Bool = false
    @Published var showingDiagnostics: Bool = false
    @Published var pickedSession: String?
    @Published var isHoveringCapsule: Bool = false
    @Published var isDraggingCapsule: Bool = false
    @Published var now: Date = Date()
    @Published var diagnosticsReport: ConnectionReport?
    @Published var diagnosticsError: String = ""
    @Published var isInstallingHooks: Bool = false
    @Published var showIdleSessions: Bool = true
    @Published var titleCache: [String: String] = [:]
    @Published var openingSessionKey: String?
    @Published var jumpErrorByKey: [String: OpenSessionResponse] = [:]

    private(set) var store = StateStore()
    private lazy var presenceWatcher = PresenceWatcher { [weak self] presence in
        Task { @MainActor [weak self] in
            self?.presence = presence
            self?.store.refreshAllDestinations()
        }
    }
    private lazy var codexReviews = CodexReviewWatcher(dbPath: codexDatabase) { [store] thread, reason in
        store.recordCodexDenial(thread: thread, reason: reason)
    }
    private var codexDatabase: String { (configPaths.codexDir as NSString).appendingPathComponent("state_5.sqlite") }
    private var configPaths: AgentConfigPaths {
        AgentConfigPaths.resolve(homeDir: testHome, env: testHome == nil ? environment : [:])
    }
    private(set) var environment = ProcessInfo.processInfo.environment
    private var httpServer: LocalHTTPServer?
    private var writerLockFD: Int32 = -1
    private var tickTimer: Timer?

    private var codexTrustQuery: Task<Void, Never>?
    private var lastReceived: [AgentId: String] = [:]
    private var lastFailure: JumpFailureRecord?
    private var lastInstall: InstallOutcome?
    private var openInFlight: Set<String> = []
    private var titleLookupKey: String?
    private var titleMisses: [String: TitleRetry] = [:]
    private var titleRetryTask: Task<Void, Never>?
    private var scheduledRetry: Date?

    let dataDir: String
    private(set) var port = LocalHTTPServer.defaultPort
    let smokeTest: Bool
    let testHome: String?

    var onPanelOpenChanged: ((Bool) -> Void)?
    var onPanelContentChanged: (() -> Void)?

    init(smokeTest: Bool = false) {
        self.smokeTest = smokeTest
        let env = ProcessInfo.processInfo.environment
        self.dataDir = env["LIGHT_DATA_DIR"] ?? DataMigration.defaultDataDir()
        self.testHome = smokeTest ? env["LIGHT_TEST_HOME"] : nil
    }

    func configureEnvironment(_ env: [String: String]) {
        environment = env
        let requestedPort = UInt16(env["LIGHT_PORT"] ?? "")
        port = requestedPort == 0 && !smokeTest ? LocalHTTPServer.defaultPort : requestedPort ?? LocalHTTPServer.defaultPort
        let database = codexDatabase
        let presence = presenceWatcher
        let claudeLookup = ClaudeDesktopLookup()
        store = StateStore(
            findDesktopTarget: { agent, id, refresh in
                guard presence.getState().isInstalled(agent: agent) else { return nil }
                let target = DesktopDestinationLookup.lookup(agent: agent, id: id, refresh: refresh, codexDatabase: database, claudeLookup: claudeLookup)
                return presence.getState().isInstalled(agent: agent) ? target : nil
            },
            isDesktopInstalled: { presence.getState().isInstalled(agent: $0) }
        )
        self.store.onStateChanged = { [weak self] snapshot in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.sessions = snapshot.sessions
                let keys = Set(snapshot.sessions.map(\.key))
                self.titleMisses = self.titleMisses.filter { keys.contains($0.key) }
                if self.titleCache.keys.contains(where: { !keys.contains($0) }) {
                    self.titleCache = self.titleCache.filter { keys.contains($0.key) }
                }
                self.syncTickTimer()
                if self.isPanelOpen {
                    self.onPanelContentChanged?()
                    self.fetchMissingTitles()
                }
            }
        }
    }

    var visibleSessions: [SessionState] {
        sessions.filter { session in
            session.status != .idle ||
            session.isPinned ||
            (session.unreadApprovals?.isEmpty == false) ||
            session.recent.contains { $0.type != .sessionStart }
        }
    }

    var activeSessions: [SessionState] {
        visibleSessions.filter { $0.status != .idle }
    }

    var idleSessions: [SessionState] {
        visibleSessions
            .filter { $0.status == .idle }
            .sorted { a, b in
                if a.isPinned != b.isPinned { return a.isPinned }
                let ta = ISO8601Date.parse(a.turnEnd?.timestamp ?? a.lastEventAt)?.timeIntervalSince1970 ?? 0
                let tb = ISO8601Date.parse(b.turnEnd?.timestamp ?? b.lastEventAt)?.timeIntervalSince1970 ?? 0
                return ta > tb
            }
    }

    var activeByAgent: [AgentId: [SessionState]] {
        var map: [AgentId: [SessionState]] = [:]
        for session in activeSessions {
            map[session.agent, default: []].append(session)
        }
        return map
    }

    var activeAgents: [AgentId] {
        let grouped = activeByAgent
        return AgentId.displayOrder.filter { grouped[$0] != nil }
    }

    var isMinimal: Bool { activeAgents.isEmpty }

    var globalStatus: AgentStatus {
        activeSessions.first?.status ?? .idle
    }

    var hasUnreadApprovals: Bool {
        sessions.contains { $0.unreadApprovals?.isEmpty == false }
    }

    var isReadOnly: Bool { serviceStatus.readOnly }

    var expandedSessionKey: String? {
        let displayed = showIdleSessions ? visibleSessions : activeSessions
        if let picked = pickedSession {
            if picked == "__none__" { return nil }
            if displayed.contains(where: { $0.key == picked }) { return picked }
        }
        return activeSessions.first?.key
    }

    // MARK: - Lifecycle

    func startServices() {
        let pinnedPath = (dataDir as NSString).appendingPathComponent("pinned-sessions.json")
        let requestedPort = self.port

        guard httpServer == nil else { return }
        presenceWatcher.start()
        presence = presenceWatcher.getState()
        do {
            writerLockFD = try DirectoryLock.acquire(directory: dataDir)
        } catch DirectoryLock.LockError.alreadyLocked {
            enterReadOnly(reason: "已有 Light 正在使用此数据目录", pinnedPath: pinnedPath)
            return
        } catch {
            enterReadOnly(reason: "无法打开会话数据目录", pinnedPath: pinnedPath)
            return
        }

        let reviews = codexReviews
        let server = LocalHTTPServer(
            store: store,
            port: requestedPort,
            prepareForRequests: { [store] in
                // Runs on the listener's queue after binding and before delivering events.
                store.configurePersistence(pinnedFilePath: pinnedPath, mode: .readWrite)
            },
            onCodexHook: { thread, turn, type in
                reviews.track(thread: thread, turn: turn, event: type)
            },
            onReceived: { [weak self] agent in
                let formatted = ISO8601Date.formatZhDateTime()
                Task { @MainActor [weak self] in
                    self?.lastReceived[agent] = formatted
                    if let index = self?.diagnosticsReport?.adapters.firstIndex(where: { $0.agent == agent }) {
                        self?.diagnosticsReport?.adapters[index].received = formatted
                    }
                }
            },
            onState: { [weak self] state in
                Task { @MainActor [weak self] in
                    self?.handleListenerState(state, pinnedPath: pinnedPath)
                }
            }
        )
        self.httpServer = server
        server.start()
    }

    func stopServices() {
        codexTrustQuery?.cancel()
        tickTimer?.invalidate()
        tickTimer = nil
        codexReviews.stop()
        presenceWatcher.stop()
        httpServer?.stop()
        httpServer = nil
        store.suspendPersistence()
        if writerLockFD >= 0 {
            DirectoryLock.release(writerLockFD)
            writerLockFD = -1
        }
    }

    private func handleListenerState(_ state: LocalHTTPServer.ListenerState, pinnedPath: String) {
        guard let server = httpServer else { return }
        switch state {
        case .listening(let actualPort):
            guard server.isListening else { return }
            serviceStatus = ServiceStatus(running: true, status: "监听中", address: "127.0.0.1:\(actualPort)", readOnly: false)
            sessions = store.getState().sessions
            if smokeTest {
                FileHandle.standardOutput.write(Data("LIGHT_TEST_PORT=\(actualPort)\n".utf8))
            }
            if isPanelOpen && showingDiagnostics { refreshDiagnostics() }
        case .failed(let reason, _):
            enterReadOnly(reason: reason, pinnedPath: pinnedPath)
        }
    }

    private func enterReadOnly(reason: String, pinnedPath: String) {
        httpServer?.stop()
        httpServer = nil
        store.configurePersistence(pinnedFilePath: pinnedPath, mode: .readOnly)
        if writerLockFD >= 0 {
            DirectoryLock.release(writerLockFD)
            writerLockFD = -1
        }
        sessions = store.getState().sessions
        serviceStatus = ServiceStatus(
            running: false,
            status: "\(reason)，固定列表只读",
            address: "127.0.0.1:\(port)",
            readOnly: true
        )
        if smokeTest {
            FileHandle.standardOutput.write(Data("LIGHT_TEST_READ_ONLY=1\n".utf8))
        }
        if isPanelOpen && showingDiagnostics { refreshDiagnostics() }
    }

    // MARK: - Panel & Interaction

    func clickCapsule(agent: AgentId?) {
        let session = agent.flatMap { activeByAgent[$0]?.first }
        let currentExpanded = expandedSessionKey

        // Matches user's chosen UX:
        // - If panel is already open and user clicks the same agent, empty capsule, or while in diagnostics -> close.
        // - If panel is already open and user clicks a DIFFERENT agent -> switch expanded session directly.
        if isPanelOpen && (session == nil || currentExpanded == session?.key || showingDiagnostics) {
            closePanel()
            return
        }
        pickedSession = session?.key
        openPanel()
    }

    func openPanel() {
        showingDiagnostics = false
        let wasOpen = isPanelOpen
        isPanelOpen = true
        if !wasOpen {
            presenceWatcher.probeNow()
            onPanelOpenChanged?(true)
        } else {
            onPanelContentChanged?()
        }
        syncTickTimer()
        fetchMissingTitles()
        refreshDesktopDestinations()
    }

    func openDiagnostics() {
        showingDiagnostics = true
        cancelTitleRetry()
        refreshDiagnostics()
        let wasOpen = isPanelOpen
        isPanelOpen = true
        if !wasOpen {
            onPanelOpenChanged?(true)
        } else {
            onPanelContentChanged?()
        }
    }

    func backFromDiagnostics() {
        codexTrustQuery?.cancel()
        showingDiagnostics = false
        onPanelContentChanged?()
        fetchMissingTitles()
    }

    func closePanel() {
        guard isPanelOpen else { return }
        isPanelOpen = false
        codexTrustQuery?.cancel()
        cancelTitleRetry()
        onPanelOpenChanged?(false)
        syncTickTimer()
    }

    func toggleSessionExpanded(_ key: String) {
        if expandedSessionKey == key {
            pickedSession = "__none__"
        } else {
            pickedSession = key
        }
    }

    // MARK: - Actions

    func clearEvents() {
        guard !isReadOnly else { return }
        store.clearEvents()
    }

    func removeSession(_ key: String) {
        guard !isReadOnly else { return }
        store.removeSession(key: key)
        jumpErrorByKey.removeValue(forKey: key)
    }

    func togglePin(_ session: SessionState) {
        guard !isReadOnly else { return }
        store.setPinned(key: session.key, pinned: !session.isPinned)
    }

    func acknowledgeApproval(sessionKey: String, approvalId: Int) {
        guard !isReadOnly else { return }
        store.acknowledgeApproval(key: sessionKey, id: approvalId)
    }

    func effectiveJumpTarget(for session: SessionState) -> JumpTargetKind? {
        guard let kind = session.jumpTarget else { return nil }
        if (kind == .codex || kind == .claudeDesktop) && !presence.isInstalled(agent: session.agent) {
            return nil
        }
        return kind
    }

    func openSession(_ session: SessionState, allowUnverifiedRestore: Bool = false) {
        let key = session.key
        guard !openInFlight.contains(key),
              !allowUnverifiedRestore || jumpErrorByKey[key]?.canResumeInNewTab == true else { return }
        openInFlight.insert(key)
        openingSessionKey = key
        jumpErrorByKey.removeValue(forKey: key)

        let storeRef = self.store
        let presenceRef = self.presenceWatcher
        let childEnvironment = environment
        let claudeConfigDir = configPaths.claudeDir

        Task.detached { [weak self] in
            let target = await storeRef.resolveSessionDestination(key: key, refresh: true)
            let resume = storeRef.getResumeContext(key: key)
            let resultResponse: OpenSessionResponse
            let failedTargetName: String

            if let target {
                failedTargetName = target.kind.rawValue
                do {
                    let result = try SessionNavigation.openOrReopenJumpTarget(
                        target,
                        resume: resume,
                        exec: { try ProcessRunner.run(executable: $0, args: $1, timeout: $2, environment: childEnvironment) },
                        claudeConfigDir: claudeConfigDir,
                        allowUnverifiedRestore: allowUnverifiedRestore,
                        onTargetUpdated: { updated in
                            storeRef.updateJumpTarget(key: key, jump: updated)
                        }
                    )
                    if result.opened {
                        resultResponse = OpenSessionResponse(opened: true)
                    } else {
                        resultResponse = OpenSessionResponse(opened: false, message: "系统未能打开目标。")
                    }
                } catch {
                    let msg = error.localizedDescription
                    if (target.kind == .codex || target.kind == .claudeDesktop),
                       msg.range(of: "Unable to find application", options: .caseInsensitive) != nil {
                        presenceRef.markNotInstalled(target.kind == .codex ? .codex : .claudeCode)
                    }
                    resultResponse = OpenSessionResponse(opened: false, message: msg, canResumeInNewTab: error is RexSessionLocationUnknown)
                }
            } else {
                failedTargetName = "会话"
                resultResponse = OpenSessionResponse(opened: false, message: "找不到这条会话的跳转目标。")
            }

            await MainActor.run { [weak self] in
                guard let self else { return }
                self.openInFlight.remove(key)
                if self.openingSessionKey == key { self.openingSessionKey = nil }
                if resultResponse.opened {
                    self.closePanel()
                } else {
                    let msg = resultResponse.message ?? "打开失败，请检查应用、分屏或系统自动化权限。"
                    self.jumpErrorByKey[key] = resultResponse
                    self.lastFailure = JumpFailureRecord(
                        at: ISO8601Date.formatZhDateTime(),
                        target: failedTargetName,
                        reason: msg
                    )
                    self.onPanelContentChanged?()
                }
            }
        }
    }

    // MARK: - Diagnostics & Hooks

    func refreshDiagnostics() {
        diagnosticsError = ""
        codexTrustQuery?.cancel()
        let fallback = FileManager.default.currentDirectoryPath
        func workspace(for agent: AgentId) -> String? {
            let ordered = sessions.filter { $0.agent == agent }.sorted {
                (ISO8601Date.parse($0.lastEventAt) ?? .distantPast) > (ISO8601Date.parse($1.lastEventAt) ?? .distantPast)
            }
            for session in ordered {
                if let cwd = store.getResumeContext(key: session.key)?.cwd { return cwd }
            }
            return fallback == "/" ? nil : fallback
        }
        var adapters = HookInstaller.readHookConnections(homeDir: testHome, env: testHome == nil ? environment : [:],
                                                         claudeWorkspace: workspace(for: .claudeCode)).map { adapter -> AdapterConnection in
            var copy = adapter
            if let agent = adapter.agent {
                copy.received = lastReceived[agent]
            }
            return copy
        }
        if let traeTime = lastReceived[.trae] {
            adapters.append(AdapterConnection(
                agent: .trae,
                name: "Trae",
                configured: true,
                status: "外部事件源",
                configPath: nil,
                received: traeTime
            ))
        }
        if showingDiagnostics && !smokeTest, let index = adapters.firstIndex(where: { $0.agent == .codex }),
           FileManager.default.fileExists(atPath: configPaths.codexFile) {
            adapters[index].assessment = HookAssessment("正在查询 Hook 信任状态…")
            let env = environment
            let cwd = workspace(for: .codex) ?? configPaths.homeDir
            codexTrustQuery = Task.detached(priority: .utility) { [weak self] in
                guard !Task.isCancelled else { return }
                let assessment = HookDiagnostics.codexTrust(environment: env, workspace: cwd)
                await MainActor.run { [weak self] in
                    guard !Task.isCancelled, let self, self.showingDiagnostics,
                          let index = self.diagnosticsReport?.adapters.firstIndex(where: { $0.agent == .codex }) else { return }
                    self.diagnosticsReport?.adapters[index].assessment = assessment
                    self.onPanelContentChanged?()
                }
            }
        }
        diagnosticsReport = ConnectionReport(
            service: serviceStatus,
            adapters: adapters,
            lastFailure: lastFailure,
            lastInstall: lastInstall
        )
    }

    func installHooks() {
        guard !isInstallingHooks else { return }
        guard serviceStatus.running, let server = httpServer, server.isListening else {
            diagnosticsError = "请先恢复本地事件服务"
            return
        }
        guard let hookBinary = Self.resolveBundledHookBinary() else {
            diagnosticsError = "找不到内置的 light-hook 执行程序，请重新构建应用。"
            return
        }

        isInstallingHooks = true
        diagnosticsError = ""
        let listenPort = Int(server.boundPort)
        let dataPath = self.dataDir
        let home = self.testHome
        let configEnvironment = home == nil ? environment : [:]

        Task.detached { [weak self] in
            let res = HookInstaller.installHooks(
                sourceHookBinary: hookBinary,
                userDataPath: dataPath,
                port: listenPort,
                homeDir: home,
                env: configEnvironment
            )
            let targets = [res.claude, res.codex, res.antigravity]
            let failures = targets.filter { $0.error != nil }
            let outcome = InstallOutcome(
                ok: failures.isEmpty,
                summary: !failures.isEmpty
                    ? failures.map(\.target).joined(separator: "、") + " 接入失败"
                    : (targets.contains(where: \.changed) ? "Hooks 配置已更新" : "Hooks 配置已是最新"),
                detail: HookInstaller.formatInstallResult(res)
            )
            await MainActor.run { [weak self] in
                guard let self else { return }
                self.lastInstall = outcome
                self.isInstallingHooks = false
                self.refreshDiagnostics()
            }
        }
    }

    static func resolveBundledHookBinary() -> String? {
        let fm = FileManager.default
        if let execURL = Bundle.main.executableURL {
            let sibling = execURL.deletingLastPathComponent().appendingPathComponent("light-hook").path
            if fm.isExecutableFile(atPath: sibling) { return sibling }
        }
        if let resURL = Bundle.main.resourceURL {
            let inRes = resURL.appendingPathComponent("light-hook").path
            if fm.isExecutableFile(atPath: inRes) { return inRes }
        }
        let argv0 = CommandLine.arguments.first ?? ""
        if !argv0.isEmpty {
            let dir = (argv0 as NSString).deletingLastPathComponent
            let candidate = (dir as NSString).appendingPathComponent("light-hook")
            if fm.isExecutableFile(atPath: candidate) { return candidate }
        }
        return nil
    }

    // MARK: - Titles & Timers

    func title(for session: SessionState) -> String? {
        if let cached = titleCache[session.key], !cached.isEmpty {
            return cached
        }
        if let prompt = session.lastPrompt?.trimmingCharacters(in: .whitespacesAndNewlines), !prompt.isEmpty {
            return prompt.components(separatedBy: CharacterSet.newlines).first
        }
        return nil
    }

    private func fetchMissingTitles() {
        guard isPanelOpen, !showingDiagnostics, titleLookupKey == nil else { return }
        let now = Date()
        var earliest: Date?
        for session in visibleSessions where titleCache[session.key] == nil {
            let key = session.key
            guard let info = store.getTitleSession(key: key) else { continue }
            if let miss = titleMisses[key], miss.after > now {
                earliest = min(earliest ?? miss.after, miss.after)
                continue
            }
            cancelTitleRetry()
            titleLookupKey = key
            let paths = configPaths
            Task { [weak self] in
                let title: String? = await Task.detached(priority: .utility) {
                    switch info.agent {
                    case .codex: return SessionTitles.readCodexThreadTitle(threadId: info.id, codexHome: paths.codexDir)
                    case .claudeCode: return SessionTitles.readClaudeSessionTitle(sessionId: info.id, claudeHome: paths.claudeDir)
                    case .antigravity:
                        let gemini = (paths.homeDir as NSString).appendingPathComponent(".gemini")
                        return SessionTitles.readAntigravitySessionTitle(sessionId: info.id, geminiHome: gemini)
                    case .trae: return nil
                    }
                }.value
                guard let self else { return }
                titleLookupKey = nil
                if store.getTitleSession(key: key) != nil {
                    if let title {
                        titleCache[key] = title
                        titleMisses.removeValue(forKey: key)
                    } else {
                        titleMisses[key] = TitleRetry(previous: titleMisses[key], now: Date())
                    }
                }
                fetchMissingTitles()
            }
            return
        }
        guard scheduledRetry != earliest else { return }
        cancelTitleRetry()
        guard let earliest else { return }
        scheduledRetry = earliest
        titleRetryTask = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(max(0, earliest.timeIntervalSinceNow))) }
            catch { return }
            self?.scheduledRetry = nil
            self?.fetchMissingTitles()
        }
    }

    private func cancelTitleRetry() {
        titleRetryTask?.cancel()
        titleRetryTask = nil
        scheduledRetry = nil
    }

    private func refreshDesktopDestinations() {
        for session in visibleSessions where session.agent == .claudeCode || session.agent == .codex {
            guard presence.isInstalled(agent: session.agent) else { continue }
            guard effectiveJumpTarget(for: session) == nil else { continue }
            let key = session.key
            let storeRef = self.store
            Task.detached {
                _ = await storeRef.resolveSessionDestination(key: key)
            }
        }
    }

    private func syncTickTimer() {
        let hasRunning = activeSessions.contains { ($0.status == .working || $0.status == .waiting) && $0.startedAt != nil }
        let hasIdle = isPanelOpen && !idleSessions.isEmpty
        if !hasRunning && !hasIdle {
            tickTimer?.invalidate()
            tickTimer = nil
            return
        }
        let interval: TimeInterval = hasRunning ? 1.0 : 30.0
        if let existing = tickTimer, abs(existing.timeInterval - interval) < 0.01 {
            return
        }
        tickTimer?.invalidate()
        let timer = Timer(timeInterval: interval, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.now = Date()
            }
        }
        timer.tolerance = interval * 0.2
        RunLoop.main.add(timer, forMode: .common)
        tickTimer = timer
    }
}
