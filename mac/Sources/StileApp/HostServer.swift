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

/// One connection on host.sock = one Chrome profile's extension (what one Perl helper process used to be).
/// The socket carries native-messaging frames (4-byte native-endian length + JSON) in both directions.
/// All state is touched on the main queue only: the dispatch sources run on `.main` and async entry
/// points hop to it explicitly.
final class ProfileBridge {
    let id = UUID()
    fileprivate let fd: Int32
    private weak var server: HostServer?
    private var source: DispatchSourceRead?
    private let writeQueue = DispatchQueue(label: "ca.simplistics.sidebar.bridge.write")
    private var inbox = Data()
    private var pending: [String: CheckedContinuation<Any, Error>] = [:]
    private var subscribers: [UUID: ([String: Any]) -> Void] = [:]
    private var nextId = 0

    /// Empty until the extension sends `identify`.
    fileprivate(set) var profileDir: String = ""
    private(set) var closed = false

    var identified: Bool { !profileDir.isEmpty }

    fileprivate init(fd: Int32, server: HostServer) {
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
        while !closed && inbox.count >= 4 {
            let s = inbox.startIndex
            let len = Int(UInt32(inbox[s]) | (UInt32(inbox[s + 1]) << 8) | (UInt32(inbox[s + 2]) << 16) | (UInt32(inbox[s + 3]) << 24))
            if len > 64 * 1024 * 1024 {
                Log.write("host: absurd frame length \(len), closing connection")
                shutdown()
                return
            }
            if inbox.count < 4 + len { break }
            let payload = inbox.subdata(in: (s + 4)..<(s + 4 + len))
            inbox.removeSubrange(s..<(s + 4 + len))
            handleFrame(payload)
        }
    }

