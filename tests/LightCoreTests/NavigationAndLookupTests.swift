import Foundation
import SQLite3
import Network
@testable import LightCore

enum NavigationAndLookupTests {
    static let allTests: [(String, () throws -> Void)] = [
        ("Navigation.shellQuoteAndBuildResumeCommand", shellQuoteAndBuildResumeCommand),
        ("RexNavigation.focusesLiveBlock", rexNavigationFocusesLiveBlock),
        ("RexNavigation.reopensMissingBlockWithResumeCommand", rexNavigationReopensMissingBlockWithResumeCommand),
        ("RexNavigation.checksClaudeSessionBeforeFocus", rexChecksClaudeSessionBeforeFocus),
        ("RexNavigation.findsMovedClaudeOrOffersRestore", findsMovedClaudeOrOffersRestore),
        ("RexNavigation.codexThreadRouting", codexThreadRouting),
        ("SQLite.codexOriginatorAndGuardianDenial", nativeSQLiteCodexOriginatorAndGuardianDenial),
        ("AppPresence.probeAndMarkNotInstalled", appPresenceWatcherProbeAndMarkNotInstalled),
    ]

    static func shellQuoteAndBuildResumeCommand() throws {
        try expectEqual(SessionNavigation.shellQuote("simple"), "'simple'")
        try expectEqual(SessionNavigation.shellQuote("with space"), "'with space'")
        try expectEqual(SessionNavigation.shellQuote("a'b"), "'a'\\''b'")

        let claude = SessionNavigation.buildResumeCommand(
            ResumeSpec(agent: .claudeCode, sessionId: "11111111-2222-3333-4444-555555555555", cwd: "/tmp"),
            dirExists: { $0 == "/tmp" }
        )
        try expectEqual(claude?.argv ?? [], ["claude", "--resume", "11111111-2222-3333-4444-555555555555"])
        try expectEqual(claude?.cwd, "/tmp")

        let codex = SessionNavigation.buildResumeCommand(
            ResumeSpec(agent: .codex, sessionId: "22222222-2222-3333-4444-555555555555", cwd: "/nonexistent"),
            dirExists: { _ in false }
        )
        try expectEqual(codex?.argv ?? [], ["codex", "resume", "22222222-2222-3333-4444-555555555555"])
        try expect(codex?.cwd == nil)
    }

