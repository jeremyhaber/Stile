import CryptoKit
import Darwin
import Foundation

enum BridgeError: Error, LocalizedError {
    case disconnected
    case timeout
    case remote(String)

    var errorDescription: String? {
        switch self {
        case .disconnected: return "Bridge disconnected"
        case .timeout: return "Bridge call timed out"
        case .remote(let m): return m
        }
    }
}

/// One connected helper (one Chrome profile). All state is touched on the main queue only:
/// the dispatch sources run on `.main` and async entry points hop to it explicitly.
final class ProfileBridge {
    let id = UUID()
    fileprivate let fd: Int32
    private weak var server: BridgeServer?
    private var source: DispatchSourceRead?
    private let writeQueue = DispatchQueue(label: "ca.simplistics.sidebar.bridge.write")
    private var inbox = Data()
    private var pending: [String: CheckedContinuation<Any, Error>] = [:]
    private var subscribers: [UUID: ([String: Any]) -> Void] = [:]
    private var nextId = 0

    private(set) var profileDir: String = ""
    private(set) var profiles: Any?
    private(set) var closed = false

    fileprivate init(fd: Int32, server: BridgeServer) {
        self.fd = fd
        self.server = server
    }

    fileprivate func start() {
        let src = DispatchSource.makeReadSource(fileDescriptor: fd, queue: .main)
        let q = writeQueue
        let descriptor = fd
        src.setEventHandler { [weak self] in self?.readable() }
        src.setCancelHandler {
            q.async { _ = Darwin.close(descriptor) }
        }
        source = src
        src.resume()
    }

    // MARK: Reading

    private func readable() {
        var buf = [UInt8](repeating: 0, count: 65536)
        let n = Darwin.read(fd, &buf, buf.count)
        if n > 0 {
            inbox.append(contentsOf: buf[0..<n])
            processInbox()
        } else if n == 0 {
            shutdown()
        } else if errno != EAGAIN && errno != EINTR {
            shutdown()
        }
    }

    private func processInbox() {
        while let nl = inbox.firstIndex(of: 0x0A) {
            let line = inbox.subdata(in: inbox.startIndex..<nl)
            inbox.removeSubrange(inbox.startIndex...nl)
            if line.isEmpty { continue }
            handleLine(line)
        }
        if inbox.count > 64 * 1024 * 1024 { shutdown() }
    }

    private func handleLine(_ line: Data) {
        guard let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
              let type = obj["type"] as? String else {
            Log.write("bridge: unparseable line (\(line.count) bytes)")
            return
        }
        switch type {
        case "profileHello":
            profileDir = (obj["profileDir"] as? String) ?? ""
            profiles = obj["profiles"]
            Log.write("bridge: profileHello \(profileDir)")
            server?.changed()
        case "fromExt":
            if profileDir.isEmpty, let p = obj["profileDir"] as? String { profileDir = p }
            if let msg = obj["msg"] as? [String: Any] { dispatch(msg) }
        default:
            break
        }
    }

    private func dispatch(_ msg: [String: Any]) {
        if (msg["type"] as? String) == "bridgeResult", let rid = msg["id"] as? String,
           let cont = pending.removeValue(forKey: rid) {
            if (msg["ok"] as? Bool) == true {
                cont.resume(returning: msg["result"] ?? NSNull())
            } else {
                cont.resume(throwing: BridgeError.remote((msg["error"] as? String) ?? "Bridge error"))
            }
        }
        for handler in Array(subscribers.values) { handler(msg) }
    }

    // MARK: Writing

    /// Wrap `msg` as {type:"toExt", msg} and send to the helper.
    func sendToExt(_ msg: [String: Any]) {
        guard !closed else { return }
        let wrapper: [String: Any] = ["type": "toExt", "msg": msg]
        guard JSONSerialization.isValidJSONObject(wrapper),
              var data = try? JSONSerialization.data(withJSONObject: wrapper, options: []) else {
            Log.write("bridge: refusing to send non-JSON message")
            return
        }
        data.append(0x0A)
        let descriptor = fd
        let payload = data
        writeQueue.async {
            var offset = 0
            let total = payload.count
            payload.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
                guard let base = raw.baseAddress else { return }
                while offset < total {
                    let n = Darwin.write(descriptor, base + offset, total - offset)
                    if n < 0 {
                        if errno == EINTR { continue }
                        return
                    }
                    if n == 0 { return }
                    offset += n
                }
            }
        }
    }

    // MARK: API

    func addSubscriber(_ handler: @escaping ([String: Any]) -> Void) -> UUID {
        let token = UUID()
        subscribers[token] = handler
        return token
    }

    func removeSubscriber(_ token: UUID) {
        subscribers.removeValue(forKey: token)
    }

    /// Calls a bridge function in the extension. Throws on timeout (10 s), disconnect or remote error.
    func call(_ name: String, _ args: [Any] = []) async throws -> Any {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Any, Error>) in
            DispatchQueue.main.async {
                if self.closed {
                    cont.resume(throwing: BridgeError.disconnected)
                    return
                }
                self.nextId += 1
                let rid = "app-\(self.nextId)"
                self.pending[rid] = cont
                self.sendToExt(["type": "bridge", "id": rid, "call": name, "args": args])
                DispatchQueue.main.asyncAfter(deadline: .now() + 10) {
                    if let c = self.pending.removeValue(forKey: rid) {
                        c.resume(throwing: BridgeError.timeout)
                    }
                }
            }
        }
    }

    /// Fire-and-forget call (errors are logged).
    func callDetached(_ name: String, _ args: [Any] = []) {
        Task {
            do { _ = try await self.call(name, args) } catch { Log.write("bridge call \(name) failed: \(error.localizedDescription)") }
        }
    }

    func shutdown() {
        if closed { return }
        closed = true
        Log.write("bridge: closed \(profileDir)")
        source?.cancel()
        source = nil
        let waiting = pending
        pending.removeAll()
        subscribers.removeAll()
        for (_, c) in waiting { c.resume(throwing: BridgeError.disconnected) }
        server?.remove(self)
    }
}

