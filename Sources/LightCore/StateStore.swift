import Foundation

public final class StateStore: @unchecked Sendable {
    public enum PersistenceMode: Sendable {
        case readOnly
        case readWrite
    }

    public typealias DesktopTargetFinder = @Sendable (_ agent: AgentId, _ id: String, _ refresh: Bool) -> JumpTarget?
    public typealias DesktopInstalledChecker = @Sendable (_ agent: AgentId) -> Bool

    public static let doneLingerSeconds: TimeInterval = 8
    public static let errorLingerSeconds: TimeInterval = 5
    public static let staleWorkingSeconds: TimeInterval = 4 * 60
    public static let staleWaitingSeconds: TimeInterval = 60
    public static let idleGCSeconds: TimeInterval = 60 * 60
    public static let recentCap = 30
    public static let publishIntervalSeconds: TimeInterval = 0.75

    private struct DesktopLookupState {
        var target: JumpTarget?
        var nextCheck: Date
        var requestID: UUID?
    }

    private struct StoredSession {
        var state: SessionState
        var desktop: DesktopLookupState?
        var jump: JumpTarget?
        var cwd: String?
        var resumeId: String?
        var ended: Bool
    }

    private struct PersistedPinnedSession: Codable {
        var key: String
        var agent: AgentId
        var sessionId: String
        var lastPrompt: String?
        var lastEventAt: String
        var turnEnd: TurnEnd?
        var recent: [LightEvent]?
        var cwd: String?
        var resumeId: String?
        var jump: JumpTarget?
    }

    private struct PersistedFile: Codable {
        var version: Int
        var sessions: [PersistedPinnedSession]
    }

    private let queue = DispatchQueue(label: "com.light.state-store")
    private let lookupQueue = DispatchQueue(label: "com.light.desktop-lookup", attributes: .concurrent)

    private var sessionOrder: [String] = []
    private var sessions: [String: StoredSession] = [:]
    private var approvalSequence: Int = 0
    private var timers: [String: DispatchWorkItem] = [:]
    private var gcTimers: [String: DispatchWorkItem] = [:]
    private var publishWorkItem: DispatchWorkItem?
    private var lastPublishedAt: Date?
    private var pinnedFilePath: String?

    private let findDesktopTarget: DesktopTargetFinder?
    private let isDesktopInstalled: DesktopInstalledChecker?

    public var onStateChanged: (@Sendable (AppStateSnapshot) -> Void)?
    public var onEvent: (@Sendable (LightEvent) -> Void)?

    public init(
        findDesktopTarget: DesktopTargetFinder? = nil,
        isDesktopInstalled: DesktopInstalledChecker? = nil,
        pinnedFilePath: String? = nil
    ) {
        self.findDesktopTarget = findDesktopTarget
        self.isDesktopInstalled = isDesktopInstalled
        self.pinnedFilePath = pinnedFilePath
        if let pinnedFilePath {
            queue.sync {
                self.loadPinnedSessionsLocked(at: pinnedFilePath)
            }
        }
    }

    public func configurePersistence(pinnedFilePath: String, mode: PersistenceMode) {
        queue.sync {
            self.pinnedFilePath = (mode == .readWrite) ? pinnedFilePath : nil
            self.loadPinnedSessionsLocked(at: pinnedFilePath)
        }
    }

    public func suspendPersistence() {
        queue.sync { pinnedFilePath = nil }
    }

    public func getState() -> AppStateSnapshot {
        queue.sync { snapshotLocked() }
    }

    public func getJumpTarget(key: String) -> JumpTarget? {
        queue.sync { effectiveJumpTargetLocked(sessions[key]) }
    }

    public func getResumeContext(key: String) -> ResumeSpec? {
        queue.sync {
            guard let s = sessions[key],
                  s.state.agent.isResumable,
                  let resumeId = s.resumeId,
                  Validation.isSessionUUID(resumeId) else {
                return nil
            }
            return ResumeSpec(agent: s.state.agent, sessionId: resumeId, cwd: s.cwd)
        }
    }

