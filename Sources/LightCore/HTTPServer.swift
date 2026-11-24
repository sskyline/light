import Foundation
import Network

public final class LocalHTTPServer: @unchecked Sendable {
    public static let defaultPort: UInt16 = 51789
    public static let maxBodyBytes = 32 * 1024

    public enum ListenerState: Sendable {
        case listening(port: UInt16)
        case failed(reason: String, isAddressInUse: Bool)
    }

    private let store: StateStore
    private let requestedPort: UInt16
    private let prepareForRequests: (@Sendable () throws -> Void)?
    private let onCodexHook: (@Sendable (String?, String?, EventType) -> Void)?
    private let onReceived: (@Sendable (AgentId) -> Void)?
    private let onState: (@Sendable (ListenerState) -> Void)?

    private let queue = DispatchQueue(label: "com.light.http-server")
    private var listener: NWListener?
    private var connections: [ObjectIdentifier: NWConnection] = [:]
    private var _boundPort: UInt16 = 0
    private var _isListening = false

    public var boundPort: UInt16 {
        queue.sync { _boundPort }
    }

    public var isListening: Bool {
        queue.sync { _isListening }
    }

    public init(
        store: StateStore,
        port: UInt16 = LocalHTTPServer.defaultPort,
        prepareForRequests: (@Sendable () throws -> Void)? = nil,
        onCodexHook: (@Sendable (String?, String?, EventType) -> Void)? = nil,
        onReceived: (@Sendable (AgentId) -> Void)? = nil,
        onState: (@Sendable (ListenerState) -> Void)? = nil
    ) {
        self.store = store
        self.requestedPort = port
        self.prepareForRequests = prepareForRequests
        self.onCodexHook = onCodexHook
        self.onReceived = onReceived
        self.onState = onState
    }

    public func start() {
        start(makeListener: { try NWListener(using: $0) })
    }

    func start(makeListener: @escaping @Sendable (NWParameters) throws -> NWListener) {
        queue.async { [weak self] in
            self?.startLocked(makeListener: makeListener)
        }
    }

    public func stop() {
        queue.sync { stopLocked() }
    }

    private func stopLocked() {
        _isListening = false
        _boundPort = 0
        listener?.cancel()
        listener = nil
        for connection in connections.values { connection.cancel() }
        connections.removeAll()
    }

    private func startLocked(makeListener: (NWParameters) throws -> NWListener) {
        guard listener == nil else { return }
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        params.requiredLocalEndpoint = NWEndpoint.hostPort(
            host: .ipv4(.loopback),
            port: requestedPort == 0 ? .any : NWEndpoint.Port(rawValue: requestedPort)!
        )

        let nwListener: NWListener
        do {
            nwListener = try makeListener(params)
        } catch {
            onState?(.failed(reason: error.localizedDescription, isAddressInUse: false))
            return
        }

        nwListener.stateUpdateHandler = { [weak self, weak nwListener] state in
            guard let self, let nwListener, self.listener === nwListener else { return }
            switch state {
            case .ready:
                guard !self._isListening else { return }
                do {
                    try self.prepareForRequests?()
                } catch {
                    self.stopLocked()
                    self.onState?(.failed(reason: error.localizedDescription, isAddressInUse: false))
                    return
                }
                let port = nwListener.port?.rawValue ?? self.requestedPort
                self._boundPort = port
                self._isListening = true
                self.onState?(.listening(port: port))
                for connection in self.connections.values { self.handleConnection(connection) }
            case .failed(let error):
                self.stopLocked()
                let inUse = error == .posix(.EADDRINUSE)
                let reason = inUse
                    ? "端口已被占用（请检查是否已有另一个 Light 正在运行）"
                    : error.localizedDescription
                self.onState?(.failed(reason: reason, isAddressInUse: inUse))
            default:
                break
            }
        }

        nwListener.newConnectionHandler = { [weak self, weak nwListener] connection in
            guard let self, let nwListener, self.listener === nwListener else {
                connection.cancel()
                return
            }
            self.connections[ObjectIdentifier(connection)] = connection
            if self._isListening { self.handleConnection(connection) }
        }

        self.listener = nwListener
        nwListener.start(queue: queue)
    }

