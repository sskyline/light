import Foundation

public enum AgentId: String, Codable, CaseIterable, Hashable, Sendable {
    case claudeCode = "claude-code"
    case codex = "codex"
    case antigravity = "antigravity"
    case trae = "trae"

    public static let displayOrder: [AgentId] = [.claudeCode, .codex, .antigravity, .trae]

    public var shortName: String {
        switch self {
        case .claudeCode: return "Claude"
        case .codex: return "Codex"
        case .antigravity: return "Antigravity"
        case .trae: return "Trae"
        }
    }

    public var fullName: String {
        switch self {
        case .claudeCode: return "Claude Code"
        case .codex: return "Codex"
        case .antigravity: return "Antigravity"
        case .trae: return "Trae"
        }
    }

    public var hasSessionTitles: Bool {
        self == .claudeCode || self == .codex || self == .antigravity
    }

    public var isResumable: Bool {
        self == .claudeCode || self == .codex
    }
}

public enum AgentStatus: String, Codable, Hashable, Sendable {
    case idle
    case working
    case waiting
    case autoApprovalFailed = "auto_approval_failed"
    case done
    case error

    public var priority: Int {
        switch self {
        case .error: return -1
        case .autoApprovalFailed: return 0
        case .waiting, .working: return 1
        case .done: return 2
        case .idle: return 3
        }
    }
}

public enum EventType: String, Codable, Hashable, Sendable {
    case sessionStart = "session_start"
    case sessionEnd = "session_end"
    case userPrompt = "user_prompt"
    case toolUse = "tool_use"
    case approvalRequest = "approval_request"
    case autoApprovalFailed = "auto_approval_failed"
    case toolResult = "tool_result"
    case stop
    case interrupt
    case notification
    case error

    public var displayLabel: String {
        switch self {
        case .sessionStart: return "会话开始"
        case .sessionEnd: return "会话结束"
        case .userPrompt: return "开始处理"
        case .toolUse: return "调用工具"
        case .approvalRequest: return "审批请求"
        case .autoApprovalFailed: return "自动审批失败"
        case .toolResult: return "工具返回"
        case .stop: return "本轮结束"
        case .interrupt: return "已中断"
        case .notification: return "通知"
        case .error: return "出错"
        }
    }

    public var isMilestone: Bool {
        switch self {
        case .userPrompt, .stop, .interrupt, .error, .autoApprovalFailed:
            return true
        default:
            return false
        }
    }

    public var isToolEvent: Bool {
        self == .toolUse || self == .toolResult || self == .approvalRequest
    }
}

public enum JumpTargetKind: String, Codable, Hashable, Sendable {
    case codex
    case claudeDesktop = "claude-desktop"
    case iterm
    case ghostty
    case rex

    public func label(idle: Bool) -> String {
        switch self {
        case .codex: return "在 Codex 中打开对话"
        case .claudeDesktop: return "在 Claude 桌面版中打开对话"
        case .iterm: return idle ? "定位或恢复 iTerm2 分屏" : "定位 iTerm2 分屏"
        case .ghostty: return idle ? "定位或恢复 Ghostty 分屏" : "定位 Ghostty 分屏"
        case .rex: return idle ? "定位或恢复 Rex 分屏" : "定位 Rex 分屏"
        }
    }
}

public enum JumpTarget: Codable, Equatable, Hashable, Sendable {
    case codex(id: String)
    case claudeDesktop(id: String)
    case iterm(id: String)
    case ghostty(id: String)
    case rex(session: String, id: String)

    public var kind: JumpTargetKind {
        switch self {
        case .codex: return .codex
        case .claudeDesktop: return .claudeDesktop
        case .iterm: return .iterm
        case .ghostty: return .ghostty
        case .rex: return .rex
        }
    }

    public var id: String {
        switch self {
        case .codex(let id), .claudeDesktop(let id), .iterm(let id), .ghostty(let id), .rex(_, let id):
            return id
        }
    }