    public func getTitleSession(key: String) -> (agent: AgentId, id: String)? {
        queue.sync { getTitleSessionLocked(key: key) }
    }

    private func getTitleSessionLocked(key: String) -> (agent: AgentId, id: String)? {
        guard let agent = sessions[key]?.state.agent, agent.hasSessionTitles else { return nil }
        let prefix = agent.rawValue + "::"
        guard key.hasPrefix(prefix) else { return nil }
        let id = String(key.dropFirst(prefix.count))
        return Validation.isSessionUUID(id) ? (agent, id) : nil
    }

    public func resolveSessionDestination(key: String, refresh: Bool = false) async -> JumpTarget? {
        guard let finder = findDesktopTarget else {
            return getJumpTarget(key: key)
        }

        enum Action {
            case done(JumpTarget?)
            case fetch(AgentId, String, UUID)
        }

        let action: Action = queue.sync {
            guard var stored = sessions[key],
                  let titleSession = getTitleSessionLocked(key: key),
                  titleSession.agent != .antigravity,
                  stored.jump == nil else {
                if refresh, sessions[key]?.jump?.kind == .codex {
                    publishStateLocked(immediate: true)
                }
                return .done(effectiveJumpTargetLocked(sessions[key]))
            }
            var lookup = stored.desktop ?? DesktopLookupState(target: nil, nextCheck: .distantPast, requestID: nil)
            let now = Date()
            if lookup.requestID == nil && (refresh || now >= lookup.nextCheck) {
                let requestID = UUID()
                lookup.requestID = requestID
                stored.desktop = lookup
                sessions[key] = stored
                return .fetch(titleSession.agent, titleSession.id, requestID)
            }
            return .done(effectiveJumpTargetLocked(stored))
        }

        switch action {
        case .done(let target):
            return target
        case .fetch(let agent, let id, let requestID):
            let found: JumpTarget? = await withCheckedContinuation { continuation in
                lookupQueue.async {
                    continuation.resume(returning: finder(agent, id, refresh))
                }
            }
            return queue.sync {
                guard var stored = sessions[key] else { return nil }
                guard stored.jump == nil, stored.desktop?.requestID == requestID else {
                    return effectiveJumpTargetLocked(stored)
                }
                let previous = effectiveJumpTargetLocked(stored)
                stored.desktop = DesktopLookupState(
                    target: found,
                    nextCheck: Date().addingTimeInterval(found != nil ? 60 : 5),
                    requestID: nil
                )
                sessions[key] = stored
                let current = effectiveJumpTargetLocked(stored)
                if previous != current {
                    publishStateLocked(immediate: true)
                }
                return current
            }
        }
    }

    @discardableResult
    public func ingest(_ rawEvent: RawIncomingEvent) -> LightEvent {
        let (ingested, lookupKey) = queue.sync { ingestLocked(rawEvent) }
        if let lookupKey {
            Task.detached { [weak self] in
                _ = await self?.resolveSessionDestination(key: lookupKey)
            }
        }
        onEvent?(ingested)
        return ingested
    }

