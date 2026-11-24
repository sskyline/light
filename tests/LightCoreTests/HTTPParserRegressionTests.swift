import Foundation
import Network
@testable import LightCore

enum HTTPParserRegressionTests {
    static let allTests: [(String, () throws -> Void)] = [
        ("HTTPServer.fixedLengthAndQuery", fixedLengthAndQuery),
        ("HTTPServer.fragmentedChunkedBodyAndTrailers", fragmentedChunkedBodyAndTrailers),
        ("HTTPServer.rejectsInvalidFraming", rejectsInvalidFraming),
        ("HTTPServer.singleListenerAndPreparation", singleListenerAndPreparation),
        ("HTTPServer.failureAfterReady", failureAfterReady),
    ]

    private static func request(headers: String = "", body: String = "") -> Data {
        Data(("POST /event?source=hook HTTP/1.1\r\nHost: localhost\r\n" + headers + "\r\n" + body).utf8)
    }

    private static func fixedLengthAndQuery() throws {
        let data = request(headers: "Content-Length: 2\r\nContent-Length: 2\r\n", body: "{}")
        for length in 0..<data.count {
            guard case .needMore = LocalHTTPServer.parseHTTPRequest(data.prefix(length)) else {
                throw TestFailure(message: "premature request completion")
            }
        }
        guard case .complete(let parsed) = LocalHTTPServer.parseHTTPRequest(data) else {
            throw TestFailure(message: "expected complete request")
        }
        try expectEqual(parsed.path, "/event")
        try expectEqual(parsed.body, Data("{}".utf8))
        guard case .complete(let noBody) = LocalHTTPServer.parseHTTPRequest(request(body: "next request")) else {
            throw TestFailure(message: "expected bodyless request")
        }
        try expect(noBody.body.isEmpty)
    }

    private static func fragmentedChunkedBodyAndTrailers() throws {
        let data = request(headers: "Transfer-Encoding: chunked\r\n",
                           body: "1;label=first\r\n{\r\n1\r\n}\r\n0\r\nX-Trace: 7\r\n\r\n")
        for length in 0..<data.count {
            guard case .needMore = LocalHTTPServer.parseHTTPRequest(data.prefix(length)) else {
                throw TestFailure(message: "chunked message ended before trailers")
            }
        }
        guard case .complete(let parsed) = LocalHTTPServer.parseHTTPRequest(data) else {
            throw TestFailure(message: "expected complete chunked request")
        }
        try expectEqual(parsed.body, Data("{}".utf8))
        try expect(parsed.headers["x-trace"] == nil)
    }

    private static func rejectsInvalidFraming() throws {
        let invalidHeaders = [
            "Content-Length: unknown\r\n",
            "Content-Length: 3, 4\r\n",
            "Content-Length: 0\r\nTransfer-Encoding: chunked\r\n",
        ]
        for headers in invalidHeaders {
            guard case .invalid = LocalHTTPServer.parseHTTPRequest(request(headers: headers)) else {
                throw TestFailure(message: "expected invalid framing")
            }
        }
        let chunked = "Transfer-Encoding: chunked\r\n"
        guard case .invalid = LocalHTTPServer.parseHTTPRequest(request(headers: chunked, body: "1\r\nA..")) else {
            throw TestFailure(message: "expected invalid chunk terminator")
        }
        let oversize = String(LocalHTTPServer.maxBodyBytes + 1, radix: 16) + "\r\n"
        guard case .tooLarge = LocalHTTPServer.parseHTTPRequest(request(headers: chunked, body: oversize)) else {
            throw TestFailure(message: "expected body-size limit")
        }
    }

    private static func failureAfterReady() throws {
        final class ListenerBox: @unchecked Sendable { var value: NWListener? }
        let box = ListenerBox()
        let ready = DispatchSemaphore(value: 0)
        let failed = DispatchSemaphore(value: 0)
        let server = LocalHTTPServer(store: StateStore(), port: 0, onState: { state in
            switch state {
            case .listening: ready.signal()
            case .failed: failed.signal()
            }
        })
        server.start { parameters in
            let listener = try NWListener(using: parameters)
            box.value = listener
            return listener
        }
        defer { server.stop() }
        try expectEqual(ready.wait(timeout: .now() + 5), .success)
        let listener = try require(box.value)
        let queue = try require(listener.queue)
        queue.async { listener.stateUpdateHandler?(.failed(.posix(.ENETDOWN))) }
        try expectEqual(failed.wait(timeout: .now() + 5), .success)
        try expect(!server.isListening)
    }

    private static func singleListenerAndPreparation() throws {
        let ready = DispatchSemaphore(value: 0)
        let prepared = DispatchSemaphore(value: 0)
        let first = LocalHTTPServer(store: StateStore(), port: 0, prepareForRequests: {
            prepared.signal()
        }, onState: { state in
            if case .listening = state { ready.signal() }
        })
        first.start()
        defer { first.stop() }
        try expectEqual(ready.wait(timeout: .now() + 5), .success)
        try expectEqual(prepared.wait(timeout: .now()), .success)

        let collision = DispatchSemaphore(value: 0)
        let secondPrepared = DispatchSemaphore(value: 0)
        let second = LocalHTTPServer(store: StateStore(), port: first.boundPort, prepareForRequests: {
            secondPrepared.signal()
        }, onState: { state in
            if case .failed(_, true) = state { collision.signal() }
        })
        second.start()
        defer { second.stop() }
        try expectEqual(collision.wait(timeout: .now() + 5), .success)
        try expectEqual(secondPrepared.wait(timeout: .now()), .timedOut)
    }
}
