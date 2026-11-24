import LightCore
import SwiftUI

struct ExpandPanelView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let isAboveCapsule: Bool
    @ObservedObject var vm: LightViewModel
    let maxHeight: CGFloat
    let panelWidth: CGFloat

    var body: some View {
        Group {
            if vm.showingDiagnostics {
                DiagnosticsView(vm: vm)
            } else {
                sessionsContent
            }
        }
        .frame(width: panelWidth)
        .frame(maxHeight: maxHeight)
        .fixedSize(horizontal: false, vertical: !vm.showingDiagnostics)
        .background {
            GeometryReader { geometry in
                Color.clear.onChange(of: geometry.size.height) { _, _ in
                    if !vm.showingDiagnostics { vm.onPanelContentChanged?() }
                }
            }
        }
        // AppKit resizes after layout. Keep the content against the capsule in the old frame too.
        .frame(minHeight: 0, maxHeight: .infinity, alignment: isAboveCapsule ? .bottom : .top)
        .background {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(LightTheme.panelTint)
                .overlay(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .fill(LightTheme.glassSheen)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .strokeBorder(LightTheme.glassEdge, lineWidth: 1)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .strokeBorder(
                            LinearGradient(
                                colors: [Color.white.opacity(0.18), Color.clear, Color(red: 205/255, green: 222/255, blue: 248/255, opacity: 0.06)],
                                startPoint: .top,
                                endPoint: .bottom
                            ),
                            lineWidth: 0.5
                        )
                        .padding(0.5)
                )
        }
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .buttonStyle(StableLabelButtonStyle())
        .environment(\.colorScheme, .dark)
    }

    private var hasClearableEvents: Bool {
        vm.visibleSessions.contains { session in
            session.recent.contains { event in
                guard let aid = event.approvalId else { return true }
                return !(session.unreadApprovals?.contains(where: { $0.approvalId == aid }) ?? false)
            }
        }
    }

    private var sessionsContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Text("会话")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(LightTheme.heading)
                    .accessibilityIdentifier("session-list-heading")

                if vm.isReadOnly {
                    Text("只读")
                        .font(.system(size: 10.5, weight: .medium))
                        .foregroundStyle(LightTheme.warning)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(LightTheme.warning.opacity(0.12), in: Capsule())
                        .help("端口或数据目录已被另一个 Light 占用，当前窗口为只读模式")
                }

                Spacer()

                DiagnosticsIconButton {
                    vm.openDiagnostics()
                }

                Menu {
                    Button("清空进展") {
                        vm.clearEvents()
                    }
                    .disabled(!hasClearableEvents || vm.isReadOnly)
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(hasClearableEvents && !vm.isReadOnly ? LightTheme.textDim : LightTheme.textDim.opacity(0.35))
                        .frame(width: 24, height: 24)
                        .contentShape(Rectangle())
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
                .disabled(!hasClearableEvents || vm.isReadOnly)
                .help("会话列表更多操作")
            }
            .frame(minHeight: 26)

            ScrollView(.vertical, showsIndicators: true) {
                VStack(alignment: .leading, spacing: 12) {
                    if !vm.activeSessions.isEmpty {
                        VStack(alignment: .leading, spacing: 12) {
                            ForEach(vm.activeSessions) { session in
                                SessionRowView(
                                    vm: vm,
                                    session: session,
                                    expanded: vm.expandedSessionKey == session.key
                                )
                            }
                        }
                    }

                    if vm.visibleSessions.isEmpty {
                        Text("暂无活动会话")
                            .font(.system(size: 12))
                            .foregroundStyle(LightTheme.textDim)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 6)
                    }

                    if !vm.idleSessions.isEmpty {
                        VStack(alignment: .leading, spacing: 0) {
                            if !vm.activeSessions.isEmpty {
                                Rectangle()
                                    .fill(LightTheme.rule)
                                    .frame(height: 1)
                                    .padding(.bottom, 8)
                            }

                            Button {
                                vm.showIdleSessions.toggle()
                            } label: {
                                HStack(spacing: 6) {
                                    Image(systemName: "chevron.right")
                                        .font(.system(size: 9, weight: .semibold))
                                        .rotationEffect(.degrees(vm.showIdleSessions ? 90 : 0))
                                        .animation(reduceMotion ? nil : .smooth(duration: 0.2), value: vm.showIdleSessions)
                                    Text("空闲")
                                        .font(.system(size: 12, weight: .regular))
                                    Text("· \(vm.idleSessions.count)")
                                        .font(.system(size: 11).monospacedDigit())
                                        .foregroundStyle(LightTheme.textMuted)
                                    Spacer()
                                }
                                .foregroundStyle(LightTheme.textDim)
                                .padding(.vertical, 4)
                                .contentShape(Rectangle())
                            }

                            if vm.showIdleSessions {
                                VStack(alignment: .leading, spacing: 8) {
                                    ForEach(vm.idleSessions) { session in
                                        SessionRowView(
                                            vm: vm,
                                            session: session,
                                            expanded: vm.expandedSessionKey == session.key
                                        )
                                    }
                                }
                                .padding(.top, 8)
                            }
                        }
                    }
                }
                .padding(.trailing, 2)
            }
            .frame(maxHeight: max(100, maxHeight - 64))
            .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 16)
        .padding(.top, 15)
        .padding(.bottom, 17)
    }
}

