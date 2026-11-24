import Foundation

public enum ProgressOrder {
    public static func compareEventsDesc(_ a: LightEvent, _ b: LightEvent) -> Bool {
        let ta = ISO8601Date.parse(a.timestamp)?.timeIntervalSince1970
        let tb = ISO8601Date.parse(b.timestamp)?.timeIntervalSince1970
        switch (ta, tb) {
        case let (va?, vb?):
            return va > vb
        case (_?, nil):
            return true
        case (nil, _?):
            return false
        case (nil, nil):
            return false
        }
    }

    public static func stableSortDesc(_ events: [LightEvent]) -> [LightEvent] {
        events.enumerated().sorted { lhs, rhs in
            let ta = ISO8601Date.parse(lhs.element.timestamp)?.timeIntervalSince1970
            let tb = ISO8601Date.parse(rhs.element.timestamp)?.timeIntervalSince1970
            switch (ta, tb) {
            case let (va?, vb?):
                if va != vb { return va > vb }
                return lhs.offset < rhs.offset
            case (_?, nil):
                return true
            case (nil, _?):
                return false
            case (nil, nil):
                return lhs.offset < rhs.offset
            }
        }.map(\.element)
    }

    public static func selectVisibleProgressEvents(
        recent: [LightEvent],
        unread: [LightEvent] = [],
        inspected: LightEvent? = nil
    ) -> [LightEvent] {
        let ordered = stableSortDesc(recent.filter { $0.type != .approvalRequest })
        let latestStart = ordered.firstIndex { $0.type == .userPrompt }
        let latest = latestStart.map { Array(ordered.prefix($0 + 1)) } ?? ordered

        let ids = Set(latest.compactMap(\.approvalId))
        var pinned = unread.filter { event in
            guard let id = event.approvalId else { return true }
            return !ids.contains(id)
        }
        if let inspected {
            let inLatest = inspected.approvalId.map { ids.contains($0) } ?? false
            let inPinned = pinned.contains { $0.approvalId == inspected.approvalId && $0.approvalId != nil }
            if !inLatest && !inPinned {
                pinned.append(inspected)
            }
        }
        return stableSortDesc(latest + pinned)
    }
}

public struct ActivityRow: Identifiable, Equatable, Sendable {
    public let id: String
    public var key: String { id }
    public var event: LightEvent
    public var call: LightEvent?

    public init(id: String, event: LightEvent, call: LightEvent? = nil) {
        self.id = id
        self.event = event
        self.call = call
    }
}

public struct ProgressEntry: Identifiable, Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        case event(EventType)
        case activity
    }

    public let id: String
    public var kind: Kind
    public var events: [LightEvent]

    public init(id: String, kind: Kind, events: [LightEvent]) {
        self.id = id
        self.kind = kind
        self.events = events
    }
}

public enum ToolActivity {
    private static let fileActions: [String: String] = [
        "read": "读取文件",
        "read_file": "读取文件",
        "view_file": "读取文件",
        "edit": "编辑文件",
        "multiedit": "编辑文件",
        "replace_file_content": "编辑文件",
        "multi_replace_file_content": "编辑文件",
        "write": "写入文件",
        "write_to_file": "写入文件"
    ]

    private static let shellTools: Set<String> = [
        "bash", "shell", "exec_command", "run_command", "powershell"
    ]

    private static let scriptTools: Set<String> = ["exec", "js", "python"]

    private static let leafRegex = try! NSRegularExpression(pattern: "^[\\p{L}\\p{N}._()@+ -]+$")
    private static let programRegex = try! NSRegularExpression(pattern: "^(?:[\\w./-]*/)?([\\w.-]+)(?=\\s|$)")
    private static let applyPatchRegex = try! NSRegularExpression(
        pattern: "^\\*\\*\\* (?:Update|Add|Delete) File: (.+)$",
        options: [.anchorsMatchLines]
    )
    private static let shortNameRegex = try! NSRegularExpression(pattern: "^[\\w-]+$")
    private static let doneSuffixRegex = try! NSRegularExpression(pattern: "^(?:\\S+ )?(?:completed|approval requested)$")

