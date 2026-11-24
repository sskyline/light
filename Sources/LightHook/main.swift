import CryptoKit
import Foundation

@main
enum LightHookMain {
    private static let maxLogBytes: UInt64 = 512 * 1024
    private static let suggestionMarkerPrefix = "light-codex-suggestion-"
    private static let suggestionMarkerTTL: TimeInterval = 24 * 60 * 60
    private static let suggestionPromptPrefix = "This is an app-generated request for a suggested next user message. The user did not write this message."

    private static let antigravityAutoBlocks: [String] = [
        "Action blocked by Mango safety policy",
        "Action blocked by Remy safety policy",
        "the auto-run safety check could not run",
        "the auto-run safety check did not complete",
        "the auto-run safety check is misconfigured",
        "the auto-run safety check did not reach a decision",
        "the auto-run safety check has no filesystem to inspect"
    ]

    static func main() {
        let args = CommandLine.arguments
        guard args.count >= 3 else {
            fputs("Usage: light-hook <claude|codex|antigravity> <event>\n", stderr)
            exit(2)
        }
        let adapter = args[1]
        let hookEvent = args[2]

        switch adapter {
        case "claude":
            runClaude(rawType: hookEvent)
        case "codex":
            runCodex(hookEvent: hookEvent)
        case "antigravity":
            runAntigravity(hookEvent: hookEvent)
        default:
            fputs("light-hook: unsupported adapter \"\(adapter)\"\n", stderr)
            exit(2)
        }
    }

    // MARK: - Shared Helpers

    private static func tmpDir() -> String {
        let env = ProcessInfo.processInfo.environment
        if let dir = env["TMPDIR"] ?? env["TMP"] ?? env["TEMP"], !dir.isEmpty {
            return dir
        }
        return NSTemporaryDirectory()
    }

    private static func rotatedLog(fileName: String, message: String) {
        let logPath = (tmpDir() as NSString).appendingPathComponent(fileName)
        let fm = FileManager.default
        if let attrs = try? fm.attributesOfItem(atPath: logPath),
           let size = attrs[.size] as? UInt64,
           size > maxLogBytes {
            let backup = "\(logPath).1"
            try? fm.removeItem(atPath: backup)
            try? fm.moveItem(atPath: logPath, toPath: backup)
        }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let line = "\(formatter.string(from: Date())) \(message)\n"
        guard let data = line.data(using: .utf8) else { return }
        if fm.fileExists(atPath: logPath) {
            if let handle = FileHandle(forWritingAtPath: logPath) {
                _ = try? handle.seekToEnd()
                try? handle.write(contentsOf: data)
                try? handle.close()
            }
        } else {
            try? data.write(to: URL(fileURLWithPath: logPath))
        }
    }

    private static func readStdin(timeout: TimeInterval = 0.8, maxBytes: Int = 1024 * 1024) -> String {
        if isatty(STDIN_FILENO) != 0 { return "" }
        let fd = STDIN_FILENO
        var data = Data()
        let deadline = Date().addingTimeInterval(timeout)

        // Set non-blocking so we can respect wall-clock timeout cleanly.
        let flags = fcntl(fd, F_GETFL, 0)
        if flags >= 0 {
            _ = fcntl(fd, F_SETFL, flags | O_NONBLOCK)
        }
        var buf = [UInt8](repeating: 0, count: 8192)
        while Date() < deadline {
            var pfd = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            let remainingMs = max(1, Int32(deadline.timeIntervalSinceNow * 1000))
            let ready = poll(&pfd, 1, remainingMs)
            if ready <= 0 { break }
            let n = read(fd, &buf, buf.count)
            if n > 0 {
                if data.count + n > maxBytes { return "" }
                data.append(buf, count: n)
            } else if n == 0 {
                break
            } else if errno != EAGAIN && errno != EWOULDBLOCK {
                break
            }
        }
        return String(data: data, encoding: .utf8) ?? ""
    }

