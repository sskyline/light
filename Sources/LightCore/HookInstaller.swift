import Darwin
import Foundation

public struct HookTargetResult: Equatable, Sendable {
    public let target: String
    public let path: String
    public var changed: Bool
    public var added: Int
    public var updated: Int
    public var skipped: Int
    public var backupPath: String?
    public var error: String?

    public init(
        target: String,
        path: String,
        changed: Bool = false,
        added: Int = 0,
        updated: Int = 0,
        skipped: Int = 0,
        backupPath: String? = nil,
        error: String? = nil
    ) {
        self.target = target
        self.path = path
        self.changed = changed
        self.added = added
        self.updated = updated
        self.skipped = skipped
        self.backupPath = backupPath
        self.error = error
    }
}

public struct InstallHooksResult: Equatable, Sendable {
    public let claude: HookTargetResult
    public let codex: HookTargetResult
    public let antigravity: HookTargetResult
    public let hookDir: String

    public init(claude: HookTargetResult, codex: HookTargetResult, antigravity: HookTargetResult, hookDir: String) {
        self.claude = claude
        self.codex = codex
        self.antigravity = antigravity
        self.hookDir = hookDir
    }
}

public enum HookInstaller {
    private struct HookSpec {
        let event: String
        let arg: String
        let matcher: String?
        let statusMessage: String?
        let timeout: Int?

        init(event: String, arg: String, matcher: String? = nil, statusMessage: String? = nil, timeout: Int? = nil) {
            self.event = event
            self.arg = arg
            self.matcher = matcher
            self.statusMessage = statusMessage
            self.timeout = timeout
        }
    }

    private static let claudeSpecs: [HookSpec] = [
        HookSpec(event: "SessionStart", arg: "session_start"),
        HookSpec(event: "SessionEnd", arg: "session_end"),
        HookSpec(event: "UserPromptSubmit", arg: "user_prompt"),
        HookSpec(event: "PreToolUse", arg: "tool_use", matcher: "*"),
        HookSpec(event: "PermissionRequest", arg: "approval_request", matcher: "*"),
        HookSpec(event: "PermissionDenied", arg: "auto_approval_failed", matcher: "*"),
        HookSpec(event: "PostToolUse", arg: "tool_result", matcher: "*"),
        HookSpec(event: "Stop", arg: "stop")
    ]

    private static let codexSpecs: [HookSpec] = [
        HookSpec(event: "UserPromptSubmit", arg: "UserPromptSubmit", statusMessage: "Light: Codex working"),
        HookSpec(event: "PreToolUse", arg: "PreToolUse", matcher: "*", statusMessage: "Light: Codex tool started"),
        HookSpec(event: "PermissionRequest", arg: "PermissionRequest", matcher: "*", statusMessage: "Light: Codex approval requested"),
        HookSpec(event: "PostToolUse", arg: "PostToolUse", matcher: "*", statusMessage: "Light: Codex tool finished"),
        HookSpec(event: "Stop", arg: "Stop", statusMessage: "Light: Codex turn finished"),
        HookSpec(event: "Interrupt", arg: "Interrupt", statusMessage: "Light: Codex turn interrupted", timeout: 3)
    ]

    // PreToolUse participates in permission decisions in Antigravity. A status
    // monitor must not register it or return an allow/deny decision.
    private static let antigravityEvents = ["PreInvocation", "PostToolUse", "Stop"]
    private static let antigravityHookName = "light-antigravity"

    private static let managedNativeShapeRegex = try! NSRegularExpression(
        pattern: "^(?:LIGHT_PORT=[0-9]+ )?'(?:[^']|'\\\\'')*' '(?:claude|codex|antigravity)' '(?:[^']|'\\\\'')*'$"
    )

    public static func quoteArg(_ value: String) -> String {
        "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    public static func buildNativeCommand(hookBinaryPath: String, agent: String, arg: String, port: Int = 51789) -> String {
        let prefix = port == 51789 ? "" : "LIGHT_PORT=\(port) "
        return prefix + [hookBinaryPath, agent, arg].map(quoteArg).joined(separator: " ")
    }