    private enum CodingKeys: String, CodingKey {
        case kind, id, session
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(JumpTargetKind.self, forKey: .kind)
        let id = try container.decode(String.self, forKey: .id)
        switch kind {
        case .codex: self = .codex(id: id)
        case .claudeDesktop: self = .claudeDesktop(id: id)
        case .iterm: self = .iterm(id: id)
        case .ghostty: self = .ghostty(id: id)
        case .rex:
            let session = try container.decode(String.self, forKey: .session)
            self = .rex(session: session, id: id)
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(kind, forKey: .kind)
        try container.encode(id, forKey: .id)
        if case .rex(let session, _) = self {
            try container.encode(session, forKey: .session)
        }
    }
}

public struct TerminalPayload: Codable, Equatable, Hashable, Sendable {
    public var kind: String
    public var id: String
    public var session: String?

    public init(kind: String, id: String, session: String? = nil) {
        self.kind = kind
        self.id = id
        self.session = session
    }
}

public struct TurnEnd: Codable, Equatable, Hashable, Sendable {
    public enum Kind: String, Codable, Hashable, Sendable {
        case stop
        case interrupt
        case error
    }

    public var type: Kind
    public var timestamp: String

    public init(type: Kind, timestamp: String) {
        self.type = type
        self.timestamp = timestamp
    }
}

public struct LightEvent: Codable, Equatable, Hashable, Sendable {
    public var agent: AgentId
    public var type: EventType
    public var sessionId: String?
    public var tool: String?
    public var toolTarget: String?
    public var toolCallId: String?
    public var approvalId: Int?
    public var message: String?
    public var timestamp: String

    public init(
        agent: AgentId,
        type: EventType,
        sessionId: String? = nil,
        tool: String? = nil,
        toolTarget: String? = nil,
        toolCallId: String? = nil,
        approvalId: Int? = nil,
        message: String? = nil,
        timestamp: String = ISO8601Date.nowString()
    ) {
        self.agent = agent
        self.type = type
        self.sessionId = sessionId
        self.tool = tool
        self.toolTarget = toolTarget
        self.toolCallId = toolCallId
        self.approvalId = approvalId
        self.message = message
        self.timestamp = timestamp
    }
}

public struct RawIncomingEvent: Sendable {
    public var agent: AgentId
    public var type: EventType
    public var sessionId: String?
    public var turnId: String?
    public var cwd: String?
    public var terminal: TerminalPayload?
    public var terminalProvided: Bool
    public var tool: String?
    public var toolTarget: String?
    public var toolCallId: String?
    public var message: String?
    public var timestamp: String?
    public var autoApprovalFailed: Bool

    public init(
        agent: AgentId,
        type: EventType,
        sessionId: String? = nil,
        turnId: String? = nil,
        cwd: String? = nil,
        terminal: TerminalPayload? = nil,
        terminalProvided: Bool = false,
        tool: String? = nil,
        toolTarget: String? = nil,
        toolCallId: String? = nil,
        message: String? = nil,
        timestamp: String? = nil,
        autoApprovalFailed: Bool = false
    ) {
        self.agent = agent
        self.type = type
        self.sessionId = sessionId
        self.turnId = turnId
        self.cwd = cwd
        self.terminal = terminal
        self.terminalProvided = terminalProvided
        self.tool = tool
        self.toolTarget = toolTarget
        self.toolCallId = toolCallId
        self.message = message
        self.timestamp = timestamp
        self.autoApprovalFailed = autoApprovalFailed
    }
}

public struct SessionState: Codable, Equatable, Hashable, Identifiable, Sendable {
    public var id: String { key }
    public var key: String
    public var agent: AgentId
    public var sessionId: String
    public var status: AgentStatus
    public var pinned: Bool?
    public var jumpTarget: JumpTargetKind?
    public var currentTool: String?
    public var lastPrompt: String?
    public var lastEventAt: String
    public var startedAt: String?
    public var turnEnd: TurnEnd?
    public var unreadApprovals: [LightEvent]?
    public var recent: [LightEvent]

    public var isPinned: Bool { pinned == true }

