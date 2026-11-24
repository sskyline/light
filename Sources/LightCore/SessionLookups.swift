import Foundation
import SQLite3

public struct TitleRetry: Sendable {
    public let after: Date
    private let delay: TimeInterval

    public init(previous: TitleRetry?, now: Date) {
        delay = min((previous?.delay ?? 2.5) * 2, 60)
        after = now.addingTimeInterval(delay)
    }
}

public enum SessionTitles {
    public static func readCodexThreadTitle(
        threadId: String,
        codexHome: String = AgentConfigPaths.resolve().codexDir
    ) -> String? {
        let indexPath = (codexHome as NSString).appendingPathComponent("session_index.jsonl")
        guard let content = try? String(contentsOfFile: indexPath, encoding: .utf8) else { return nil }
        for line in content.split(separator: "\n", omittingEmptySubsequences: true).reversed() {
            guard let data = line.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let id = obj["id"] as? String,
                  id == threadId else {
                continue
            }
            if let name = obj["thread_name"] as? String {
                let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
                return trimmed.isEmpty ? nil : trimmed
            }
            return nil
        }
        return nil
    }

    public static func readClaudeSessionTitle(
        sessionId: String,
        claudeHome: String = AgentConfigPaths.resolve().claudeDir
    ) -> String? {
        guard Validation.isSessionUUID(sessionId) else { return nil }
        let projectsDir = (claudeHome as NSString).appendingPathComponent("projects")
        guard let transcript = findClaudeTranscript(projectsDir: projectsDir, sessionId: sessionId),
              let file = fopen(transcript, "r") else { return nil }
        defer { fclose(file) }

        var customTitle = ""
        var autoTitle = ""
        var line: UnsafeMutablePointer<CChar>?
        var capacity = 0
        defer { free(line) }
        while true {
            let length = getline(&line, &capacity, file)
            guard length > 0, let bytes = line else { break }
            guard strstr(bytes, "\"custom-title\"") != nil || strstr(bytes, "\"ai-title\"") != nil else { continue }
            let data = Data(bytes: bytes, count: length)
            guard let entry = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let sid = entry["sessionId"] as? String,
                  sid == sessionId else {
                continue
            }
            let type = entry["type"] as? String
            if type == "custom-title", let title = entry["customTitle"] as? String {
                customTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
            } else if type == "ai-title", let title = entry["aiTitle"] as? String {
                autoTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
            }
        }
        if !customTitle.isEmpty { return customTitle }
        if !autoTitle.isEmpty { return autoTitle }
        return nil
    }

    private static func findClaudeTranscript(projectsDir: String, sessionId: String) -> String? {
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(atPath: projectsDir) else { return nil }
        var latestPath: String?
        var latestDate = Date.distantPast
        for name in entries {
            let dirPath = (projectsDir as NSString).appendingPathComponent(name)
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: dirPath, isDirectory: &isDir), isDir.boolValue else { continue }
            let candidate = (dirPath as NSString).appendingPathComponent("\(sessionId).jsonl")
            guard let attrs = try? fm.attributesOfItem(atPath: candidate),
                  let type = attrs[.type] as? FileAttributeType,
                  type == .typeRegular else {
                continue
            }
            let mtime = (attrs[.modificationDate] as? Date) ?? Date.distantPast
            if latestPath == nil || mtime > latestDate {
                latestPath = candidate
                latestDate = mtime
            }
        }
        return latestPath
    }

    private static let antigravityTitleRegex = try! NSRegularExpression(
        pattern: "^title:[ \\t]*(\"(?:[^\"\\\\\\r\\n]|\\\\.)*\")",
        options: [.anchorsMatchLines]
    )

    public static func readAntigravitySessionTitle(
        sessionId: String,
        geminiHome: String = (FileManager.default.homeDirectoryForCurrentUser.path as NSString).appendingPathComponent(".gemini")
    ) -> String? {
        guard Validation.isSessionUUID(sessionId) else { return nil }
        for dir in ["antigravity", "antigravity-ide", "antigravity-cli"] {
            let file = (((geminiHome as NSString).appendingPathComponent(dir) as NSString)
                .appendingPathComponent("annotations") as NSString)
                .appendingPathComponent("\(sessionId).pbtxt")
            guard let annotation = try? String(contentsOfFile: file, encoding: .utf8) else { continue }
            let range = NSRange(annotation.startIndex..<annotation.endIndex, in: annotation)
            guard let match = antigravityTitleRegex.firstMatch(in: annotation, range: range),
                  let quotedRange = Range(match.range(at: 1), in: annotation) else {
                continue
            }
            let quoted = String(annotation[quotedRange])
            if let data = quoted.data(using: .utf8),
               let decoded = try? JSONDecoder().decode(String.self, from: data) {
                let trimmed = decoded.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty { return trimmed }
            }
        }
        return nil
    }
}

