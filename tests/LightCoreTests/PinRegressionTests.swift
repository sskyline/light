import Foundation
@testable import LightCore

enum PinRegressionTests {
    static let allTests: [(String, () throws -> Void)] = [
        ("Pins.firstNetworkEventKeepsRestoredPin", firstNetworkEventKeepsRestoredPin),
        ("Pins.startupAndTimestampRoundTrip", startupAndTimestampRoundTrip),
        ("Pins.shortKeysPreserveDistinctSessions", shortKeysPreserveDistinctSessions),
        ("Navigation.terminalWinsDuringDesktopLookup", terminalWinsDuringDesktopLookup),
    ]

    private static func withHome(_ body: (URL) throws -> Void) throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("light-pins-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: home) }
        try body(home)
    }

    private static func firstNetworkEventKeepsRestoredPin() throws {
        try withHome { home in
            let path = home.appendingPathComponent("pins.json").path
            let writer = StateStore(pinnedFilePath: path)
            writer.ingest(RawIncomingEvent(agent: .codex, type: .userPrompt, sessionId: "startup"))
            try expect(writer.setPinned(key: "codex::startup", pinned: true))
            let store = StateStore()
            let delivered = DispatchSemaphore(value: 0)
            let server = LocalHTTPServer(store: store, port: 0, prepareForRequests: {
                store.configurePersistence(pinnedFilePath: path, mode: .readWrite)
            }, onState: { state in
                guard case .listening(let port) = state, store.getState().sessions.first?.isPinned == true else { return }
                var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/event")!)
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.httpBody = Data(#"{"agent":"codex","sessionId":"startup","type":"user_prompt","message":"first"}"#.utf8)
                URLSession.shared.dataTask(with: request) { _, response, _ in
                    if (response as? HTTPURLResponse)?.statusCode == 200 { delivered.signal() }
                }.resume()
            })
            server.start()
            defer { server.stop() }
            try expectEqual(delivered.wait(timeout: .now() + 5), .success)
            let session = try require(StateStore(pinnedFilePath: path).getState().sessions.first)
            try expect(session.isPinned)
            try expectEqual(session.lastPrompt, "first")
        }
    }

    private static func startupAndTimestampRoundTrip() throws {
        try withHome { home in
            let file = home.appendingPathComponent("pins.json")
            let key = "claude-code::test"
            let writer = StateStore(pinnedFilePath: file.path)
            let event = writer.ingest(RawIncomingEvent(agent: .claudeCode, type: .userPrompt, sessionId: "test", timestamp: "bad-date"))
            try expect(ISO8601Date.parse(event.timestamp) != nil)
            try expect(writer.setPinned(key: key, pinned: true))
            let reader = StateStore()
            reader.ingest(RawIncomingEvent(agent: .claudeCode, type: .userPrompt, sessionId: "test", message: "first new event"))
            reader.configurePersistence(pinnedFilePath: file.path, mode: .readWrite)
            let live = try require(reader.getState().sessions.first)
            try expect(live.isPinned)
            try expectEqual(live.lastPrompt, "first new event")

            let original = try Data(contentsOf: file)
            reader.suspendPersistence()
            try expect(reader.setPinned(key: key, pinned: false))
            try expectEqual(try Data(contentsOf: file), original)
            let oldData = String(decoding: original, as: UTF8.self).replacingOccurrences(of: event.timestamp, with: "bad-old-date")
            try Data(oldData.utf8).write(to: file)
            let recovered = try require(StateStore(pinnedFilePath: file.path).getState().sessions.first)
            try expect(recovered.isPinned)
            try expect(ISO8601Date.parse(recovered.lastEventAt) != nil)
        }
    }

    private static func shortKeysPreserveDistinctSessions() throws {
        try withHome { home in
            let file = home.appendingPathComponent("pins.json")
            let first = "legacy-prefix-one", second = "legacy-prefix-two"
            let short = Validation.shortSessionId(first)
            try expectEqual(short, Validation.shortSessionId(second))
            let original = StateStore(pinnedFilePath: file.path)
            original.ingest(RawIncomingEvent(agent: .claudeCode, type: .userPrompt, sessionId: short))
            try expect(original.setPinned(key: "claude-code::\(short)", pinned: true))
            let restored = StateStore(pinnedFilePath: file.path)
            for id in [first, second] {
                restored.ingest(RawIncomingEvent(agent: .claudeCode, type: .userPrompt, sessionId: id))
            }
            try expectEqual(restored.getState().sessions.count, 3)
            try expectEqual(restored.getState().sessions.filter(\.isPinned).map(\.key), ["claude-code::\(short)"])
            try expect(restored.setPinned(key: "claude-code::\(first)", pinned: true))
            let afterRestart = StateStore(pinnedFilePath: file.path).getState().sessions
            try expectEqual(Set(afterRestart.map(\.key)), Set(["claude-code::\(short)", "claude-code::\(first)"]))
        }
    }

    private static func terminalWinsDuringDesktopLookup() throws {
        let started = DispatchSemaphore(value: 0)
        let release = DispatchSemaphore(value: 0)
        let returned = DispatchSemaphore(value: 0)
        let sid = "11111111-2222-3333-4444-555555555555"
        let paneID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        let store = StateStore(findDesktopTarget: { _, _, _ in
            started.signal()
            _ = release.wait(timeout: .now() + 3)
            returned.signal()
            return .claudeDesktop(id: "local_\(sid)")
        })
        let key = "claude-code::\(sid)"
        store.ingest(RawIncomingEvent(agent: .claudeCode, type: .userPrompt, sessionId: sid))
        try expectEqual(started.wait(timeout: .now() + 3), .success)
        store.ingest(RawIncomingEvent(agent: .claudeCode, type: .toolUse, sessionId: sid,
                                      terminal: TerminalPayload(kind: "ghostty", id: paneID), terminalProvided: true))
        release.signal()
        try expectEqual(returned.wait(timeout: .now() + 3), .success)

        let done = DispatchSemaphore(value: 0)
        Task.detached {
            let target = await store.resolveSessionDestination(key: key, refresh: true)
            if target == .ghostty(id: paneID) { done.signal() }
        }
        try expectEqual(done.wait(timeout: .now() + 3), .success)
        try expectEqual(store.getJumpTarget(key: key), .ghostty(id: paneID))
        try expectEqual(started.wait(timeout: .now()), .timedOut)
    }
}
