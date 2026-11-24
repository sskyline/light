import Foundation

public struct ValidatedResumeCommand: Equatable, Sendable {
    public let argv: [String]
    public let cwd: String?
    public let shellCommand: String

    public init(argv: [String], cwd: String?, shellCommand: String) {
        self.argv = argv
        self.cwd = cwd
        self.shellCommand = shellCommand
    }
}

public struct OpenJumpResult: Equatable, Sendable {
    public let opened: Bool
    public let reopened: Bool
    public let updatedTarget: JumpTarget?

    public init(opened: Bool, reopened: Bool = false, updatedTarget: JumpTarget? = nil) {
        self.opened = opened
        self.reopened = reopened
        self.updatedTarget = updatedTarget
    }
}

public struct OpenSessionResponse: Equatable, Sendable {
    public let opened: Bool
    public let message: String?

    public let canResumeInNewTab: Bool

    public init(opened: Bool, message: String? = nil, canResumeInNewTab: Bool = false) {
        self.canResumeInNewTab = canResumeInNewTab
        self.opened = opened
        self.message = message
    }
}

public struct RexSessionLocationUnknown: LocalizedError, Sendable {
    public var errorDescription: String? { "无法确认这条会话是否仍在 Rex 中运行。" }
}

public struct NavigationError: LocalizedError, Sendable {
    public let message: String
    public var errorDescription: String? { message }
    public init(_ message: String) { self.message = message }
}

public typealias ProcessExec = @Sendable (_ executable: String, _ args: [String], _ timeout: TimeInterval) throws -> String

public enum ProcessRunner {
    public static func run(
        executable: String, args: [String], timeout: TimeInterval = 15,
        environment: [String: String]? = nil
    ) throws -> String {
        guard timeout.isFinite, timeout > 0 else { throw NavigationError("命令执行超时。") }
        let deadline = DispatchTime.now() + timeout
        let stdout = Pipe()
        let stderr = Pipe()
        // FileHandle owns the descriptors. Only this thread drains the pipes.
        defer {
            try? stdout.fileHandleForReading.close()
            try? stderr.fileHandleForReading.close()
        }
        let handles = [stdout.fileHandleForReading.fileDescriptor, stderr.fileHandleForReading.fileDescriptor]
        for fd in handles {
            let flags = fcntl(fd, F_GETFL)
            guard flags >= 0, fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0 else {
                throw systemError(errno)
            }
        }

        let pid = try spawn(executable: executable, args: args,
                            environment: environment ?? ProcessInfo.processInfo.environment,
                            stdout: stdout.fileHandleForWriting.fileDescriptor,
                            stderr: stderr.fileHandleForWriting.fileDescriptor)
        try? stdout.fileHandleForWriting.close()
        try? stderr.fileHandleForWriting.close()

        var descriptors = handles.map { pollfd(fd: $0, events: Int16(POLLIN), revents: 0) }
        var output = [Data(), Data()]
        var buffer = [UInt8](repeating: 0, count: 16384)
        var status: Int32 = 0
        var reaped = false
        defer {
            if !reaped { terminateAndReap(pid) }
        }
        while true {
            if !reaped {
                let result = waitpid(pid, &status, WNOHANG)
                if result < 0 {
                    if errno == EINTR { continue }
                    // ECHILD means there is no longer an owned child to signal.
                    reaped = errno == ECHILD
                    throw systemError(errno)
                }
                reaped = result == pid
            }
            let pipesClosed = descriptors.allSatisfy { $0.fd < 0 }
            if reaped && pipesClosed { break }
            let now = DispatchTime.now()
            guard now < deadline else { throw NavigationError("命令执行超时。") }
            let remaining = (deadline.uptimeNanoseconds - now.uptimeNanoseconds) / 1_000_000
            // With both pipes closed the only possible event is the child's exit.
            let milliseconds = Int32(clamping: min(remaining, pipesClosed ? 10 : UInt64(Int32.max)))
            let ready = poll(&descriptors, nfds_t(descriptors.count), max(1, milliseconds))
            if ready < 0 {
                if errno == EINTR { continue }
                throw systemError(errno)
            }
            for i in descriptors.indices where descriptors[i].revents != 0 {
                let n = read(descriptors[i].fd, &buffer, buffer.count)
                if n > 0 { output[i].append(buffer, count: n) }
                else if n == 0 { descriptors[i].fd = -1 }
                else if errno != EAGAIN && errno != EINTR { throw systemError(errno) }
            }
        }
        guard status == 0 else {
            let reason = String(decoding: output[1], as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            throw NavigationError(reason.isEmpty ? "系统未能打开目标。" : String(reason.prefix(500)))
        }
        return String(data: output[0], encoding: .utf8) ?? ""
    }

    /// A full-duplex descriptor for a short-lived, line-oriented CLI exchange.
    static func withStandardIO<T>(executable: String, args: [String], environment: [String: String],
                                  _ exchange: (Int32) throws -> T) throws -> T {
        var sockets = [Int32](repeating: -1, count: 2)
        guard socketpair(AF_UNIX, SOCK_STREAM, 0, &sockets) == 0 else { throw systemError(errno) }
        defer {
            close(sockets[0])
            if sockets[1] >= 0 { close(sockets[1]) }
        }
        var one: Int32 = 1
        guard setsockopt(sockets[0], SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size)) == 0
        else { throw systemError(errno) }
        let errors = open("/dev/null", O_WRONLY)
        guard errors >= 0 else { throw systemError(errno) }
        defer { close(errors) }
        let pid = try spawn(executable: executable, args: args, environment: environment,
                            stdin: sockets[1], stdout: sockets[1], stderr: errors)
        close(sockets[1])
        sockets[1] = -1
        defer {
            shutdown(sockets[0], SHUT_RDWR)
            terminateAndReap(pid)
        }
        return try exchange(sockets[0])
    }