    public init(
        key: String,
        agent: AgentId,
        sessionId: String,
        status: AgentStatus,
        pinned: Bool? = nil,
        jumpTarget: JumpTargetKind? = nil,
        currentTool: String? = nil,
        lastPrompt: String? = nil,
        lastEventAt: String,
        startedAt: String? = nil,
        turnEnd: TurnEnd? = nil,
        unreadApprovals: [LightEvent]? = nil,
        recent: [LightEvent] = []
    ) {
        self.key = key
        self.agent = agent
        self.sessionId = sessionId
        self.status = status
        self.pinned = pinned
        self.jumpTarget = jumpTarget
        self.currentTool = currentTool
        self.lastPrompt = lastPrompt
        self.lastEventAt = lastEventAt
        self.startedAt = startedAt
        self.turnEnd = turnEnd
        self.unreadApprovals = unreadApprovals
        self.recent = recent
    }
}

public struct AppStateSnapshot: Codable, Equatable, Sendable {
    public var sessions: [SessionState]

    public init(sessions: [SessionState] = []) {
        self.sessions = sessions
    }
}

public struct ResumeSpec: Equatable, Sendable {
    public var agent: AgentId
    public var sessionId: String
    public var cwd: String?

    public init(agent: AgentId, sessionId: String, cwd: String? = nil) {
        self.agent = agent
        self.sessionId = sessionId
        self.cwd = cwd
    }
}

public struct ServiceStatus: Equatable, Sendable {
    public var running: Bool
    public var status: String
    public var address: String
    public var readOnly: Bool

    public init(running: Bool, status: String, address: String, readOnly: Bool = false) {
        self.running = running
        self.status = status
        self.address = address
        self.readOnly = readOnly
    }
}

public struct HookAssessment: Equatable, Sendable {
    public let text: String
    public let needsAttention: Bool

    public init(_ text: String, needsAttention: Bool = false) {
        self.text = text
        self.needsAttention = needsAttention
    }
}

public struct AdapterConnection: Equatable, Identifiable, Sendable {
    public var id: String { name }
    public var agent: AgentId?
    public var name: String
    public var configured: Bool
    public var status: String
    public var assessment: HookAssessment?
    public var configPath: String?
    public var received: String?

    public init(
        agent: AgentId? = nil,
        name: String,
        configured: Bool,
        status: String,
        configPath: String? = nil,
        received: String? = nil
    ) {
        self.agent = agent
        self.name = name
        self.configured = configured
        self.status = status
        self.configPath = configPath
        self.received = received
    }
}

public struct JumpFailureRecord: Equatable, Sendable {
    public var at: String
    public var target: String
    public var reason: String

    public init(at: String, target: String, reason: String) {
        self.at = at
        self.target = target
        self.reason = reason
    }
}

public struct InstallOutcome: Equatable, Sendable {
    public var ok: Bool
    public var summary: String
    public var detail: String

    public init(ok: Bool, summary: String, detail: String) {
        self.ok = ok
        self.summary = summary
        self.detail = detail
    }
}

public struct ConnectionReport: Equatable, Sendable {
    public var service: ServiceStatus
    public var adapters: [AdapterConnection]
    public var lastFailure: JumpFailureRecord?
    public var lastInstall: InstallOutcome?

    public init(
        service: ServiceStatus,
        adapters: [AdapterConnection],
        lastFailure: JumpFailureRecord? = nil,
        lastInstall: InstallOutcome? = nil
    ) {
        self.service = service
        self.adapters = adapters
        self.lastFailure = lastFailure
        self.lastInstall = lastInstall
    }
}

public enum SwitchTarget: String, CaseIterable, Hashable, Sendable {
    case antigravity = "antigravity"
    case codex = "codex"
    case claudeCode = "claude-code"

    public var bundleID: String {
        switch self {
        case .antigravity: return "com.google.antigravity"
        case .codex: return "com.openai.codex"
        case .claudeCode: return "com.anthropic.claudefordesktop"
        }
    }
}

public struct PresenceState: Equatable, Sendable {
    public var installed: [SwitchTarget: Bool]

    public init(installed: [SwitchTarget: Bool] = [
        .antigravity: true,
        .codex: true,
        .claudeCode: true
    ]) {
        self.installed = installed
    }

    public func isInstalled(_ target: SwitchTarget) -> Bool {
        installed[target] ?? true
    }