    private static func fileName(_ rawPath: String) -> String? {
        if rawPath.isEmpty { return nil }
        if rawPath.rangeOfCharacter(from: CharacterSet(charactersIn: "\r\n<>{}|;")) != nil { return nil }
        let trimmed = rawPath.trimmingCharacters(in: .whitespacesAndNewlines)
        let parts = trimmed.split(whereSeparator: { $0 == "/" || $0 == "\\" })
        guard let leafSub = parts.last else { return nil }
        let leaf = String(leafSub)
        let range = NSRange(leaf.startIndex..<leaf.endIndex, in: leaf)
        return leafRegex.firstMatch(in: leaf, range: range) != nil ? leaf : nil
    }

    private static func firstCapture(_ regex: NSRegularExpression, in text: String, group: Int = 1) -> String? {
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        guard let match = regex.firstMatch(in: text, range: range),
              group < match.numberOfRanges,
              let r = Range(match.range(at: group), in: text) else {
            return nil
        }
        return String(text[r])
    }

    private static func matches(_ regex: NSRegularExpression, in text: String) -> Bool {
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        return regex.firstMatch(in: text, range: range) != nil
    }

    private static func shellAction(_ command: String) -> String {
        guard let program = firstCapture(programRegex, in: command) else { return "运行命令" }
        let hasMeta = command.rangeOfCharacter(from: CharacterSet(charactersIn: ";&|`$<>\r\n")) != nil
        if !hasMeta {
            if command.range(of: "^git\\s+status\\b", options: .regularExpression) != nil { return "查看 Git 状态" }
            if command.range(of: "^git\\s+diff\\b", options: .regularExpression) != nil { return "查看代码差异" }
            if command.range(of: "^(?:npm|pnpm|yarn)\\s+(?:run\\s+)?test(?:\\s|$)", options: .regularExpression) != nil { return "运行测试" }
            if command.range(of: "^(?:npm|pnpm|yarn)\\s+(?:run\\s+)?build(?:\\s|$)", options: .regularExpression) != nil { return "构建项目" }
            if program == "rg" || program == "grep" { return "搜索文件" }
        }
        return "运行命令 · \(program)"
    }

    private static func shortToolStem(_ tool: String?) -> String? {
        guard let tool, !tool.isEmpty else { return nil }
        // Split by "__" or "."
        let pieces = tool.replacingOccurrences(of: "__", with: ".").split(separator: ".")
        return pieces.last.map(String.init)
    }