    private func handleFrame(_ payload: Data) {
        guard let any = try? JSONSerialization.jsonObject(with: payload) else {
            Log.write("host: malformed JSON from extension (\(payload.count) bytes)")
            return
        }
        guard let obj = any as? [String: Any], let type = obj["type"] as? String else {
            Log.write("host: ignoring message without type")
            return
        }
        if type == "bridgeResult" || type == "bridgeEvent" {
            dispatch(obj)
            return
        }
        server?.handle(obj, from: self)
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

    /// Send one native-messaging frame to the extension (also used for `bridge` envelopes from the page).
    func sendToExt(_ msg: [String: Any]) {
        guard !closed else { return }
        guard let json = JSONUtil.data(msg) else {
            Log.write("host: refusing to send non-JSON message")
            return
        }
        if json.count > 1024 * 1024 - 64 {
            Log.write("host: dropping \(json.count)-byte message (over Chrome's 1 MB host-to-extension limit)")
            return
        }
        var len = UInt32(json.count)   // native-endian, as Chrome expects
        var frame = Data(bytes: &len, count: 4)
        frame.append(json)
        let descriptor = fd
        let payload = frame
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

    /// Reply to `request`, echoing its requestId when it had one.
    func reply(_ request: [String: Any], _ msg: [String: Any]) {
        var m = msg
        if let rid = request["requestId"] { m["requestId"] = rid }
        sendToExt(m)
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
        Log.write("host: connection closed (\(profileDir.isEmpty ? "unidentified" : profileDir))")
        source?.cancel()
        source = nil
        let waiting = pending
        pending.removeAll()
        subscribers.removeAll()
        for (_, c) in waiting { c.resume(throwing: BridgeError.disconnected) }
        server?.remove(self)
    }
}

/// Native messaging host server: replaces the Perl helper and the old overlay.sock relay.
final class HostServer {
    private(set) var bridges: [ProfileBridge] = []
    private var listenFD: Int32 = -1
    private var acceptSource: DispatchSourceRead?
    private(set) var socketPath: String = ""
    private(set) var listening = false
    private(set) var overlayRunning = false
    /// Times an identify replaced another live connection, per profile dir (duplicate-identity guard).
    private var replaceLog: [String: [Date]] = [:]
    private var handoffs: [String: (bounds: [String: Any]?, at: Date)] = [:]
    private var missingCache: (list: [(dir: String, name: String)], at: Date)?
    /// Global overlay on/off (state.json `overlayEnabled`, default true); the app is the source of truth.
    private(set) var overlayEnabled: Bool = HostStore.overlayEnabled(from: HostStore.readState())
    /// v3.0: `appSetting` (app-wide settings relayed by the extension) and `getAppState`. Set by the OverlayManager
    /// at creation; the closure must hop to the main actor itself. Arguments: message type, message, origin.
    var onAppMessage: ((String, [String: Any], ProfileBridge) -> Void)?

    /// Names accepted in `appSetting {name, value}` (also accepted as top-level message types).
    static let appSettingNames: Set<String> = [
        "setLockstep", "setLaunchAtLogin", "requestScreenCapture", "openAccessibilitySettings", "rescanRail",
        "quitApp", "setOverlayEnabled", "setDefaultBrowser", "reviewPermissions", "setPinned", "setShowMenuBarIcon",
    ]

    func start() {
        signal(SIGPIPE, SIG_IGN)
        socketPath = HostPaths.hostSocketPath()
        let parent = (socketPath as NSString).deletingLastPathComponent
        try? FileManager.default.createDirectory(atPath: parent, withIntermediateDirectories: true,
                                                 attributes: [.posixPermissions: 0o700])
        unlink(socketPath)

        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        if fd < 0 {
            Log.write("host: socket() failed errno=\(errno)")
            retryLater()
            return
        }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(socketPath.utf8) + [0]
        let capacity = MemoryLayout.size(ofValue: addr.sun_path)
        if bytes.count > capacity {
            Log.write("host: socket path too long: \(socketPath)")
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
            Log.write("host: bind failed errno=\(errno) path=\(socketPath)")
            Darwin.close(fd)
            retryLater()
            return
        }
        chmod(socketPath, 0o600)
        if Darwin.listen(fd, 16) != 0 {
            Log.write("host: listen failed errno=\(errno)")
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
        Log.write("host: listening on \(socketPath)")
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
            Log.write("host: extension connected (\(bridges.count) connections)")
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

    /// Bridges whose extension has sent `identify`.
    var identified: [ProfileBridge] {
        bridges.filter { !$0.closed && $0.identified }
    }

    /// Called once the overlay feature (Chrome tracking) is running.
    func setOverlayRunning(_ on: Bool) {
        overlayRunning = on
        for b in identified { b.sendToExt(["type": "overlayStatus", "connected": on]) }
    }

    /// Chrome profiles that look open (Local State `last_active_profiles`, or all when unknown) but
    /// have no connected extension. Cached for a few seconds.
    func missingProfiles() -> [(dir: String, name: String)] {
        if let c = missingCache, Date().timeIntervalSince(c.at) < 3 { return c.list }
        let connected = Set(identified.map { $0.profileDir })
        let active = HostStore.lastActiveProfiles()
        var out: [(dir: String, name: String)] = []
        for p in HostStore.readProfiles(withExtras: false) {
            guard let dir = p["dir"] as? String else { continue }
            if connected.contains(dir) { continue }
            if !active.isEmpty && !active.contains(dir) { continue }
            out.append((dir: dir, name: (p["name"] as? String) ?? dir))
        }
        missingCache = (list: out, at: Date())
        return out
    }

    // MARK: Messages from extensions (same behaviour as the Perl helper)

    fileprivate func handle(_ m: [String: Any], from c: ProfileBridge) {
        guard let type = m["type"] as? String else { return }
        switch type {
        case "hello":
            c.reply(m, [
                "type": "hello",
                "hostVersion": AppInfo.version,
                "profiles": HostStore.profilesCapped(),
                "settings": HostStore.currentSettings(),
            ])
        case "identify":
            doIdentify(m, c)
        case "getProfiles":
            c.reply(m, ["type": "profiles", "profiles": HostStore.profilesCapped()])
        case "setProfileStyle":
            doSetStyle(m, c)
        case "switchProfile":
            doSwitch(m, c)
        case "setGlobalSettings":
            doSetSettings(m, c)
        case "setOverlayEnabled":
            doSetOverlayEnabled(m, c)
        case "setDefaultBrowser":
            doSetDefaultBrowser(m, c)
        case "appSetting":
            doAppSetting(m, c)
        case "getAppState":
            onAppMessage?("getAppState", m, c)
        case _ where Self.appSettingNames.contains(type):
            // Top-level form of an app setting: {type: "setLockstep", value|enabled: ...}.
            var wrapped: [String: Any] = ["type": "appSetting", "name": type]
            if let rid = m["requestId"] { wrapped["requestId"] = rid }
            if let v = m["value"] ?? m["enabled"] { wrapped["value"] = v }
            doAppSetting(wrapped, c)
        default:
            Log.write("host: unknown message type '\(type)'")
            c.reply(m, ["type": "error", "error": "unknown message type '\(type)'"])
        }
    }

    private func boundsOf(_ v: Any?) -> [String: Any]? {
        v as? [String: Any]
    }

    private func broadcast(except c: ProfileBridge?, _ msg: [String: Any]) {
        // Every other open connection, identified or not (same as the Node reference).
        for b in bridges where b !== c && !b.closed { b.sendToExt(msg) }
    }

    private func doIdentify(_ m: [String: Any], _ c: ProfileBridge) {
        guard let dir = m["profileDir"] as? String, !dir.isEmpty else {
            c.reply(m, ["type": "identified", "profileDir": m["profileDir"] ?? NSNull(), "error": "missing profileDir"])
            return
        }
        // A newer connection for the same profile replaces the older one (normally the extension's service worker
        // restarted). If that keeps happening, two different Chrome profiles are claiming the same profile and
        // would knock each other off forever: stop replacing and tell the newcomer to pick its profile.
        let now = Date()
        replaceLog[dir] = (replaceLog[dir] ?? []).filter { now.timeIntervalSince($0) < 60 }
        let others = bridges.filter { $0 !== c && !$0.closed && $0.profileDir == dir }
        if !others.isEmpty {
            if (replaceLog[dir]?.count ?? 0) >= 3 {
                Log.write("host: '\(dir)' claimed by two connections repeatedly; refusing the newer one")
                c.reply(m, ["type": "identified", "profileDir": NSNull(), "error": "duplicate profile"])
                return
            }
            replaceLog[dir, default: []].append(now)
            for old in others {
                Log.write("host: replacing older connection for '\(dir)'")
                old.shutdown()
            }
        }
        c.profileDir = dir
        Log.write("host: identified '\(dir)'")
        missingCache = nil
        c.reply(m, ["type": "identified", "profileDir": dir])

        if let h = handoffs.removeValue(forKey: dir) {
            if Date().timeIntervalSince(h.at) < 60 {
                c.sendToExt(["type": "activate", "bounds": h.bounds.map { $0 as Any } ?? NSNull()])
            } else {
                Log.write("host: ignoring stale pending handoff for '\(dir)'")
            }
        }
        if overlayRunning { c.sendToExt(["type": "overlayStatus", "connected": true]) }
        changed()
    }

    private func doSwitch(_ m: [String: Any], _ c: ProfileBridge) {
        guard let target = m["targetDir"] as? String, !target.isEmpty else {
            c.reply(m, ["type": "switchResult", "ok": false, "error": "missing targetDir"])
            return
        }
        let bounds = boundsOf(m["bounds"])
        let boundsValue: Any = bounds.map { $0 as Any } ?? NSNull()
        if let live = identified.first(where: { $0.profileDir == target }) {
            live.sendToExt(["type": "activate", "bounds": boundsValue])
            Log.write("host: switch to '\(target)': focused via connection")
            c.reply(m, ["type": "switchResult", "ok": true, "method": "focused"])
            return
        }
        handoffs[target] = (bounds: bounds, at: Date())
        if let err = HostActions.launchChrome(args: ["--profile-directory=\(target)"]) {
            handoffs.removeValue(forKey: target)
            Log.write("host: switch to '\(target)': \(err)")
            c.reply(m, ["type": "switchResult", "ok": false, "error": err])
            return
        }
        Log.write("host: switch to '\(target)': launched Chrome")
        c.reply(m, ["type": "switchResult", "ok": true, "method": "launched"])
    }

    /// Saves `overlayEnabled`, tells every connection except `origin`, and posts a settings change so the
    /// overlay hides or resumes. Also used by the global hotkey (`origin` nil: all connections are told).
    func setOverlayEnabled(_ on: Bool, from origin: ProfileBridge?) {
        _ = HostStore.updateState(["overlayEnabled": on])
        overlayEnabled = on
        broadcast(except: origin, ["type": "overlayEnabled", "enabled": on])
        Settings.post()
    }

    private func doSetOverlayEnabled(_ m: [String: Any], _ c: ProfileBridge) {
        guard HostStore.isBool(m["enabled"]), let on = m["enabled"] as? Bool else {
            c.reply(m, ["type": "overlayEnabled", "enabled": overlayEnabled, "error": "invalid enabled"])
            return
        }
        setOverlayEnabled(on, from: c)
        c.reply(m, ["type": "overlayEnabled", "enabled": on])
    }

    /// v2.8: make this app (or Chrome again) the default browser. Replies when macOS has answered.
    private func doSetDefaultBrowser(_ m: [String: Any], _ c: ProfileBridge) {
        guard HostStore.isBool(m["enabled"]), let on = m["enabled"] as? Bool else {
            let now = (HostStore.currentSettings()["defaultBrowser"] as? Bool) ?? false
            c.reply(m, ["type": "defaultBrowser", "enabled": now, "ok": false, "error": "invalid enabled"])
            return
        }
        setDefaultBrowser(on, from: c) { now, err in
            var reply: [String: Any] = ["type": "defaultBrowser", "enabled": now, "ok": err == nil]
            if let e = err { reply["error"] = e }
            c.reply(m, reply)
        }
    }

    /// Shared by the extension message and the permissions window. `done` runs on the main queue once macOS
    /// has answered, before the other connections are told.
    func setDefaultBrowser(_ on: Bool, from origin: ProfileBridge?, done: @escaping (_ now: Bool, _ error: String?) -> Void) {
        LittleLinks.setDefault(on) { [weak self] err in
            // Turning it off always sticks (the feature is off even if Chrome could not be restored).
            if err == nil || !on { _ = HostStore.updateState(["littleLinksEnabled": on]) }
            let now = (HostStore.currentSettings()["defaultBrowser"] as? Bool) ?? false
            done(now, err)
            self?.broadcast(except: origin, ["type": "defaultBrowser", "enabled": now])
            Settings.post()
        }
    }

    /// v3.0: `{type:"appSetting", name, value}` relayed by the extension for the settings page. The two settings
    /// the host already knew reuse their handlers (and reply with their own message types); the rest are run by
    /// the OverlayManager and acknowledged with `{type:"appSetting", name, ok}`.
    private func doAppSetting(_ m: [String: Any], _ c: ProfileBridge) {
        let name = (m["name"] as? String) ?? ""
        let value = m["value"]
        guard Self.appSettingNames.contains(name) else {
            c.reply(m, ["type": "appSetting", "name": name, "ok": false, "error": "unknown app setting '\(name)'"])
            return
        }
        switch name {
        case "setOverlayEnabled":
            var mm = m
            mm["enabled"] = value ?? NSNull()
            doSetOverlayEnabled(mm, c)
        case "setDefaultBrowser":
            var mm = m
            mm["enabled"] = value ?? NSNull()
            doSetDefaultBrowser(mm, c)
        default:
            Log.write("host: appSetting \(name)")
            onAppMessage?("appSetting", m, c)
            c.reply(m, ["type": "appSetting", "name": name, "ok": true])
        }
    }

    private func doSetSettings(_ m: [String: Any], _ c: ProfileBridge) {
        let s = (m["settings"] as? [String: Any]) ?? [:]
        var changes: [String: Any] = [:]
        if s["archiveDefaultMinutes"] != nil {
            guard let minutes = HostStore.validMinutes(s["archiveDefaultMinutes"]) else {
                c.reply(m, ["type": "settings", "settings": HostStore.currentSettings(),
                            "error": "invalid archiveDefaultMinutes"])
                return
            }
            changes["archiveDefaultMinutes"] = minutes
        }
        let new = HostStore.updateState(changes)
        broadcast(except: c, ["type": "settings", "settings": new])
        c.reply(m, ["type": "settings", "settings": new])
    }

    private func doSetStyle(_ m: [String: Any], _ c: ProfileBridge) {
        let styleValue = m["style"]
        let hasStyle = styleValue != nil && !(styleValue is NSNull)
        var err: String?
        var icon = "", color = ""
        let dir = (m["dir"] as? String) ?? ""
        if dir.isEmpty {
            err = "missing dir"
        } else if hasStyle {
            if let sd = styleValue as? [String: Any] {
                if let i = sd["icon"] as? String, HostStore.allowedIcons.contains(i) {
                    icon = i
                    if let col = sd["color"] as? String, HostStore.validHexColor(col) {
                        color = col
                    } else {
                        err = "invalid color"
                    }
                } else {
                    err = "invalid icon"
                }
            } else {
                err = "invalid style"
            }
        }
        if err == nil && !HostStore.readProfiles(withExtras: false).contains(where: { ($0["dir"] as? String) == dir }) {
            err = "unknown profile"
        }
        if let e = err {
            c.reply(m, ["type": "profiles", "profiles": HostStore.profilesCapped(), "error": e])
            return
        }
        var st = HostStore.readState()
        var styles = (st["profileStyles"] as? [String: Any]) ?? [:]
        if hasStyle {
            styles[dir] = ["icon": icon, "color": color.lowercased()]
        } else {
            styles.removeValue(forKey: dir)
        }
        st["profileStyles"] = styles
        HostStore.writeState(st)

        let fresh = HostStore.profilesCapped()
        broadcast(except: c, ["type": "profiles", "profiles": fresh])
        c.reply(m, ["type": "profiles", "profiles": fresh])
    }
}