    private func handleConnection(_ connection: NWConnection) {
        let id = ObjectIdentifier(connection)
        connection.stateUpdateHandler = { [weak self, weak connection] state in
            switch state {
            case .failed, .cancelled:
                if let self, let connection, self.connections[id] === connection {
                    self.connections.removeValue(forKey: id)
                    connection.cancel()
                }
            default:
                break
            }
        }
        connection.start(queue: queue)
        receiveRequest(on: connection, buffer: Data())
    }

    private func receiveRequest(on connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            guard let self, self._isListening, self.connections[ObjectIdentifier(connection)] != nil else {
                connection.cancel()
                return
            }
            if error != nil {
                connection.cancel()
                return
            }
            var accumulated = buffer
            if let data {
                accumulated.append(data)
            }

            switch Self.parseHTTPRequest(accumulated) {
            case .needMore:
                if isComplete {
                    self.sendResponse(connection: connection, status: 400, statusText: "Bad Request", body: #"{"ok":false,"error":"incomplete request"}"#)
                    return
                }
                self.receiveRequest(on: connection, buffer: accumulated)

            case .tooLarge:
                self.sendResponse(connection: connection, status: 413, statusText: "Payload Too Large", body: #"{"ok":false,"error":"body too large"}"#)

            case .invalid:
                self.sendResponse(connection: connection, status: 400, statusText: "Bad Request", body: #"{"ok":false,"error":"malformed http"}"#)

            case .complete(let req):
                self.dispatchRequest(req, on: connection)
            }
        }
    }

    public struct ParsedRequest: Sendable {
        public let method: String
        public let path: String
        public let headers: [String: String]
        public let body: Data
    }

    public enum ParseResult: Sendable {
        case needMore
        case tooLarge
        case invalid
        case complete(ParsedRequest)
    }

    private static let maxHeaderBytes = 16 * 1024
    // A one-byte chunk needs five extra bytes of framing. Allow additional metadata for trailers and extensions.
    private static let maxChunkedWireBytes = 6 * maxBodyBytes + maxHeaderBytes
    private static let headerDelimiter = Data([13, 10, 13, 10])
    private static let crlf = Data([13, 10])
    private static let tokenBytes = Set("!#$%&'*+-.^_`|~0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ".utf8)
    private static let optionalWhitespace = CharacterSet(charactersIn: " \t")

    private static func headerField(_ line: String) -> (name: String, value: String)? {
        guard let colon = line.firstIndex(of: ":") else { return nil }
        let name = line[..<colon]
        let value = line[line.index(after: colon)...]
        guard !name.isEmpty, name.utf8.allSatisfy(tokenBytes.contains),
              value.unicodeScalars.allSatisfy({ $0.value == 9 || ($0.value >= 32 && $0.value != 127) }) else {
            return nil
        }
        return (name.lowercased(), value.trimmingCharacters(in: optionalWhitespace))
    }

    public static func parseHTTPRequest(_ data: Data) -> ParseResult {
        guard let delimiter = data.prefix(maxHeaderBytes).range(of: headerDelimiter) else {
            return data.count >= maxHeaderBytes ? .invalid : .needMore
        }
        guard let text = String(data: data[..<delimiter.lowerBound], encoding: .isoLatin1) else { return .invalid }
        let lines = text.components(separatedBy: "\r\n")
        let parts = lines[0].split(separator: " ")
        guard parts.count == 3, parts[1].hasPrefix("/"), ["HTTP/1.1", "HTTP/1.0"].contains(parts[2]),
              parts[0].utf8.allSatisfy(tokenBytes.contains) else { return .invalid }
        let method = parts[0].uppercased()
        let path = String(parts[1].prefix(while: { $0 != "?" }))

        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let (name, value) = headerField(line) else { return .invalid }
            if let previous = headers[name] {
                headers[name] = previous + "," + value
            } else {
                headers[name] = value
            }
        }
        func complete(_ bytes: Data) -> ParseResult {
            .complete(ParsedRequest(method: method, path: path, headers: headers, body: bytes))
        }
        let body = data[delimiter.upperBound...]
        if let encoding = headers["transfer-encoding"] {
            guard encoding.lowercased() == "chunked", headers["content-length"] == nil else { return .invalid }
            return decodeChunked(body, complete: complete)
        }

        guard let lengthField = headers["content-length"] else { return complete(Data()) }
        var length: Int?
        for field in lengthField.split(separator: ",", omittingEmptySubsequences: false) {
            let digits = field.trimmingCharacters(in: optionalWhitespace)
            guard !digits.isEmpty, digits.utf8.allSatisfy({ (48...57).contains($0) }) else { return .invalid }
            guard let number = Int(digits), number <= maxBodyBytes else { return .tooLarge }
            if let length, length != number { return .invalid }
            length = number
        }
        guard let length else { return .invalid }
        guard body.count >= length else { return .needMore }
        return complete(Data(body.prefix(length)))
    }

    private static func decodeChunked(_ bytes: Data, complete: (Data) -> ParseResult) -> ParseResult {
        let data = bytes.prefix(maxChunkedWireBytes)
        let incomplete: ParseResult = data.count == maxChunkedWireBytes ? .tooLarge : .needMore
        var decoded = Data()
        var cursor = data.startIndex
        var readingTrailers = false
        while cursor < data.endIndex {
            guard let delimiter = data.range(of: crlf, in: cursor..<data.endIndex) else { return incomplete }
            let line = data[cursor..<delimiter.lowerBound]
            cursor = delimiter.upperBound
            if readingTrailers {
                if line.isEmpty { return complete(decoded) }
                guard let text = String(data: line, encoding: .isoLatin1), headerField(text) != nil else { return .invalid }
                // Trailers never change the headers used for routing or framing.
                continue
            }
            var sizeField = line
            if let extensionStart = line.firstIndex(of: 59) { // ";" starts chunk extensions
                sizeField = line[..<extensionStart]
                while sizeField.last == 32 || sizeField.last == 9 { sizeField = sizeField.dropLast() }
            }
            guard !sizeField.isEmpty, sizeField.allSatisfy({
                (48...57).contains($0) || (65...70).contains($0) || (97...102).contains($0)
            }) else { return .invalid }
            let digits = String(decoding: sizeField, as: UTF8.self)
            guard let size = Int(digits, radix: 16), size <= maxBodyBytes - decoded.count else { return .tooLarge }
            if size == 0 {
                readingTrailers = true
                continue
            }
            guard size <= data.endIndex - cursor else { return incomplete }
            let end = cursor + size
            guard end < data.endIndex else { return incomplete }
            guard data[end] == 13 else { return .invalid }
            guard data.endIndex - end >= 2 else { return incomplete }
            guard data[end + 1] == 10 else { return .invalid }
            decoded.append(data[cursor..<end])
            cursor = end + 2
        }
        return incomplete
    }

    private static let allowedHostRegex = try! NSRegularExpression(
        pattern: "^(localhost|127\\.0\\.0\\.1)(:\\d+)?$",
        options: [.caseInsensitive]
    )

    private func dispatchRequest(_ req: ParsedRequest, on connection: NWConnection) {
        let host = req.headers["host"] ?? ""
        let hostRange = NSRange(host.startIndex..<host.endIndex, in: host)
        let hostValid = Self.allowedHostRegex.firstMatch(in: host, range: hostRange) != nil
        if !hostValid || req.headers["origin"] != nil {
            sendResponse(connection: connection, status: 403, statusText: "Forbidden", body: #"{"ok":false}"#)
            return
        }

        if req.method == "GET" && req.path == "/health" {
            sendResponse(connection: connection, status: 200, statusText: "OK", body: #"{"ok":true,"version":1}"#)
            return
        }

        if req.method == "GET" && req.path == "/state" {
            struct StateReply: Encodable {
                let ok: Bool
                let state: AppStateSnapshot
            }
            let encoder = JSONEncoder()
            if let data = try? encoder.encode(StateReply(ok: true, state: store.getState())),
               let body = String(data: data, encoding: .utf8) {
                sendResponse(connection: connection, status: 200, statusText: "OK", body: body)
            } else {
                sendResponse(connection: connection, status: 500, statusText: "Internal Server Error", body: #"{"ok":false}"#)
            }
            return
        }

        if req.method == "POST" && req.path == "/event" {
            let contentType = req.headers["content-type"]?
                .split(separator: ";", maxSplits: 1).first?
                .trimmingCharacters(in: .whitespaces)
                .lowercased()
            guard contentType == "application/json" else {
                sendResponse(connection: connection, status: 415, statusText: "Unsupported Media Type", body: #"{"ok":false}"#)
                return
            }

            do {
                let rawText = String(data: req.body, encoding: .utf8) ?? ""
                let bodyObj: [String: Any]
                if rawText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    bodyObj = [:]
                } else {
                    guard let parsed = try JSONSerialization.jsonObject(with: req.body) as? [String: Any] else {
                        throw NavigationError("bad json")
                    }
                    bodyObj = parsed
                }

                guard let agentStr = bodyObj["agent"] as? String, let agent = AgentId(rawValue: agentStr) else {
                    sendResponse(connection: connection, status: 400, statusText: "Bad Request", body: #"{"ok":false,"error":"invalid agent"}"#)
                    return
                }
                guard let typeStr = bodyObj["type"] as? String, let type = EventType(rawValue: typeStr) else {
                    sendResponse(connection: connection, status: 400, statusText: "Bad Request", body: #"{"ok":false,"error":"invalid type"}"#)
                    return
                }

                for field in ["sessionId", "tool", "toolTarget", "toolCallId", "message", "timestamp"] {
                    if let val = bodyObj[field], !(val is NSNull), !(val is String) {
                        throw NavigationError("invalid \(field)")
                    }
                }

                let terminalProvided = bodyObj.keys.contains("terminal")
                var terminalPayload: TerminalPayload?
                if let termDict = bodyObj["terminal"] as? [String: Any],
                   let kind = termDict["kind"] as? String,
                   let id = termDict["id"] as? String {
                    terminalPayload = TerminalPayload(kind: kind, id: id, session: termDict["session"] as? String)
                }

                let rawEvent = RawIncomingEvent(
                    agent: agent,
                    type: type,
                    sessionId: bodyObj["sessionId"] as? String,
                    turnId: bodyObj["turnId"] as? String,
                    cwd: bodyObj["cwd"] as? String,
                    terminal: terminalPayload,
                    terminalProvided: terminalProvided,
                    tool: bodyObj["tool"] as? String,
                    toolTarget: bodyObj["toolTarget"] as? String,
                    toolCallId: bodyObj["toolCallId"] as? String,
                    message: bodyObj["message"] as? String,
                    timestamp: bodyObj["timestamp"] as? String,
                    autoApprovalFailed: (bodyObj["autoApprovalFailed"] as? Bool) == true
                )

                let ingested = store.ingest(rawEvent)
                onReceived?(agent)
                if agent == .codex {
                    onCodexHook?(rawEvent.sessionId, rawEvent.turnId, type)
                }

                struct EventReply: Encodable {
                    let ok: Bool
                    let event: LightEvent
                }
                let data = try JSONEncoder().encode(EventReply(ok: true, event: ingested))
                let text = String(data: data, encoding: .utf8) ?? #"{"ok":true}"#
                sendResponse(connection: connection, status: 200, statusText: "OK", body: text)
            } catch {
                let errMsg = error.localizedDescription
                let errJSON = (try? JSONSerialization.data(withJSONObject: ["ok": false, "error": errMsg]))
                    .flatMap { String(data: $0, encoding: .utf8) } ?? #"{"ok":false,"error":"bad json"}"#
                sendResponse(connection: connection, status: 400, statusText: "Bad Request", body: errJSON)
            }
            return
        }

        sendResponse(connection: connection, status: 404, statusText: "Not Found", body: #"{"ok":false,"error":"not found"}"#)
    }

    private func sendResponse(connection: NWConnection, status: Int, statusText: String, body: String) {
        let bodyData = Data(body.utf8)
        let header = "HTTP/1.1 \(status) \(statusText)\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: \(bodyData.count)\r\nConnection: close\r\n\r\n"
        var payload = Data(header.utf8)
        payload.append(bodyData)
        connection.send(content: payload, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }
}
