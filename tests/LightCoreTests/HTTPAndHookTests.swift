import Foundation
@testable import LightCore

enum HTTPAndHookTests {
    static let allTests: [(String, () throws -> Void)] = [
        ("HTTPServer.healthStateAndEvent", localHTTPServerHealthStateAndEvent),
        ("HookInstaller.stagesBinaryAndUpdatesConfigs", hookInstallerStagesBinaryAndUpdatesConfigs),
        ("HookInstaller.rejectsMalformedConfig", rejectsMalformedConfig),
        ("HookInstaller.replacesBinaryAtomically", replacesBinaryAtomically),
        ("DirectoryLock.exclusivity", directoryLockExclusivity),
    ]

    static func localHTTPServerHealthStateAndEvent() throws {
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
        let boundPort = portBox.value
        try expect(boundPort > 0)

        // GET /health
        let healthURL = URL(string: "http://127.0.0.1:\(boundPort)/health")!
        let (healthData, healthResp) = try syncRequest(URLRequest(url: healthURL))
        try expectEqual((healthResp as? HTTPURLResponse)?.statusCode, 200)
        let healthObj = try JSONSerialization.jsonObject(with: healthData) as? [String: Any]
        try expectEqual(healthObj?["ok"] as? Bool, true)

        // POST /event with invalid Origin -> 403
        var badReq = URLRequest(url: URL(string: "http://127.0.0.1:\(boundPort)/event")!)
        badReq.httpMethod = "POST"
        badReq.setValue("application/json", forHTTPHeaderField: "Content-Type")
        badReq.setValue("https://evil.example", forHTTPHeaderField: "Origin")
        badReq.httpBody = Data(#"{"agent":"claude-code","type":"user_prompt"}"#.utf8)
        let (_, badResp) = try syncRequest(badReq)
        try expectEqual((badResp as? HTTPURLResponse)?.statusCode, 403)

        // POST /event valid
        var okReq = URLRequest(url: URL(string: "http://127.0.0.1:\(boundPort)/event")!)
        okReq.httpMethod = "POST"
        okReq.setValue("application/json", forHTTPHeaderField: "Content-Type")
        okReq.httpBody = Data(#"{"agent":"claude-code","sessionId":"44444444-2222-3333-4444-555555555555","type":"user_prompt","message":"hello swift"}"#.utf8)
        let (_, okResp) = try syncRequest(okReq)
        try expectEqual((okResp as? HTTPURLResponse)?.statusCode, 200)

        // GET /state verifies ingested session
        struct StateEnvelope: Decodable {
            let ok: Bool
            let state: AppStateSnapshot
        }
        let (stateData, _) = try syncRequest(URLRequest(url: URL(string: "http://127.0.0.1:\(boundPort)/state")!))
        let env = try JSONDecoder().decode(StateEnvelope.self, from: stateData)
        try expect(env.ok)
        try expectEqual(env.state.sessions.count, 1)
        try expectEqual(env.state.sessions[0].lastPrompt, "hello swift")
    }

    static func hookInstallerStagesBinaryAndUpdatesConfigs() throws {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("light-hooks-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }

        let fakeBin = tmp.appendingPathComponent("src-light-hook")
        try Data("#!/bin/sh\nexit 0\n".utf8).write(to: fakeBin)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: fakeBin.path)

        let fakeHome = tmp.appendingPathComponent("home")
        let fakeData = tmp.appendingPathComponent("data")
        try FileManager.default.createDirectory(at: fakeHome, withIntermediateDirectories: true)

        let claudeDir = fakeHome.appendingPathComponent(".claude")
        try FileManager.default.createDirectory(at: claudeDir, withIntermediateDirectories: true)
        let existingClaude = """
        {
          "hooks": {
            "UserPromptSubmit": [
              { "hooks": [{ "type": "command", "command": "/usr/local/bin/my-custom-hook" }] }
            ]
          }
        }
        """
        let settings = claudeDir.appendingPathComponent("settings.json")
        let tracked = fakeHome.appendingPathComponent("tracked-settings.json")
        try existingClaude.write(to: tracked, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: tracked.path)
        try FileManager.default.createSymbolicLink(atPath: settings.path, withDestinationPath: "../tracked-settings.json")

        let antigravityConfig = URL(fileURLWithPath: AgentConfigPaths.resolve(homeDir: fakeHome.path).antigravityFile)
        try FileManager.default.createDirectory(at: antigravityConfig.deletingLastPathComponent(), withIntermediateDirectories: true)
        let oldConfig = #"{"light-antigravity":{"Stop":[{"type":"command","command":"'/old/light-hook' 'antigravity' 'Stop'"}]}}"#
        try oldConfig.write(to: antigravityConfig, atomically: true, encoding: .utf8)

        let res = HookInstaller.installHooks(
            sourceHookBinary: fakeBin.path,
            userDataPath: fakeData.path,
            port: 51789,
            homeDir: fakeHome.path
        )
        try expect(res.claude.error == nil)
        try expect(res.codex.error == nil)
        try expect(res.antigravity.error == nil)
        try expect(res.claude.changed)
        try expect(res.codex.changed)
        try expect(res.antigravity.changed)

        let staged = fakeData.appendingPathComponent("hooks/light-hook").path
        try expect(FileManager.default.isExecutableFile(atPath: staged))

        let claudeText = try String(contentsOf: claudeDir.appendingPathComponent("settings.json"), encoding: .utf8)
        try expect(claudeText.contains("/usr/local/bin/my-custom-hook"))
        try expect(claudeText.contains("light-hook"))

        try expectEqual(try FileManager.default.destinationOfSymbolicLink(atPath: settings.path), "../tracked-settings.json")
        try expectEqual(try String(contentsOf: tracked, encoding: .utf8), claudeText)
        try expectEqual(try FileManager.default.attributesOfItem(atPath: tracked.path)[.posixPermissions] as? Int, 0o600)
        let backup = try require(res.claude.backupPath)
        try expectEqual(try String(contentsOfFile: backup, encoding: .utf8), existingClaude)
        try expectEqual(try FileManager.default.attributesOfItem(atPath: backup)[.type] as? FileAttributeType, .typeRegular)
        try expectEqual(res.antigravity.added, 2)
        try expectEqual(res.antigravity.updated, 1)
        let antigravityText = try String(contentsOf: antigravityConfig, encoding: .utf8)
        try expect(!antigravityText.contains("/old/light-hook"))

        let connections = HookInstaller.readHookConnections(homeDir: fakeHome.path)
        try expectEqual(connections.count, 3)
        try expect(connections.allSatisfy(\.configured))

        // Second run is idempotent
        let res2 = HookInstaller.installHooks(
            sourceHookBinary: fakeBin.path,
            userDataPath: fakeData.path,
            port: 51789,
            homeDir: fakeHome.path
        )
        try expect(!res2.claude.changed)
        try expect(!res2.codex.changed)
        try expect(!res2.antigravity.changed)
    }

    static func rejectsMalformedConfig() throws {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("light-config-\(UUID().uuidString)")
        defer { try? fm.removeItem(at: root) }
        let paths = AgentConfigPaths.resolve(homeDir: root.path)
        let claude = URL(fileURLWithPath: paths.claudeFile)
        let codex = URL(fileURLWithPath: paths.codexFile)
        for file in [claude, codex] {
            try fm.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        }
        let malformed: [[String: Any]] = [
            ["hooks": ["unexpected"]],
            ["hooks": ["UserPromptSubmit": [["hooks": [["command": "my-custom-hook"]]], "other"]]],
            ["hooks": ["UserPromptSubmit": [["hooks": ["unexpected"]]]]]
        ]
        for config in malformed {
            let original = try JSONSerialization.data(withJSONObject: config)
            for file in [claude, codex] { try original.write(to: file) }
            let result = HookInstaller.installHooks(sourceHookBinary: "/usr/bin/true", userDataPath: root.path, homeDir: root.path)
            for target in [result.claude, result.codex] {
                try expect(target.error != nil)
                try expect(!target.changed)
                try expect(target.backupPath == nil)
                try expectEqual(try Data(contentsOf: URL(fileURLWithPath: target.path)), original)
            }
        }
        try fm.removeItem(at: claude)
        try fm.createSymbolicLink(atPath: claude.path, withDestinationPath: "../missing.json")
        let broken = HookInstaller.installHooks(sourceHookBinary: "/usr/bin/true", userDataPath: root.path, homeDir: root.path)
        try expect(broken.claude.error != nil)
        try expectEqual(try fm.destinationOfSymbolicLink(atPath: claude.path), "../missing.json")
    }

    static func replacesBinaryAtomically() throws {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("light-binary-\(UUID().uuidString)")
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: root) }
        let old = Data("old helper".utf8)
        let new = Data("new helper".utf8)
        let source = root.appendingPathComponent("source")
        try old.write(to: source)
        let target = try HookInstaller.stageHookBinary(sourceBinaryPath: source.path, userDataPath: root.path)
        let opened = try FileHandle(forReadingFrom: URL(fileURLWithPath: target))
        defer { try? opened.close() }
        try new.write(to: source)

        // Every caller loads the same build. Each must either find it or install it successfully.
        let results = DispatchQueue(label: "LightHookTests.results")
        final class Failures: @unchecked Sendable { var errors: [Error] = [] }
        let failures = Failures()
        DispatchQueue.concurrentPerform(iterations: 12) { _ in
            do {
                _ = try HookInstaller.stageHookBinary(sourceBinaryPath: source.path, userDataPath: root.path)
                try expectEqual(try Data(contentsOf: URL(fileURLWithPath: target)), new)
            } catch {
                results.sync { failures.errors.append(error) }
            }
        }
        if let error = failures.errors.first { throw error }
        try expectEqual(try opened.readToEnd(), old)
        try expect(fm.isExecutableFile(atPath: target))
        try expectEqual(try fm.contentsOfDirectory(atPath: root.appendingPathComponent("hooks").path), ["light-hook"])
    }

    static func directoryLockExclusivity() throws {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("light-lock-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: tmp) }

        let fd1 = try DirectoryLock.acquire(directory: tmp.path)
        defer { DirectoryLock.release(fd1) }

        var gotLocked = false
        do {
            _ = try DirectoryLock.acquire(directory: tmp.path)
        } catch DirectoryLock.LockError.alreadyLocked {
            gotLocked = true
        }
        try expect(gotLocked, "second lock acquire should throw alreadyLocked")
    }

    private static func syncRequest(_ req: URLRequest) throws -> (Data, URLResponse) {
        let sem = DispatchSemaphore(value: 0)
        final class RespBox: @unchecked Sendable {
            var data = Data()
            var resp: URLResponse?
            var err: Error?
        }
        let box = RespBox()
        URLSession.shared.dataTask(with: req) { data, resp, err in
            if let data { box.data = data }
            box.resp = resp
            box.err = err
            sem.signal()
        }.resume()
        _ = sem.wait(timeout: .now() + 5)
        if let err = box.err { throw err }
        return (box.data, try require(box.resp))
    }
}
