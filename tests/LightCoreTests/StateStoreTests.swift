import Foundation
@testable import LightCore

enum StateStoreTests {
    static let allTests: [(String, () throws -> Void)] = [
        ("StateStore.workingDoneAndIdleTransitions", workingDoneAndIdleTransitions),
        ("StateStore.codexChildToolsAfterStop", codexChildToolsAfterStop),
        ("StateStore.autoApprovalFailedUnreadAndAcknowledge", autoApprovalFailedUnreadAndAcknowledge),
        ("StateStore.pinnedPersistenceReadWriteAndReadOnly", pinnedPersistenceReadWriteAndReadOnly),
        ("StateStore.sessionOrderingPriority", sessionOrderingPriority),
    ]

    static func workingDoneAndIdleTransitions() throws {
        let store = StateStore()
        let now = Date()

        let ev1 = store.ingest(RawIncomingEvent(
            agent: .claudeCode,
            type: .userPrompt,
            sessionId: "11111111-2222-3333-4444-555555555555",
            message: "Fix the bug",
            timestamp: ISO8601Date.string(from: now)
        ))
        try expectEqual(ev1.agent, .claudeCode)

        var snap = store.getState()
        try expectEqual(snap.sessions.count, 1)
        try expectEqual(snap.sessions[0].status, .working)
        try expectEqual(snap.sessions[0].lastPrompt, "Fix the bug")

        _ = store.ingest(RawIncomingEvent(
            agent: .claudeCode,
            type: .stop,
            sessionId: "11111111-2222-3333-4444-555555555555",
            timestamp: ISO8601Date.string(from: now.addingTimeInterval(3))
        ))

        snap = store.getState()
        try expectEqual(snap.sessions[0].status, .done)
        try expectEqual(snap.sessions[0].turnEnd?.type, .stop)

        // Unpinned sessionEnd removes the session from the active list
        _ = store.ingest(RawIncomingEvent(
            agent: .claudeCode,
            type: .sessionEnd,
            sessionId: "11111111-2222-3333-4444-555555555555",
            timestamp: ISO8601Date.string(from: now.addingTimeInterval(4))
        ))
        snap = store.getState()
        try expectEqual(snap.sessions.count, 0)
    }

    static func codexChildToolsAfterStop() throws {
        let store = StateStore()
        let sid = "11111111-2222-3333-4444-555555555555"
        func send(_ type: EventType, turn: String) {
            _ = store.ingest(RawIncomingEvent(agent: .codex, type: type, sessionId: sid, turnId: turn))
        }

        send(.userPrompt, turn: "parent")
        send(.stop, turn: "parent")
        let stopped = try require(store.getState().sessions.first)
        for type in [EventType.toolResult, .toolUse, .approvalRequest, .toolResult] {
            send(type, turn: "child")
            let current = try require(store.getState().sessions.first)
            try expectEqual(current.status, .done)
            try expectEqual(current.turnEnd?.timestamp, stopped.turnEnd?.timestamp)
            try expectEqual(current.recent.map(\.type), [.stop, .userPrompt])
        }

        send(.userPrompt, turn: "next")
        send(.approvalRequest, turn: "next")
        try expectEqual(store.getState().sessions.first?.status, .waiting)
        send(.toolResult, turn: "next")
        try expectEqual(store.getState().sessions.first?.status, .working)
    }

    static func autoApprovalFailedUnreadAndAcknowledge() throws {
        let store = StateStore()
        let now = Date()
        let sid = "22222222-2222-3333-4444-555555555555"

        _ = store.ingest(RawIncomingEvent(
            agent: .codex,
            type: .userPrompt,
            sessionId: sid,
            message: "Deploy",
            timestamp: ISO8601Date.string(from: now)
        ))

        store.recordCodexDenial(thread: sid, reason: "Command requires manual approval")
        var snap = store.getState()
        let session = try require(snap.sessions.first)
        try expectEqual(session.status, .autoApprovalFailed)
        try expectEqual(session.unreadApprovals?.count, 1)
        let aid = try require(session.unreadApprovals?.first?.approvalId)

        // Clearing events preserves unread approvals
        store.clearEvents()
        snap = store.getState()
        try expectEqual(snap.sessions[0].unreadApprovals?.count, 1)

        // Acknowledging clears unread
        store.acknowledgeApproval(key: session.key, id: aid)
        snap = store.getState()
        try expect(snap.sessions[0].unreadApprovals == nil)
    }

    static func pinnedPersistenceReadWriteAndReadOnly() throws {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("light-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        let pinnedPath = tmp.appendingPathComponent("pinned-sessions.json").path

        let store1 = StateStore()
        store1.configurePersistence(pinnedFilePath: pinnedPath, mode: .readWrite)

        let sid = "33333333-2222-3333-4444-555555555555"
        let now = Date()
        _ = store1.ingest(RawIncomingEvent(
            agent: .claudeCode,
            type: .userPrompt,
            sessionId: sid,
            cwd: "/tmp",
            terminal: TerminalPayload(kind: "rex", id: "block:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", session: "session:11111111-2222-3333-4444-555555555555"),
            message: "Pinned task",
            timestamp: ISO8601Date.string(from: now)
        ))

        let key = "claude-code::\(sid)"
        try expect(store1.setPinned(key: key, pinned: true))

        // Reload in read-only mode
        let store2 = StateStore()
        store2.configurePersistence(pinnedFilePath: pinnedPath, mode: .readOnly)
        let loaded = store2.getState().sessions
        try expectEqual(loaded.count, 1)
        try expectEqual(loaded[0].key, key)
        try expect(loaded[0].isPinned)
        try expectEqual(loaded[0].jumpTarget, .rex)
        try expectEqual(loaded[0].lastPrompt, "Pinned task")
    }

    static func sessionOrderingPriority() throws {
        let store = StateStore()
        let base = Date()

        _ = store.ingest(RawIncomingEvent(agent: .codex, type: .userPrompt, sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", timestamp: ISO8601Date.string(from: base)))
        _ = store.ingest(RawIncomingEvent(agent: .claudeCode, type: .error, sessionId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", message: "boom", timestamp: ISO8601Date.string(from: base.addingTimeInterval(1))))
        _ = store.ingest(RawIncomingEvent(agent: .antigravity, type: .autoApprovalFailed, sessionId: "cccccccc-cccc-cccc-cccc-cccccccccccc", message: "denied", timestamp: ISO8601Date.string(from: base.addingTimeInterval(2))))

        let statuses = store.getState().sessions.map(\.status)
        try expectEqual(statuses, [.error, .autoApprovalFailed, .working])
    }
}
