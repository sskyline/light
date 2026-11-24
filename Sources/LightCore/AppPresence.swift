import AppKit
import Foundation

public final class PresenceWatcher: @unchecked Sendable {
    public typealias ProbeClosure = @Sendable (String) -> Bool

    private let lock = NSLock()
    private var state = PresenceState()
    private var started = false
    private let probeBundleInstalled: ProbeClosure
    private let onChange: @Sendable (PresenceState) -> Void

    public init(
        probeBundleInstalled: @escaping ProbeClosure = { PresenceWatcher.defaultProbe(bundleID: $0) },
        onChange: @escaping @Sendable (PresenceState) -> Void
    ) {
        self.probeBundleInstalled = probeBundleInstalled
        self.onChange = onChange
    }

    public static func defaultProbe(bundleID: String) -> Bool {
        NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) != nil
    }

    public func getState() -> PresenceState {
        lock.lock()
        defer { lock.unlock() }
        return state
    }

    public func start() {
        lock.lock()
        if started {
            lock.unlock()
            return
        }
        started = true
        lock.unlock()
        probeNow()
    }

    public func stop() {
        lock.lock()
        started = false
        lock.unlock()
    }

    public func probeNow() {
        lock.lock()
        let active = started
        lock.unlock()
        guard active else { return }

        var nextMap: [SwitchTarget: Bool] = [:]
        for target in SwitchTarget.allCases {
            nextMap[target] = probeBundleInstalled(target.bundleID)
        }
        apply(PresenceState(installed: nextMap))
    }

    public func markNotInstalled(_ target: SwitchTarget) {
        lock.lock()
        var next = state
        next.installed[target] = false
        lock.unlock()
        apply(next)
    }

    private func apply(_ next: PresenceState) {
        lock.lock()
        if state == next {
            lock.unlock()
            return
        }
        state = next
        lock.unlock()
        onChange(next)
    }
}