public final class ClaudeDesktopLookup: @unchecked Sendable {
    private let appSupport: String
    private let lock = NSLock()
    private var cachedIndex: [String: String?]?
    private var expiresAt: Date = .distantPast

    public init(appSupport: String = (FileManager.default.homeDirectoryForCurrentUser.path as NSString).appendingPathComponent("Library/Application Support")) {
        self.appSupport = appSupport
    }

    public func findLocalSessionId(cliId: String, refresh: Bool = false) -> String? {
        guard Validation.isSessionUUID(cliId) else { return nil }
        let now = Date()
        lock.lock()
        let needRebuild = refresh || cachedIndex == nil || now >= expiresAt
        lock.unlock()

        let index: [String: String?]
        if needRebuild {
            let built = buildIndex()
            lock.lock()
            cachedIndex = built
            expiresAt = Date().addingTimeInterval(5)
            lock.unlock()
            index = built
        } else {
            lock.lock()
            index = cachedIndex ?? [:]
            lock.unlock()
        }
        return index[cliId.lowercased()] ?? nil
    }

    private func buildIndex() -> [String: String?] {
        let fm = FileManager.default
        var index: [String: String?] = [:]
        for profile in ["Claude", "Claude-3p"] {
            let root = ((appSupport as NSString).appendingPathComponent(profile) as NSString)
                .appendingPathComponent("claude-code-sessions")
            guard let accounts = try? fm.contentsOfDirectory(atPath: root) else { continue }
            for account in accounts {
                let accountDir = (root as NSString).appendingPathComponent(account)
                var isDir: ObjCBool = false
                guard fm.fileExists(atPath: accountDir, isDirectory: &isDir), isDir.boolValue else { continue }
                guard let orgs = try? fm.contentsOfDirectory(atPath: accountDir) else { continue }
                for org in orgs {
                    let orgDir = (accountDir as NSString).appendingPathComponent(org)
                    var orgIsDir: ObjCBool = false
                    guard fm.fileExists(atPath: orgDir, isDirectory: &orgIsDir), orgIsDir.boolValue else { continue }
                    guard let files = try? fm.contentsOfDirectory(atPath: orgDir) else { continue }
                    for file in files where file.hasSuffix(".json") {
                        let id = String(file.dropLast(5))
                        guard Validation.isClaudeDesktopId(id) else { continue }
                        let filePath = (orgDir as NSString).appendingPathComponent(file)
                        guard let data = fm.contents(atPath: filePath),
                              let record = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                              (record["sessionId"] as? String) == id,
                              (record["isArchived"] as? Bool) != true else {
                            continue
                        }
                        var cliIds: [String] = []
                        if let primary = record["cliSessionId"] as? String {
                            cliIds.append(primary)
                        }
                        if let previous = record["previousCliSessionIds"] as? [String] {
                            cliIds.append(contentsOf: previous)
                        }
                        for cliId in cliIds where Validation.isSessionUUID(cliId) {
                            let key = cliId.lowercased()
                            if let existing = index[key] {
                                if existing != id {
                                    index[key] = .some(nil)
                                }
                            } else {
                                index[key] = .some(id)
                            }
                        }
                    }
                }
            }
        }
        return index
    }
}

