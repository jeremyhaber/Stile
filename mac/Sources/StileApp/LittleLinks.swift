import AppKit

/// v2.8: links from other apps open in "little windows". Helpers for the default-browser registration,
/// handing URLs to Chrome and asking the extension to open / promote a little window.
enum LittleLinks {
    static let chromeBundleID = "com.google.Chrome"
    static let schemes = ["http", "https"]

    /// state.json `littleLinksEnabled` (default false).
    static func enabled(in st: [String: Any]) -> Bool {
        HostStore.isBool(st["littleLinksEnabled"]) && (st["littleLinksEnabled"] as? Bool) == true
    }

    static func chromeURL() -> URL? {
        NSWorkspace.shared.urlForApplication(withBundleIdentifier: chromeBundleID)
    }

    static var chromeRunning: Bool {
        NSRunningApplication.runningApplications(withBundleIdentifier: chromeBundleID).contains { !$0.isTerminated }
    }

    /// True when this app is currently the default handler for both http and https.
    static func isDefaultHandler() -> Bool {
        let me = Bundle.main.bundleURL.resolvingSymlinksInPath().path
        for s in schemes {
            guard let probe = URL(string: "\(s)://example.com"),
                  let app = NSWorkspace.shared.urlForApplication(toOpen: probe) else { return false }
            if app.resolvingSymlinksInPath().path != me { return false }
        }
        return true
    }

    /// Makes this app (on) or Chrome (off) the default http/https handler. macOS shows its own confirmation.
    /// `completion` runs on the main queue with an error message, or nil on success.
    static func setDefault(_ on: Bool, completion: @escaping (String?) -> Void) {
        let alreadyDefault = isDefaultHandler()
        if on == alreadyDefault || (!on && !alreadyDefault) {
            completion(nil)
            return
        }
        let target: URL
        if on {
            target = Bundle.main.bundleURL
        } else if let chrome = chromeURL() {
            target = chrome
        } else {
            completion("Google Chrome was not found")
            return
        }
        func step(_ i: Int) {
            if i >= schemes.count {
                completion(nil)
                return
            }
            NSWorkspace.shared.setDefaultApplication(at: target, toOpenURLsWithScheme: schemes[i]) { error in
                DispatchQueue.main.async {
                    if let e = error {
                        completion(e.localizedDescription)
                    } else {
                        step(i + 1)
                    }
                }
            }
        }
        step(0)
    }

    /// Hands URLs (web or anything else) to Chrome itself, never to the default handler (that may be us).
    static func openInChrome(_ urls: [URL]) {
        guard let chrome = chromeURL() else {
            Log.write("little: Chrome not found; cannot open \(urls.count) link(s)")
            return
        }
        NSWorkspace.shared.open(urls, withApplicationAt: chrome, configuration: NSWorkspace.OpenConfiguration()) { _, error in
            if let e = error { Log.write("little: opening in Chrome failed: \(e.localizedDescription)") }
        }
    }

    /// Brings Chrome forward, launching it when it is not running.
    static func openChromeApp() {
        if let app = NSRunningApplication.runningApplications(withBundleIdentifier: chromeBundleID)
            .first(where: { !$0.isTerminated }) {
            app.activate()
        } else if let chrome = chromeURL() {
            NSWorkspace.shared.openApplication(at: chrome, configuration: NSWorkspace.OpenConfiguration()) { _, error in
                if let e = error { Log.write("little: launching Chrome failed: \(e.localizedDescription)") }
            }
        }
    }

    /// 760x620 pt centred on the screen containing the mouse, in Chrome's top-left screen coordinates.
    static func littleBounds() -> [String: Any] {
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first(where: { NSMouseInRect(mouse, $0.frame, false) })
            ?? NSScreen.main ?? NSScreen.screens.first
        let vf = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let w = min(760, vf.width), h = min(620, vf.height)
        let ns = CGRect(x: vf.midX - w / 2, y: vf.midY - h / 2, width: w, height: h)
        let ax = Geometry.flip(ns)
        return ["left": Int(ax.minX.rounded()), "top": Int(ax.minY.rounded()),
                "width": Int(w.rounded()), "height": Int(h.rounded())]
    }