private struct DiagnosticsIconButton: View {
    let action: () -> Void
    private var hoveredState = SwiftUI.State(initialValue: false)
    private var hovered: Bool {
        get { hoveredState.wrappedValue }
        nonmutating set { hoveredState.wrappedValue = newValue }
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                if hovered {
                    Text("连接与诊断")
                        .font(.system(size: 11.5))
                        .foregroundStyle(LightTheme.text)
                }
                Image(systemName: "slider.horizontal.3")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(hovered ? LightTheme.text : LightTheme.textDim)
                    .frame(width: 24, height: 24)
            }
            .contentShape(Rectangle())
        }
        .onHover { inside in
            hovered = inside
        }
        .help("连接与诊断")
    }
}

private struct SessionRowView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ObservedObject var vm: LightViewModel
    let session: SessionState
    let expanded: Bool

    private var hoveredState = SwiftUI.State(initialValue: false)
    private var hovered: Bool {
        get { hoveredState.wrappedValue }
        nonmutating set { hoveredState.wrappedValue = newValue }
    }

    private var statusText: String {
        let action = expanded ? ToolActivity.currentToolAction(session) : nil
        switch session.status {
        case .idle: return "空闲"
        case .working: return action ?? "工作中"
        case .waiting: return "工作中"
        case .autoApprovalFailed: return "自动审批失败"
        case .done: return "刚完成"
        case .error: return "出错"
        }
    }

    private var statusColor: Color {
        switch session.status {
        case .working, .waiting: return LightTheme.working
        case .autoApprovalFailed: return LightTheme.approval
        case .done: return LightTheme.done
        case .error: return LightTheme.error
        case .idle: return LightTheme.textDim
        }
    }

    var body: some View {
        let title = vm.title(for: session)
        let agentName = session.agent.fullName
        let idle = session.status == .idle
        let jumpTarget = vm.effectiveJumpTarget(for: session)
        let jumpLabel = jumpTarget?.label(idle: idle)
        let timeLabel: String = {
            if session.status == .working || session.status == .waiting {
                return TimeFormatting.panelDuration(from: session.startedAt, now: vm.now)
            } else if session.status == .idle {
                return TimeFormatting.idleLabel(for: session, now: vm.now)
            }
            return ""
        }()
        let hasUnread = session.unreadApprovals?.isEmpty == false

        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 8) {
                Button {
                    vm.toggleSessionExpanded(session.key)
                } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 8.5, weight: .semibold))
                            .foregroundStyle(hovered ? LightTheme.heading : LightTheme.textDim)
                            .rotationEffect(.degrees(expanded ? 90 : 0))
                            .animation(reduceMotion ? nil : .smooth(duration: 0.2), value: expanded)
                            .frame(width: 9)

                        if idle {
                            HStack(alignment: .firstTextBaseline, spacing: 6) {
                                if hasUnread {
                                    Circle()
                                        .fill(LightTheme.approval)
                                        .frame(width: 5, height: 5)
                                        .help("有未读的自动审批失败")
                                }
                                if let title {
                                    Text(title)
                                        .font(.system(size: 13.5, weight: .regular))
                                        .foregroundStyle(LightTheme.text.opacity(0.74))
                                        .lineLimit(1)
                                        .truncationMode(.tail)
                                        .help(title)
                                }
                                Text(agentName)
                                    .font(.system(size: 11))
                                    .foregroundStyle(LightTheme.textMuted)
                                    .fixedSize()
                                Spacer(minLength: 4)
                                if !timeLabel.isEmpty {
                                    Text(timeLabel)
                                        .font(.system(size: 11).monospacedDigit())
                                        .foregroundStyle(LightTheme.textMuted)
                                        .fixedSize()
                                }
                            }
                            .padding(.vertical, 2)
                        } else {
                            VStack(alignment: .leading, spacing: 3) {
                                HStack(alignment: .center, spacing: 6) {
                                    if hasUnread {
                                        Circle()
                                            .fill(LightTheme.approval)
                                            .frame(width: 5, height: 5)
                                            .help("有未读的自动审批失败")
                                    }
                                    if let title {
                                        Text(title)
                                            .font(.system(size: 14, weight: .semibold))
                                            .foregroundStyle(LightTheme.text)
                                            .lineLimit(1)
                                            .truncationMode(.tail)
                                            .help(title)
                                    } else {
                                        Text(agentName)
                                            .font(.system(size: 13, weight: .semibold))
                                            .foregroundStyle(LightTheme.text)
                                    }
                                }

                                HStack(spacing: 5) {
                                    if title != nil {
                                        Text(agentName)
                                            .font(.system(size: 11))
                                            .foregroundStyle(LightTheme.textMuted)
                                            .fixedSize()
                                        Text("·")
                                            .font(.system(size: 11))
                                            .foregroundStyle(LightTheme.textMuted)
                                    }

                                    HStack(spacing: 3) {
                                        if session.status == .done || session.status == .error || session.status == .autoApprovalFailed {
                                            StatusMarkView(status: session.status)
                                        }
                                        Text(statusText)
                                            .font(.system(size: 12))
                                            .foregroundStyle(statusColor)
                                            .lineLimit(1)
                                            .truncationMode(.tail)
                                    }

                                    if !timeLabel.isEmpty {
                                        Text("·")
                                            .font(.system(size: 11))
                                            .foregroundStyle(LightTheme.textMuted)
                                        Text(timeLabel)
                                            .font(.system(size: 11).monospacedDigit())
                                            .foregroundStyle(LightTheme.textMuted)
                                            .fixedSize()
                                    }
                                }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .accessibilityIdentifier("session-toggle-\(session.key)")

                HStack(spacing: 0) {
                    if expanded {
                        Menu {
                            Button("从列表移除", role: .destructive) {
                                vm.removeSession(session.key)
                            }
                            .disabled(vm.isReadOnly)
                        } label: {
                            Image(systemName: "ellipsis")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(vm.isReadOnly ? LightTheme.textDim.opacity(0.35) : LightTheme.textDim)
                                .frame(width: 24, height: 24)
                                .contentShape(Rectangle())
                        }
                        .menuStyle(.borderlessButton)
                        .menuIndicator(.hidden)
                        .fixedSize()
                        .disabled(vm.isReadOnly)
                    }

                    let showPin = session.isPinned || hovered || expanded
                    Button {
                        vm.togglePin(session)
                    } label: {
                        Image(systemName: session.isPinned ? "pin.fill" : "pin")
                            .font(.system(size: 11, weight: .medium))
                            .rotationEffect(.degrees(session.isPinned ? 0 : 32))
                            .foregroundStyle(session.isPinned ? LightTheme.pinned : LightTheme.textDim)
                            .frame(width: 24, height: 24)
                            .contentShape(Rectangle())
                    }
                    .opacity(showPin ? (vm.isReadOnly ? 0.45 : 1) : 0)
                    .allowsHitTesting(showPin && !vm.isReadOnly)
                    .help(session.isPinned ? "取消固定" : "固定会话（免自动清理）")

                    if let jumpLabel {
                        let opening = vm.openingSessionKey == session.key
                        Button {
                            vm.openSession(session)
                        } label: {
                            Image(systemName: "arrow.up.right")
                                .font(.system(size: 11, weight: .medium))
                                .foregroundStyle(opening ? LightTheme.textDim.opacity(0.45) : LightTheme.textDim)
                                .frame(width: 24, height: 24)
                                .contentShape(Rectangle())
                        }
                        .disabled(opening)
                        .help(jumpLabel)
                    }
                }
            }
            .onHover { inside in
                hovered = inside
            }

            if let failure = vm.jumpErrorByKey[session.key], let message = failure.message {
                VStack(alignment: .leading, spacing: 5) {
                    Text(message)
                    if failure.canResumeInNewTab && jumpTarget == .rex {
                        Button {
                            vm.openSession(session, allowUnverifiedRestore: true)
                        } label: {
                            Text("在新标签页恢复")
                                .padding(.horizontal, 8)
                                .padding(.vertical, 3)
                                .background(LightTheme.surfaceHover, in: RoundedRectangle(cornerRadius: 5))
                        }
                    }
                }
                .font(.system(size: 11.5))
                .foregroundStyle(LightTheme.warning)
                .padding(.top, 4)
                .padding(.leading, 15)
            }

            if expanded {
                TaskProgressView(
                    recent: session.recent,
                    unread: session.unreadApprovals ?? [],
                    onRead: { id in
                        vm.acknowledgeApproval(sessionKey: session.key, approvalId: id)
                    }
                )
                .padding(.top, 10)
                .padding(.leading, 14)
            }
        }
    }
}

