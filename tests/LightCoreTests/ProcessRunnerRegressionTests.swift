import Foundation
import LightCore

enum ProcessRunnerRegressionTests {
    static let allTests = [
        ("ProcessRunner.shortExitAndEnvironment", shortExitAndEnvironment),
        ("ProcessRunner.drainsBothPipes", drainsBothPipes),
        ("ProcessRunner.terminatesIgnoringChild", terminatesIgnoringChild),
        ("ProcessRunner.boundsPipeDrainAfterExit", boundsPipeDrainAfterExit),
    ]

    static func shortExitAndEnvironment() throws {
        for _ in 0..<12 {
            let value = try ProcessRunner.run(executable: "/usr/bin/env", args: [], environment: ["LIGHT_TEST": "local"])
            try expectEqual(value.trimmingCharacters(in: .newlines), "LIGHT_TEST=local")
        }
        do {
            _ = try ProcessRunner.run(executable: "/bin/sh", args: ["-c", "echo failure >&2; exit 3"])
            throw TestFailure(message: "Expected nonzero exit")
        } catch let error as NavigationError {
            try expectEqual(error.message, "failure")
        }
    }

    static func drainsBothPipes() throws {
        let command = "/usr/bin/head -c 262144 /dev/zero >&2; /usr/bin/head -c 262144 /dev/zero"
        let result = try ProcessRunner.run(executable: "/bin/sh", args: ["-c", command])
        try expectEqual(result.utf8.count, 262144)
    }

    static func terminatesIgnoringChild() throws {
        let pidFile = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: pidFile) }
        let command = #"trap '' TERM; echo $$ > "$1"; exec /bin/sleep 4"#
        try expectTimeout(args: ["-c", command, "sh", pidFile.path])
        let text = try String(contentsOf: pidFile, encoding: .utf8)
        let pid = try require(Int32(text.trimmingCharacters(in: .whitespacesAndNewlines)))
        let deadline = DispatchTime.now() + .seconds(1)
        while kill(pid, 0) == 0 && DispatchTime.now() < deadline {
            Thread.sleep(forTimeInterval: 0.01)
        }
        try expect(kill(pid, 0) == -1 && errno == ESRCH, "timed-out direct child still alive")
    }

    static func boundsPipeDrainAfterExit() throws {
        // The shell exits immediately, but its background sleep inherits both writers.
        try expectTimeout(args: ["-c", "/bin/sleep 2 & exit 0"])
    }

    private static func expectTimeout(args: [String]) throws {
        let start = ContinuousClock.now
        do {
            _ = try ProcessRunner.run(executable: "/bin/sh", args: args, timeout: 0.3)
            throw TestFailure(message: "Expected a process or pipe timeout")
        } catch let error as NavigationError {
            try expectEqual(error.message, "命令执行超时。")
        }
        try expect(start.duration(to: .now) < .seconds(1.7), "timeout exceeded its cleanup allowance")
    }
}