final class BridgeServer {
    private(set) var bridges: [ProfileBridge] = []
    private var listenFD: Int32 = -1
    private var acceptSource: DispatchSourceRead?
    private(set) var socketPath: String = ""
    private(set) var listening = false

    static func helperDir() -> String {
        if let e = ProcessInfo.processInfo.environment["SIDEBAR_HELPER_DIR"], !e.isEmpty { return e }
        return NSHomeDirectory() + "/Library/Application Support/SidebarHelper"
    }

    static func md5Prefix(_ s: String) -> String {
        let digest = Insecure.MD5.hash(data: Data(s.utf8))
        let hex = digest.map { String(format: "%02x", $0) }.joined()
        return String(hex.prefix(12))
    }

    static func resolveSocketPath() -> String {
        let dir = helperDir()
        var path = dir + "/overlay.sock"
        if path.utf8.count > 100 {
            let h = md5Prefix("overlay")
            path = dir + "/sock/" + h + ".sock"
            if path.utf8.count > 100 {
                path = "/tmp/sbh-\(getuid())-\(h).sock"
            }
        }
        return path
    }

    func start() {
        signal(SIGPIPE, SIG_IGN)
        socketPath = Self.resolveSocketPath()
        let parent = (socketPath as NSString).deletingLastPathComponent
        try? FileManager.default.createDirectory(atPath: parent, withIntermediateDirectories: true,
                                                 attributes: [.posixPermissions: 0o700])
        unlink(socketPath)

        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        if fd < 0 {
            Log.write("server: socket() failed errno=\(errno)")
            retryLater()
            return
        }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(socketPath.utf8) + [0]
        let capacity = MemoryLayout.size(ofValue: addr.sun_path)
        if bytes.count > capacity {
            Log.write("server: socket path too long: \(socketPath)")
            Darwin.close(fd)
            return
        }
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in
            raw.copyBytes(from: bytes)
        }
        let len = socklen_t(MemoryLayout<sockaddr_un>.size)
        let bindResult = withUnsafePointer(to: &addr) { ptr -> Int32 in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                Darwin.bind(fd, sa, len)
            }
        }
        if bindResult != 0 {
            Log.write("server: bind failed errno=\(errno) path=\(socketPath)")
            Darwin.close(fd)
            retryLater()
            return
        }
        chmod(socketPath, 0o600)
        if Darwin.listen(fd, 8) != 0 {
            Log.write("server: listen failed errno=\(errno)")
            Darwin.close(fd)
            retryLater()
            return
        }
        _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
        listenFD = fd
        let src = DispatchSource.makeReadSource(fileDescriptor: fd, queue: .main)
        src.setEventHandler { [weak self] in self?.acceptPending() }
        acceptSource = src
        src.resume()
        listening = true
        Log.write("server: listening on \(socketPath)")
    }

    private func retryLater() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
            guard let self = self, !self.listening else { return }
            self.start()
        }
    }

    private func acceptPending() {
        while true {
            let cfd = Darwin.accept(listenFD, nil, nil)
            if cfd < 0 { break }
            var one: Int32 = 1
            _ = setsockopt(cfd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
            // BSD accepted sockets inherit O_NONBLOCK; we want blocking I/O (reads happen only when readable).
            _ = fcntl(cfd, F_SETFL, fcntl(cfd, F_GETFL) & ~O_NONBLOCK)
            let bridge = ProfileBridge(fd: cfd, server: self)
            bridges.append(bridge)
            bridge.start()
            Log.write("server: helper connected (\(bridges.count) total)")
            changed()
        }
    }

    fileprivate func remove(_ b: ProfileBridge) {
        bridges.removeAll { $0 === b }
        changed()
    }

    fileprivate func changed() {
        NotificationCenter.default.post(name: .sidebarBridgesChanged, object: nil)
    }

    func stop() {
        acceptSource?.cancel()
        acceptSource = nil
        for b in bridges { b.shutdown() }
        if listenFD >= 0 { Darwin.close(listenFD); listenFD = -1 }
        unlink(socketPath)
        listening = false
    }

    /// Bridges that have identified their profile.
    var identified: [ProfileBridge] {
        bridges.filter { !$0.closed }
    }
}