    private static func spawn(executable: String, args: [String], environment: [String: String],
                              stdin: Int32? = nil, stdout: Int32, stderr: Int32) throws -> pid_t {
        var actions: posix_spawn_file_actions_t?
        var attributes: posix_spawnattr_t?
        func check(_ result: Int32) throws {
            if result != 0 { throw systemError(result) }
        }
        try check(posix_spawn_file_actions_init(&actions))
        defer { posix_spawn_file_actions_destroy(&actions) }
        try check(posix_spawnattr_init(&attributes))
        defer { posix_spawnattr_destroy(&attributes) }
        try check(posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_CLOEXEC_DEFAULT)))
        if let stdin {
            try check(posix_spawn_file_actions_adddup2(&actions, stdin, STDIN_FILENO))
        } else {
            try check(posix_spawn_file_actions_addopen(&actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0))
        }
        try check(posix_spawn_file_actions_adddup2(&actions, stdout, STDOUT_FILENO))
        try check(posix_spawn_file_actions_adddup2(&actions, stderr, STDERR_FILENO))

        let argv = ([executable] + args).map { strdup($0) }
        let envp = environment.map { strdup("\($0.key)=\($0.value)") }
        defer { for ptr in argv + envp { free(ptr) } }
        guard !argv.contains(nil), !envp.contains(nil) else { throw systemError(ENOMEM) }
        var pid: pid_t = 0
        try check(posix_spawn(&pid, executable, &actions, &attributes, argv + [nil], envp + [nil]))
        return pid
    }

    private static func terminateAndReap(_ pid: pid_t) {
        // We are the sole waiter. Until waitpid reaps it, this PID cannot be reused.
        func finished() -> Bool {
            let result = waitpid(pid, nil, WNOHANG)
            return result == pid || (result < 0 && errno == ECHILD)
        }
        guard !finished() else { return }
        kill(pid, SIGTERM)
        let deadline = DispatchTime.now() + .milliseconds(150)
        while DispatchTime.now() < deadline {
            if finished() { return }
            Thread.sleep(forTimeInterval: 0.005)
        }
        kill(pid, SIGKILL)
        // Reap even if the kernel takes time to deliver SIGKILL; the caller can return.
        DispatchQueue.global(qos: .utility).async {
            while waitpid(pid, nil, 0) < 0 && errno == EINTR { }
        }
    }

    private static func systemError(_ code: Int32) -> NavigationError {
        NavigationError(String(cString: strerror(code)))
    }

}

public enum SessionNavigation {
    public static func shellQuote(_ value: String) -> String {
        "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    public static func buildResumeCommand(
        _ resume: ResumeSpec?,
        dirExists: (String) -> Bool = { path in
            var isDir: ObjCBool = false
            return FileManager.default.fileExists(atPath: path, isDirectory: &isDir) && isDir.boolValue
        }
    ) -> ValidatedResumeCommand? {
        guard let resume, resume.agent.isResumable, Validation.isSessionUUID(resume.sessionId) else {
            return nil
        }
        let argv = resume.agent == .claudeCode
            ? ["claude", "--resume", resume.sessionId]
            : ["codex", "resume", resume.sessionId]

        var validCwd: String?
        if let rawCwd = Validation.sanitizeCwd(resume.cwd), dirExists(rawCwd) {
            validCwd = rawCwd
        }
        let quotedArgv = argv.map(shellQuote).joined(separator: " ")
        let shellCmd = validCwd.map { "cd -- \(shellQuote($0)) && \(quotedArgv)" } ?? quotedArgv
        return ValidatedResumeCommand(argv: argv, cwd: validCwd, shellCommand: shellCmd)
    }

