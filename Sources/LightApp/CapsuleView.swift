import AppKit
import LightCore
import SwiftUI

enum CapsuleDragEvent {
    case began(at: CGPoint)
    case moved(to: CGPoint)
    case ended
}

struct CapsuleView: View {
    @ObservedObject var vm: LightViewModel
    let onSizeChanged: (CGSize) -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var pillWidth = SwiftUI.State(initialValue: CGFloat(56))
    private var windowWidth = SwiftUI.State(initialValue: CGFloat(56))

    var body: some View {
        let minimal = vm.isMinimal
        let agents = vm.activeAgents
        let grouped = vm.activeByAgent

        ZStack {
            if minimal {
                IdleGripView(isOpen: vm.isPanelOpen, isHighlighted: vm.isHoveringCapsule || vm.isPanelOpen)
                    .contentShape(Rectangle())
                    .onTapGesture {
                        vm.clickCapsule(agent: nil)
                    }
            } else {
                HStack(spacing: 12) {
                    ForEach(Array(agents.enumerated()), id: \.element) { idx, agent in
                        if idx > 0 {
                            Rectangle()
                                .fill(LightTheme.hairline)
                                .frame(width: 1, height: 14)
                        }
                        if let list = grouped[agent] {
                            AgentPillView(
                                agent: agent,
                                sessionsByPriority: list,
                                now: vm.now
                            ) {
                                vm.clickCapsule(agent: agent)
                            }
                        }
                    }
                }
                .padding(.leading, 16)
                .padding(.trailing, vm.hasUnreadApprovals ? 22 : 16)
            }
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.14), value: agents)
        .fixedSize()
        .background {
            GeometryReader { geometry in
                Color.clear.onChange(of: geometry.size.width, initial: true) { _, width in
                    resize(to: max(56, ceil(width)))
                }
            }
        }
        .frame(width: pillWidth.wrappedValue, height: 36)
        .background { capsuleBackground }
        .overlay(alignment: .trailing) {
            if vm.hasUnreadApprovals {
                Circle()
                    .fill(LightTheme.approval)
                    .frame(width: 5, height: 5)
                    .padding(.trailing, 9)
                    .allowsHitTesting(false)
                    .accessibilityLabel("有未读的自动审批失败")
            }
        }
        .clipShape(Capsule())
        .overlay(
            CapsuleHoverArea { inside in vm.isHoveringCapsule = inside }
        )
        .frame(width: windowWidth.wrappedValue, height: 36)
        .environment(\.colorScheme, .dark)
    }

    private var capsuleBackground: some View {
        Capsule(style: .continuous)
            .fill((vm.isHoveringCapsule || vm.isPanelOpen) ? LightTheme.capsuleHover : LightTheme.capsule)
            .animation(reduceMotion ? nil : .easeInOut(duration: 0.16), value: vm.isHoveringCapsule || vm.isPanelOpen)
            .overlay(
                Capsule(style: .continuous)
                    .fill(LightTheme.glassSheen)
            )
            .overlay(
                Capsule(style: .continuous)
                    .strokeBorder(LightTheme.capsuleBorder(for: vm.globalStatus), lineWidth: 1)
            )
            .overlay(
                Capsule(style: .continuous)
                    .strokeBorder(
                        LinearGradient(
                            colors: [Color.white.opacity(0.20), Color.clear, Color(red: 205/255, green: 222/255, blue: 248/255, opacity: 0.07)],
                            startPoint: .top,
                            endPoint: .bottom
                        ),
                        lineWidth: 0.5
                    )
                    .padding(0.5)
            )
    }

    private func resize(to width: CGFloat) {
        guard pillWidth.wrappedValue != width else { return }
        // Reserve the larger frame until the visible capsule has finished shrinking.
        if width > windowWidth.wrappedValue {
            windowWidth.wrappedValue = width
            onSizeChanged(CGSize(width: width, height: 36))
        }
        let animation: Animation? = reduceMotion || vm.isDraggingCapsule ? nil : .smooth(duration: 0.24)
        withAnimation(animation, completionCriteria: .removed) {
            pillWidth.wrappedValue = width
        } completion: {
            guard pillWidth.wrappedValue == width, windowWidth.wrappedValue != width else { return }
            windowWidth.wrappedValue = width
            onSizeChanged(CGSize(width: width, height: 36))
        }
    }
}

private struct IdleGripView: View {
    let isOpen: Bool
    let isHighlighted: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let color = isHighlighted ? LightTheme.heading : LightTheme.idle
        ZStack {
            RoundedRectangle(cornerRadius: 1)
                .fill(color)
                .frame(width: isOpen ? 7 : 9, height: 1.5)
                .offset(x: isOpen ? -2.2 : -3.5, y: isOpen ? -0.5 : 0)
                .rotationEffect(.degrees(isOpen ? -42 : 0), anchor: .center)

            RoundedRectangle(cornerRadius: 1)
                .fill(color)
                .frame(width: isOpen ? 7 : 9, height: 1.5)
                .offset(x: isOpen ? 2.2 : 3.5, y: isOpen ? -0.5 : 0)
                .rotationEffect(.degrees(isOpen ? 42 : 0), anchor: .center)
        }
        .frame(width: 56, height: 36)
        .animation(reduceMotion ? nil : .spring(response: 0.22, dampingFraction: 0.8), value: isOpen)
    }
}