public enum DesktopDestinationLookup {
    public static func lookup(
        agent: AgentId,
        id: String,
        refresh: Bool,
        codexDatabase: String = (AgentConfigPaths.resolve().codexDir as NSString).appendingPathComponent("state_5.sqlite"),
        claudeLookup: ClaudeDesktopLookup = ClaudeDesktopLookup()
    ) -> JumpTarget? {
        guard Validation.isSessionUUID(id) else { return nil }
        if agent == .claudeCode {
            if let localId = claudeLookup.findLocalSessionId(cliId: id, refresh: refresh) {
                return .claudeDesktop(id: localId)
            }
            return nil
        }
        if agent == .codex {
            if readCodexOriginator(databasePath: codexDatabase, threadId: id.lowercased()) == "Codex Desktop" {
                return .codex(id: id)
            }
        }
        return nil
    }

    public static func readCodexOriginator(databasePath: String, threadId: String) -> String? {
        guard FileManager.default.fileExists(atPath: databasePath) else { return nil }
        var db: OpaquePointer?
        let rc = sqlite3_open_v2(databasePath, &db, SQLITE_OPEN_READONLY | SQLITE_OPEN_NOMUTEX, nil)
        guard rc == SQLITE_OK, let db else {
            if let db { sqlite3_close(db) }
            return nil
        }
        defer { sqlite3_close(db) }
        sqlite3_busy_timeout(db, 1000)

        let sql = "SELECT originator FROM threads WHERE id = ?1 LIMIT 1"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else {
            return nil
        }
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_text(stmt, 1, threadId, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
        if sqlite3_step(stmt) == SQLITE_ROW, let cStr = sqlite3_column_text(stmt, 0) {
            return String(cString: cStr).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return nil
    }
}

public struct CodexDenial: Equatable, Sendable {
    public let id: String
    public let thread: String
    public let turn: String
    public let reason: String?

    public init(id: String, thread: String, turn: String, reason: String?) {
        self.id = id
        self.thread = thread
        self.turn = turn
        self.reason = reason
    }
}

public final class CodexReviewWatcher: @unchecked Sendable {
    private struct TrackedTurn {
        var id: String
        var expires: Date
    }

    private let dbPath: String
    private let onDenied: @Sendable (String, String?) -> Void
    private let queue = DispatchQueue(label: "com.light.codex-reviews")
    private var turns: [String: TrackedTurn] = [:]
    private var reportedOrder: [String] = []
    private var reportedSet: Set<String> = []
    private var revision: String = ""
    private var generation: Int = 0
    private var timer: DispatchSourceTimer?

    public init(
        dbPath: String = (AgentConfigPaths.resolve().codexDir as NSString).appendingPathComponent("state_5.sqlite"),
        onDenied: @escaping @Sendable (String, String?) -> Void
    ) {
        self.dbPath = dbPath
        self.onDenied = onDenied
    }

    public func track(thread: String?, turn: String?, event: EventType) {
        queue.async { [weak self] in
            self?.trackLocked(thread: thread, turn: turn, event: event)
        }
    }

    private func trackLocked(thread: String?, turn: String?, event: EventType) {
        guard let thread, Validation.isSessionUUID(thread) else { return }
        if event == .sessionEnd || turn == nil || !Validation.isSessionUUID(turn!) {
            if event == .sessionEnd || event == .userPrompt {
                turns.removeValue(forKey: thread)
            }
            return
        }
        let turnId = turn!
        if let existing = turns[thread], existing.id != turnId {
            if event != .userPrompt { return }
            turns[thread] = TrackedTurn(id: turnId, expires: Date())
            generation += 1
        } else if turns[thread] == nil {
            turns[thread] = TrackedTurn(id: turnId, expires: Date())
            generation += 1
        }
        let ended = (event == .stop || event == .interrupt || event == .error)
        turns[thread]?.expires = Date().addingTimeInterval(ended ? 12 : 300)
        startTimerIfNeeded()
    }

    private func startTimerIfNeeded() {
        guard timer == nil else { return }
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + 1.5, repeating: 1.5, leeway: .milliseconds(250))
        t.setEventHandler { [weak self] in
            self?.pollLocked()
        }
        timer = t
        t.resume()
    }

    public func stop() {
        queue.async { [weak self] in
            self?.stopLocked()
        }
    }

    private func stopLocked() {
        timer?.cancel()
        timer = nil
        turns.removeAll()
        revision = ""
    }

    private func pollLocked() {
        let now = Date()
        turns = turns.filter { $0.value.expires > now }
        if turns.isEmpty {
            stopLocked()
            return
        }
        let fm = FileManager.default
        guard let dbAttrs = try? fm.attributesOfItem(atPath: dbPath) else { return }
        let dbIno = (dbAttrs[.systemFileNumber] as? NSNumber)?.int64Value ?? 0
        let dbMtime = (dbAttrs[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
        let walAttrs = try? fm.attributesOfItem(atPath: dbPath + "-wal")
        let walMtime = (walAttrs?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
        let walSize = (walAttrs?[.size] as? NSNumber)?.int64Value ?? 0
        let currentRevision = "\(generation)/\(dbIno)/\(dbMtime)/\(walMtime)/\(walSize)"
        if currentRevision == revision { return }

        let snapshot = turns.mapValues(\.id)
        let denials = Self.readCodexDenials(databasePath: dbPath, turns: snapshot)
        for row in denials {
            guard turns[row.thread]?.id == row.turn, !reportedSet.contains(row.id) else { continue }
            reportedSet.insert(row.id)
            reportedOrder.append(row.id)
            if reportedOrder.count > 1024 {
                let oldest = reportedOrder.removeFirst()
                reportedSet.remove(oldest)
            }
            onDenied(row.thread, row.reason)
        }
        revision = currentRevision
    }

    public static func readCodexDenials(databasePath: String, turns: [String: String]) -> [CodexDenial] {
        let validPairs = turns.filter { Validation.isSessionUUID($0.key) && Validation.isSessionUUID($0.value) }
        guard !validPairs.isEmpty, FileManager.default.fileExists(atPath: databasePath) else { return [] }

        var db: OpaquePointer?
        let rc = sqlite3_open_v2(databasePath, &db, SQLITE_OPEN_READONLY | SQLITE_OPEN_NOMUTEX, nil)
        guard rc == SQLITE_OK, let db else {
            if let db { sqlite3_close(db) }
            return []
        }
        defer { sqlite3_close(db) }
        sqlite3_busy_timeout(db, 1500)

        let idsClause = validPairs.map { "('\($0.key)', '\($0.value)')" }.joined(separator: ",")
        let query = """
        WITH tracked(thread, turn) AS (VALUES \(idsClause)),
        reviews AS (
          SELECT id, thread_id AS thread,
            CASE WHEN json_valid(CAST(record AS TEXT)) THEN CAST(record AS TEXT) END AS data
          FROM guardian_review_feedback WHERE thread_id IN (SELECT thread FROM tracked)
        ), denied AS (
          SELECT id, thread,
            json_extract(data, '$.reviewed_turn_id') AS turn,
            json_extract(data, '$.status') AS status,
            json_extract(data, '$.decision') AS decision
          FROM reviews
          WHERE json_extract(data, '$.reviewed_thread_id') = thread
            AND (thread, turn) IN (SELECT thread, turn FROM tracked)
            AND status IN ('denied', 'timedOut', 'timed_out')
        )
        SELECT id, thread, turn,
          CASE WHEN status IN ('timedOut', 'timed_out') THEN '自动审批超时'
               WHEN json_valid(decision) THEN substr(json_extract(decision, '$.rationale'), 1, 400)
          END AS reason
        FROM denied
        """

        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, query, -1, &stmt, nil) == SQLITE_OK, let stmt else { return [] }
        defer { sqlite3_finalize(stmt) }

        var results: [CodexDenial] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            guard let idPtr = sqlite3_column_text(stmt, 0),
                  let threadPtr = sqlite3_column_text(stmt, 1),
                  let turnPtr = sqlite3_column_text(stmt, 2) else {
                continue
            }
            let id = String(cString: idPtr)
            let thread = String(cString: threadPtr)
            let turn = String(cString: turnPtr)
            let reason = sqlite3_column_text(stmt, 3).map { String(cString: $0) }
            if turns[thread] == turn {
                results.append(CodexDenial(id: id, thread: thread, turn: turn, reason: reason))
            }
        }
        return results
    }
}