    public static func resolveJumpTarget(
        agent: AgentId,
        sessionUUID: String?,
        terminal: TerminalPayload?
    ) -> JumpTarget? {
        if let terminal {
            let pane = terminal.id
            if terminal.kind == "rex",
               let session = terminal.session,
               Validation.isRexId(session, kind: "session"),
               Validation.isRexId(pane, kind: "block") {
                return .rex(session: session, id: pane)
            }
            if terminal.kind == "ghostty", Validation.isSessionUUID(pane) {
                return .ghostty(id: pane)
            }
            if terminal.kind == "iterm", Validation.extractItermGUID(pane) != nil {
                return .iterm(id: pane)
            }
        }
        if agent == .codex, let id = sessionUUID, Validation.isSessionUUID(id) {
            return .codex(id: id)
        }
        return nil
    }

    public static func validatePersistedJump(agent: AgentId, target: JumpTarget?) -> JumpTarget? {
        guard let target else { return nil }
        switch target {
        case .rex(let session, let id):
            return resolveJumpTarget(agent: agent, sessionUUID: nil, terminal: TerminalPayload(kind: "rex", id: id, session: session))
        case .ghostty(let id):
            return resolveJumpTarget(agent: agent, sessionUUID: nil, terminal: TerminalPayload(kind: "ghostty", id: id))
        case .iterm(let id):
            return resolveJumpTarget(agent: agent, sessionUUID: nil, terminal: TerminalPayload(kind: "iterm", id: id))
        case .codex(let id):
            guard agent == .codex, Validation.isSessionUUID(id) else { return nil }
            return .codex(id: id.lowercased())
        case .claudeDesktop(let id):
            guard agent == .claudeCode, Validation.isClaudeDesktopId(id) else { return nil }
            return .claudeDesktop(id: id)
        }
    }

    private static let openOrReopenGhosttyScript = """
    on run argv
      set surfaceID to item 1 of argv
      set workDir to item 2 of argv
      set resumeShellCmd to item 3 of argv
      if application id "com.mitchellh.ghostty" is running then
        tell application id "com.mitchellh.ghostty"
          if (exists (terminal id surfaceID)) then
            focus (terminal id surfaceID)
            activate
            return "focused:" & surfaceID
          end if
        end tell
      end if
      if resumeShellCmd is "" then error "原 Ghostty 分屏已关闭。"
      tell application id "com.mitchellh.ghostty"
        activate
        set cfg to new surface configuration
        if workDir is not "" then set initial working directory of cfg to workDir
        set initial input of cfg to resumeShellCmd & linefeed
        if (count of windows) > 0 then
          set t to new tab in front window with configuration cfg
          return "reopened:" & (id of focused terminal of t)
        else
          set w to new window with configuration cfg
          return "reopened:" & (id of focused terminal of selected tab of w)
        end if
      end tell
    end run
    """

    private static let openOrReopenItermScript = """
    on run argv
      set targetGuid to item 1 of argv
      set resumeShellCmd to item 2 of argv
      if application id "com.googlecode.iterm2" is running then
        tell application id "com.googlecode.iterm2"
          repeat with w in windows
            repeat with t in tabs of w
              repeat with s in sessions of t
                if id of s is targetGuid then
                  select w
                  select t
                  select s
                  activate
                  return "focused:" & (id of s)
                end if
              end repeat
            end repeat
          end repeat
        end tell
      end if
      if resumeShellCmd is "" then error "原 iTerm2 分屏已关闭。"
      tell application id "com.googlecode.iterm2"
        activate
        if (count of windows) > 0 then
          set newTab to (create tab with default profile in current window)
          set newSession to current session of newTab
        else
          set newWin to (create window with default profile)
          set newSession to current session of newWin
        end if
        tell newSession to write text resumeShellCmd
        return "reopened:w0t0p0:" & (id of newSession)
      end tell
    end run
    """

