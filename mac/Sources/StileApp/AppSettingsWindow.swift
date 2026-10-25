import AppKit
import WebKit

/// Stile's settings, always in an app window (with a Dock icon while it is open). It is the extension's own
/// `settings.html?host=app` served from the web root. Chrome mode: the page is scoped to one connected profile
/// (`&profile=<dir>`) and its `sidebarBridge` handler is wired to that profile's `ProfileBridge`, exactly like a
/// sidebar panel, so the page edits that profile's settings through the extension. Capture-only mode (or no
/// extension connected): the unbridged page, which talks to the app through the `stileSettings` message handler
/// (see `extension/settings-app.js`) and shows the Capture and Recording groups plus a few app rows.
@MainActor
final class AppSettingsWindow: NSObject, NSWindowDelegate, WKScriptMessageHandlerWithReply {
    static let shared = AppSettingsWindow()

    weak var server: HostServer?
    weak var manager: OverlayManager?

    private var window: NSWindow?
    private var webView: WKWebView?
    private var observers: [NSObjectProtocol] = []
    private var lastPushed = ""
    private var timer: Timer?
    private static let schemeHandler = WebSchemeHandler()

    // scope: the profile whose bridge the page is wired to (nil: unbridged page)
    private weak var scope: ProfileBridge?
    private var loadedKey = ""
    private let token = String(UUID().uuidString.prefix(8)).lowercased()
    private var idMap: [String: Any] = [:]
    private var subscription: UUID?
    private var bridgeTrampoline: ScriptMessageTrampoline?

    var isOpen: Bool { window != nil }

    func show(section: String? = nil, bridge: ProfileBridge? = nil) {
        let fresh = window == nil
        if fresh { build() }
        load(scope: Settings.useChrome ? (bridge ?? desiredScope()) : nil, section: section, force: fresh)
        DockPresence.update()   // before activating, so the window comes forward with its Dock icon
        NSApp.activate(ignoringOtherApps: true)
        if window?.isMiniaturized == true { window?.deminiaturize(nil) }
        window?.makeKeyAndOrderFront(nil)
    }

    /// Chrome mode: the current scope while alive, else the focused window's profile, else the first connected one.
    private func desiredScope() -> ProfileBridge? {
        guard Settings.useChrome else { return nil }
        if let s = scope, !s.closed, s.identified { return s }
        if let b = manager?.focusedController()?.mappedBridge, !b.closed, b.identified { return b }
        return server?.identified.first
    }

    private func detach() {
        if let sub = subscription { scope?.removeSubscriber(sub) }
        subscription = nil
        idMap.removeAll()
    }

    /// Reloads only when the scope (or bridged/unbridged mode) changed; a section alone just moves the hash.
    private func load(scope s: ProfileBridge?, section: String?, force: Bool = false) {
        guard let wv = webView else { return }
        let key = s?.id.uuidString ?? "unbridged"
        if !force && key == loadedKey {
            if let sec = section {
                wv.evaluateJavaScript("location.hash = \(JSONUtil.stringLiteral(sec))", completionHandler: nil)
            }
            return
        }
        detach()
        loadedKey = key
        scope = s
        let ucc = wv.configuration.userContentController
        // the page's bridge shim activates whenever this handler exists, so it is only there for the bridged load
        ucc.removeScriptMessageHandler(forName: "sidebarBridge")
        bridgeTrampoline = nil
        var comps = URLComponents()
        comps.scheme = "sidebar"
        comps.host = "app"
        comps.path = "/settings.html"
        comps.queryItems = [URLQueryItem(name: "host", value: "app")]
        if let s {
            let t = ScriptMessageTrampoline { [weak self] body in MainActor.assumeIsolated { self?.pageMessage(body) } }
            bridgeTrampoline = t
            ucc.add(t, name: "sidebarBridge")
            subscription = s.addSubscriber { [weak self] msg in MainActor.assumeIsolated { self?.fromExt(msg) } }
            comps.queryItems?.append(URLQueryItem(name: "profile", value: s.profileDir))
        }
        if let sec = section, !sec.isEmpty { comps.fragment = sec }
        if let url = comps.url { wv.load(URLRequest(url: url)) }
        push()
    }

    /// Bridges or the mode changed: rescope if the scoped bridge is gone (or one appeared / the mode flipped), then push.
    private func refresh() {
        if window != nil {
            let want = Settings.useChrome ? desiredScope() : nil
            if (want?.id.uuidString ?? "unbridged") != loadedKey { load(scope: want, section: nil) }
        }
        push()
    }

    // MARK: Bridge (page <-> extension), same envelope as SidebarPanel

    private func pageMessage(_ body: Any) {
        guard let s = body as? String, let data = s.data(using: .utf8),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
        switch obj["type"] as? String {
        case "bridge":
            let rawId = obj["id"] ?? NSNull()
            guard let b = scope, !b.closed else {
                deliver(["type": "bridgeResult", "id": rawId, "ok": false, "error": "Stile extension not connected"])
                return
            }
            let prefixed = token + ":" + (rawId as? String ?? String(describing: rawId))
            idMap[prefixed] = rawId
            var m = obj
            m["id"] = prefixed
            b.sendToExt(m)
        case "host":
            Log.write("settings window: ignoring host message '\((obj["action"] as? String) ?? "")'")
        default:
            break
        }
    }

    private func fromExt(_ msg: [String: Any]) {
        switch msg["type"] as? String {
        case "bridgeEvent":
            deliver(msg)
        case "bridgeResult":
            guard let rid = msg["id"] as? String, rid.hasPrefix(token + ":"),
                  let original = idMap.removeValue(forKey: rid) else { return }
            var m = msg
            m["id"] = original
            deliver(m)
        default:
            break
        }
    }