    private func ingestLocked(_ rawEvent: RawIncomingEvent) -> (LightEvent, String?) {
        let rawSessionId = rawEvent.sessionId
        let titleSessionId: String? = (rawEvent.agent.hasSessionTitles && rawSessionId.map(Validation.isSessionUUID) == true)
            ? rawSessionId!.lowercased()
            : nil
        let sessionId = Validation.shortSessionId(titleSessionId ?? rawSessionId)
        let timestamp: String
        if let supplied = rawEvent.timestamp, ISO8601Date.parse(supplied) != nil {
            timestamp = supplied
        } else {
            timestamp = ISO8601Date.nowString()
        }
        let toolCallId: String? = {
            guard let id = rawEvent.toolCallId, !id.isEmpty, id.count <= 256 else { return nil }
            return id
        }()

        var evt = LightEvent(
            agent: rawEvent.agent,
            type: rawEvent.type,
            sessionId: sessionId,
            tool: Validation.truncate(rawEvent.tool, max: 80),
            toolTarget: Validation.truncate(rawEvent.toolTarget, max: 160),
            toolCallId: toolCallId,
            approvalId: nil,
            message: Validation.truncate(rawEvent.message, max: 400),
            timestamp: timestamp
        )

        let suffix = titleSessionId ?? ((rawSessionId?.isEmpty == false) ? rawSessionId! : "default")
        let key = "\(evt.agent.rawValue)::\(suffix)"

        let prev = sessions[key]
        // Codex can report child tools under the parent session after its turn ends.
        // Leave the finished turn and its idle timer intact until the next prompt.
        if evt.agent == .codex, prev?.state.turnEnd != nil,
           [.toolUse, .toolResult, .approvalRequest].contains(evt.type) {
            return (evt, nil)
        }
        let validCwd = Validation.sanitizeCwd(rawEvent.cwd) ?? prev?.cwd
        let resumeId: String? = {
            if evt.agent.isResumable, let rawSessionId, Validation.isSessionUUID(rawSessionId) {
                return rawSessionId.lowercased()
            }
            return prev?.resumeId
        }()

        if evt.type == .sessionEnd {
            cancelTimersLocked(for: key)
            if var existing = prev {
                if existing.state.isPinned {
                    existing.state.status = .idle
                    existing.state.currentTool = nil
                    existing.state.startedAt = nil
                    existing.cwd = validCwd
                    existing.resumeId = resumeId
                    existing.ended = true
                    if existing.jump == nil && rawEvent.terminalProvided {
                        existing.jump = SessionNavigation.resolveJumpTarget(
                            agent: evt.agent,
                            sessionUUID: titleSessionId,
                            terminal: rawEvent.terminal
                        )
                    }
                    sessions[key] = existing
                    savePinnedSessionsLocked()
                } else if existing.state.unreadApprovals?.isEmpty == false {
                    existing.state.status = .idle
                    existing.state.currentTool = nil
                    existing.state.startedAt = nil
                    existing.jump = nil
                    existing.cwd = validCwd
                    existing.resumeId = resumeId
                    existing.ended = true
                    sessions[key] = existing
                } else {
                    removeKeyLocked(key)
                }
            }
            publishStateLocked(immediate: true)
            return (evt, nil)
        }

        let recent = prev?.state.recent ?? []
        let finalDenial = evt.agent == .antigravity &&
            evt.type == .error &&
            rawEvent.autoApprovalFailed &&
            !(recent.first?.type == .autoApprovalFailed && recent.first?.message == evt.message)

        var denial: LightEvent?
        if finalDenial {
            var copy = evt
            copy.type = .autoApprovalFailed
            approvalSequence += 1
            copy.approvalId = approvalSequence
            denial = copy
        } else if evt.type == .autoApprovalFailed {
            approvalSequence += 1
            evt.approvalId = approvalSequence
            denial = evt
        }

        let history = (finalDenial && denial != nil) ? ([denial!] + recent) : recent
        let newRecent: [LightEvent] = (evt.type == .approvalRequest)
            ? recent
            : Array(([evt] + history).prefix(Self.recentCap))

        let unreadApprovals: [LightEvent]? = {
            if let denial {
                return [denial] + (prev?.state.unreadApprovals ?? [])
            }
            return prev?.state.unreadApprovals
        }()

        var nextState = SessionState(
            key: key,
            agent: evt.agent,
            sessionId: sessionId,
            status: prev?.state.status ?? .idle,
            pinned: prev?.state.isPinned == true ? true : nil,
            jumpTarget: nil,
            currentTool: prev?.state.currentTool,
            lastPrompt: prev?.state.lastPrompt,
            lastEventAt: evt.timestamp,
            startedAt: prev?.state.startedAt,
            turnEnd: nil,
            unreadApprovals: unreadApprovals,
            recent: newRecent
        )

        switch evt.type {
        case .sessionStart:
            nextState.status = .idle
            nextState.currentTool = nil
            nextState.startedAt = nil
            nextState.lastPrompt = nil
        case .userPrompt:
            nextState.status = .working
            nextState.startedAt = evt.timestamp
            nextState.lastPrompt = evt.message
            nextState.currentTool = nil
        case .toolUse:
            nextState.status = .working
            nextState.currentTool = evt.tool ?? evt.message
            if nextState.startedAt == nil { nextState.startedAt = evt.timestamp }
        case .approvalRequest:
            nextState.status = .waiting
            nextState.currentTool = evt.tool ?? evt.message
            if nextState.startedAt == nil { nextState.startedAt = evt.timestamp }
        case .autoApprovalFailed:
            nextState.status = .autoApprovalFailed
            nextState.currentTool = nil
        case .toolResult:
            nextState.status = .working
            nextState.currentTool = nil
            if nextState.startedAt == nil { nextState.startedAt = evt.timestamp }
        case .stop:
            nextState.status = .done
            nextState.turnEnd = TurnEnd(type: .stop, timestamp: evt.timestamp)
            nextState.currentTool = nil
        case .interrupt:
            nextState.status = .idle
            nextState.turnEnd = TurnEnd(type: .interrupt, timestamp: evt.timestamp)
            nextState.currentTool = nil
            nextState.startedAt = nil
        case .error:
            nextState.status = .error
            nextState.turnEnd = TurnEnd(type: .error, timestamp: evt.timestamp)
            nextState.currentTool = nil
        case .notification:
            nextState.turnEnd = prev?.state.turnEnd
        case .sessionEnd:
            break
        }

        let previousJump = (!rawEvent.terminalProvided && evt.type != .sessionStart) ? prev?.jump : nil
        let jump = previousJump ?? SessionNavigation.resolveJumpTarget(
            agent: evt.agent,
            sessionUUID: titleSessionId,
            terminal: rawEvent.terminal
        )

        if sessions[key] == nil {
            sessionOrder.append(key)
        }
        sessions[key] = StoredSession(
            state: nextState,
            desktop: jump == nil ? prev?.desktop : nil,
            jump: jump,
            cwd: validCwd,
            resumeId: resumeId,
            ended: false
        )

        let shouldSavePinned = nextState.isPinned && (
            evt.type == .sessionStart ||
            evt.type == .userPrompt ||
            evt.type == .stop ||
            evt.type == .interrupt ||
            evt.type == .error ||
            prev?.cwd != validCwd ||
            prev?.resumeId != resumeId ||
            prev?.jump != jump
        )
        if shouldSavePinned {
            savePinnedSessionsLocked()
        }

        scheduleAutoResetLocked(for: key)
        scheduleGcLocked(for: key)

        let immediate = (
            evt.type == .approvalRequest ||
            evt.type == .autoApprovalFailed ||
            evt.type == .error ||
            evt.type == .stop ||
            evt.type == .interrupt ||
            evt.type == .userPrompt
        )
        publishStateLocked(immediate: immediate)
        let needsLookup = findDesktopTarget != nil && jump == nil && titleSessionId != nil && evt.agent != .antigravity
        return (evt, needsLookup ? key : nil)
    }