    public static func openOrReopenJumpTarget(
        _ target: JumpTarget,
        resume: ResumeSpec? = nil,
        exec: ProcessExec = { try ProcessRunner.run(executable: $0, args: $1, timeout: $2) },
        dirExists: (String) -> Bool = { path in
            var isDir: ObjCBool = false
            return FileManager.default.fileExists(atPath: path, isDirectory: &isDir) && isDir.boolValue
        },
        rexCli: String? = nil,
        claudeConfigDir: String = AgentConfigPaths.resolve().claudeDir,
        allowUnverifiedRestore: Bool = false,
        sleepFn: (TimeInterval) -> Void = { Thread.sleep(forTimeInterval: $0) },
        onTargetUpdated: ((JumpTarget) -> Void)? = nil
    ) throws -> OpenJumpResult {
        let validatedResume = buildResumeCommand(resume, dirExists: dirExists)

        switch target {
        case .rex(let session, let block):
            let res = try RexNavigation.openOrReopenPane(
                session: session,
                block: block,
                resumeArgv: validatedResume?.argv,
                resumeCwd: validatedResume?.cwd,
                cli: rexCli,
                claudeConfigDir: claudeConfigDir,
                allowUnverifiedRestore: allowUnverifiedRestore,
                exec: exec,
                sleepFn: sleepFn
            ) { reopened in
                onTargetUpdated?(.rex(session: reopened.session, id: reopened.id))
            }
            let updated: JumpTarget? = (res.reopened || res.session != session || res.id != block)
                ? .rex(session: res.session, id: res.id)
                : nil
            if !res.reopened, let updated { onTargetUpdated?(updated) }
            return OpenJumpResult(opened: true, reopened: res.reopened, updatedTarget: updated)

        case .claudeDesktop(let id):
            let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            _ = try exec("/usr/bin/open", ["-b", SwitchTarget.claudeCode.bundleID, "claude://claude.ai/epitaxy/\(encoded)"], 15)
            return OpenJumpResult(opened: true)

        case .codex(let id):
            _ = try exec("/usr/bin/open", ["-b", SwitchTarget.codex.bundleID, "codex://threads/\(id)"], 15)
            return OpenJumpResult(opened: true)

        case .ghostty(let surfaceId):
            let stdout = try exec("/usr/bin/osascript", [
                "-e", openOrReopenGhosttyScript,
                surfaceId,
                validatedResume?.cwd ?? "",
                validatedResume?.shellCommand ?? ""
            ], 15)
            let trimmed = stdout.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.hasPrefix("reopened:") {
                let newSurface = String(trimmed.dropFirst("reopened:".count)).trimmingCharacters(in: .whitespacesAndNewlines)
                let updated: JumpTarget? = Validation.isSessionUUID(newSurface) ? .ghostty(id: newSurface) : nil
                if let updated { onTargetUpdated?(updated) }
                return OpenJumpResult(opened: true, reopened: true, updatedTarget: updated)
            }
            return OpenJumpResult(opened: true)

        case .iterm(let paneId):
            let guid = paneId.contains(":") ? String(paneId.split(separator: ":", maxSplits: 1)[1]) : paneId
            guard Validation.isSessionUUID(guid) else {
                throw NavigationError("无效的 iTerm2 会话标识。")
            }
            let stdout = try exec("/usr/bin/osascript", [
                "-e", openOrReopenItermScript,
                guid,
                validatedResume?.shellCommand ?? ""
            ], 15)
            let trimmed = stdout.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.hasPrefix("reopened:") {
                let newPane = String(trimmed.dropFirst("reopened:".count)).trimmingCharacters(in: .whitespacesAndNewlines)
                let updated: JumpTarget? = Validation.extractItermGUID(newPane) != nil ? .iterm(id: newPane) : nil
                if let updated { onTargetUpdated?(updated) }
                return OpenJumpResult(opened: true, reopened: true, updatedTarget: updated)
            }
            return OpenJumpResult(opened: true)
        }
    }
}

public enum RexNavigation {
    private struct RexClient: Decodable {
        struct Info: Decodable { let kind: String?; let platform: String? }
        struct Principal: Decodable { let transport: String? }
        let client_id: String
        let connection_state: String
        let info: Info?
        let principal: Principal?
        let session_ids: [String]?
    }

    private struct ClientInventory: Decodable {
        let clients: [RexClient]?
    }

    private struct BlockInspect: Decodable {
        struct Block: Decodable { let block_id: String?; let window_id: String? }
        let session_id: String?
        let block: Block?
    }

    private struct PaneProcess: Decodable {
        struct Entry: Decodable {
            let pid: Int32
            let name: String?
            let path: String?
            let invoked_path: String?
            let argv0: String?

