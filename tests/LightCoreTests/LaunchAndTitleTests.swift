import Foundation
import LightCore

enum LaunchAndTitleTests {
    static let allTests: [(String, () throws -> Void)] = [
        ("Environment.configDirectoryDefaultsAndOverrides", configDirectoryDefaultsAndOverrides),
        ("Titles.streamTranscriptAndRetryLateTitle", streamTranscriptAndRetryLateTitle)
    ]

    static func configDirectoryDefaultsAndOverrides() throws {
        let home = "/Users/example"
        let defaults = AgentConfigPaths.resolve(homeDir: home, env: [:])
        try expectEqual(defaults.claudeDir, home + "/.claude")
        try expectEqual(defaults.codexDir, home + "/.codex")

        let custom = AgentConfigPaths.resolve(homeDir: home, env: [
            "CLAUDE_CONFIG_DIR": "~/custom claude",
            "CODEX_HOME": "/custom/codex"
        ])
        try expectEqual(custom.claudeDir, home + "/custom claude")
        try expectEqual(custom.codexDir, "/custom/codex")
    }

    static func streamTranscriptAndRetryLateTitle() throws {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: tmp) }
        let dir = tmp.appendingPathComponent("projects/example")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let id = UUID().uuidString.lowercased()
        func lookup() -> String? { SessionTitles.readClaudeSessionTitle(sessionId: id, claudeHome: tmp.path) }
        try expect(lookup() == nil)
        let now = Date(timeIntervalSince1970: 100)
        let first = TitleRetry(previous: nil, now: now)
        try expectEqual(first.after.timeIntervalSince(now), 5)
        try expectEqual(TitleRetry(previous: first, now: first.after).after.timeIntervalSince(first.after), 10)
        let lines = [String(repeating: "x", count: 100_000),
                     #"{"type":"ai-title","sessionId":"\#(id)","aiTitle":"automatic"}"#,
                     "{incomplete",
                     #"{"type":"custom-title","sessionId":"\#(id)","customTitle":"重命名"}"#]
        try lines.joined(separator: "\n").write(to: dir.appendingPathComponent("\(id).jsonl"), atomically: true, encoding: .utf8)
        try expectEqual(lookup(), "重命名")
    }
}