private struct AgentPillView: View {
    let agent: AgentId
    let sessionsByPriority: [SessionState]
    let now: Date
    let onTap: () -> Void

    var body: some View {
        let active = sessionsByPriority.first
        let status = active?.status ?? .idle
        let count = sessionsByPriority.count
        let busyCount = sessionsByPriority.filter {
            $0.status == .working || $0.status == .waiting || $0.status == .autoApprovalFailed
        }.count
        let timeText = (status == .working || status == .waiting)
            ? TimeFormatting.shortElapsed(from: active?.startedAt, now: now)
            : ""
        let countBadge: String? = count > 1
            ? "×\(count)\(busyCount > 0 && busyCount < count ? " · \(busyCount)忙" : "")"
            : nil

        Button(action: onTap) {
            ZStack(alignment: .leading) {
                if !timeText.isEmpty {
                    // Keep the agent name in place when the elapsed time gains a digit.
                    let sample = timeText.contains("h") ? "00h00m" : (timeText.contains("m") ? "00m00s" : "00s")
                    label(status: status, countBadge: countBadge, timeText: sample)
                        .hidden()
                        .accessibilityHidden(true)
                }
                label(status: status, countBadge: countBadge, timeText: timeText)
            }
            .frame(height: 36)
            .contentShape(Rectangle())
        }
        .buttonStyle(StableLabelButtonStyle())
    }

    private func label(status: AgentStatus, countBadge: String?, timeText: String) -> some View {
        HStack(spacing: 7) {
            if status != .working && status != .waiting {
                StatusMarkView(status: status)
            }

            Text(agent.shortName)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(LightTheme.text)
                .fixedSize()

            if let countBadge {
                Text(countBadge)
                    .font(.system(size: 11, weight: .regular).monospacedDigit())
                    .foregroundStyle(LightTheme.textDim)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .overlay(
                        RoundedRectangle(cornerRadius: 5)
                            .strokeBorder(LightTheme.rule, lineWidth: 1)
                    )
                    .fixedSize()
            }

            chipView(status: status, timeText: timeText)
                .fixedSize()
        }
    }

    @ViewBuilder
    private func chipView(status: AgentStatus, timeText: String) -> some View {
        switch status {
        case .done:
            Text("完成")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(LightTheme.done)
        case .error:
            Text("出错")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(LightTheme.error)
        case .autoApprovalFailed:
            Text("自动审批失败")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(LightTheme.approval)
        case .working, .waiting:
            HStack(spacing: 4) {
                Text("工作中")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(LightTheme.working)
                if !timeText.isEmpty {
                    Text("·")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(LightTheme.textDim)
                    Text(timeText)
                        .font(.system(size: 12, weight: .medium).monospacedDigit())
                        .foregroundStyle(LightTheme.working)
                }
            }
        case .idle:
            Text("空闲")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(LightTheme.textDim)
        }
    }
}

private struct CapsuleHoverArea: NSViewRepresentable {
    let onHoverChanged: (Bool) -> Void

    func makeNSView(context: Context) -> CapsuleHoverView {
        let view = CapsuleHoverView()
        view.onHoverChanged = onHoverChanged
        return view
    }

    func updateNSView(_ nsView: CapsuleHoverView, context: Context) {
        nsView.onHoverChanged = onHoverChanged
    }
}

private final class CapsuleHoverView: NSView {
    var onHoverChanged: ((Bool) -> Void)?
    private var trackingArea: NSTrackingArea?

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let trackingArea { removeTrackingArea(trackingArea) }
        let area = NSTrackingArea(
            rect: bounds,
            options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
            owner: self,
            userInfo: nil
        )
        addTrackingArea(area)
        trackingArea = area
    }

    override func mouseEntered(with event: NSEvent) {
        onHoverChanged?(true)
    }

    override func mouseExited(with event: NSEvent) {
        onHoverChanged?(false)
    }

}

/// AppKit delays delivering the press to SwiftUI until it knows the gesture is a click.
/// A drag consumes its entire sequence, including its initial mouse-down.
final class CapsuleDragRecognizer: NSGestureRecognizer {
    var onDrag: ((CapsuleDragEvent) -> Void)?
    private var start: CGPoint?
    private var dragging = false

    override func mouseDown(with event: NSEvent) {
        super.mouseDown(with: event)
        start = event.window?.convertPoint(toScreen: event.locationInWindow)
    }

    override func mouseDragged(with event: NSEvent) {
        super.mouseDragged(with: event)
        guard let start, let window = event.window else { return }
        let point = window.convertPoint(toScreen: event.locationInWindow)
        if !dragging {
            guard hypot(point.x - start.x, point.y - start.y) >= 5 else { return }
            state = .began
            guard state == .began else { return }
            dragging = true
            onDrag?(.began(at: start))
        } else {
            state = .changed
        }
        onDrag?(.moved(to: point))
    }

    override func mouseUp(with event: NSEvent) {
        super.mouseUp(with: event)
        state = dragging ? .ended : .failed
    }

    override func reset() {
        super.reset()
        start = nil
        if dragging {
            dragging = false
            onDrag?(.ended)
        }
    }
}