            private var executableNames: [String] {
                [name, path, invoked_path, argv0].compactMap { $0 }.map { ($0 as NSString).lastPathComponent }
            }

            var isCodexExecutable: Bool {
                executableNames.contains { name in
                    name == "codex" || name == "codex.js" ||
                        name.hasPrefix("codex-aarch64-") || name.hasPrefix("codex-x86_64-")
                }
            }

            var isNode: Bool { executableNames.contains("node") }

            var mayRunClaude: Bool {
                let names = executableNames
                return names.contains("claude") || names.contains("node") ||
                    path?.contains("/claude/versions/") == true ||
                    names.contains("cli.js")
            }
        }

        struct Exit: Decodable {}
        let last_exit: Exit?
        let child: Entry?
        let foreground: Entry?
        let ancestors: [Entry]?
    }

    private struct ClaudeSessionRecord: Decodable {
        let pid: Int32
        let sessionId: String
    }

    private struct TerminalProcess {
        let entry: PaneProcess.Entry
        let parent: Int32
        let group: Int32
        let foregroundGroup: Int32

        init?(_ line: Substring) {
            let fields = line.split(maxSplits: 4, whereSeparator: { $0.isWhitespace })
            guard fields.count == 5, let pid = Int32(fields[0]), let parent = Int32(fields[1]),
                  let group = Int32(fields[2]), let foregroundGroup = Int32(fields[3]) else { return nil }
            self.parent = parent
            self.group = group
            self.foregroundGroup = foregroundGroup
            self.entry = PaneProcess.Entry(pid: pid, name: nil, path: String(fields[4]), invoked_path: nil, argv0: nil)
        }
    }

    // Rex can return only the login process when the terminal's foreground group has exited.
    private static func terminalProcesses(childPID: Int32, exec: ProcessExec) throws -> [PaneProcess.Entry] {
        let unknown = NavigationError("无法读取 Rex 分屏的终端进程，请稍后重试。")
        let tty = try exec("/bin/ps", ["-p", String(childPID), "-o", "tty="], 5)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !tty.isEmpty, tty != "??" else { throw unknown }
        let listing = try exec("/bin/ps", ["-t", tty, "-o", "pid=,ppid=,pgid=,tpgid=,comm="], 5)
        var rows: [Int32: TerminalProcess] = [:]
        for line in listing.split(whereSeparator: \.isNewline) {
            guard let row = TerminalProcess(line) else { throw unknown }
            rows[row.entry.pid] = row
        }
        guard let root = rows[childPID] else { throw unknown }
        let foreground = rows.values.filter { $0.group == root.foregroundGroup }
        let candidates = foreground.isEmpty ? Array(rows.values) : foreground
        var panePIDs = Set<Int32>()
        for candidate in candidates {
            var lineage = Set<Int32>()
            var row = candidate
            while lineage.insert(row.entry.pid).inserted {
                if row.entry.pid == childPID {
                    panePIDs.formUnion(lineage)
                    break
                }
                guard let parent = rows[row.parent] else { break }
                row = parent
            }
        }
        guard !panePIDs.isEmpty else { throw unknown }
        return panePIDs.compactMap { rows[$0]?.entry }
    }

    // lsof emits a process (p), its parent (R), then its open files (n).
    // The CLI can hold a thread lock itself or run a private app-server child that holds it.
    private static func codexThreadOwners(_ listing: String) -> [Int32: Set<String>] {
        var result: [Int32: Set<String>] = [:]
        var pid: Int32?
        var parent: Int32?
        for line in listing.split(separator: "\n") {
            let field = line.dropFirst()
            switch line.first {
            case "p":
                pid = Int32(field)
                parent = nil
            case "R":
                parent = Int32(field)
            case "n":
                guard let pid, field.hasSuffix(".lock") else { continue }
                let path = field.split(separator: "/")
                guard path.dropLast().last == "thread-writer-locks", let filename = path.last else { continue }
                let id = String(filename.dropLast(5)).lowercased()
                guard Validation.isSessionUUID(id) else { continue }
                result[pid, default: []].insert(id)
                if let parent { result[parent, default: []].insert(id) }
            default:
                continue
            }
        }
        return result
    }

