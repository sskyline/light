import Foundation
@testable import LightCore

enum HookDiagnosticsTests {
    static let allTests: [(String, () throws -> Void)] = [
        ("Diagnostics.claudeWorkspaceTrust", claudeWorkspaceTrust),
        ("Diagnostics.codexHookTrust", codexHookTrust),
        ("Diagnostics.antigravitySwitches", antigravitySwitches)
    ]

    static func claudeWorkspaceTrust() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).resolvingSymlinksInPath()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let paths = AgentConfigPaths.resolve(homeDir: dir.path)
        let project = dir.appendingPathComponent("project").path
        func check(_ path: String?) -> HookAssessment { HookDiagnostics.claudeWorkspaceTrust(paths: paths, workspace: path) }
        try expect(check(nil).text.contains("尚无项目"))
        try expect(check(project).text.contains("无法读取"))
        let settings = ["projects": [project: ["hasTrustDialogAccepted": true]]]
        try JSONSerialization.data(withJSONObject: settings).write(to: dir.appendingPathComponent(".claude.json"))
        try expect(check(project + "/subdir").text.contains("已信任"))
        try expect(check(project + "-other").text.contains("未找到"))
    }

    static func codexHookTrust() throws {
        let config = "/tmp/codex/hooks.json", binary = "/tmp/Light hooks/light-hook"
        func hook(_ trust: String, enabled: Bool = true, source: String? = nil, command: String? = nil) -> [String: Any] {
            ["sourcePath": source ?? config, "handlerType": "command", "eventName": "preToolUse",
             "command": command ?? HookInstaller.buildNativeCommand(hookBinaryPath: binary, agent: "codex", arg: "PreToolUse", port: 51800),
             "enabled": enabled, "trustStatus": trust]
        }
        func assess(_ hooks: [[String: Any]], expected count: Int) throws -> HookAssessment {
            let command = HookInstaller.buildNativeCommand(hookBinaryPath: binary, agent: "codex", arg: "PreToolUse", port: 51800)
            return try HookDiagnostics.codexAssessment(result: ["data": [["hooks": hooks, "errors": []]]],
                                               config: URL(fileURLWithPath: config).resolvingSymlinksInPath().path, expected: [.init(event: "pretooluse", text: command): count])
        }
        let clean = try assess([hook("trusted"), hook("managed"), hook("modified", command: "another-hook"),
                                hook("untrusted", source: "/tmp/project/.codex/hooks.json")], expected: 2)
        try expectEqual(clean.text, "已信任并启用 2/2")
        try expect(!clean.needsAttention)
        let mixed = try assess([hook("trusted"), hook("modified"), hook("untrusted"), hook("trusted", enabled: false), hook("future")], expected: 5)
        for part in ["1/5", "已变更 1", "待信任 1", "已禁用 1", "未知 1", "/hooks"] {
            try expect(mixed.text.contains(part))
        }
        try expect(mixed.needsAttention)
        let missing = try assess([], expected: 6)
        try expect(missing.text.contains("未加载 6"))
        try expect(missing.needsAttention)
    }

    static func antigravitySwitches() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = URL(fileURLWithPath: AgentConfigPaths.resolve(homeDir: dir.path).antigravityFile)
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        for enabled in [true, false] {
            let handler = ["type":"command", "command":"'/tmp/light-hook' 'antigravity' 'Stop'"]
            let config: [String: Any] = ["light-antigravity": ["enabled": enabled, "Stop": [handler]]]
            try JSONSerialization.data(withJSONObject: config).write(to: file)
            let report = try require(HookInstaller.readHookConnections(homeDir: dir.path).first { $0.agent == .antigravity }?.assessment)
            try expect(report.text.contains(enabled ? "1/1" : "0/1"))
            try expectEqual(report.needsAttention, !enabled)
        }
    }
}