    public func recordCodexDenial(thread: String, reason: String?) {
        let key = "codex::\(thread.lowercased())"
        let shouldIngest: Bool = queue.sync {
            guard var stored = sessions[key] else { return false }
            if stored.state.status == .idle || stored.state.turnEnd != nil {
                approvalSequence += 1
                let ts = stored.state.turnEnd?.timestamp ?? stored.state.lastEventAt
                let event = LightEvent(
                    agent: .codex,
                    type: .autoApprovalFailed,
                    sessionId: stored.state.sessionId,
                    approvalId: approvalSequence,
                    message: Validation.truncate(reason, max: 400),
                    timestamp: ts
                )
                stored.state.unreadApprovals = [event] + (stored.state.unreadApprovals ?? [])
                if let endType = stored.state.turnEnd?.type,
                   let idx = stored.state.recent.firstIndex(where: { $0.type.rawValue == endType.rawValue && $0.timestamp == ts }) {
                    stored.state.recent.insert(event, at: idx + 1)
                } else {
                    stored.state.recent.insert(event, at: 0)
                }
                stored.state.recent = Array(stored.state.recent.prefix(Self.recentCap))
                sessions[key] = stored
                if stored.state.isPinned { savePinnedSessionsLocked() }
                publishStateLocked(immediate: true)
                return false
            }
            return true
        }

        if shouldIngest {
            _ = ingest(RawIncomingEvent(
                agent: .codex,
                type: .autoApprovalFailed,
                sessionId: thread,
                message: Validation.truncate(reason, max: 400)
            ))
        }
    }