    private static func paneRunsSession(
        _ target: ResumeSpec, processJSON: String, claudeConfigDir: String, exec: ProcessExec,
        codexThreads: (Int32) -> Set<String>
    ) throws -> Bool {
        let unknown = RexSessionLocationUnknown()
        guard let pane = try? JSONDecoder().decode(PaneProcess.self, from: Data(processJSON.utf8)) else { throw unknown }

        let entries: [PaneProcess.Entry]
        let orderedByAncestry: Bool
        if let foreground = pane.foreground, pane.ancestors != nil || foreground.pid == pane.child?.pid {
            entries = [foreground] + (pane.ancestors ?? [])
            orderedByAncestry = true
        } else if pane.foreground == nil && pane.last_exit != nil {
            return false
        } else if let child = pane.child, child.pid > 0 {
            entries = try terminalProcesses(childPID: child.pid, exec: exec)
            orderedByAncestry = false
        } else {
            throw unknown
        }

        let sessionsDir = URL(fileURLWithPath: claudeConfigDir).appendingPathComponent("sessions")
        var foundCandidate = false
        var sessionIDs = Set<String>()
        for entry in entries {
            guard entry.pid > 0, entry.name != nil || entry.path != nil else { throw unknown }
            if target.agent == .codex {
                guard entry.isCodexExecutable else {
                    // A bare Node process may be a wrapper. Its name alone cannot identify a thread.
                    if entry.isNode { foundCandidate = true }
                    continue
                }
                foundCandidate = true
                let ids = codexThreads(entry.pid)
                guard ids.count == 1 else { throw unknown }
                sessionIDs.formUnion(ids)
                continue
            }
            guard entry.mayRunClaude else { continue }
            foundCandidate = true
            let file = sessionsDir.appendingPathComponent("\(entry.pid).json")
            if let data = try? Data(contentsOf: file),
               let record = try? JSONDecoder().decode(ClaudeSessionRecord.self, from: data),
               record.pid == entry.pid, Validation.isSessionUUID(record.sessionId) {
                if orderedByAncestry {
                    return record.sessionId.caseInsensitiveCompare(target.sessionId) == .orderedSame
                }
                sessionIDs.insert(record.sessionId.lowercased())
            }
        }
        if !foundCandidate { return false }
        guard sessionIDs.count == 1 else { throw unknown }
        return sessionIDs.contains(target.sessionId.lowercased())
    }

    private struct BlockList: Decodable {
        struct Block: Decodable {
            let block_id: String
            let window_id: String?
            let creator_name: String
        }
        let blocks: [Block]
    }

    private struct SessionList: Decodable {
        struct Item: Decodable { let session_id: String }
        let sessions: [Item]
    }

    private struct RunCreated: Decodable {
        let window_id: String?
        let block_ids: [String]?
    }

    private struct NewCreated: Decodable {
        let session_id: String?
        let initial_windows: [RunCreated]?
    }

    public struct OpenResult: Equatable, Sendable {
        public let reopened: Bool
        public let session: String
        public let id: String
    }

    public static func installedRexCli() throws -> String {
        let homeApps = (FileManager.default.homeDirectoryForCurrentUser.path as NSString).appendingPathComponent("Applications")
        for dir in ["/Applications", homeApps] {
            for app in ["Rex.app", "Rex Beta.app"] {
                let path = ((dir as NSString).appendingPathComponent(app) as NSString)
                    .appendingPathComponent("Contents/Helpers/Rex Server.rex/Contents/MacOS/rex")
                if FileManager.default.fileExists(atPath: path) {
                    return path
                }
            }
        }
        throw NavigationError("未找到 Rex 应用内的命令行工具。")
    }

    private static func listLocalClients(inventory: String) -> [RexClient] {
        guard let data = inventory.data(using: .utf8),
              let parsed = try? JSONDecoder().decode(ClientInventory.self, from: data),
              let clients = parsed.clients else {
            return []
        }
        return clients.filter { client in
            client.info?.kind == "app" &&
            client.info?.platform == "macos" &&
            client.principal?.transport == "unix" &&
            client.connection_state == "connected" &&
            Validation.isRexId(client.client_id, kind: "client")
        }
    }

    private static func isServerOffline(_ error: Error) -> Bool {
        let msg = error.localizedDescription.lowercased()
        return msg.contains("no rex server is running") ||
            msg.contains("autostart is disabled") ||
            msg.contains("connection refused") ||
            msg.contains("connect: no such file or directory")
    }

    private static func isClosedPane(_ error: Error) -> Bool {
        let msg = error.localizedDescription
        return msg.range(of: "not found", options: .caseInsensitive) != nil || msg.contains("原 Rex 分屏已关闭")
    }

    private static func isMissingSession(_ error: Error) -> Bool {
        error.localizedDescription.range(of: "session\\b.*not found", options: [.regularExpression, .caseInsensitive]) != nil
    }

