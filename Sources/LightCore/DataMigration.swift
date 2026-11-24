import Foundation

public struct AgentConfigPaths: Equatable, Sendable {
    public let homeDir: String
    public let claudeDir: String
    public let codexDir: String
    public let claudeFile: String
    public let codexFile: String
    public let antigravityFile: String

    public static func resolve(
        homeDir: String? = nil,
        env: [String: String]? = nil
    ) -> AgentConfigPaths {
        let rawHome = homeDir?.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedHome = (rawHome?.isEmpty == false ? rawHome! : FileManager.default.homeDirectoryForCurrentUser.path)
            .standardizedPath
        let effectiveEnv: [String: String] = env ?? (homeDir != nil ? [:] : ProcessInfo.processInfo.environment)

        let rawClaude = effectiveEnv["CLAUDE_CONFIG_DIR"]?.trimmingCharacters(in: .whitespacesAndNewlines)
        let rawCodex = effectiveEnv["CODEX_HOME"]?.trimmingCharacters(in: .whitespacesAndNewlines)

        let claudeDir = (rawClaude?.isEmpty == false)
            ? expandHome(rawClaude!, homeDir: resolvedHome)
            : (resolvedHome as NSString).appendingPathComponent(".claude")
        let codexDir = (rawCodex?.isEmpty == false)
            ? expandHome(rawCodex!, homeDir: resolvedHome)
            : (resolvedHome as NSString).appendingPathComponent(".codex")

        return AgentConfigPaths(
            homeDir: resolvedHome,
            claudeDir: claudeDir,
            codexDir: codexDir,
            claudeFile: (claudeDir as NSString).appendingPathComponent("settings.json"),
            codexFile: (codexDir as NSString).appendingPathComponent("hooks.json"),
            antigravityFile: ((resolvedHome as NSString).appendingPathComponent(".gemini/config") as NSString).appendingPathComponent("hooks.json")
        )
    }

    public static func formatDisplayPath(_ filePath: String, homeDir: String) -> String {
        let normFile = filePath.standardizedPath
        let normHome = homeDir.standardizedPath
        let prefix = normHome.hasSuffix("/") ? normHome : normHome + "/"
        if normFile.hasPrefix(prefix) {
            return "~/" + normFile.dropFirst(prefix.count)
        }
        return normFile
    }

    private static func expandHome(_ raw: String, homeDir: String) -> String {
        if raw == "~" { return homeDir }
        if raw.hasPrefix("~/") {
            return ((homeDir as NSString).appendingPathComponent(String(raw.dropFirst(2)))).standardizedPath
        }
        return raw.standardizedPath
    }
}

public extension String {
    var standardizedPath: String {
        (self as NSString).standardizingPath
    }
}

public enum DataMigration {
    public static func defaultDataDir(homeDir: String = FileManager.default.homeDirectoryForCurrentUser.path) -> String {
        ((homeDir as NSString).appendingPathComponent("Library/Application Support/Light")).standardizedPath
    }
}

public enum DirectoryLock {
    public enum LockError: Error {
        case alreadyLocked
        case systemError(Int32)
    }

    /// Acquires a non-blocking exclusive Darwin directory lock (`O_EXLOCK`).
    /// Keeps the returned file descriptor open until `release(_:)` is called.
    public static func acquire(directory: String) throws -> Int32 {
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        let flags = O_DIRECTORY | O_RDONLY | O_NONBLOCK | O_EXLOCK | O_CLOEXEC
        let fd = open(directory, flags)
        if fd < 0 {
            let code = errno
            if code == EAGAIN || code == EWOULDBLOCK {
                throw LockError.alreadyLocked
            }
            throw LockError.systemError(code)
        }
        return fd
    }

    public static func release(_ fd: Int32) {
        if fd >= 0 {
            close(fd)
        }
    }
}