private struct TaskProgressView: View {
    let recent: [LightEvent]
    let unread: [LightEvent]
    let onRead: (Int) -> Void

    private var inspectedState = SwiftUI.State<LightEvent?>(initialValue: nil)
    private var expandedEntryIdState = SwiftUI.State<String?>(initialValue: nil)
    private var inspected: LightEvent? {
        get { inspectedState.wrappedValue }
        nonmutating set { inspectedState.wrappedValue = newValue }
    }
    private var expandedEntryId: String? {
        get { expandedEntryIdState.wrappedValue }
        nonmutating set { expandedEntryIdState.wrappedValue = newValue }
    }

    var body: some View {
        let visible = ProgressOrder.selectVisibleProgressEvents(recent: recent, unread: unread, inspected: inspected)
        if visible.isEmpty {
            Text("暂无任务进展")
                .font(.system(size: 11))
                .foregroundStyle(LightTheme.textDim)
        } else {
            let entries = ToolActivity.toProgressEntries(visible)
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(entries.enumerated()), id: \.element.id) { idx, entry in
                    ProgressEntryRow(
                        entry: entry,
                        isLast: idx == entries.count - 1,
                        expanded: expandedEntryId == entry.id
                    ) {
                        let opening = expandedEntryId != entry.id
                        expandedEntryId = opening ? entry.id : nil
                        if opening, let first = entry.events.first {
                            if let aid = first.approvalId {
                                inspected = first
                                if unread.contains(where: { $0.approvalId == aid }) {
                                    onRead(aid)
                                }
                            } else {
                                inspected = nil
                            }
                        } else {
                            inspected = nil
                        }
                    }
                }
            }
        }
    }
}

