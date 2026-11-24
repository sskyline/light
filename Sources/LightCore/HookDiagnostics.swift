import Darwin
import Foundation

public enum HookDiagnostics {
    static func claudeWorkspaceTrust(paths: AgentConfigPaths, workspace: String?) -> HookAssessment {
        guard let workspace, workspace.hasPrefix("/"), workspace != "/" else {
            return HookAssessment("工作区信任待核实 · 尚无项目目录")
        }
        let project = URL(fileURLWithPath: workspace).standardizedFileURL.resolvingSymlinksInPath()
        let scope = AgentConfigPaths.formatDisplayPath(workspace, homeDir: paths.homeDir)
        let configDir = URL(fileURLWithPath: paths.claudeDir)
        let scoped = configDir.appendingPathComponent(".claude.json")
        let defaultDir = URL(fileURLWithPath: paths.homeDir).appendingPathComponent(".claude").path
        let config = paths.claudeDir == defaultDir && !FileManager.default.fileExists(atPath: scoped.path)
            ? URL(fileURLWithPath: paths.homeDir).appendingPathComponent(".claude.json") : scoped
        struct Project: Decodable { let hasTrustDialogAccepted: Bool? }
        struct Settings: Decodable { let projects: [String: Project]? }
        guard let data = try? Data(contentsOf: config),
              let settings = try? JSONDecoder().decode(Settings.self, from: data) else {
            return HookAssessment("工作区信任记录无法读取 · \(scope)", needsAttention: true)
        }
        var directory = project.path
        while !directory.isEmpty {
            if settings.projects?[directory]?.hasTrustDialogAccepted == true {
                return HookAssessment("交互工作区已信任 · \(scope)")
            }
            if directory == "/" { break }
            directory = (directory as NSString).deletingLastPathComponent
        }
        return HookAssessment("未找到工作区信任记录 · \(scope)", needsAttention: true)
    }

    struct Command: Hashable {
        let event: String
        let text: String
    }

    static func codexAssessment(result: [String: Any], config: String, expected: [Command: Int]) throws -> HookAssessment {
        guard let entries = result["data"] as? [[String: Any]], entries.count == 1,
              let entry = entries.first, let hooks = entry["hooks"] as? [[String: Any]],
              (entry["errors"] as? [Any])?.isEmpty == true else { throw QueryError.incomplete }

        let total = expected.values.reduce(0, +)
        var remaining = expected
        var ready = 0, disabled = 0, modified = 0, untrusted = 0, unknown = 0
        for hook in hooks {
            guard let source = hook["sourcePath"] as? String,
                  URL(fileURLWithPath: source).resolvingSymlinksInPath().path == config,
                  hook["handlerType"] as? String == "command", let command = hook["command"] as? String,
                  let event = hook["eventName"] as? String else { continue }
            let key = Command(event: event.lowercased(), text: command)
            guard let count = remaining[key], count > 0 else { continue }
            remaining[key] = count - 1
            guard let enabled = hook["enabled"] as? Bool else { unknown += 1; continue }
            if !enabled { disabled += 1; continue }
            switch hook["trustStatus"] as? String {
            case "managed", "trusted": ready += 1
            case "modified": modified += 1
            case "untrusted": untrusted += 1
            default: unknown += 1
            }
        }
        guard total > 0 else { return HookAssessment("用户级配置中未找到 Light Hook", needsAttention: true) }
        var parts = ["已信任并启用 \(ready)/\(total)"]
        if modified > 0 { parts.append("已变更 \(modified)") }
        if untrusted > 0 { parts.append("待信任 \(untrusted)") }
        if disabled > 0 { parts.append("已禁用 \(disabled)") }
        let missing = remaining.values.reduce(0, +)
        if missing > 0 { parts.append("未加载 \(missing)") }
        if unknown > 0 { parts.append("未知 \(unknown)") }
        if ready < total { parts.append("在 Codex 中查看 /hooks") }
        return HookAssessment(parts.joined(separator: " · "), needsAttention: ready < total)
    }

