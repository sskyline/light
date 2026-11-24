import Foundation

struct TestFailure: Error, CustomStringConvertible {
    let message: String
    var description: String { message }
}

func expect(_ condition: @autoclosure () -> Bool, _ message: String = "", file: StaticString = #filePath, line: UInt = #line) throws {
    if !condition() {
        let loc = "\((String(describing: file) as NSString).lastPathComponent):\(line)"
        throw TestFailure(message: message.isEmpty ? "Assertion failed at \(loc)" : "\(message) (\(loc))")
    }
}

func expectEqual<T: Equatable>(_ a: T, _ b: T, _ message: String = "", file: StaticString = #filePath, line: UInt = #line) throws {
    if a != b {
        let loc = "\((String(describing: file) as NSString).lastPathComponent):\(line)"
        let prefix = message.isEmpty ? "" : "\(message): "
        throw TestFailure(message: "\(prefix)expected \(b), got \(a) (\(loc))")
    }
}

func require<T>(_ value: T?, _ message: String = "unexpected nil", file: StaticString = #filePath, line: UInt = #line) throws -> T {
    guard let value else {
        let loc = "\((String(describing: file) as NSString).lastPathComponent):\(line)"
        throw TestFailure(message: "\(message) (\(loc))")
    }
    return value
}

@main
struct LightTestRunner {
    static func main() {
        let cases: [(String, () throws -> Void)] =
            StateStoreTests.allTests +
            PinRegressionTests.allTests +
            PanelPlacementTests.allTests +
            ProgressOrderTests.allTests +
            HTTPAndHookTests.allTests +
            HookDiagnosticsTests.allTests +
            HTTPParserRegressionTests.allTests +
            NavigationAndLookupTests.allTests +
            ProcessRunnerRegressionTests.allTests +
            LaunchAndTitleTests.allTests +
            LightHookCLITests.allTests

        var passed = 0
        var failed = 0
        for (name, fn) in cases {
            fputs("  RUN   \(name)...\n", stderr)
            do {
                try fn()
                passed += 1
                print("  PASS  \(name)")
                fflush(stdout)
            } catch {
                failed += 1
                fputs("  FAIL  \(name): \(error)\n", stderr)
            }
        }
        print("\nRan \(cases.count) tests: \(passed) passed, \(failed) failed")
        exit(failed == 0 ? 0 : 1)
    }
}