    private func deliver(_ obj: [String: Any]) {
        guard let json = JSONUtil.string(obj) else { return }
        let lit = JSONUtil.stringLiteral(json)
        webView?.evaluateJavaScript("window.__sidebarBridgeReceive && window.__sidebarBridgeReceive(\(lit))", completionHandler: nil)
    }

    private func build() {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(Self.schemeHandler, forURLScheme: "sidebar")
        let ucc = WKUserContentController()
        ucc.addScriptMessageHandler(SettingsReplyTrampoline(self), contentWorld: .page, name: "stileSettings")
        config.userContentController = ucc
        let wv = WKWebView(frame: .zero, configuration: config)
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 860, height: 640),
                         styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        w.title = "Stile Settings"
        w.isReleasedWhenClosed = false
        w.minSize = NSSize(width: 640, height: 420)
        w.contentView = wv
        w.delegate = self
        w.tabbingMode = .disallowed
        w.center()
        window = w
        webView = wv
        let nc = NotificationCenter.default
        for n in [Notification.Name.stileCaptureSettingsChanged, .sidebarSettingsChanged, .stileModeChanged] {
            observers.append(nc.addObserver(forName: n, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in self?.refresh() }
            })
        }
        observers.append(nc.addObserver(forName: .sidebarBridgesChanged, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        })
        // permissions change outside the app: look again now and then while the window is open
        timer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.push() }
        }
    }

    func windowWillClose(_ notification: Notification) {
        timer?.invalidate()
        timer = nil
        for o in observers { NotificationCenter.default.removeObserver(o) }
        observers.removeAll()
        detach()
        webView?.configuration.userContentController.removeAllScriptMessageHandlers()
        webView = nil
        window = nil
        bridgeTrampoline = nil
        scope = nil
        loadedKey = ""
        lastPushed = ""
        DispatchQueue.main.async { DockPresence.update() }   // next turn, so isOpen is false
    }

    // MARK: State

    private func state() -> [String: Any] {
        [
            "useChrome": Settings.useChrome,
            "capture": CaptureSettings.shared.publicDict(),
            "microphones": CaptureSettings.microphones(),
            "microphone": Permissions.microphoneGranted,
            "screenCapture": Permissions.screenCaptureGranted,
            "launchAtLogin": LoginItem.enabled,
            "showMenuBarIcon": Settings.showMenuBarIcon,
            "appVersion": AppInfo.version,
            "connectedProfiles": (server?.identified.map { $0.profileDir } ?? []).sorted(),
            "scopeProfile": (scope?.profileDir as Any?) ?? NSNull(),
        ]
    }

    /// Sends the state to the page when it changed.
    private func push() {
        guard let wv = webView, let json = JSONUtil.string(state()), json != lastPushed else { return }
        lastPushed = json
        wv.evaluateJavaScript("window.__stileSettingsPush && window.__stileSettingsPush(\(json))", completionHandler: nil)
    }

    // MARK: Requests from the page

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        guard let m = message.body as? [String: Any], let op = m["op"] as? String else { return replyHandler(nil, "bad request") }
        let cs = CaptureSettings.shared
        switch op {
        case "state":
            lastPushed = JSONUtil.string(state()) ?? ""
            replyHandler(state(), nil)
        case "full":
            replyHandler(cs.publicDict(full: true), nil)
        case "set":
            if let patch = m["patch"] as? [String: Any] { cs.apply(patch) }
            replyHandler(cs.publicDict(), nil)
        case "chooseFolder":
            cs.chooseFolder(key: (m["kind"] as? String) == "recordings" ? "recordingFolder" : "screenshotFolder")
            replyHandler(cs.publicDict(), nil)
        case "fetch":
            CaptureEditorWindow.proxyFetch(m, reply: replyHandler)
        case "appSetting":
            appSetting(m["name"] as? String ?? "", m["value"])
            replyHandler(true, nil)
        case "selectProfile":
            guard let dir = m["dir"] as? String, let b = server?.identified.first(where: { $0.profileDir == dir }) else {
                return replyHandler(nil, "That profile isn't open in Chrome")
            }
            load(scope: b, section: m["section"] as? String)
            replyHandler(true, nil)
        default:
            replyHandler(nil, "unknown op \(op)")
        }
    }

    private func appSetting(_ name: String, _ value: Any?) {
        let on = (value as? Bool) ?? ((value as? NSNumber)?.boolValue ?? false)
        switch name {
        case "setUseChrome": Settings.useChrome = on
        case "setLaunchAtLogin": LoginItem.set(on); Settings.post()
        case "setShowMenuBarIcon": Settings.showMenuBarIcon = on
        case "requestScreenCapture":
            if !Permissions.requestScreenCapture() { Permissions.openScreenCaptureSettings() }
        case "requestMicrophone":
            if Permissions.microphoneGranted { break }
            Permissions.openMicrophoneSettings()
        case "reviewPermissions": NotificationCenter.default.post(name: .sidebarReviewPermissions, object: nil)
        case "quitApp":
            FileManager.default.createFile(atPath: HostPaths.quitFlagPath, contents: nil)
            NSApp.terminate(nil)
        default: Log.write("settings window: unknown setting '\(name)'")
        }
        push()
    }
}

/// Weak trampoline so the content controller doesn't retain the window object.
@MainActor
private final class SettingsReplyTrampoline: NSObject, WKScriptMessageHandlerWithReply {
    private weak var target: AppSettingsWindow?
    init(_ target: AppSettingsWindow) { self.target = target }
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        guard let t = target else { return replyHandler(nil, "closed") }
        t.userContentController(ucc, didReceive: message, replyHandler: replyHandler)
    }
}