    public static func knownAction(tool: String?, message: String?, toolTarget: String?) -> String? {
        let name = shortToolStem(tool)?.lowercased() ?? ""
        var input = (message ?? "")
            .replacingOccurrences(of: "^completed: ", with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if let tool, input.hasPrefix("\(tool): ") {
            input = String(input.dropFirst(tool.count + 2))
        }
        if input == tool || matches(doneSuffixRegex, in: input) {
            input = ""
        }

        if let fileAction = fileActions[name] {
            let target = toolTarget ?? fileName(input)
            return target.map { "\(fileAction) · \($0)" } ?? fileAction
        }
        if name == "apply_patch" {
            let patchPath = firstCapture(applyPatchRegex, in: input)
            let target = patchPath.flatMap(fileName)
            return target.map { "修改文件 · \($0)" } ?? "修改文件"
        }
        if shellTools.contains(name) {
            if let toolTarget {
                let prefix = shellAction(toolTarget).components(separatedBy: " · ").first ?? "运行命令"
                return "\(prefix) · \(toolTarget)"
            }
            return shellAction(input)
        }
        if scriptTools.contains(name) { return "运行脚本" }
        if name == "grep" || name == "glob" { return "搜索文件" }
        return nil
    }

    public static func currentToolAction(_ session: SessionState) -> String? {
        guard let currentTool = session.currentTool else { return nil }
        if let event = session.recent.first(where: { $0.type != .notification }),
           (event.type == .toolUse || event.type == .approvalRequest),
           (event.tool ?? event.message) == currentTool {
            return knownAction(tool: event.tool, message: event.message, toolTarget: event.toolTarget) ?? "调用工具"
        }
        return knownAction(tool: currentTool, message: nil, toolTarget: nil) ?? "调用工具"
    }

    public static func toolActivityLabel(_ event: LightEvent) -> String {
        if let action = knownAction(tool: event.tool, message: event.message, toolTarget: event.toolTarget) {
            return action
        }
        if let shortName = shortToolStem(event.tool), matches(shortNameRegex, in: shortName) {
            return "使用工具 · \(shortName)"
        }
        return "工具操作"
    }

    public static func activityRowLabel(_ row: ActivityRow) -> String {
        let label = toolActivityLabel(row.event)
        if let call = row.call {
            var withoutMessage = row.event
            withoutMessage.message = nil
            if row.event.message?.hasPrefix("工具失败：") == true || label == toolActivityLabel(withoutMessage) {
                return toolActivityLabel(call)
            }
        }
        return label
    }

    public static func toolPhase(_ row: ActivityRow) -> String {
        if row.event.type != .toolResult { return "已调用" }
        if row.event.message?.hasPrefix("工具失败：") == true { return "工具失败" }
        guard let call = row.call,
              let end = ISO8601Date.parse(row.event.timestamp),
              let start = ISO8601Date.parse(call.timestamp) else {
            return "已返回"
        }
        let ms = (end.timeIntervalSince(start) * 1000).rounded()
        guard ms >= 0 else { return "已返回" }
        if ms < 1000 { return "\(Int(ms)) ms" }
        return String(format: "%.1f s", ms / 1000.0)
    }

    private static func compatibleLegacyCall(_ call: LightEvent, _ result: LightEvent) -> Bool {
        let input = call.message?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let output = (result.message ?? "")
            .replacingOccurrences(of: "^completed: ", with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return input.isEmpty || output.isEmpty || input == call.tool || output == "\(result.tool ?? "") completed" || input == output
    }

    public static func activityRows(_ events: [LightEvent]) -> [ActivityRow] {
        var rows: [ActivityRow] = []
        var pending: [String: (count: Int, candidateId: String?)] = [:]
        var occurrences: [String: Int] = [:]

        for event in events.reversed() {
            let identity = "\(event.type.rawValue)|\(event.timestamp)|\(event.toolCallId ?? "")|\(event.tool ?? "")|\(event.message ?? "")"
            let occurrence = occurrences[identity, default: 0]
            occurrences[identity] = occurrence + 1
            var row = ActivityRow(id: "\(identity):\(occurrence)", event: event)

            let group = "\(event.tool ?? "")|\(event.toolCallId ?? "")"
            if event.type == .toolUse && (event.tool != nil || event.toolCallId != nil) {
                if let existing = pending[group] {
                    pending[group] = (count: existing.count + 1, candidateId: nil)
                } else {
                    pending[group] = (count: 1, candidateId: row.id)
                }
            } else if event.type == .toolResult, var outstanding = pending[group] {
                let candidateId = outstanding.candidateId
                outstanding.count -= 1
                if outstanding.count == 0 {
                    pending.removeValue(forKey: group)
                } else {
                    pending[group] = outstanding
                }
                if let candidateId,
                   let idx = rows.firstIndex(where: { $0.id == candidateId }) {
                    let candidate = rows[idx]
                    let canPair = (event.toolCallId != nil) || (idx == rows.count - 1 && compatibleLegacyCall(candidate.event, event))
                    if canPair {
                        rows.remove(at: idx)
                        row = ActivityRow(id: candidate.id, event: event, call: candidate.event)
                    }
                }
            }
            rows.append(row)
        }
        return rows.reversed()
    }

    public static func toProgressEntries(_ recent: [LightEvent]) -> [ProgressEntry] {
        var entries: [ProgressEntry] = []
        var occurrences: [String: Int] = [:]
        var activityAnchor = "initial"

        for event in recent.reversed() {
            if event.type.isMilestone {
                let identity = "\(event.type.rawValue)|\(event.timestamp)|\(event.tool ?? "")|\(event.message ?? "")"
                let occurrence = occurrences[identity, default: 0] + 1
                occurrences[identity] = occurrence
                activityAnchor = "\(identity):\(occurrence)"
                let id = event.approvalId.map { "approval-\($0)" } ?? activityAnchor
                entries.append(ProgressEntry(id: id, kind: .event(event.type), events: [event]))
                continue
            }
            if let lastIdx = entries.indices.last, entries[lastIdx].kind == .activity {
                entries[lastIdx].events.insert(event, at: 0)
            } else {
                entries.append(ProgressEntry(id: "activity:\(activityAnchor)", kind: .activity, events: [event]))
            }
        }
        return entries.reversed()
    }
}
