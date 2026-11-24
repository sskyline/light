import CoreGraphics
@testable import LightCore

enum PanelPlacementTests {
    static let allTests: [(String, () throws -> Void)] = [
        ("PanelPlacement.capsuleClampedWithinVisibleArea", capsuleClampedWithinVisibleArea),
        ("PanelPlacement.dropdownOpensAboveWhenNearBottom", dropdownOpensAboveWhenNearBottom),
        ("PanelPlacement.resolveDisplayMatchesIDThenKeyThenMouse", resolveDisplayMatchesIDThenKeyThenMouse),
    ]

    static func capsuleClampedWithinVisibleArea() throws {
        let area = CGRect(x: 0, y: 0, width: 1440, height: 900)
        let res = computeCapsulePlacement(
            anchor: CGPoint(x: -50, y: 980),
            area: area,
            capsuleSize: CGSize(width: 120, height: 36)
        )
        try expectEqual(res.frame.minX, 0)
        try expectEqual(res.frame.maxY, 900)
        try expect(!res.layout.above)
    }

    static func dropdownOpensAboveWhenNearBottom() throws {
        let area = CGRect(x: 0, y: 0, width: 1440, height: 900)
        let capsuleFrame = CGRect(x: 660, y: 40, width: 120, height: 36)
        let drop = computeDropdownFrame(
            capsuleFrame: capsuleFrame,
            panelSize: CGSize(width: 384, height: 300),
            area: area
        )
        try expect(drop.above)
        try expectEqual(drop.frame.minY, capsuleFrame.maxY + 9)
        try expectEqual(drop.frame.width, 384)
    }

    static func resolveDisplayMatchesIDThenKeyThenMouse() throws {
        let d1 = DisplayDescriptor(id: 1, key: "Built-in|1512x982|scale:2", frame: CGRect(x: 0, y: 0, width: 1512, height: 982), visibleFrame: CGRect(x: 0, y: 0, width: 1512, height: 950))
        let d2 = DisplayDescriptor(id: 2, key: "Studio|2560x1440|scale:2", frame: CGRect(x: 1512, y: 0, width: 2560, height: 1440), visibleFrame: CGRect(x: 1512, y: 0, width: 2560, height: 1400))

        let byKey = resolveDisplay(
            saved: SavedCapsulePosition(displayID: 99, displayKey: "Studio|2560x1440|scale:2", x: 500, top: 64),
            displays: [d1, d2],
            mouseLocation: CGPoint(x: 100, y: 100),
            mainDisplayID: 1
        )
        try expectEqual(byKey?.display.id, 2)
        try expectEqual(byKey?.matchedSaved, true)

        let byMouse = resolveDisplay(
            saved: nil,
            displays: [d1, d2],
            mouseLocation: CGPoint(x: 2000, y: 300),
            mainDisplayID: 1
        )
        try expectEqual(byMouse?.display.id, 2)
        try expectEqual(byMouse?.matchedSaved, false)
    }
}

enum ProgressOrderTests {
    static let allTests: [(String, () throws -> Void)] = [
        ("ProgressOrder.selectsLatestTurnAndPreservesUnreadApprovals", selectsLatestTurnAndPreservesUnreadApprovals),
        ("ProgressOrder.pairsToolCallAndResultIntoSingleActivityRow", pairsToolCallAndResultIntoSingleActivityRow),
    ]

    static func selectsLatestTurnAndPreservesUnreadApprovals() throws {
        let oldApproval = LightEvent(agent: .codex, type: .autoApprovalFailed, sessionId: "s", approvalId: 1, message: "Denied", timestamp: "2026-01-01T10:00:00.000Z")
        let oldPrompt = LightEvent(agent: .codex, type: .userPrompt, sessionId: "s", message: "Old", timestamp: "2026-01-01T09:59:00.000Z")
        let newPrompt = LightEvent(agent: .codex, type: .userPrompt, sessionId: "s", message: "New", timestamp: "2026-01-01T10:05:00.000Z")
        let newTool = LightEvent(agent: .codex, type: .toolUse, sessionId: "s", tool: "Bash", message: "ls", timestamp: "2026-01-01T10:05:05.000Z")

        let visible = ProgressOrder.selectVisibleProgressEvents(
            recent: [oldPrompt, oldApproval, newPrompt, newTool],
            unread: [oldApproval]
        )
        let types: [EventType] = visible.map(\.type)
        try expectEqual(types, [.toolUse, .userPrompt, .autoApprovalFailed])
    }

    static func pairsToolCallAndResultIntoSingleActivityRow() throws {
        let call = LightEvent(agent: .claudeCode, type: .toolUse, sessionId: "s", tool: "Read", toolCallId: "tc-1", message: "foo.swift", timestamp: "2026-01-01T10:00:01.000Z")
        let result = LightEvent(agent: .claudeCode, type: .toolResult, sessionId: "s", tool: "Read", toolCallId: "tc-1", message: "ok", timestamp: "2026-01-01T10:00:02.000Z")
        let rows = ToolActivity.activityRows([result, call])
        try expectEqual(rows.count, 1)
        try expectEqual(rows[0].call?.type, .toolUse)
        try expectEqual(rows[0].event.type, .toolResult)
        try expectEqual(ToolActivity.toolPhase(rows[0]), "1.0 s")
    }
}