    /// Copies the bundled `light-hook` binary into `<userDataPath>/hooks/light-hook`
    /// so hook configurations remain stable across app upgrades or DMG moves.
    public static func stageHookBinary(sourceBinaryPath: String, userDataPath: String) throws -> String {
        let fm = FileManager.default
        let hookDir = (userDataPath as NSString).appendingPathComponent("hooks")
        let targetPath = (hookDir as NSString).appendingPathComponent("light-hook")
        try fm.createDirectory(atPath: hookDir, withIntermediateDirectories: true)

        let sourceData = try Data(contentsOf: URL(fileURLWithPath: sourceBinaryPath))
        let existingData = try? Data(contentsOf: URL(fileURLWithPath: targetPath))
        if existingData != sourceData {
            let tmpPath = "\(targetPath).\(UUID().uuidString).tmp"
            try sourceData.write(to: URL(fileURLWithPath: tmpPath), options: .withoutOverwriting)
            defer { try? fm.removeItem(atPath: tmpPath) }
            try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: tmpPath)
            guard rename(tmpPath, targetPath) == 0 else {
                throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
            }
        } else {
            try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: targetPath)
        }
        return targetPath
    }

    private static func isEquivalentHook(command: String, agent: String) -> Bool {
        command.contains("light-hook") && command.contains("'\(agent)'")
    }

    private static func isManagedCommand(_ old: String, agent: String, arg: String) -> Bool {
        let range = NSRange(old.startIndex..<old.endIndex, in: old)
        guard old.hasSuffix(" \(quoteArg(arg))") else { return false }
        return managedNativeShapeRegex.firstMatch(in: old, range: range) != nil &&
            old.contains("light-hook") &&
            old.contains("'\(agent)'")
    }

    private static func readJsonConfig(at path: String) -> (config: [String: Any], existed: Bool, error: String?) {
        let fm = FileManager.default
        guard fm.fileExists(atPath: path) else {
            if (try? fm.destinationOfSymbolicLink(atPath: path)) != nil {
                return ([:], true, "配置符号链接的目标无法读取")
            }
            return ([:], false, nil)
        }
        do {
            let raw = try String(contentsOfFile: path, encoding: .utf8)
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty { return ([:], true, nil) }
            guard let data = raw.data(using: .utf8) else {
                return ([:], true, "配置文件无法按 UTF-8 读取")
            }
            let obj = try JSONSerialization.jsonObject(with: data)
            guard let dict = obj as? [String: Any] else {
                return ([:], true, "配置文件顶层不是 JSON object")
            }
            return (dict, true, nil)
        } catch {
            return ([:], true, error.localizedDescription)
        }
    }

    private static func writeJsonConfig(_ dict: [String: Any], to path: String, existed: Bool) throws -> String? {
        let fm = FileManager.default
        let target = URL(fileURLWithPath: path).resolvingSymlinksInPath()
        try fm.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)

        var backupPath: String?
        if existed {
            let df = DateFormatter()
            df.locale = Locale(identifier: "en_US_POSIX")
            df.dateFormat = "yyyyMMdd-HHmmss"
            let candidate = "\(target.path).light-backup-\(df.string(from: Date()))-\(UUID().uuidString)"
            try fm.copyItem(atPath: target.path, toPath: candidate)
            backupPath = candidate
        }

        let data = try JSONSerialization.data(withJSONObject: dict, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
        var out = data
        out.append(0x0A)
        try out.write(to: target, options: .atomic)
        return backupPath
    }

    private static func installStandardTarget(
        targetName: String,
        agent: String,
        filePath: String,
        specs: [HookSpec],
        hookBinaryPath: String,
        port: Int
    ) -> HookTargetResult {
        var result = HookTargetResult(target: targetName, path: filePath)
        let loaded = readJsonConfig(at: filePath)
        if let err = loaded.error {
            result.error = err
            return result
        }

        var config = loaded.config
        guard var hooks = (config["hooks"] ?? [String: Any]()) as? [String: Any] else {
            result.error = "hooks 不是 JSON object"
            return result
        }
        for spec in specs {
            guard let entry = hooks[spec.event] else { continue }
            guard let groups = entry as? [[String: Any]],
                  groups.allSatisfy({ $0["hooks"] is [[String: Any]] }) else {
                result.error = "hooks.\(spec.event) 的配置组或处理器列表格式异常"
                return result
            }
        }

        for spec in specs {
            let command = buildNativeCommand(hookBinaryPath: hookBinaryPath, agent: agent, arg: spec.arg, port: port)
            var groups = (hooks[spec.event] as? [[String: Any]]) ?? []

            var foundAny = false
            var updatedAny = false
            for gIdx in groups.indices {
                guard var groupHooks = groups[gIdx]["hooks"] as? [[String: Any]] else { continue }
                var groupModified = false
                for hIdx in groupHooks.indices {
                    guard (groupHooks[hIdx]["type"] as? String) == "command",
                          let oldCmd = groupHooks[hIdx]["command"] as? String,
                          isEquivalentHook(command: oldCmd, agent: agent) else {
                        continue
                    }
                    foundAny = true
                    if oldCmd != command && isManagedCommand(oldCmd, agent: agent, arg: spec.arg) {
                        groupHooks[hIdx]["command"] = command
                        groupModified = true
                        updatedAny = true
                    }
                }
                if groupModified {
                    groups[gIdx]["hooks"] = groupHooks
                }
            }

            if foundAny {
                if updatedAny {
                    hooks[spec.event] = groups
                    result.updated += 1
                } else {
                    result.skipped += 1
                }
                continue
            }

            var handler: [String: Any] = [
                "type": "command",
                "command": command
            ]
            if let statusMessage = spec.statusMessage { handler["statusMessage"] = statusMessage }
            if let timeout = spec.timeout { handler["timeout"] = timeout }

            var group: [String: Any] = ["hooks": [handler]]
            if let matcher = spec.matcher { group["matcher"] = matcher }
            groups.append(group)
            hooks[spec.event] = groups
            result.added += 1
        }

        if result.added == 0 && result.updated == 0 {
            return result
        }

        config["hooks"] = hooks
        do {
            result.backupPath = try writeJsonConfig(config, to: filePath, existed: loaded.existed)
            result.changed = true
        } catch {
            result.error = error.localizedDescription
        }
        return result
    }

    private static func installAntigravityTarget(
        filePath: String,
        hookBinaryPath: String,
        port: Int
    ) -> HookTargetResult {
        var result = HookTargetResult(target: "Antigravity", path: filePath)
        let loaded = readJsonConfig(at: filePath)
        if let err = loaded.error {
            result.error = err
            return result
        }
        var config = loaded.config
        if let existing = config[antigravityHookName], !(existing is [String: Any]) {
            result.error = "\(antigravityHookName) 不是 JSON object，未修改"
            return result
        }
        for event in antigravityEvents {
            if let val = (config[antigravityHookName] as? [String: Any])?[event], !(val is [Any]) {
                result.error = "\(antigravityHookName).\(event) 不是数组，未修改"
                return result
            }
        }

        for event in antigravityEvents {
            let command = buildNativeCommand(hookBinaryPath: hookBinaryPath, agent: "antigravity", arg: event, port: port)
            var foundAny = false
            var updatedAny = false

            for (entryKey, entryVal) in config {
                guard var entryDict = entryVal as? [String: Any],
                      var eventItems = entryDict[event] as? [Any] else { continue }
                var entryModified = false

                for i in eventItems.indices {
                    if event == "PostToolUse",
                       var group = eventItems[i] as? [String: Any],
                       var groupHooks = group["hooks"] as? [[String: Any]] {
                        var grpChanged = false
                        for hIdx in groupHooks.indices {
                            let type = groupHooks[hIdx]["type"] as? String
                            guard (type == nil || type == "command"),
                                  let oldCmd = groupHooks[hIdx]["command"] as? String,
                                  isEquivalentHook(command: oldCmd, agent: "antigravity") else {
                                continue
                            }
                            foundAny = true
                            if oldCmd != command && isManagedCommand(oldCmd, agent: "antigravity", arg: event) {
                                groupHooks[hIdx]["command"] = command
                                grpChanged = true
                                updatedAny = true
                            }
                        }
                        if grpChanged {
                            group["hooks"] = groupHooks
                            eventItems[i] = group
                            entryModified = true
                        }
                    } else if var handler = eventItems[i] as? [String: Any] {
                        let type = handler["type"] as? String
                        guard (type == nil || type == "command"),
                              let oldCmd = handler["command"] as? String,
                              isEquivalentHook(command: oldCmd, agent: "antigravity") else {
                            continue
                        }
                        foundAny = true
                        if oldCmd != command && isManagedCommand(oldCmd, agent: "antigravity", arg: event) {
                            handler["command"] = command
                            eventItems[i] = handler
                            entryModified = true
                            updatedAny = true
                        }
                    }
                }

                if entryModified {
                    entryDict[event] = eventItems
                    config[entryKey] = entryDict
                }
            }

            if foundAny {
                if updatedAny { result.updated += 1 }
                else { result.skipped += 1 }
                continue
            }

            let handler: [String: Any] = [
                "type": "command",
                "command": command,
                "timeout": 3
            ]
            let item: Any = (event == "PostToolUse") ? ["matcher": "*", "hooks": [handler]] : handler
            var namedHook = (config[antigravityHookName] as? [String: Any]) ?? [:]
            var previous = (namedHook[event] as? [Any]) ?? []
            previous.append(item)
            namedHook[event] = previous
            config[antigravityHookName] = namedHook
            result.added += 1
        }

        if result.added == 0 && result.updated == 0 {
            return result
        }
        do {
            result.backupPath = try writeJsonConfig(config, to: filePath, existed: loaded.existed)
            result.changed = true
        } catch {
            result.error = error.localizedDescription
        }
        return result
    }

    public static func installHooks(
        sourceHookBinary: String,
        userDataPath: String,
        port: Int = 51789,
        homeDir: String? = nil,
        env: [String: String]? = nil
    ) -> InstallHooksResult {
        let paths = AgentConfigPaths.resolve(homeDir: homeDir, env: env)
        let hookDir = (userDataPath as NSString).appendingPathComponent("hooks")

        let stagedPath: String
        do {
            stagedPath = try stageHookBinary(sourceBinaryPath: sourceHookBinary, userDataPath: userDataPath)
        } catch {
            let msg = "无法部署 light-hook 二进制：\(error.localizedDescription)"
            return InstallHooksResult(
                claude: HookTargetResult(target: "Claude Code", path: paths.claudeFile, error: msg),
                codex: HookTargetResult(target: "Codex", path: paths.codexFile, error: msg),
                antigravity: HookTargetResult(target: "Antigravity", path: paths.antigravityFile, error: msg),
                hookDir: hookDir
            )
        }

        let claude = installStandardTarget(
            targetName: "Claude Code",
            agent: "claude",
            filePath: paths.claudeFile,
            specs: claudeSpecs,
            hookBinaryPath: stagedPath,
            port: port
        )
        let codex = installStandardTarget(
            targetName: "Codex",
            agent: "codex",
            filePath: paths.codexFile,
            specs: codexSpecs,
            hookBinaryPath: stagedPath,
            port: port
        )
        let antigravity = installAntigravityTarget(
            filePath: paths.antigravityFile,
            hookBinaryPath: stagedPath,
            port: port
        )
        return InstallHooksResult(claude: claude, codex: codex, antigravity: antigravity, hookDir: hookDir)
    }

    static func codexDiagnosticCommands(at path: String) -> [HookDiagnostics.Command: Int]? {
        let loaded = readJsonConfig(at: path)
        guard loaded.error == nil else { return nil }
        let hooks = loaded.config["hooks"] as? [String: Any] ?? [:]
        var expected: [HookDiagnostics.Command: Int] = [:]
        for spec in codexSpecs {
            let groups = hooks[spec.event] as? [[String: Any]] ?? []
            for group in groups {
                for handler in group["hooks"] as? [[String: Any]] ?? [] {
                    if handler["type"] as? String == "command", let command = handler["command"] as? String,
                       isEquivalentHook(command: command, agent: "codex") {
                        expected[.init(event: spec.event.lowercased(), text: command), default: 0] += 1
                    }
                }
            }
        }
        return expected
    }

    public static func readHookConnections(homeDir: String? = nil, env: [String: String]? = nil, claudeWorkspace: String? = nil) -> [AdapterConnection] {
        let paths = AgentConfigPaths.resolve(homeDir: homeDir, env: env)
        let targets: [(agent: AgentId, name: String, file: String, events: [String], cliAgent: String)] = [
            (.claudeCode, "Claude Code", paths.claudeFile, claudeSpecs.map(\.event), "claude"),
            (.codex, "Codex", paths.codexFile, codexSpecs.map(\.event), "codex"),
            (.antigravity, "Antigravity", paths.antigravityFile, antigravityEvents, "antigravity")
        ]

        return targets.map { target in
            let loaded = readJsonConfig(at: target.file)
            let status: String
            var assessment: HookAssessment?
            if loaded.error != nil {
                assessment = HookAssessment("无法核实 Hook 状态", needsAttention: true)
                status = "配置无法读取"
            } else {
                func countEvents(activeOnly: Bool) -> Int {
                    if target.agent == .antigravity {
                        return target.events.filter { event in
                            hasAntigravityHook(in: loaded.config, event: event, activeOnly: activeOnly)
                        }.count
                    }
                    if activeOnly && (loaded.config["disableAllHooks"] as? Bool) == true {
                        return 0
                    }
                    let hooksDict = loaded.config["hooks"] as? [String: Any]
                    return target.events.filter { event in
                        guard let groups = hooksDict?[event] as? [[String: Any]] else { return false }
                        return groups.contains { group in
                            guard let handlers = group["hooks"] as? [[String: Any]] else { return false }
                            return handlers.contains { h in
                                (h["type"] as? String) == "command" &&
                                (h["command"] as? String).map {
                                    isEquivalentHook(command: $0, agent: target.cliAgent)
                                } == true
                            }
                        }
                    }.count
                }

                let active = countEvents(activeOnly: true)
                let installed = countEvents(activeOnly: false)
                if active == target.events.count {
                    status = "Hook 已配置"
                } else if active > 0 {
                    status = "部分已配置（\(active)/\(target.events.count)）"
                } else if installed > 0 {
                    status = "Hook 已禁用"
                } else {
                    status = "未找到 Light Hook"
                }
                if installed > 0 {
                    switch target.agent {
                    case .claudeCode:
                        assessment = HookDiagnostics.claudeWorkspaceTrust(paths: paths, workspace: claudeWorkspace)
                    case .antigravity:
                        assessment = HookAssessment("全局开关已启用 \(active)/\(installed) 个事件", needsAttention: active < installed)
                    default: break
                    }
                }
            }

            var connection = AdapterConnection(
                agent: target.agent,
                name: target.name,
                configured: status == "Hook 已配置",
                status: status,
                configPath: AgentConfigPaths.formatDisplayPath(target.file, homeDir: paths.homeDir)
            )
            connection.assessment = assessment
            return connection
        }
    }

    private static func hasAntigravityHook(in config: [String: Any], event: String, activeOnly: Bool) -> Bool {
        for (_, val) in config {
            guard let entry = val as? [String: Any] else { continue }
            if activeOnly && (entry["enabled"] as? Bool) == false { continue }
            guard let items = entry[event] as? [Any] else { continue }
            for item in items {
                guard let dict = item as? [String: Any] else { continue }
                let handlers: [[String: Any]]
                if event == "PostToolUse", let nested = dict["hooks"] as? [[String: Any]] {
                    handlers = nested
                } else {
                    handlers = [dict]
                }
                for h in handlers {
                    let type = h["type"] as? String
                    if (type == nil || type == "command"),
                       let cmd = h["command"] as? String,
                       isEquivalentHook(command: cmd, agent: "antigravity") {
                        return true
                    }
                }
            }
        }
        return false
    }

    public static func formatInstallResult(_ result: InstallHooksResult) -> String {
        let lines = [
            "Hook 配置明细",
            "补齐缺失事件，并更新安装器生成的旧执行路径；自定义命令和其他 hook 保持不变。",
            "",
            formatTargetResult(result.claude),
            formatTargetResult(result.codex),
            formatTargetResult(result.antigravity),
            "",
            "Hook 执行目录: \(result.hookDir)",
            "",
            "下一步: 重启 Claude Code / Codex，并在 CLI 里运行 /hooks 信任新增 hook。",
            "Antigravity: 新一轮对话会加载配置；若未生效，按原有方式完全退出并重新启动。",
            "Antigravity 支持工作、工具完成、完成/出错；暂不检测等待审批或窗口关闭。"
        ]
        return lines.joined(separator: "\n")
    }

    private static func formatTargetResult(_ result: HookTargetResult) -> String {
        if let err = result.error {
            return "\(result.target): 失败，未修改\n  \(result.path)\n  \(err)"
        }
        let status = result.changed
            ? "补齐 \(result.added) 项，更新路径 \(result.updated) 项，跳过 \(result.skipped) 项"
            : "无需修改，已有 Light hook \(result.skipped) 项"
        let backup = result.backupPath.map { "\n  备份: \($0)" } ?? ""
        return "\(result.target): \(status)\n  \(result.path)\(backup)"
    }
}