    public static func codexTrust(environment: [String: String], workspace: String) -> HookAssessment {
        let paths = AgentConfigPaths.resolve(env: environment)
        guard let expected = HookInstaller.codexDiagnosticCommands(at: paths.codexFile) else {
            return HookAssessment("无法读取 Codex Hook 配置", needsAttention: true)
        }
        guard !expected.isEmpty else { return HookAssessment("用户级配置中未找到 Light Hook") }
        let search = (environment["PATH"] ?? "").split(separator: ":").map(String.init) +
            ["/opt/homebrew/bin", "/usr/local/bin", paths.homeDir + "/.local/bin"]
        let candidates = search.filter { $0.hasPrefix("/") }.map { ($0 as NSString).appendingPathComponent("codex") } +
            ["/Applications/Codex.app/Contents/Resources/codex",
             "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"]
        guard let cli = candidates.first(where: FileManager.default.isExecutableFile(atPath:)) else {
            return HookAssessment("无法查询信任状态 · 未找到 Codex CLI", needsAttention: true)
        }
        do {
            return try ProcessRunner.withStandardIO(executable: cli, args: ["app-server", "--stdio"], environment: environment) { fd in
                let deadline = DispatchTime.now() + .seconds(6)
                var pending = Data()
                func send(_ message: [String: Any]) throws {
                    var data = try JSONSerialization.data(withJSONObject: message)
                    data.append(10)
                    try data.withUnsafeBytes { buffer in
                        var offset = 0
                        while offset < buffer.count {
                            let n = Darwin.write(fd, buffer.baseAddress! + offset, buffer.count - offset)
                            if n < 0 && errno == EINTR { continue }
                            guard n > 0 else { throw QueryError.incomplete }
                            offset += n
                        }
                    }
                }
                func reply(_ id: Int) throws -> [String: Any] {
                    var buffer = [UInt8](repeating: 0, count: 8192)
                    while !Task.isCancelled && DispatchTime.now() < deadline {
                        if let end = pending.firstIndex(of: 10) {
                            let line = pending[..<end]
                            pending.removeSubrange(...end)
                            let message = try JSONSerialization.jsonObject(with: line) as? [String: Any]
                            guard message?["id"] as? Int == id else { continue }
                            guard let result = message?["result"] as? [String: Any] else { throw QueryError.incomplete }
                            return result
                        }
                        guard pending.count <= 4 * 1024 * 1024 else { throw QueryError.incomplete }
                        var descriptor = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
                        let available = poll(&descriptor, 1, 100)
                        if available == 0 || (available < 0 && errno == EINTR) { continue }
                        guard available > 0 else { throw QueryError.incomplete }
                        let n = read(fd, &buffer, buffer.count)
                        if n < 0 && errno == EINTR { continue }
                        guard n > 0 else { throw QueryError.incomplete }
                        pending.append(buffer, count: n)
                    }
                    throw QueryError.timeout
                }
                try send(["id": 1, "method": "initialize", "params": [
                    "clientInfo": ["name": "light", "version": "1"],
                    "capabilities": ["experimentalApi": true]]])
                _ = try reply(1)
                try send(["method": "initialized"])
                try send(["id": 2, "method": "hooks/list", "params": ["cwds": [workspace]]])
                return try codexAssessment(result: reply(2), config: URL(fileURLWithPath: paths.codexFile).resolvingSymlinksInPath().path,
                                           expected: expected)
            }
        } catch QueryError.timeout {
            return HookAssessment("信任状态查询超时，可刷新重试", needsAttention: true)
        } catch {
            return HookAssessment("无法查询信任状态 · 在 Codex 中查看 /hooks", needsAttention: true)
        }
    }

    private enum QueryError: Error { case incomplete, timeout }
}