private struct ProgressEntryRow: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let entry: ProgressEntry
    let isLast: Bool
    let expanded: Bool
    let onToggle: () -> Void

    var body: some View {
        let isActivity = entry.kind == .activity
        let event = entry.events[0]
        let rows = isActivity ? ToolActivity.activityRows(entry.events) : []
        let detail: String? = {
            if isActivity { return nil }
            if let msg = event.message, !msg.isEmpty { return msg }
            if case .event(.autoApprovalFailed) = entry.kind {
                return [event.tool, "客户端未提供具体原因。"].compactMap { $0 }.joined(separator: " · ")
            }
            return event.tool
        }()
        let canExpand = isActivity || (detail != nil)
        let label: String = {
            if isActivity {
                return entry.events.allSatisfy({ $0.type.isToolEvent }) ? "工具活动" : "运行日志"
            }
            if case .event(let type) = entry.kind {
                return type.displayLabel
            }
            return ""
        }()
        let accent: Color? = {
            switch entry.kind {
            case .event(.autoApprovalFailed): return LightTheme.approval
            case .event(.error): return LightTheme.error
            default: return nil
            }
        }()

        HStack(alignment: .top, spacing: 8) {
            VStack(spacing: 0) {
                Circle()
                    .fill(accent ?? LightTheme.surface)
                    .overlay(Circle().strokeBorder(accent ?? LightTheme.textDim, lineWidth: 1))
                    .frame(width: 6, height: 6)
                    .padding(.top, 9)

                if !isLast {
                    Rectangle()
                        .fill(LightTheme.hairline)
                        .frame(width: 1)
                        .frame(maxHeight: .infinity)
                }
            }
            .frame(width: 8)

            VStack(alignment: .leading, spacing: 4) {
                Group {
                    if canExpand {
                        Button(action: onToggle) {
                            entryHeader(label: label, accent: accent, isActivity: isActivity, count: rows.count, event: event, canExpand: true)
                        }
                        .accessibilityIdentifier(isActivity ? "activity-group" : "progress-event")
                    } else {
                        entryHeader(label: label, accent: accent, isActivity: isActivity, count: rows.count, event: event, canExpand: false)
                    }
                }

                if !expanded, case .event(.error) = entry.kind, let detail {
                    Text(detail)
                        .font(.system(size: 12))
                        .foregroundStyle(LightTheme.textDim)
                        .lineLimit(2)
                        .padding(.bottom, 4)
                }

                if expanded {
                    if isActivity {
                        ActivityLogView(rows: rows)
                            .padding(.bottom, 6)
                    } else if let detail {
                        Text(detail)
                            .font(.system(size: 12))
                            .foregroundStyle(LightTheme.textDim)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.bottom, 8)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func entryHeader(label: String, accent: Color?, isActivity: Bool, count: Int, event: LightEvent, canExpand: Bool) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(label)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(accent ?? LightTheme.text)
            if isActivity {
                Text("· \(count)")
                    .font(.system(size: 11).monospacedDigit())
                    .foregroundStyle(LightTheme.textDim)
            }
            Spacer(minLength: 4)
            if !(isActivity && expanded) {
                let timeStr = ISO8601Date.formatClockTime(event.timestamp)
                if !timeStr.isEmpty {
                    Text(timeStr)
                        .font(.system(size: 11, design: .monospaced).monospacedDigit())
                        .foregroundStyle(LightTheme.textDim)
                }
            }
            if canExpand {
                Image(systemName: "chevron.right")
                    .font(.system(size: 8, weight: .semibold))
                    .foregroundStyle(LightTheme.textDim)
                    .rotationEffect(.degrees(expanded ? 90 : 0))
                    .animation(reduceMotion ? nil : .smooth(duration: 0.18), value: expanded)
                    .frame(width: 8)
            } else {
                Spacer().frame(width: 8)
            }
        }
        .padding(.vertical, 5)
        .contentShape(Rectangle())
    }
}

private struct ActivityLogView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let rows: [ActivityRow]
    private var openRowIdState = SwiftUI.State<String?>(initialValue: nil)
    private var openRowId: String? {
        get { openRowIdState.wrappedValue }
        nonmutating set { openRowIdState.wrappedValue = newValue }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.element.id) { idx, row in
                if idx > 0 {
                    Rectangle()
                        .fill(Color.white.opacity(0.05))
                        .frame(height: 1)
                }

                if row.event.type.isToolEvent {
                    let hasDetail = row.call != nil || row.event.tool != nil || row.event.message != nil
                    let isOpen = openRowId == row.id

                    VStack(alignment: .leading, spacing: 4) {
                        Button {
                            guard hasDetail else { return }
                            openRowId = isOpen ? nil : row.id
                        } label: {
                            HStack(spacing: 6) {
                                Text(ToolActivity.activityRowLabel(row))
                                    .font(.system(size: 12))
                                    .foregroundStyle(LightTheme.text)
                                    .lineLimit(1)
                                    .truncationMode(.tail)
                                Spacer(minLength: 4)
                                Text(ToolActivity.toolPhase(row))
                                    .font(.system(size: 11))
                                    .foregroundStyle(LightTheme.textDim)
                                    .fixedSize()
                                let ts = ISO8601Date.formatClockTime(row.event.timestamp)
                                if !ts.isEmpty {
                                    Text(ts)
                                        .font(.system(size: 11, design: .monospaced).monospacedDigit())
                                        .foregroundStyle(LightTheme.textDim)
                                        .fixedSize()
                                }
                                if hasDetail {
                                    Image(systemName: "chevron.right")
                                        .font(.system(size: 8, weight: .semibold))
                                        .foregroundStyle(LightTheme.textDim)
                                        .rotationEffect(.degrees(isOpen ? 90 : 0))
                                        .animation(reduceMotion ? nil : .easeInOut(duration: 0.14), value: isOpen)
                                        .frame(width: 7)
                                }
                            }
                            .padding(.vertical, 5)
                            .contentShape(Rectangle())
                        }
                        .accessibilityIdentifier("tool-detail")

                        if isOpen {
                            let records = row.call != nil ? [row.call!, row.event] : [row.event]
                            VStack(alignment: .leading, spacing: 6) {
                                ForEach(Array(records.enumerated()), id: \.offset) { _, rec in
                                    VStack(alignment: .leading, spacing: 2) {
                                        let ts = ISO8601Date.formatClockTime(rec.timestamp)
                                        let parts = [rec.type.displayLabel, ts.isEmpty ? nil : ts, rec.tool].compactMap { $0 }
                                        Text(parts.joined(separator: " · "))
                                            .font(.system(size: 11))
                                            .foregroundStyle(LightTheme.textDim)
                                        if let msg = rec.message, msg != rec.tool {
                                            Text(msg)
                                                .font(.system(size: 11, design: .monospaced))
                                                .foregroundStyle(LightTheme.text)
                                                .textSelection(.enabled)
                                                .fixedSize(horizontal: false, vertical: true)
                                        }
                                    }
                                }
                            }
                            .padding(.leading, 8)
                            .padding(.vertical, 4)
                            .overlay(alignment: .leading) {
                                Rectangle().fill(LightTheme.rule).frame(width: 1)
                            }
                            .padding(.bottom, 4)
                        }
                    }
                } else {
                    VStack(alignment: .leading, spacing: 2) {
                        HStack {
                            Text(row.event.type.displayLabel)
                                .font(.system(size: 11))
                                .foregroundStyle(LightTheme.text)
                            Spacer()
                            let ts = ISO8601Date.formatClockTime(row.event.timestamp)
                            if !ts.isEmpty {
                                Text(ts)
                                    .font(.system(size: 11, design: .monospaced).monospacedDigit())
                                    .foregroundStyle(LightTheme.textDim)
                            }
                        }
                        if let detail = row.event.message ?? row.event.tool {
                            Text(detail)
                                .font(.system(size: 12))
                                .foregroundStyle(LightTheme.textDim)
                                .textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .padding(.vertical, 5)
                }
            }
        }
        .padding(.leading, 6)
    }
}

