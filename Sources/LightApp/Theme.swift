import LightCore
import SwiftUI

enum LightTheme {
    static let panelTint = Color(red: 24 / 255, green: 26 / 255, blue: 31 / 255, opacity: 0.90)
    static let capsule = Color(red: 23 / 255, green: 25 / 255, blue: 30 / 255, opacity: 0.84)
    static let capsuleHover = Color(red: 34 / 255, green: 36 / 255, blue: 42 / 255, opacity: 0.90)
    static let surface = Color(red: 31 / 255, green: 31 / 255, blue: 31 / 255)
    static let surfaceHover = Color(red: 48 / 255, green: 48 / 255, blue: 48 / 255)
    static let glassEdge = Color(red: 224 / 255, green: 232 / 255, blue: 246 / 255, opacity: 0.24)
    static let hairline = Color(red: 81 / 255, green: 81 / 255, blue: 81 / 255)
    static let rule = Color(red: 57 / 255, green: 57 / 255, blue: 57 / 255)
    static let text = Color(red: 241 / 255, green: 240 / 255, blue: 238 / 255)
    static let textDim = Color(red: 186 / 255, green: 186 / 255, blue: 186 / 255)
    static let textMuted = Color(red: 170 / 255, green: 168 / 255, blue: 162 / 255)
    static let heading = Color(red: 233 / 255, green: 228 / 255, blue: 217 / 255)

    static let idle = Color(red: 164 / 255, green: 164 / 255, blue: 164 / 255)
    static let working = Color(red: 193 / 255, green: 198 / 255, blue: 203 / 255)
    static let approval = Color(red: 219 / 255, green: 195 / 255, blue: 147 / 255)
    static let done = Color(red: 183 / 255, green: 196 / 255, blue: 185 / 255)
    static let error = Color(red: 240 / 255, green: 171 / 255, blue: 167 / 255)
    static let pinned = Color(red: 216 / 255, green: 207 / 255, blue: 184 / 255)
    static let connected = Color(red: 168 / 255, green: 215 / 255, blue: 180 / 255)
    static let warning = Color(red: 230 / 255, green: 197 / 255, blue: 140 / 255)

    static let cardFill = Color.white.opacity(0.04)
    static let cardBorder = Color.white.opacity(0.09)

    static let glassSheen = LinearGradient(
        colors: [
            Color(red: 239 / 255, green: 245 / 255, blue: 255 / 255, opacity: 0.12),
            Color.clear,
            Color(red: 201 / 255, green: 215 / 255, blue: 238 / 255, opacity: 0.03)
        ],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
    )

    static func accent(for status: AgentStatus) -> Color {
        switch status {
        case .idle: return idle
        case .working, .waiting: return working
        case .autoApprovalFailed: return approval
        case .done: return done
        case .error: return error
        }
    }

    static func capsuleBorder(for status: AgentStatus) -> Color {
        switch status {
        case .idle:
            return glassEdge
        case .working, .waiting:
            return glassEdge.opacity(0.92)
        case .autoApprovalFailed:
            return approval.opacity(0.45)
        case .done:
            return done.opacity(0.40)
        case .error:
            return error.opacity(0.45)
        }
    }
}

enum TimeFormatting {
    static func shortElapsed(from iso: String?, now: Date) -> String {
        guard let iso, let start = ISO8601Date.parse(iso) else { return "" }
        let s = Int(now.timeIntervalSince(start))
        guard s >= 0 else { return "" }
        if s < 60 { return "\(s)s" }
        let m = s / 60
        if m < 60 { return "\(m)m\(s % 60)s" }
        return "\(m / 60)h\(m % 60)m"
    }

    static func panelDuration(from iso: String?, now: Date) -> String {
        guard let iso, let start = ISO8601Date.parse(iso) else { return "" }
        let s = Int(now.timeIntervalSince(start))
        guard s >= 0 else { return "" }
        if s < 60 { return "\(s)s" }
        let m = s / 60
        if m < 60 { return "\(m)m \(s % 60)s" }
        return "\(m / 60)h \(m % 60)m"
    }

    static func idleLabel(for session: SessionState, now: Date) -> String {
        let raw = session.turnEnd?.timestamp ?? session.lastEventAt
        guard let ts = ISO8601Date.parse(raw) else { return "" }
        let minutes = max(0, Int(now.timeIntervalSince(ts) / 60))
        let ago: String
        if minutes == 0 { ago = "刚刚" }
        else if minutes < 60 { ago = "\(minutes) 分钟前" }
        else { ago = "\(minutes / 60) 小时前" }

        switch session.turnEnd?.type {
        case .interrupt: return "\(ago)中断"
        case .error: return "\(ago)出错"
        default: return ago
        }
    }
}

struct StatusMarkView: View {
    let status: AgentStatus

    var body: some View {
        Group {
            switch status {
            case .done:
                Image(systemName: "checkmark")
                    .font(.system(size: 8.5, weight: .bold))
                    .foregroundStyle(LightTheme.done)
            case .error:
                Text("!")
                    .font(.system(size: 11.5, weight: .bold))
                    .foregroundStyle(LightTheme.error)
            case .autoApprovalFailed:
                Circle()
                    .fill(LightTheme.approval)
                    .frame(width: 5, height: 5)
            case .idle:
                Circle()
                    .fill(LightTheme.idle)
                    .frame(width: 5, height: 5)
            case .working, .waiting:
                EmptyView()
            }
        }
        .frame(width: 10, height: 12)
    }
}