    private static func selectSession(
        rex: ([String]) throws -> String,
        clientId: String,
        session: String,
        windowId: String? = nil
    ) throws {
        var args = ["-C", clientId, "do", "session.select", "session_id=\(session)"]
        if let windowId { args.append("window_id=\(windowId)") }
        do {
            _ = try rex(args)
        } catch {
            let msg = error.localizedDescription
            if msg.range(of: "turn on remote control|remote control is disabled", options: [.regularExpression, .caseInsensitive]) != nil {
                throw NavigationError("请在 Rex → Settings → Server 页底部的 Client Info 中开启 Remote Control，然后再点会话右侧的 ↗ 按钮。")
            }
            throw error
        }
    }

    public static func openOrReopenPane(
        session: String,
        block: String,
        resumeArgv: [String]? = nil,
        resumeCwd: String? = nil,
        cli: String? = nil,
        claudeConfigDir: String = AgentConfigPaths.resolve().claudeDir,
        allowUnverifiedRestore: Bool = false,
        exec: ProcessExec = { try ProcessRunner.run(executable: $0, args: $1, timeout: $2) },
        sleepFn: (TimeInterval) -> Void = { Thread.sleep(forTimeInterval: $0) },
        onPaneReopened: (((session: String, id: String)) -> Void)? = nil
    ) throws -> OpenResult {
        let rexCli = try cli ?? installedRexCli()
        let hasResume = !(resumeArgv ?? []).isEmpty
        var useAutostart = false

        func rex(_ args: [String]) throws -> String {
            let autostartFlag = useAutostart ? "--autostart=true" : "--autostart=false"
            do {
                return try exec(rexCli, [autostartFlag, "--timeout", "4s"] + args, 5)
            } catch {
                let firstLine = error.localizedDescription.split(separator: "\n").first.map(String.init) ?? "Rex 未能定位分屏。"
                throw NavigationError(firstLine)
            }
        }

        var launchedApp = false
        var localClients: [RexClient] = []

        do {
            let inventory = try rex(["client", "ls", "--json"])
            localClients = listLocalClients(inventory: inventory)
        } catch {
            if !hasResume || !isServerOffline(error) { throw error }
            useAutostart = true
        }

        if localClients.count > 1 {
            throw NavigationError("无法唯一确定本机 Rex 客户端，请检查已连接的 Rex 窗口。")
        }

        if localClients.isEmpty {
            if !hasResume {
                throw NavigationError("无法唯一确定本机 Rex 客户端，请检查已连接的 Rex 窗口。")
            }
            _ = try exec("/usr/bin/open", ["-b", "com.superlogical.rex"], 5)
            launchedApp = true
            for attempt in 0..<25 {
                if attempt > 0 { sleepFn(0.2) }
                do {
                    let inventory = try rex(["client", "ls", "--json"])
                    localClients = listLocalClients(inventory: inventory)
                    if !localClients.isEmpty { break }
                } catch {
                    if !useAutostart && isServerOffline(error) {
                        useAutostart = true
                        continue
                    }
                    throw error
                }
            }
            if localClients.count != 1 {
                throw NavigationError("无法唯一确定本机 Rex 客户端，请检查已连接的 Rex 窗口。")
            }
        }

        let client = localClients[0]

        func focus(session: String, window: String, block: String) throws {
            try selectSession(rex: rex, clientId: client.client_id, session: session, windowId: window)
            _ = try rex(["block", "focus", block, "-s", session, "-w", window])
            if !launchedApp { _ = try exec("/usr/bin/open", ["-b", "com.superlogical.rex"], 5) }
        }

        let target: ResumeSpec? = {
            guard let argv = resumeArgv, argv.count == 3, Validation.isSessionUUID(argv[2]) else { return nil }
            let agent: AgentId
            if argv.starts(with: ["codex", "resume"]) { agent = .codex }
            else if argv.starts(with: ["claude", "--resume"]) { agent = .claudeCode }
            else { return nil }
            return ResumeSpec(agent: agent, sessionId: argv[2], cwd: resumeCwd)
        }()
        // Take one snapshot per jump, only if a pane contains a Codex candidate.
        lazy var owners = (try? exec("/usr/sbin/lsof", ["-nP", "-c", "codex", "-FRn"], 5)).map(codexThreadOwners) ?? [:]
        var uncertain = false
        func matches(_ target: ResumeSpec, session: String, block: String) -> Bool {
            do {
                let processes = try rex(["block", "call", "-s", session, "-b", block, "process"])
                return try paneRunsSession(target, processJSON: processes, claudeConfigDir: claudeConfigDir, exec: exec) {
                    owners[$0] ?? []
                }
            } catch {
                uncertain = true
                return false
            }
        }

        var sessionExists = true
        var originalChecked = false
        var location: BlockInspect?
        do {
            let raw = try rex(["block", "inspect", block, "-s", session, "--json"])
            location = try JSONDecoder().decode(BlockInspect.self, from: Data(raw.utf8))
        } catch {
            if hasResume && isClosedPane(error) { sessionExists = !isMissingSession(error) }
            else if target == nil { throw error }
            // The full inventory below can still locate a resumable session.
        }
        if let location, location.session_id == session, location.block?.block_id == block,
           let window = location.block?.window_id, Validation.isRexId(window, kind: "window") {
            originalChecked = true
            if target.map({ matches($0, session: session, block: block) }) ?? true {
                try focus(session: session, window: window, block: block)
                return OpenResult(reopened: false, session: session, id: block)
            }
        }

        guard let argv = resumeArgv, !argv.isEmpty else { throw NavigationError("原 Rex 分屏已关闭。") }

        if let target {
            func inventory<T: Decodable>(_ args: [String], as type: T.Type) -> T? {
                do { return try JSONDecoder().decode(type, from: Data(rex(args).utf8)) }
                catch { uncertain = true; return nil }
            }
            if let list = inventory(["ls", "--short=false", "--json"], as: SessionList.self) {
                sessionExists = list.sessions.contains { $0.session_id == session }
                for item in list.sessions {
                    let sid = item.session_id
                    guard Validation.isRexId(sid, kind: "session") else { uncertain = true; continue }
                    guard let panes = inventory(["block", "ls", "-s", sid, "--json"], as: BlockList.self) else { continue }
                    for pane in panes.blocks where pane.creator_name == "com.superlogical.terminal" {
                        if originalChecked && sid == session && pane.block_id == block { continue }
                        guard let window = pane.window_id, Validation.isRexId(window, kind: "window"),
                              Validation.isRexId(pane.block_id, kind: "block") else { uncertain = true; continue }
                        if matches(target, session: sid, block: pane.block_id) {
                            try focus(session: sid, window: window, block: pane.block_id)
                            return OpenResult(reopened: false, session: sid, id: pane.block_id)
                        }
                    }
                }
            }
            if uncertain && !allowUnverifiedRestore { throw RexSessionLocationUnknown() }
        }

        var flags = ["--json"]
        if let resumeCwd { flags += ["-c", resumeCwd] }
        if target == nil { flags += ["--interactive", "--keep-open", "--"] + argv }

        func createTab() throws -> (String, RunCreated) {
            var destinations = sessionExists ? [session] : []
            if let fallback = client.session_ids?.first(where: { $0 != session && Validation.isRexId($0, kind: "session") }) {
                destinations.append(fallback)
            }
            for destination in destinations {
                let raw: String
                do {
                    try selectSession(rex: rex, clientId: client.client_id, session: destination)
                    let command = target == nil ? ["run"] : ["window", "new"]
                    raw = try rex(command + ["-s", destination] + flags)
                } catch {
                    // The session can disappear before creation. Never repeat a successful create.
                    if isMissingSession(error) { continue }
                    throw error
                }
                return (destination, try JSONDecoder().decode(RunCreated.self, from: Data(raw.utf8)))
            }
            let raw = try rex(["new"] + flags)
            let result = try JSONDecoder().decode(NewCreated.self, from: Data(raw.utf8))
            guard let sid = result.session_id, Validation.isRexId(sid, kind: "session"),
                  let window = result.initial_windows?.first else { throw NavigationError("无法定位新建的 Rex 标签页。") }
            return (sid, window)
        }

        let (newSession, created) = try createTab()
        guard let window = created.window_id, Validation.isRexId(window, kind: "window"),
              let newBlock = created.block_ids?.first, Validation.isRexId(newBlock, kind: "block") else {
            throw NavigationError("无法定位新建的 Rex 标签页。")
        }
        if target != nil {
            // Only send input to the newly created shell. It stays interactive after Claude exits.
            let command = argv.map(SessionNavigation.shellQuote).joined(separator: " ")
            _ = try rex(["send", "-s", newSession, "-w", window, "-b", newBlock, "--", command + "\r"])
        }
        onPaneReopened?((session: newSession, id: newBlock))
        try focus(session: newSession, window: window, block: newBlock)
        return OpenResult(reopened: true, session: newSession, id: newBlock)
    }
}