    public func acknowledgeApproval(key: String, id: Int) {
        queue.sync {
            guard var stored = sessions[key],
                  let pending = stored.state.unreadApprovals,
                  pending.contains(where: { $0.approvalId == id }) else {
                return
            }
            let remaining = pending.filter { $0.approvalId != id }
            if remaining.isEmpty {
                stored.state.unreadApprovals = nil
                sessions[key] = stored
                if gcTimers[key] == nil {
                    scheduleGcLocked(for: key)
                }
            } else {
                stored.state.unreadApprovals = remaining
                sessions[key] = stored
            }
            publishStateLocked(immediate: true)
        }
    }

    @discardableResult
    public func setPinned(key: String, pinned: Bool) -> Bool {
        queue.sync {
            guard var stored = sessions[key] else { return false }
            if pinned {
                stored.state.pinned = true
                gcTimers[key]?.cancel()
                gcTimers.removeValue(forKey: key)
            } else {
                stored.state.pinned = nil
            }
            sessions[key] = stored
            if !pinned {
                scheduleGcLocked(for: key)
            }
            savePinnedSessionsLocked()
            publishStateLocked(immediate: true)
            return true
        }
    }

    public func updateJumpTarget(key: String, jump: JumpTarget) {
        queue.sync {
            guard var stored = sessions[key] else { return }
            stored.jump = jump
            stored.desktop = nil
            stored.ended = false
            sessions[key] = stored
            if stored.state.isPinned { savePinnedSessionsLocked() }
            publishStateLocked(immediate: true)
        }
    }

    public func clearEvents() {
        queue.sync {
            var anyPinned = false
            for key in sessionOrder {
                guard var stored = sessions[key] else { continue }
                stored.state.recent = Array((stored.state.unreadApprovals ?? []).prefix(Self.recentCap))
                if stored.state.isPinned { anyPinned = true }
                sessions[key] = stored
            }
            if anyPinned { savePinnedSessionsLocked() }
            publishStateLocked(immediate: true)
        }
    }

    public func removeSession(key: String) {
        queue.sync {
            cancelTimersLocked(for: key)
            guard let existing = sessions[key] else { return }
            removeKeyLocked(key)
            if existing.state.isPinned { savePinnedSessionsLocked() }
            publishStateLocked(immediate: true)
        }
    }

    public func clearAll() {
        queue.sync {
            for t in timers.values { t.cancel() }
            for g in gcTimers.values { g.cancel() }
            timers.removeAll()
            gcTimers.removeAll()
            sessions.removeAll()
            sessionOrder.removeAll()
            publishStateLocked(immediate: true)
        }
    }

    public func refreshAllDestinations() {
        let keys = queue.sync { sessionOrder }
        for key in keys {
            Task.detached { [weak self] in
                _ = await self?.resolveSessionDestination(key: key, refresh: true)
            }
        }
    }

    private func removeKeyLocked(_ key: String) {
        sessions.removeValue(forKey: key)
        sessionOrder.removeAll { $0 == key }
    }

    private func cancelTimersLocked(for key: String) {
        timers[key]?.cancel()
        timers.removeValue(forKey: key)
        gcTimers[key]?.cancel()
        gcTimers.removeValue(forKey: key)
    }