    /// Asks the extension to promote the little window to a full tab.
    static func promote(bridge: ProfileBridge, windowId: Int) {
        Task {
            do {
                let res = try await bridge.call("sidebar.cmd", [["cmd": "promoteLittle", "windowId": windowId]])
                if let d = res as? [String: Any], (d["ok"] as? Bool) == false {
                    Log.write("little: promoteLittle refused (\(d["error"] as? String ?? "unknown"))")
                }
            } catch {
                Log.write("little: promoteLittle failed: \(error.localizedDescription)")
            }
        }
    }
}

/// Routes links received by the app (and the Control+Option+N hotkey) to a little window via the bridge,
/// falling back to Chrome. Never involved in connector mode (that process never creates the AppDelegate).
@MainActor
final class LinkRouter {
    private struct Pending {
        let id = UUID()
        let url: URL
    }

    private let server: HostServer
    /// The bridge of Chrome's most recently focused mapped window (set by the app once the manager exists).
    var preferredBridge: (() -> ProfileBridge?)?
    private var queue: [Pending] = []
    private var observer: NSObjectProtocol?

    init(server: HostServer) {
        self.server = server
        observer = NotificationCenter.default.addObserver(forName: .sidebarBridgesChanged, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.flush() }
        }
    }

    deinit {
        if let o = observer { NotificationCenter.default.removeObserver(o) }
    }

    // MARK: Entry points

    func handle(_ urls: [URL]) {
        for url in urls {
            guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
                LittleLinks.openInChrome([url])
                continue
            }
            route(url)
        }
    }

    /// Control+Option+N: an empty little window (the search page) on the chosen profile.
    func openNewLittle() {
        if let b = chooseBridge() {
            openLittle(url: nil, on: b)
        } else {
            LittleLinks.openChromeApp()
        }
    }

    // MARK: Routing

    private func route(_ url: URL) {
        guard LittleLinks.enabled(in: HostStore.readState()) else {
            LittleLinks.openInChrome([url])
            return
        }
        if let b = chooseBridge() {
            openLittle(url: url, on: b)
        } else if LittleLinks.chromeRunning {
            enqueue(url)
        } else {
            LittleLinks.openInChrome([url])
        }
    }

    private func chooseBridge() -> ProfileBridge? {
        if let b = preferredBridge?(), !b.closed, b.identified { return b }
        return server.identified.first
    }

    /// Waits up to 5 s for a connection, then falls back to Chrome.
    private func enqueue(_ url: URL) {
        let p = Pending(url: url)
        queue.append(p)
        let id = p.id
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
            Task { @MainActor in self?.expire(id) }
        }
    }

    private func expire(_ id: UUID) {
        guard let i = queue.firstIndex(where: { $0.id == id }) else { return }
        let p = queue.remove(at: i)
        Log.write("little: no connection within 5 s; opening link in Chrome")
        LittleLinks.openInChrome([p.url])
    }

    private func flush() {
        guard !queue.isEmpty, let b = chooseBridge() else { return }
        let items = queue
        queue.removeAll()
        for p in items { openLittle(url: p.url, on: b) }
    }

    private func openLittle(url: URL?, on bridge: ProfileBridge) {
        if let app = NSRunningApplication.runningApplications(withBundleIdentifier: LittleLinks.chromeBundleID)
            .first(where: { !$0.isTerminated }) {
            app.activate()
        }
        let urlValue: Any = url.map { $0.absoluteString as Any } ?? NSNull()
        let cmd: [String: Any] = ["cmd": "openLittle", "url": urlValue, "bounds": LittleLinks.littleBounds()]
        Task { @MainActor in
            do {
                let res = try await bridge.call("sidebar.cmd", [cmd])
                if let d = res as? [String: Any], (d["ok"] as? Bool) == false {
                    Log.write("little: openLittle refused (\(d["error"] as? String ?? "unknown")); falling back to Chrome")
                    self.fallback(url)
                }
            } catch BridgeError.timeout {
                Log.write("little: openLittle timed out")
            } catch {
                Log.write("little: openLittle failed (\(error.localizedDescription)); falling back to Chrome")
                self.fallback(url)
            }
        }
    }

    private func fallback(_ url: URL?) {
        if let u = url { LittleLinks.openInChrome([u]) } else { LittleLinks.openChromeApp() }
    }
}