    public func isInstalled(agent: AgentId) -> Bool {
        switch agent {
        case .antigravity: return isInstalled(.antigravity)
        case .codex: return isInstalled(.codex)
        case .claudeCode: return isInstalled(.claudeCode)
        case .trae: return false
        }
    }
}

public enum ISO8601Date {
    private static let lock = NSLock()
    private static let fractionalFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let basicFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
    private static let localTimeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "HH:mm:ss"
        return f
    }()
    private static let zhDateTimeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "zh_CN")
        f.dateFormat = "yyyy/M/d HH:mm:ss"
        return f
    }()

    public static func nowString() -> String {
        string(from: Date())
    }

    public static func string(from date: Date) -> String {
        lock.lock()
        defer { lock.unlock() }
        return fractionalFormatter.string(from: date)
    }

    public static func parse(_ raw: String) -> Date? {
        lock.lock()
        defer { lock.unlock() }
        if let d = fractionalFormatter.date(from: raw) { return d }
        return basicFormatter.date(from: raw)
    }

    public static func formatClockTime(_ raw: String) -> String {
        guard let date = parse(raw) else { return "" }
        lock.lock()
        defer { lock.unlock() }
        return localTimeFormatter.string(from: date)
    }

    public static func formatZhDateTime(_ date: Date = Date()) -> String {
        lock.lock()
        defer { lock.unlock() }
        return zhDateTimeFormatter.string(from: date)
    }
}

public enum Validation {
    public static let sessionUUIDRegex = try! NSRegularExpression(
        pattern: "^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$",
        options: [.caseInsensitive]
    )
    public static let claudeDesktopIdRegex = try! NSRegularExpression(
        pattern: "^local_[a-zA-Z0-9-]{1,64}$"
    )
    public static let itermPaneRegex = try! NSRegularExpression(
        pattern: "^w\\d+t\\d+p\\d+:([\\da-f-]+)$",
        options: [.caseInsensitive]
    )
    public static let rexIdRegex = try! NSRegularExpression(
        pattern: "^(session|block|window|client):[a-f\\d]{8}(?:-[a-f\\d]{4}){3}-[a-f\\d]{12}$",
        options: [.caseInsensitive]
    )

    public static func isSessionUUID(_ value: String) -> Bool {
        let range = NSRange(value.startIndex..<value.endIndex, in: value)
        return sessionUUIDRegex.firstMatch(in: value, range: range) != nil
    }

    public static func isClaudeDesktopId(_ value: String) -> Bool {
        let range = NSRange(value.startIndex..<value.endIndex, in: value)
        return claudeDesktopIdRegex.firstMatch(in: value, range: range) != nil
    }

    public static func isRexId(_ value: String, kind: String) -> Bool {
        guard value.hasPrefix(kind + ":") else { return false }
        let range = NSRange(value.startIndex..<value.endIndex, in: value)
        return rexIdRegex.firstMatch(in: value, range: range) != nil
    }

    public static func extractItermGUID(_ value: String) -> String? {
        let range = NSRange(value.startIndex..<value.endIndex, in: value)
        guard let match = itermPaneRegex.firstMatch(in: value, range: range),
              let guidRange = Range(match.range(at: 1), in: value) else { return nil }
        let guid = String(value[guidRange])
        return isSessionUUID(guid) ? guid : nil
    }

    public static func sanitizeCwd(_ raw: String?) -> String? {
        guard let raw else { return nil }
        if raw.contains("\0") || raw.contains("\r") || raw.contains("\n") { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= 1024, trimmed.hasPrefix("/") else { return nil }
        return trimmed
    }

    public static func truncate(_ value: String?, max: Int = 200) -> String? {
        guard let value else { return nil }
        if value.count <= max { return value }
        return String(value.prefix(max)) + "…"
    }

    public static func shortSessionId(_ raw: String?) -> String {
        guard let raw, !raw.isEmpty else { return "default" }
        let cleaned = String(raw.filter { ch in
            ("A"..."Z").contains(ch) || ("a"..."z").contains(ch) || ("0"..."9").contains(ch) || ch == "-"
        })
        let cut = String(cleaned.prefix(12))
        return cut.isEmpty ? "default" : cut
    }
}