    private func effectiveJumpTargetLocked(_ stored: StoredSession?) -> JumpTarget? {
        guard let stored else { return nil }
        let target = stored.jump ?? stored.desktop?.target
        guard let target, let isDesktopInstalled else { return target }
        if target.kind == .codex && !isDesktopInstalled(.codex) { return nil }
        if target.kind == .claudeDesktop && !isDesktopInstalled(.claudeCode) { return nil }
        return target
    }

    private func snapshotLocked() -> AppStateSnapshot {
        let ordered = sessionOrder.compactMap { sessions[$0] }
        let sorted = ordered.enumerated().sorted { lhs, rhs in
            let p1 = lhs.element.state.status.priority
            let p2 = rhs.element.state.status.priority
            if p1 != p2 { return p1 < p2 }
            return lhs.offset < rhs.offset
        }.map { pair -> SessionState in
            var copy = pair.element.state
            copy.jumpTarget = effectiveJumpTargetLocked(pair.element)?.kind
            return copy
        }
        return AppStateSnapshot(sessions: sorted)
    }

    private func publishStateLocked(immediate: Bool) {
        let now = Date()
        let remaining: TimeInterval
        if let last = lastPublishedAt {
            remaining = Self.publishIntervalSeconds - now.timeIntervalSince(last)
        } else {
            remaining = 0
        }

        if immediate || remaining <= 0 {
            publishWorkItem?.cancel()
            publishWorkItem = nil
            lastPublishedAt = now
            let snapshot = snapshotLocked()
            let callback = onStateChanged
            DispatchQueue.main.async {
                callback?(snapshot)
            }
        } else if publishWorkItem == nil {
            let item = DispatchWorkItem { [weak self] in
                self?.publishStateLocked(immediate: true)
            }
            publishWorkItem = item
            queue.asyncAfter(deadline: .now() + remaining, execute: item)
        }
    }

    private func scheduleAutoResetLocked(for key: String) {
        timers[key]?.cancel()
        timers.removeValue(forKey: key)
        guard let cur = sessions[key] else { return }

        let delay: TimeInterval
        switch cur.state.status {
        case .done: delay = Self.doneLingerSeconds
        case .error: delay = Self.errorLingerSeconds
        case .working: delay = Self.staleWorkingSeconds
        case .waiting, .autoApprovalFailed: delay = Self.staleWaitingSeconds
        case .idle: return
        }

        let item = DispatchWorkItem { [weak self] in
            guard let self, var stored = self.sessions[key] else { return }
            self.timers.removeValue(forKey: key)
            if stored.state.status != .idle {
                stored.state.status = .idle
                stored.state.startedAt = nil
                stored.state.currentTool = nil
                self.sessions[key] = stored
                if stored.state.isPinned { self.savePinnedSessionsLocked() }
                self.publishStateLocked(immediate: true)
            }
        }
        timers[key] = item
        queue.asyncAfter(deadline: .now() + delay, execute: item)
    }

    private func scheduleGcLocked(for key: String) {
        gcTimers[key]?.cancel()
        gcTimers.removeValue(forKey: key)
        guard let cur = sessions[key], !cur.state.isPinned else { return }

        let item = DispatchWorkItem { [weak self] in
            guard let self, let stored = self.sessions[key] else { return }
            self.gcTimers.removeValue(forKey: key)
            if stored.state.status == .idle && !stored.state.isPinned && (stored.state.unreadApprovals?.isEmpty ?? true) {
                self.removeKeyLocked(key)
                self.timers[key]?.cancel()
                self.timers.removeValue(forKey: key)
                self.publishStateLocked(immediate: true)
            }
        }
        gcTimers[key] = item
        queue.asyncAfter(deadline: .now() + Self.idleGCSeconds, execute: item)
    }