    static func rexNavigationFocusesLiveBlock() throws {
        final class CallsBox: @unchecked Sendable { var calls: [[String]] = [] }
        let box = CallsBox()
        let res = try RexNavigation.openOrReopenPane(
            session: "session:11111111-2222-3333-4444-555555555555",
            block: "block:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            cli: "/usr/local/bin/rex",
            exec: { _, args, _ in
                box.calls.append(args)
                if args.contains("client") {
                    return #"{"clients":[{"client_id":"client:11111111-2222-3333-4444-555555555555","connection_state":"connected","info":{"kind":"app","platform":"macos"},"principal":{"transport":"unix"}}]}"#
                }
                if args.contains("inspect") {
                    return #"{"session_id":"session:11111111-2222-3333-4444-555555555555","block":{"block_id":"block:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","window_id":"window:11111111-2222-3333-4444-555555555555"}}"#
                }
                return "{}"
            }
        )
        try expect(!res.reopened)
        try expectEqual(res.id, "block:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
        try expect(box.calls.contains(where: { $0.contains("focus") }))
    }

    static func rexNavigationReopensMissingBlockWithResumeCommand() throws {
        var updatedPane: (session: String, id: String)?
        let res = try RexNavigation.openOrReopenPane(
            session: "session:11111111-2222-3333-4444-555555555555",
            block: "block:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            resumeArgv: ["claude", "--resume", "11111111-2222-3333-4444-555555555555"],
            resumeCwd: "/tmp",
            cli: "/usr/local/bin/rex",
            exec: { _, args, _ in
                if args.contains("client") {
                    return #"{"clients":[{"client_id":"client:11111111-2222-3333-4444-555555555555","connection_state":"connected","info":{"kind":"app","platform":"macos"},"principal":{"transport":"unix"}}]}"#
                }
                if args.contains("inspect") {
                    throw NavigationError("block not found")
                }
                if args.contains("ls") {
                    if args.contains("block") { return #"{"blocks":[]}"# }
                    return #"{"sessions":[{"session_id":"session:11111111-2222-3333-4444-555555555555"}]}"#
                }
                if args.contains("new") {
                    return #"{"window_id":"window:11111111-2222-3333-4444-555555555555","block_ids":["block:bbbbbbbb-cccc-dddd-eeee-ffffffffffff"]}"#
                }
                return "{}"
            },
            onPaneReopened: { pane in
                updatedPane = pane
            }
        )
        try expect(res.reopened)
        try expectEqual(res.id, "block:bbbbbbbb-cccc-dddd-eeee-ffffffffffff")
        try expectEqual(updatedPane?.id, "block:bbbbbbbb-cccc-dddd-eeee-ffffffffffff")
    }

    static func rexChecksClaudeSessionBeforeFocus() throws {
        let fm = FileManager.default
        let config = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let records = config.appendingPathComponent("sessions")
        try fm.createDirectory(at: records, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: config) }

        let target = "11111111-2222-3333-4444-555555555555"
        let other = "22222222-3333-4444-5555-666666666666"
        let session = "session:" + target
        let oldBlock = "block:" + target
        let newBlock = "block:" + other
        let claude = #"{"pid":31,"name":"2.1.331","invoked_path":"/bin/claude"}"#
        let shell = #"{"pid":12,"name":"zsh"}"#
        let make = #"{"pid":28,"name":"gnumake"}"#

        func process(_ foreground: String, _ parents: [String]) -> String {
            #"{"foreground":\#(foreground),"ancestors":[\#(parents.joined(separator: ","))]}"#
        }
        let childOnly = #"{"last_exit":null,"child":{"pid":10,"name":"login"}}"#
        let noForeground = "10 1 10 99 /usr/bin/login\n12 10 12 99 -zsh\n28 12 28 99 /usr/bin/make"
        let liveClaude = "10 1 10 31 /usr/bin/login\n12 10 12 31 -zsh\n31 12 31 31 claude"
        let toolRunning = "10 1 10 28 login\n12 10 12 28 zsh\n31 12 31 28 claude\n28 31 28 28 make"
        let backgroundClaude = "10 1 10 28 login\n12 10 12 28 zsh\n31 12 31 28 claude\n28 12 28 28 make"
        let cases: [(String, String?, String, Bool?)] = [
            (process(claude, [shell]), nil, target, false),
            (process(make, [claude, shell]), nil, target, false),
            (process(claude, [shell]), nil, other, true),
            (process(make, [shell]), nil, target, true),
            (process(shell, []), nil, target, true),
            (process(claude, [shell]), nil, "", nil),
            (childOnly, noForeground, target, true),
            (childOnly, liveClaude, target, false),
            (childOnly, liveClaude, other, true),
            (childOnly, toolRunning, target, false),
            (childOnly, backgroundClaude, target, true),
            (childOnly, "12 1 12 12 -zsh", target, nil)
        ]
        for (processJSON, ttyListing, registered, shouldReopen) in cases {
            let file = records.appendingPathComponent("31.json")
            try Data(#"{"pid":31,"sessionId":"\#(registered)"}"#.utf8).write(to: file)
            final class Calls: @unchecked Sendable { var runs: [[String]] = []; var sends: [[String]] = []; var focused: [String] = [] }
            let calls = Calls()
            do {
                let result = try SessionNavigation.openOrReopenJumpTarget(
                    .rex(session: session, id: oldBlock),
                    resume: ResumeSpec(agent: .claudeCode, sessionId: target, cwd: "/tmp"),
                    exec: { executable, args, _ in
                        if executable == "/bin/ps" {
                            let listing = try require(ttyListing)
                            if args == ["-p", "10", "-o", "tty="] { return " ttys009\n" }
                            try expectEqual(args, ["-t", "ttys009", "-o", "pid=,ppid=,pgid=,tpgid=,comm="])
                            return listing
                        }
                        if args.contains("client") {
                            return #"{"clients":[{"client_id":"client:\#(target)","connection_state":"connected","info":{"kind":"app","platform":"macos"},"principal":{"transport":"unix"}}]}"#
                        }
                        if args.contains("inspect") {
                            return #"{"session_id":"\#(session)","block":{"block_id":"\#(oldBlock)","window_id":"window:\#(target)"}}"#
                        }
                        if args.last == "process" {
                            try expectEqual(Array(args.suffix(7)), ["block", "call", "-s", session, "-b", oldBlock, "process"])
                            return processJSON
                        }
                        if args.contains("ls") {
                            if args.contains("block") { return #"{"blocks":[]}"# }
                            return #"{"sessions":[{"session_id":"\#(session)"}]}"#
                        }
                        if args.contains("send") { calls.sends.append(args) }
                        if args.contains("new") {
                            calls.runs.append(args)
                            return #"{"window_id":"window:\#(other)","block_ids":["\#(newBlock)"]}"#
                        }
                        if let index = args.firstIndex(of: "focus") { calls.focused.append(args[index + 1]) }
                        return ""
                    },
                    rexCli: "rex", claudeConfigDir: config.path
                )
                let reopen = try require(shouldReopen)
                try expectEqual(result.reopened, reopen)
                try expectEqual(result.updatedTarget, reopen ? .rex(session: session, id: newBlock) : nil)
                try expectEqual(calls.focused, [reopen ? newBlock : oldBlock])
                try expectEqual(calls.runs.map { Array($0.dropFirst(3)) },
                                reopen ? [["window", "new", "-s", session, "--json", "-c", "/tmp"]] : [])
                try expectEqual(calls.sends.map { Array($0.dropFirst(3)) },
                                reopen ? [["send", "-s", session, "-w", "window:" + other, "-b", newBlock, "--",
                                           "'claude' '--resume' '\(target)'\r"]] : [])
            } catch is RexSessionLocationUnknown where shouldReopen == nil {
                try expect(calls.runs.isEmpty && calls.focused.isEmpty)
            }
        }
    }

    static func findsMovedClaudeOrOffersRestore() throws {
        let config = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let records = config.appendingPathComponent("sessions")
        try FileManager.default.createDirectory(at: records, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: config) }
        let id = UUID().uuidString.lowercased()
        let original = "session:" + id
        let oldBlock = "block:" + id
        let otherID = UUID().uuidString.lowercased()
        let other = "session:" + otherID
        let moved = "block:" + otherID
        let window = "window:" + otherID
        try Data(#"{"pid":42,"sessionId":"\#(id)"}"#.utf8).write(to: records.appendingPathComponent("42.json"))

        for (live, allowRestore) in [(true, false), (true, true), (false, false), (false, true)] {
            final class Calls: @unchecked Sendable { var sends = 0; var focused: [String] = [] }
            let calls = Calls()
            var remembered: JumpTarget?
            do {
                let result = try SessionNavigation.openOrReopenJumpTarget(
                    .rex(session: original, id: oldBlock), resume: ResumeSpec(agent: .claudeCode, sessionId: id, cwd: nil),
                    exec: { _, args, _ in
                        if args.contains("client") {
                            return #"{"clients":[{"client_id":"client:\#(id)","connection_state":"connected","info":{"kind":"app","platform":"macos"},"principal":{"transport":"unix"}}]}"#
                        }
                        if args.contains("inspect") {
                            return #"{"session_id":"\#(original)","block":{"window_id":"\#(window)","block_id":"\#(oldBlock)"}}"#
                        }
                        if args.contains("ls") && args.contains("block") {
                            if args.contains(original) { return #"{"blocks":[]}"# }
                            return #"{"blocks":[{"creator_name":"com.superlogical.terminal","block_id":"\#(moved)","window_id":"\#(window)"}]}"#
                        }
                        if args.contains("ls") {
                            return #"{"sessions":[{"session_id":"\#(original)"},{"session_id":"\#(other)"}]}"#
                        }
                        if args.last == "process" {
                            if args.contains(oldBlock) { return "{}" }
                            return live ? #"{"foreground":{"pid":42,"name":"claude"},"ancestors":[]}"# : #"{"last_exit":{}}"#
                        }
                        if args.contains("new") {
                            return #"{"window_id":"\#(window)","block_ids":["\#(moved)"]}"#
                        }
                        if args.contains("send") { calls.sends += 1 }
                        if let index = args.firstIndex(of: "focus") { calls.focused.append(args[index + 1]) }
                        return ""
                    }, rexCli: "rex", claudeConfigDir: config.path, allowUnverifiedRestore: allowRestore,
                    onTargetUpdated: { remembered = $0 }
                )
                try expect(live || allowRestore)
                try expectEqual(result.reopened, !live)
                try expectEqual(remembered, .rex(session: live ? other : original, id: moved))
                try expectEqual(calls.focused, [moved])
                try expectEqual(calls.sends, live ? 0 : 1)
            } catch is RexSessionLocationUnknown {
                try expect(!live && !allowRestore)
                try expect(remembered == nil && calls.focused.isEmpty && calls.sends == 0)
            }
        }
    }

    static func codexThreadRouting() throws {
        enum Route { case original, moved, restore, unknown }
        let id = UUID().uuidString.lowercased()
        let other = UUID().uuidString.lowercased()
        let session = "session:" + id, otherSession = "session:" + other
        let original = "block:" + id, moved = "block:" + other
        let created = "block:" + UUID().uuidString.lowercased()
        let window = "window:" + id
        let cli = #"{"child":{"pid":41,"name":"codex"},"foreground":{"pid":41,"name":"codex"}}"#
        let shell = #"{"foreground":{"pid":31,"name":"zsh"},"ancestors":[]}"#
        let secondCLI = #"{"foreground":{"pid":51,"name":"codex"},"ancestors":[]}"#
        func lock(pid: Int, parent: Int, thread: String) -> String {
            "p\(pid)\nR\(parent)\nf42\nn/tmp/test/thread-writer-locks/\(thread).lock\n"
        }
        let direct = lock(pid: 41, parent: 31, thread: id)
        let child = lock(pid: 42, parent: 41, thread: id)
        let different = lock(pid: 42, parent: 41, thread: other)
        let elsewhere = lock(pid: 52, parent: 51, thread: id)
        let cases: [(String, String, String?, Bool, Route)] = [
            (cli, shell, direct, false, .original),
            (cli, shell, child, false, .original),
            (cli, secondCLI, different + elsewhere, false, .moved),
            (cli, secondCLI, elsewhere, false, .moved),
            (cli, shell, different, false, .restore),
            (shell, shell, nil, false, .restore),
            (cli, shell, child + different, false, .unknown),
            (cli, shell, nil, false, .unknown),
            (cli, shell, "", true, .restore)
        ]
        for (first, second, locks, allowRestore, route) in cases {
            final class Calls: @unchecked Sendable {
                var snapshots = 0, tabs = 0
                var focused: [String] = [], sends: [[String]] = []
            }
            let calls = Calls()
            var remembered: JumpTarget?
            do {
                let result = try SessionNavigation.openOrReopenJumpTarget(
                    .rex(session: session, id: original), resume: ResumeSpec(agent: .codex, sessionId: id, cwd: "/tmp"),
                    exec: { exe, args, _ in
                        if exe == "/usr/sbin/lsof" {
                            calls.snapshots += 1
                            guard let locks else { throw NavigationError("unavailable") }
                            return locks
                        }
                        if args.contains("client") {
                            return #"{"clients":[{"client_id":"client:\#(id)","connection_state":"connected","info":{"kind":"app","platform":"macos"},"principal":{"transport":"unix"}}]}"#
                        }
                        if args.contains("inspect") {
                            return #"{"session_id":"\#(session)","block":{"window_id":"\#(window)","block_id":"\#(original)"}}"#
                        }
                        if args.contains("ls") && args.contains("block") {
                            let b = args.contains(otherSession) ? moved : original
                            return #"{"blocks":[{"creator_name":"com.superlogical.terminal","block_id":"\#(b)","window_id":"\#(window)"}]}"#
                        }
                        if args.contains("ls") {
                            return #"{"sessions":[{"session_id":"\#(session)"},{"session_id":"\#(otherSession)"}]}"#
                        }
                        if args.last == "process" { return args.contains(original) ? first : second }
                        if args.contains("new") {
                            calls.tabs += 1
                            try expectEqual(Array(args.dropFirst(3)), ["window", "new", "-s", session, "--json", "-c", "/tmp"])
                            return #"{"window_id":"\#(window)","block_ids":["\#(created)"]}"#
                        }
                        if args.contains("send") { calls.sends.append(Array(args.dropFirst(3))) }
                        if let index = args.firstIndex(of: "focus") { calls.focused.append(args[index + 1]) }
                        return ""
                    }, rexCli: "rex", allowUnverifiedRestore: allowRestore, onTargetUpdated: { remembered = $0 }
                )
                try expect(route != .unknown)
                try expectEqual(result.reopened, route == .restore)
                let block = route == .original ? original : (route == .moved ? moved : created)
                try expectEqual(calls.focused, [block])
                try expectEqual(remembered, route == .original ? nil : .rex(session: route == .moved ? otherSession : session, id: block))
            } catch is RexSessionLocationUnknown {
                try expect(route == .unknown && calls.focused.isEmpty && remembered == nil)
            }
            try expectEqual(calls.tabs, route == .restore ? 1 : 0)
            try expectEqual(calls.sends, route == .restore ? [["send", "-s", session, "-w", window, "-b", created, "--",
                                                               "'codex' 'resume' '\(id)'\r"]] : [])
            try expectEqual(calls.snapshots, first == shell && second == shell ? 0 : 1)
        }
    }

    static func nativeSQLiteCodexOriginatorAndGuardianDenial() throws {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("light-sqlite-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        let dbPath = tmp.appendingPathComponent("state_5.sqlite").path

        let threadId = "11111111-2222-3333-4444-555555555555"
        let turnId = "22222222-2222-3333-4444-555555555555"

        var db: OpaquePointer?
        try expectEqual(sqlite3_open(dbPath, &db), SQLITE_OK)
        defer { sqlite3_close(db) }

        let recordJSON = """
        {"reviewed_thread_id":"\(threadId)","reviewed_turn_id":"\(turnId)","status":"denied","decision":{"rationale":"unsafe shell command"}}
        """
        let schema = """
        CREATE TABLE threads (id TEXT PRIMARY KEY, originator TEXT);
        INSERT INTO threads (id, originator) VALUES ('\(threadId)', 'Codex Desktop');
        CREATE TABLE guardian_review_feedback (id TEXT PRIMARY KEY, thread_id TEXT, record TEXT);
        INSERT INTO guardian_review_feedback (id, thread_id, record) VALUES ('rev-1', '\(threadId)', '\(recordJSON)');
        """
        try expectEqual(sqlite3_exec(db, schema, nil, nil, nil), SQLITE_OK)

        let target = DesktopDestinationLookup.lookup(
            agent: .codex,
            id: threadId,
            refresh: true,
            codexDatabase: dbPath
        )
        try expectEqual(target, .codex(id: threadId))

        let denials = CodexReviewWatcher.readCodexDenials(databasePath: dbPath, turns: [threadId: turnId])
        try expectEqual(denials.count, 1)
        try expectEqual(denials[0].reason, "unsafe shell command")

        let deniedSem = DispatchSemaphore(value: 0)
        final class ReasonBox: @unchecked Sendable { var value = "" }
        let reasonBox = ReasonBox()

        let watcher = CodexReviewWatcher(dbPath: dbPath) { _, reason in
            reasonBox.value = reason ?? ""
            deniedSem.signal()
        }
        watcher.track(thread: threadId, turn: turnId, event: .userPrompt)
        try expectEqual(deniedSem.wait(timeout: .now() + 4), .success)
        watcher.stop()
        try expectEqual(reasonBox.value, "unsafe shell command")
    }

    static func appPresenceWatcherProbeAndMarkNotInstalled() throws {
        final class Box: @unchecked Sendable {
            var installed = Set(["com.openai.codex"])
            var observed: [PresenceState] = []
        }
        let box = Box()
        let watcher = PresenceWatcher(
            probeBundleInstalled: { box.installed.contains($0) },
            onChange: { state in box.observed.append(state) }
        )
        watcher.start()
        try expect(watcher.getState().isInstalled(.codex))
        try expect(!watcher.getState().isInstalled(.claudeCode))

        watcher.markNotInstalled(.codex)
        try expect(!watcher.getState().isInstalled(.codex))
        try expect(box.observed.count >= 2)
    }
}

enum LightHookCLITests {
    static let allTests: [(String, () throws -> Void)] = [
        ("LightHook.claudeAndAntigravityEndToEnd", claudeAndAntigravityEndToEnd),
        ("LightHook.antigravityRepliesWhenPeerDisconnects", antigravityRepliesWhenPeerDisconnects),
    ]

    static func claudeAndAntigravityEndToEnd() throws {
        let execDir = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent()
        let hookBin = execDir.appendingPathComponent("light-hook").path
        try expect(FileManager.default.isExecutableFile(atPath: hookBin), "Missing light-hook executable at \(hookBin)")

        let store = StateStore()
        let ready = DispatchSemaphore(value: 0)
        final class PortBox: @unchecked Sendable { var value: UInt16 = 0 }
        let portBox = PortBox()

        let server = LocalHTTPServer(store: store, port: 0, onState: { state in
            if case .listening(let p) = state {
                portBox.value = p
                ready.signal()
            }
        })
        server.start()
        defer { server.stop() }
        try expectEqual(ready.wait(timeout: .now() + 5), .success)

        var env = ProcessInfo.processInfo.environment
        env["LIGHT_PORT"] = String(portBox.value)
        env["REX_SESSION"] = "session:11111111-2222-3333-4444-555555555555"
        env["REX_BLOCK"] = "block:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        let id = "55555555-2222-3333-4444-555555555555"
        func postClaude(_ event: String, _ fields: [String: Any]) throws {
            var payload = fields
            payload["session_id"] = id
            payload["cwd"] = "/tmp"
            let process = Process()
            process.executableURL = URL(fileURLWithPath: hookBin)
            process.arguments = ["claude", event]
            process.environment = env
            let input = Pipe()
            process.standardInput = input
            try process.run()
            try input.fileHandleForWriting.write(contentsOf: JSONSerialization.data(withJSONObject: payload))
            try input.fileHandleForWriting.close()
            process.waitUntilExit()
            try expectEqual(process.terminationStatus, 0)
        }

        let longPrompt = String(repeating: "a", count: 40 * 1024)
        let longCommand = String(repeating: "日志", count: 8000)
        let combining = "OK " + "a" + String(repeating: "\u{0301}", count: 20000)
        for (prompt, summary) in [
            ("ship swift", "ship swift"),
            (longPrompt, String(longPrompt.prefix(400)) + "…"),
            (combining, "OK …")
        ] {
            try postClaude("user_prompt", ["prompt": prompt])
            let session = try require(store.getState().sessions.first)
            try expectEqual(session.key, "claude-code::" + id)
            try expectEqual(session.recent.first?.type, .userPrompt)
            try expectEqual(session.lastPrompt, summary)
        }
        try postClaude("tool_use", ["tool_name": "Bash", "tool_use_id": "test-call", "tool_input": ["command": longCommand]])
        let tool = try require(store.getState().sessions.first?.recent.first)
        try expectEqual(tool.type, .toolUse)
        try expectEqual(tool.toolCallId, "test-call")
        try expectEqual(tool.message, String(("Bash: " + longCommand).prefix(400)) + "…")

        // Verify Antigravity still returns a passive {} response.
        try checkAntigravityReply(hookBin: hookBin, environment: env)

        // Verify both events landed in StateStore
        let sessions = store.getState().sessions
        try expectEqual(sessions.count, 2)
        let claude = try require(sessions.first(where: { $0.agent == .claudeCode }))
        try expectEqual(claude.jumpTarget, .rex)

        let ag = try require(sessions.first(where: { $0.agent == .antigravity }))
        try expectEqual(ag.status, .working)

        let cases: [(String, [String: Any], EventType, String?)] = [
            ("Stop", ["terminationReason": "DONE", "error": ""], .stop, "DONE"),
            ("Stop", ["fullyIdle": false, "error": "  \n"], .toolResult, "后台任务仍在运行"),
            ("Stop", ["terminationReason": "ERROR", "error": ""], .error, "ERROR"),
            ("Stop", ["error": "request failed"], .error, "request failed"),
            ("PostToolUse", ["toolCall": ["name": "view_file"], "error": ""], .toolResult, "view_file completed"),
            ("PostToolUse", ["error": "file missing"], .toolResult, "工具失败：file missing")
        ]
        for (hookEvent, fields, expectedType, expectedMessage) in cases {
            try checkAntigravityReply(hookBin: hookBin, environment: env, event: hookEvent, fields: fields)
            let latest = try require(store.getState().sessions.first { $0.key == ag.key }?.recent.first)
            try expectEqual(latest.type, expectedType)
            try expectEqual(latest.message, expectedMessage)
        }
    }

    static func antigravityRepliesWhenPeerDisconnects() throws {
        let executable = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent().appendingPathComponent("light-hook")
        try expect(FileManager.default.isExecutableFile(atPath: executable.path))
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
        let listener = try NWListener(using: parameters)
        let ready = DispatchSemaphore(value: 0)
        let disconnected = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { state in
            if case .ready = state { ready.signal() }
        }
        listener.newConnectionHandler = { connection in
            connection.cancel()
            disconnected.signal()
        }
        listener.start(queue: DispatchQueue(label: "LightHookTests.disconnect"))
        defer { listener.cancel() }
        try expectEqual(ready.wait(timeout: .now() + 5), .success)
        var env = ProcessInfo.processInfo.environment
        env["LIGHT_PORT"] = String(try require(listener.port).rawValue)
        try checkAntigravityReply(hookBin: executable.path, environment: env)
        try expectEqual(disconnected.wait(timeout: .now() + 5), .success)
    }

    private static func checkAntigravityReply(hookBin: String, environment: [String: String],
                                              event: String = "PreInvocation", fields: [String: Any] = ["invocationNum": 0]) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: hookBin)
        process.arguments = ["antigravity", event]
        process.environment = environment
        let input = Pipe()
        let output = Pipe()
        process.standardInput = input
        process.standardOutput = output
        try process.run()
        var payload = fields
        payload["conversationId"] = "66666666-2222-3333-4444-555555555555"
        try input.fileHandleForWriting.write(contentsOf: JSONSerialization.data(withJSONObject: payload))
        try input.fileHandleForWriting.close()
        let response = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        try expectEqual(process.terminationStatus, 0)
        try expectEqual(response, Data("{}\n".utf8))
    }
}