    private static func detectTerminal() -> [String: String]? {
        let env = ProcessInfo.processInfo.environment
        if env["TMUX"]?.isEmpty == false || env["STY"]?.isEmpty == false || env["SSH_CONNECTION"]?.isEmpty == false {
            return nil
        }
        if let session = env["REX_SESSION"], !session.isEmpty,
           let block = env["REX_BLOCK"], !block.isEmpty {
            return ["kind": "rex", "session": session, "id": block]
        }
        if env["TERM_PROGRAM"] == "iTerm.app",
           let id = env["ITERM_SESSION_ID"], !id.isEmpty {
            return ["kind": "iterm", "id": id]
        }
        if env["TERM_PROGRAM"] == "ghostty",
           let id = env["GHOSTTY_SURFACE_ID"], !id.isEmpty {
            return ["kind": "ghostty", "id": id]
        }
        return nil
    }

    private static func nowISO() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date())
    }

    private static func truncate(_ value: String?, max: Int) -> String? {
        guard let value else { return nil }
        return value.count > max ? String(value.prefix(max)) + "..." : value
    }

    private static func sliceText(_ value: Any?, max: Int = 400) -> String? {
        guard let str = value as? String else { return nil }
        return String(str.prefix(max))
    }

    private static func claudeSummary(_ value: String?, maxCharacters: Int) -> String? {
        guard let value else { return nil }
        // One visible character can contain thousands of combining marks.
        var remainingBytes = 4096
        let prefix = value.prefix(maxCharacters).prefix { character in
            remainingBytes -= character.utf8.count
            return remainingBytes >= 0
        }
        return prefix.endIndex == value.endIndex ? value : String(prefix) + "…"
    }

    private static func postEvent(_ payload: [String: Any]) -> String {
        let env = ProcessInfo.processInfo.environment
        let port = Int(env["LIGHT_PORT"] ?? "51789") ?? 51789
        guard (1...65535).contains(port) else { return "invalid_port" }
        guard let body = try? JSONSerialization.data(withJSONObject: payload) else { return "encode_error" }

        let sock = socket(AF_INET, SOCK_STREAM, 0)
        guard sock >= 0 else { return "socket_error" }
        defer { close(sock) }

        var noSigPipe: Int32 = 1
        guard setsockopt(sock, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size)) == 0 else {
            return "socket_error"
        }
        var tv = timeval(tv_sec: 0, tv_usec: 800_000)
        setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(sock, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))

        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = UInt16(port).bigEndian
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")

        let connected = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                connect(sock, sockPtr, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard connected == 0 else { return "unavailable" }

        let header = "POST /event HTTP/1.1\r\nHost: 127.0.0.1:\(port)\r\nContent-Type: application/json\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n"
        var req = Data(header.utf8)
        req.append(body)

        let sent = req.withUnsafeBytes { rawBuf -> Bool in
            guard let base = rawBuf.baseAddress else { return false }
            var total = 0
            while total < rawBuf.count {
                let n = send(sock, base.advanced(by: total), rawBuf.count - total, 0)
                if n <= 0 { return false }
                total += n
            }
            return true
        }
        guard sent else { return "send_error" }

        var respBuf = [UInt8](repeating: 0, count: 1024)
        let n = recv(sock, &respBuf, respBuf.count, 0)
        if n <= 0 { return "timeout" }
        let resp = String(decoding: respBuf[0..<n], as: UTF8.self)
        if let firstLine = resp.split(separator: "\r\n", maxSplits: 1).first {
            let parts = firstLine.split(separator: " ")
            if parts.count >= 2 { return "http_\(parts[1])" }
        }
        return "ok"
    }

    // MARK: - Claude Code

    private static func runClaude(rawType: String) {
        let typeMap: [String: String] = [
            "PermissionDenied": "auto_approval_failed",
            "PermissionRequest": "approval_request",
            "permission_request": "approval_request",
            "PostToolUse": "tool_result",
            "post_tool_use": "tool_result"
        ]
        let type = typeMap[rawType] ?? rawType
        let valid: Set<String> = [
            "user_prompt", "tool_use", "approval_request", "auto_approval_failed",
            "tool_result", "stop", "notification", "error", "session_start", "session_end"
        ]
        rotatedLog(fileName: "light-hook.log", message: "invoked type=\(type) raw=\(rawType) pid=\(ProcessInfo.processInfo.processIdentifier) cwd=\(FileManager.default.currentDirectoryPath)")
        guard valid.contains(type) else {
            fputs("light-hook claude: invalid type \"\(type)\"\n", stderr)
            exit(2)
        }

        let raw = readStdin()
        let parsed: [String: Any] = {
            guard !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  let data = raw.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                return [:]
            }
            return obj
        }()

        let sessionId = parsed["session_id"] as? String
        let tool = parsed["tool_name"] as? String
        var message: String?

        if type == "auto_approval_failed" {
            message = parsed["reason"] as? String
        } else {
            if type == "tool_use" || type == "approval_request" || type == "tool_result" {
                let input = (parsed["tool_input"] as? [String: Any]) ?? [:]
                let detail = (input["command"] as? String)
                    ?? (input["description"] as? String)
                    ?? (input["file_path"] as? String)
                let prefix = (type == "tool_result") ? "completed" : nil
                if let detail, let tool {
                    message = prefix != nil ? "\(prefix!): \(tool): \(detail)" : "\(tool): \(detail)"
                } else if let detail {
                    message = prefix != nil ? "\(prefix!): \(detail)" : detail
                } else if prefix != nil, let tool {
                    message = "\(tool) completed"
                }
            }
            if message == nil, let prompt = parsed["prompt"] as? String {
                message = prompt
            } else if message == nil, let msg = parsed["message"] as? String {
                message = msg
            }
        }

        let parsedCwd = (parsed["cwd"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let cwd = (parsedCwd?.isEmpty == false) ? parsedCwd! : FileManager.default.currentDirectoryPath

        var payload: [String: Any] = [
            "agent": "claude-code",
            "type": type,
            "cwd": cwd,
            "timestamp": nowISO()
        ]
        if let sessionId { payload["sessionId"] = sessionId }
        if let terminal = detectTerminal() { payload["terminal"] = terminal } else { payload["terminal"] = NSNull() }
        if let tool = claudeSummary(tool, maxCharacters: 80) { payload["tool"] = tool }
        if let callId = parsed["tool_use_id"] as? String { payload["toolCallId"] = callId }
        if let message = claudeSummary(message, maxCharacters: 400) { payload["message"] = message }

        let result = postEvent(payload)
        rotatedLog(fileName: "light-hook.log", message: "post type=\(type) -> \(result)")
        exit(0)
    }

    // MARK: - Codex

    private static func findStringByKey(_ obj: Any?, keys: [String], depth: Int = 0) -> String? {
        guard depth <= 4 else { return nil }
        if let arr = obj as? [Any] {
            for item in arr {
                if let found = findStringByKey(item, keys: keys, depth: depth + 1) { return found }
            }
            return nil
        }
        guard let dict = obj as? [String: Any] else { return nil }
        for key in keys {
            if let str = dict[key] as? String, !str.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return str
            }
        }
        for value in dict.values {
            if let found = findStringByKey(value, keys: keys, depth: depth + 1) { return found }
        }
        return nil
    }

    private static func getNestedString(_ dict: [String: Any], path: [String]) -> String? {
        var cur: Any? = dict
        for key in path {
            guard let d = cur as? [String: Any] else { return nil }
            cur = d[key]
        }
        return cur as? String
    }

    private static func pruneStaleSuggestionMarkers() {
        let dir = tmpDir()
        let fm = FileManager.default
        let now = Date()
        guard let entries = try? fm.contentsOfDirectory(atPath: dir) else { return }
        for name in entries where name.hasPrefix(suggestionMarkerPrefix) {
            let full = (dir as NSString).appendingPathComponent(name)
            if let attrs = try? fm.attributesOfItem(atPath: full),
               let type = attrs[.type] as? FileAttributeType, type == .typeRegular,
               let mtime = attrs[.modificationDate] as? Date,
               now.timeIntervalSince(mtime) > suggestionMarkerTTL {
                try? fm.removeItem(atPath: full)
            }
        }
    }

    private static func ignoreCodexSuggestionTurn(type: String, parsed: [String: Any], sessionId: String?) -> Bool {
        let prompt = findStringByKey(parsed, keys: ["prompt", "user_prompt", "userPrompt", "message", "text", "input"]) ?? ""
        let isSuggestion = (type == "user_prompt") && prompt.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix(suggestionPromptPrefix)
        guard let sessionId, !sessionId.isEmpty else { return isSuggestion }

        let digest = SHA256.hash(data: Data(sessionId.utf8))
        let hex = digest.map { String(format: "%02x", $0) }.joined()
        let marker = (tmpDir() as NSString).appendingPathComponent("\(suggestionMarkerPrefix)\(hex)")
        let fm = FileManager.default

        if type == "user_prompt" {
            if isSuggestion {
                fm.createFile(atPath: marker, contents: Data(), attributes: [.posixPermissions: 0o600])
                pruneStaleSuggestionMarkers()
            } else {
                try? fm.removeItem(atPath: marker)
            }
            return isSuggestion
        }

        var ignored = false
        if let attrs = try? fm.attributesOfItem(atPath: marker),
           let mtime = attrs[.modificationDate] as? Date {
            if Date().timeIntervalSince(mtime) <= suggestionMarkerTTL {
                ignored = true
            } else {
                try? fm.removeItem(atPath: marker)
            }
        }
        if type == "stop" || type == "interrupt" || type == "session_end" {
            try? fm.removeItem(atPath: marker)
        }
        return ignored
    }

    private static func runCodex(hookEvent: String) {
        let ignoredEvents: Set<String> = ["SessionStart", "session_start", "Enter", "enter"]
        let eventMap: [String: String] = [
            "SessionEnd": "session_end", "session_end": "session_end",
            "Exit": "session_end", "exit": "session_end",
            "UserPromptSubmit": "user_prompt", "user_prompt": "user_prompt",
            "PreToolUse": "tool_use", "tool_use": "tool_use",
            "PostToolUse": "tool_result", "tool_result": "tool_result",
            "PermissionRequest": "approval_request", "approval_request": "approval_request",
            "PreCompact": "notification", "PostCompact": "notification",
            "SubagentStart": "notification", "SubagentStop": "notification",
            "Stop": "stop", "stop": "stop",
            "Interrupt": "interrupt", "interrupt": "interrupt",
            "error": "error", "notification": "notification"
        ]

        rotatedLog(fileName: "light-codex-hook.log", message: "invoked event=\(hookEvent) pid=\(ProcessInfo.processInfo.processIdentifier) cwd=\(FileManager.default.currentDirectoryPath)")
        if ignoredEvents.contains(hookEvent) {
            rotatedLog(fileName: "light-codex-hook.log", message: "ignored event=\(hookEvent)")
            exit(0)
        }
        guard let type = eventMap[hookEvent] else {
            fputs("light-hook codex: unsupported hook event \"\(hookEvent)\"\n", stderr)
            exit(2)
        }

        let raw = readStdin()
        let parsed: [String: Any] = {
            guard !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  let data = raw.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                return [:]
            }
            return obj
        }()

        let env = ProcessInfo.processInfo.environment
        let sessionId = (env["LIGHT_CODEX_SESSION_ID"]?.isEmpty == false)
            ? env["LIGHT_CODEX_SESSION_ID"]
            : findStringByKey(parsed, keys: ["session_id", "sessionId", "thread_id", "threadId", "conversation_id", "conversationId"])

        if ignoreCodexSuggestionTurn(type: type, parsed: parsed, sessionId: sessionId) {
            rotatedLog(fileName: "light-codex-hook.log", message: "ignored event=\(hookEvent) reason=app_generated_suggestion")
            exit(0)
        }

        let tool = findStringByKey(parsed, keys: ["tool_name", "toolName", "tool", "name", "subagent_type", "subagentType"])
        let prompt = findStringByKey(parsed, keys: ["prompt", "user_prompt", "userPrompt", "message", "text", "input"])
        let command = getNestedString(parsed, path: ["tool_input", "command"])
            ?? getNestedString(parsed, path: ["toolInput", "command"])
            ?? getNestedString(parsed, path: ["input", "command"])
            ?? getNestedString(parsed, path: ["arguments", "command"])
            ?? findStringByKey(parsed, keys: ["command", "cmd"])

        let message: String?
        switch type {
        case "interrupt":
            message = "用户已取消本轮任务"
        case "user_prompt":
            message = truncate(prompt, max: 400)
        case "approval_request":
            if let command, let tool { message = truncate("\(tool): \(command)", max: 400) }
            else if let command { message = truncate(command, max: 400) }
            else { message = truncate(tool.map { "\($0) approval requested" } ?? "approval requested", max: 400) }
        case "tool_use":
            if let command, let tool { message = truncate("\(tool): \(command)", max: 400) }
            else if let command { message = truncate(command, max: 400) }
            else { message = truncate(tool, max: 400) }
        case "tool_result":
            if let command, let tool { message = truncate("completed: \(tool): \(command)", max: 400) }
            else if let command { message = truncate("completed: \(command)", max: 400) }
            else { message = truncate(tool.map { "\($0) completed" } ?? "tool completed", max: 400) }
        case "notification":
            if hookEvent == "PostToolUse" {
                message = truncate(command.map { "completed: \($0)" } ?? "tool completed", max: 400)
            } else if hookEvent == "PermissionRequest" {
                message = truncate(command.map { "approval requested: \($0)" } ?? "approval requested", max: 400)
            } else {
                message = truncate(prompt ?? hookEvent, max: 400)
            }
        default:
            message = truncate(prompt, max: 400)
        }

        let parsedCwd = (parsed["cwd"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let cwd = (parsedCwd?.isEmpty == false) ? parsedCwd! : FileManager.default.currentDirectoryPath

        var payload: [String: Any] = [
            "agent": "codex",
            "cwd": cwd,
            "type": type,
            "timestamp": nowISO()
        ]
        if let terminal = detectTerminal() { payload["terminal"] = terminal } else { payload["terminal"] = NSNull() }
        if let sessionId { payload["sessionId"] = sessionId }
        if let turnId = parsed["turn_id"] as? String { payload["turnId"] = turnId }
        if let tool = truncate(tool, max: 80) { payload["tool"] = tool }
        if let callId = (parsed["tool_use_id"] as? String) ?? (parsed["call_id"] as? String) {
            payload["toolCallId"] = callId
        }
        if let message { payload["message"] = message }

        let result = postEvent(payload)
        rotatedLog(fileName: "light-codex-hook.log", message: "post type=\(type) tool=\(tool ?? "") -> \(result)")
        exit(0)
    }

    // MARK: - Antigravity

    private static func antigravityErrorMessage(_ value: Any?) -> String? {
        guard let value, !(value is NSNull) else { return nil }
        guard let text = value as? String else { return "unknown error" }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func isAntigravityAutoReviewError(_ error: Any?) -> Bool {
        guard let str = error as? String else { return false }
        let verdict = str.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "^Encountered error in tool execution:\\s*", with: "", options: [.regularExpression, .caseInsensitive])
        return antigravityAutoBlocks.contains { label in
            verdict == label || verdict == label + "." || verdict.hasPrefix(label + ": ")
        }
    }

    private static func antigravityToolTarget(tool: String?, args: [String: Any]?) -> String? {
        guard let tool, let args else { return nil }
        switch tool {
        case "run_command":
            guard let rawCmd = args["CommandLine"] as? String else { return nil }
            let cmd = rawCmd.trimmingCharacters(in: .whitespacesAndNewlines)
            if let r = cmd.range(of: "^(?:npm|pnpm|yarn)\\s+(?:run\\s+[\\w:.-]+|test|build|install|lint)\\b", options: .regularExpression) {
                return String(cmd[r].replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).prefix(100))
            }
            if let r = cmd.range(of: "^git\\s+[a-z][a-z-]*\\b", options: .regularExpression) {
                return String(cmd[r].replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).prefix(100))
            }
            let regex = try? NSRegularExpression(pattern: "^(?:[\\w./-]*/)?([\\w.-]+)(?=\\s|$)")
            let nsRange = NSRange(cmd.startIndex..<cmd.endIndex, in: cmd)
            if let match = regex?.firstMatch(in: cmd, range: nsRange),
               let r = Range(match.range(at: 1), in: cmd) {
                return String(cmd[r].prefix(100))
            }
            return nil
        case "view_file", "replace_file_content", "multi_replace_file_content", "write_to_file":
            let fileKey = (tool == "view_file") ? "AbsolutePath" : "TargetFile"
            guard let file = args[fileKey] as? String,
                  !file.contains("\r"), !file.contains("\n"), !file.contains("\0") else {
                return nil
            }
            let leaf = file.trimmingCharacters(in: .whitespacesAndNewlines)
                .split(whereSeparator: { $0 == "/" || $0 == "\\" })
                .last.map(String.init)
            guard let leaf, !leaf.isEmpty else { return nil }
            return String(leaf.prefix(160))
        default:
            return nil
        }
    }

    private static func runAntigravity(hookEvent: String) {
        let raw = readStdin(timeout: 0.7)
        if !raw.isEmpty,
           let data = raw.data(using: .utf8),
           let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let convId = payload["conversationId"] as? String,
           !convId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            var event: [String: Any] = [
                "agent": "antigravity",
                "sessionId": convId,
                "timestamp": nowISO()
            ]
            if let terminal = detectTerminal() { event["terminal"] = terminal } else { event["terminal"] = NSNull() }

            let errorMessage = antigravityErrorMessage(payload["error"])
            var valid = true
            if hookEvent == "PreInvocation" {
                let num = (payload["invocationNum"] as? Int) ?? 0
                event["type"] = (num == 0) ? "user_prompt" : "tool_result"
            } else if hookEvent == "PostToolUse" {
                let toolCall = payload["toolCall"] as? [String: Any]
                let toolName = sliceText(toolCall?["name"], max: 80)
                if let toolName { event["tool"] = toolName }
                if isAntigravityAutoReviewError(errorMessage) {
                    event["type"] = "auto_approval_failed"
                    if let msg = sliceText(errorMessage) { event["message"] = msg }
                } else {
                    event["type"] = "tool_result"
                    if let target = antigravityToolTarget(tool: toolName, args: toolCall?["args"] as? [String: Any]) {
                        event["toolTarget"] = target
                    }
                    if let errorMessage {
                        event["message"] = sliceText("工具失败：\(errorMessage)")
                    } else {
                        event["message"] = sliceText(toolName.map { "\($0) completed" } ?? "tool completed")
                    }
                }
            } else if hookEvent == "Stop" {
                let reason = sliceText(payload["terminationReason"])
                if isAntigravityAutoReviewError(errorMessage) {
                    event["autoApprovalFailed"] = true
                }
                if errorMessage != nil || reason?.uppercased() == "ERROR" {
                    event["type"] = "error"
                    if let msg = sliceText(errorMessage) ?? reason { event["message"] = msg }
                } else if (payload["fullyIdle"] as? Bool) == false {
                    event["type"] = "tool_result"
                    event["message"] = "后台任务仍在运行"
                } else {
                    event["type"] = "stop"
                    if let reason { event["message"] = reason }
                }
            } else {
                valid = false
            }

            if valid {
                let res = postEvent(event)
                rotatedLog(fileName: "light-antigravity-hook.log", message: "event=\(hookEvent) type=\(event["type"] ?? "") result=\(res)")
            }
        }

        // Antigravity expects protocol JSON on stdout and exit 0 always.
        fputs("{}\n", stdout)
        fflush(stdout)
        exit(0)
    }
}