    private static func decodePinnedSession(_ item: Any, fallbackDate: Date) -> StoredSession? {
        guard let raw = item as? [String: Any],
              let agentStr = raw["agent"] as? String,
              let agent = AgentId(rawValue: agentStr),
              let key = raw["key"] as? String,
              key.hasPrefix("\(agent.rawValue)::") else {
            return nil
        }
        let keySuffix = String(key.dropFirst(agent.rawValue.count + 2))
        guard !keySuffix.isEmpty,
              let rawSessionId = raw["sessionId"] as? String,
              !rawSessionId.isEmpty else {
            return nil
        }

        let isUuidKey = agent.hasSessionTitles && Validation.isSessionUUID(keySuffix) && keySuffix == keySuffix.lowercased()
        let expectedShort = Validation.shortSessionId(keySuffix)
        let normalizedSessionId = isUuidKey ? rawSessionId.lowercased() : rawSessionId
        guard normalizedSessionId == expectedShort else { return nil }

        guard let rawDate = raw["lastEventAt"] as? String else { return nil }
        let lastEventAt: String
        if ISO8601Date.parse(rawDate) != nil {
            lastEventAt = rawDate
        } else {
            // Older versions accepted arbitrary timestamps before saving a pin.
            lastEventAt = ISO8601Date.string(from: fallbackDate)
        }

        if let rawCwd = raw["cwd"], !(rawCwd is NSNull) {
            guard let str = rawCwd as? String, Validation.sanitizeCwd(str) != nil else { return nil }
        }
        if let rawResume = raw["resumeId"], !(rawResume is NSNull) {
            guard agent.isResumable, let str = rawResume as? String, Validation.isSessionUUID(str) else { return nil }
        }

        var parsedJump: JumpTarget?
        if let rawJump = raw["jump"], !(rawJump is NSNull) {
            guard rawJump is [String: Any],
                  let jumpData = try? JSONSerialization.data(withJSONObject: rawJump),
                  let decodedJump = try? JSONDecoder().decode(JumpTarget.self, from: jumpData),
                  let validJump = SessionNavigation.validatePersistedJump(agent: agent, target: decodedJump) else {
                return nil
            }
            parsedJump = validJump
        }

        let cwd = (raw["cwd"] as? String).flatMap(Validation.sanitizeCwd)
        let resumeId: String? = {
            guard agent.isResumable else { return nil }
            if let str = raw["resumeId"] as? String, Validation.isSessionUUID(str) {
                return str.lowercased()
            }
            return isUuidKey ? keySuffix : nil
        }()
        if let resumeId, isUuidKey, resumeId != keySuffix { return nil }

        let lastPrompt = (raw["lastPrompt"] as? String).flatMap { Validation.truncate($0, max: 400) }
        var turnEnd: TurnEnd?
        if let teDict = raw["turnEnd"] as? [String: Any],
           let teType = (teDict["type"] as? String).flatMap(TurnEnd.Kind.init(rawValue:)),
           let teTs = teDict["timestamp"] as? String,
           ISO8601Date.parse(teTs) != nil {
            turnEnd = TurnEnd(type: teType, timestamp: teTs)
        }

        var recent: [LightEvent] = []
        if let rawRecent = raw["recent"] as? [Any] {
            for entry in rawRecent {
                if recent.count >= Self.recentCap { break }
                guard let ev = entry as? [String: Any],
                      let evAgent = (ev["agent"] as? String).flatMap(AgentId.init(rawValue:)),
                      let evType = (ev["type"] as? String).flatMap(EventType.init(rawValue:)),
                      let evTs = ev["timestamp"] as? String,
                      ISO8601Date.parse(evTs) != nil else {
                    continue
                }
                let evSid: String
                if let s = ev["sessionId"] as? String {
                    let short = Validation.shortSessionId(s)
                    evSid = isUuidKey ? short.lowercased() : short
                } else {
                    evSid = normalizedSessionId
                }
                let callId: String? = {
                    guard let c = ev["toolCallId"] as? String, !c.isEmpty, c.count <= 256 else { return nil }
                    return c
                }()
                var approvalId: Int?
                if let aid = ev["approvalId"] as? Int, aid > 0 {
                    approvalId = aid
                }
                recent.append(LightEvent(
                    agent: evAgent,
                    type: evType,
                    sessionId: evSid,
                    tool: (ev["tool"] as? String).flatMap { Validation.truncate($0, max: 80) },
                    toolTarget: (ev["toolTarget"] as? String).flatMap { Validation.truncate($0, max: 160) },
                    toolCallId: callId,
                    approvalId: approvalId,
                    message: (ev["message"] as? String).flatMap { Validation.truncate($0, max: 400) },
                    timestamp: evTs
                ))
            }
        }

        let state = SessionState(
            key: key,
            agent: agent,
            sessionId: normalizedSessionId,
            status: .idle,
            pinned: true,
            jumpTarget: nil,
            currentTool: nil,
            lastPrompt: lastPrompt,
            lastEventAt: lastEventAt,
            startedAt: nil,
            turnEnd: turnEnd,
            unreadApprovals: nil,
            recent: recent
        )
        return StoredSession(
            state: state,
            desktop: nil,
            jump: parsedJump,
            cwd: cwd,
            resumeId: resumeId,
            ended: true
        )
    }