private struct DiagnosticsView: View {
    @ObservedObject var vm: LightViewModel
    private var showInstallDetailState = SwiftUI.State(initialValue: false)
    private var showInstallDetail: Bool {
        get { showInstallDetailState.wrappedValue }
        nonmutating set { showInstallDetailState.wrappedValue = newValue }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Button {
                    vm.backFromDiagnostics()
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "chevron.left")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(LightTheme.textDim)
                        Text("连接与诊断")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(LightTheme.heading)
                    }
                    .contentShape(Rectangle())
                }
                .help("返回会话")

                Spacer()

                Button("刷新") {
                    vm.refreshDiagnostics()
                }
                .accessibilityIdentifier("refresh-diagnostics")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(LightTheme.textDim)
            }
            .padding(.horizontal, 16)
            .padding(.top, 15)
            .padding(.bottom, 10)

            ScrollView(.vertical, showsIndicators: true) {
                VStack(alignment: .leading, spacing: 9) {
                    if !vm.diagnosticsError.isEmpty {
                        Text(vm.diagnosticsError)
                            .font(.system(size: 11.5))
                            .foregroundStyle(LightTheme.warning)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    if let report = vm.diagnosticsReport {
                        diagnosticsCard {
                            Text("本地事件服务")
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(LightTheme.text)
                            VStack(spacing: 4) {
                                factRow("状态", report.service.status, valueColor: report.service.running ? LightTheme.connected : LightTheme.warning)
                                factRow("地址", report.service.address, mono: true)
                                factRow("模式", "仅本机 · 原生 Swift · 无云端")
                            }
                            .padding(.top, 4)
                        }

                        if !report.adapters.isEmpty {
                            VStack(alignment: .leading, spacing: 6) {
                                Text("Agent 接入")
                                    .font(.system(size: 11, weight: .medium))
                                    .foregroundStyle(LightTheme.textDim)
                                    .padding(.leading, 3)

                                ForEach(report.adapters) { adapter in
                                    diagnosticsCard {
                                        HStack(alignment: .firstTextBaseline) {
                                            Text(adapter.name)
                                                .font(.system(size: 13, weight: .semibold))
                                                .foregroundStyle(LightTheme.text)
                                            Spacer()
                                            Text(adapter.status)
                                                .font(.system(size: 11))
                                                .foregroundStyle(adapter.configured ? LightTheme.connected : LightTheme.warning)
                                        }
                                        if let assessment = adapter.assessment {
                                            Text(assessment.text)
                                                .font(.system(size: 11.5))
                                                .foregroundStyle(assessment.needsAttention ? LightTheme.warning : LightTheme.text)
                                                .fixedSize(horizontal: false, vertical: true)
                                        }
                                        if let path = adapter.configPath {
                                            Text(path)
                                                .font(.system(size: 10.5, design: .monospaced))
                                                .foregroundStyle(LightTheme.textDim)
                                                .textSelection(.enabled)
                                                .padding(.top, 2)
                                        }
                                        if let received = adapter.received {
                                            Text("最近事件  \(received)")
                                                .font(.system(size: 11))
                                                .foregroundStyle(LightTheme.textDim)
                                                .padding(.top, 3)
                                        }
                                    }
                                }
                            }
                        }

                        if let failure = report.lastFailure {
                            diagnosticsCard {
                                Text("上次跳转失败")
                                    .font(.system(size: 13, weight: .semibold))
                                    .foregroundStyle(LightTheme.text)
                                Text("\(failure.target) · \(failure.at)")
                                    .font(.system(size: 11))
                                    .foregroundStyle(LightTheme.textDim)
                                    .padding(.top, 2)
                                Text(failure.reason)
                                    .font(.system(size: 11.5))
                                    .foregroundStyle(LightTheme.warning)
                                    .textSelection(.enabled)
                                    .fixedSize(horizontal: false, vertical: true)
                                    .padding(.top, 3)
                            }
                        }
                    } else if vm.diagnosticsError.isEmpty {
                        Text("正在检查连接…")
                            .font(.system(size: 12))
                            .foregroundStyle(LightTheme.textDim)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 12)
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 6)
            }

            Rectangle()
                .fill(LightTheme.rule)
                .frame(height: 1)

            VStack(alignment: .leading, spacing: 6) {
                if let outcome = vm.diagnosticsReport?.lastInstall {
                    Button {
                        showInstallDetail.toggle()
                    } label: {
                        HStack {
                            Text((outcome.ok ? "✓ " : "") + outcome.summary)
                                .font(.system(size: 12))
                                .foregroundStyle(outcome.ok ? LightTheme.connected : LightTheme.warning)
                            Spacer()
                            HStack(spacing: 3) {
                                Text("详情")
                                Image(systemName: showInstallDetail ? "chevron.up" : "chevron.down")
                                    .font(.system(size: 9))
                            }
                            .font(.system(size: 11))
                            .foregroundStyle(LightTheme.textDim)
                        }
                        .padding(.vertical, 3)
                        .contentShape(Rectangle())
                    }

                    if showInstallDetail {
                        ScrollView(.vertical) {
                            Text(outcome.detail)
                                .font(.system(size: 11))
                                .foregroundStyle(LightTheme.textDim)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .frame(maxHeight: 110)

                        if outcome.ok {
                            installButton(outcome: outcome)
                        }
                    }
                }

                if vm.diagnosticsReport?.lastInstall?.ok != true {
                    installButton(outcome: vm.diagnosticsReport?.lastInstall)
                }
            }
            .padding(.horizontal, 14)
            .padding(.top, 8)
            .padding(.bottom, 10)
        }
    }

    @ViewBuilder
    private func installButton(outcome: InstallOutcome?) -> some View {
        let title: String = {
            if vm.isInstallingHooks { return "正在接入…" }
            guard let outcome else { return "接入 Hooks" }
            return outcome.ok ? "重新接入" : "重试"
        }()

        Button {
            vm.installHooks()
        } label: {
            Text(title)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(LightTheme.text)
                .frame(maxWidth: .infinity)
                .frame(height: 30)
                .background(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(Color.white.opacity(0.07))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.14), lineWidth: 1)
                )
        }
        .opacity(vm.isInstallingHooks ? 0.55 : 1)
        .disabled(vm.isInstallingHooks)
    }

    @ViewBuilder
    private func diagnosticsCard<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            content()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 11, style: .continuous)
                .fill(LightTheme.cardFill)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 11, style: .continuous)
                .strokeBorder(LightTheme.cardBorder, lineWidth: 1)
        )
    }

    @ViewBuilder
    private func factRow(_ label: String, _ value: String, valueColor: Color = LightTheme.text, mono: Bool = false) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(label)
                .font(.system(size: 11.5))
                .foregroundStyle(LightTheme.textDim)
            Spacer()
            Text(value)
                .font(mono ? .system(size: 11.5, design: .monospaced) : .system(size: 11.5))
                .foregroundStyle(valueColor)
                .multilineTextAlignment(.trailing)
                .textSelection(.enabled)
        }
    }
}