    private func loadPinnedSessionsLocked(at filePath: String) {
        guard let data = FileManager.default.contents(atPath: filePath),
              let rawRoot = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let entries = rawRoot["sessions"] as? [Any] else { return }
        let attributes = try? FileManager.default.attributesOfItem(atPath: filePath)
        let fallbackDate = attributes?[.modificationDate] as? Date ?? Date()

        for entry in entries {
            guard let restored = Self.decodePinnedSession(entry, fallbackDate: fallbackDate) else { continue }
            let key = restored.state.key
            if let highestID = restored.state.recent.compactMap(\.approvalId).max() {
                approvalSequence = max(approvalSequence, highestID)
            }
            if var live = sessions[key] {
                // Keep events already received by a caller that attaches persistence late.
                live.state.pinned = true
                live.cwd = live.cwd ?? restored.cwd
                live.resumeId = live.resumeId ?? restored.resumeId
                live.jump = live.jump ?? restored.jump
                if live.jump != nil { live.desktop = nil }
                sessions[key] = live
                gcTimers.removeValue(forKey: key)?.cancel()
                continue
            }
            sessionOrder.append(key)
            sessions[key] = restored
            if findDesktopTarget != nil && restored.jump == nil && restored.state.agent != .antigravity && getTitleSessionLocked(key: key) != nil {
                Task.detached { [weak self] in
                    _ = await self?.resolveSessionDestination(key: key)
                }
            }
        }
    }

    private func savePinnedSessionsLocked() {
        guard let filePath = pinnedFilePath else { return }
        var entries: [PersistedPinnedSession] = []
        for key in sessionOrder {
            guard let stored = sessions[key], stored.state.isPinned else { continue }
            entries.append(PersistedPinnedSession(
                key: stored.state.key,
                agent: stored.state.agent,
                sessionId: stored.state.sessionId,
                lastPrompt: stored.state.lastPrompt,
                lastEventAt: stored.state.lastEventAt,
                turnEnd: stored.state.turnEnd,
                recent: Array(stored.state.recent.prefix(Self.recentCap)),
                cwd: stored.cwd,
                resumeId: stored.resumeId,
                jump: stored.jump
            ))
        }
        let file = PersistedFile(version: 1, sessions: entries)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        guard let data = try? encoder.encode(file) else { return }

        let dir = (filePath as NSString).deletingLastPathComponent
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let tmpPath = "\(filePath).\(ProcessInfo.processInfo.processIdentifier).tmp"
        do {
            try data.write(to: URL(fileURLWithPath: tmpPath))
            if FileManager.default.fileExists(atPath: filePath) {
                _ = try FileManager.default.replaceItemAt(URL(fileURLWithPath: filePath), withItemAt: URL(fileURLWithPath: tmpPath))
            } else {
                try FileManager.default.moveItem(atPath: tmpPath, toPath: filePath)
            }
        } catch {
            try? data.write(to: URL(fileURLWithPath: filePath), options: .atomic)
        }
    }
}
