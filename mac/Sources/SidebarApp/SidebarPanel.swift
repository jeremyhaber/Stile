import AppKit
import WebKit

/// Non-activating panel (can become key so text fields work) hosting the side panel UI in a WKWebView.
@MainActor
final class SidebarPanel: NSPanel, WKNavigationDelegate {
    // Callbacks to the controller.
    var onHost: ((String, Any?) -> Void)?
    var onBridgeCall: ((String) -> Void)?
    var onDidBecomeKey: (() -> Void)?
    var onResizeBegan: (() -> Void)?
    var onResize: ((CGFloat) -> Void)?
    var onResizeEnded: (() -> Void)?

    let container = NSView(frame: .zero)
    let webView: WKWebView
    let handle = ResizeHandleView(frame: .zero)

    private let token = String(UUID().uuidString.prefix(8)).lowercased()
    private var idMap: [String: Any] = [:]
    private var bridge: ProfileBridge?
    private var subscription: UUID?
    private var loadedKey: String?
    private var pageLoaded = false
    private var trampoline: ScriptMessageTrampoline?
    private let userContent: WKUserContentController
    private static let schemeHandler = WebSchemeHandler()

    init() {
        let config = WKWebViewConfiguration()
        let ucc = WKUserContentController()
        config.userContentController = ucc
        userContent = ucc
        config.setURLSchemeHandler(SidebarPanel.schemeHandler, forURLScheme: "sidebar")
        webView = WKWebView(frame: .zero, configuration: config)

        super.init(contentRect: NSRect(x: 0, y: 0, width: 280, height: 600),
                   styleMask: [.borderless, .nonactivatingPanel],
                   backing: .buffered,
                   defer: false)

        hidesOnDeactivate = false
        isFloatingPanel = false
        level = .normal
        collectionBehavior = [.managed, .ignoresCycle]
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        isReleasedWhenClosed = false
        animationBehavior = .none
        isMovable = false
        // WKWebView does not report needsPanelToBecomeKey, so with `true` its text inputs would never
        // receive keystrokes. The panel is non-activating, so becoming key does not activate this app.
        becomesKeyOnlyIfNeeded = false
        acceptsMouseMovedEvents = true

        let t = ScriptMessageTrampoline { [weak self] body in self?.pageMessage(body) }
        trampoline = t
        userContent.add(t, name: "sidebarBridge")

        container.wantsLayer = true
        container.layer?.masksToBounds = true
        contentView = container

        webView.navigationDelegate = self
        webView.autoresizingMask = [.height, .maxXMargin]
        if webView.responds(to: NSSelectorFromString("_setDrawsBackground:")) {
            webView.setValue(false, forKey: "drawsBackground")
        }
        if #available(macOS 13.3, *) {
            webView.isInspectable = true
        }
        container.addSubview(webView)

        handle.autoresizingMask = [.minXMargin, .height]
        handle.currentWidth = { [weak self] in self?.frame.width ?? 280 }
        handle.onResizeBegan = { [weak self] in self?.onResizeBegan?() }
        handle.onResize = { [weak self] w in self?.onResize?(w) }
        handle.onResizeEnded = { [weak self] in self?.onResizeEnded?() }
        container.addSubview(handle)

        NotificationCenter.default.addObserver(forName: NSWindow.didBecomeKeyNotification, object: self, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.onDidBecomeKey?() }
        }

        showWaiting()
    }

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    /// Lay the web view out at a fixed width (the panel itself may be narrower while animating).
    func fitContent(width: CGFloat) {
        let h = container.bounds.height
        webView.frame = NSRect(x: 0, y: 0, width: width, height: h)
        handle.frame = NSRect(x: container.bounds.width - 6, y: 0, width: 6, height: h)
    }

    // MARK: Content

    func showWaiting() {
        if loadedKey == "waiting" { return }
        if let sub = subscription { bridge?.removeSubscriber(sub) }
        subscription = nil
        bridge = nil
        loadedKey = "waiting"
        pageLoaded = false
        let html = """
        <!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
        <style>
        :root{color-scheme:light dark}
        body{margin:0;font:13px -apple-system,system-ui,sans-serif;display:flex;height:100vh;align-items:center;justify-content:center;
          background:Canvas;color:CanvasText}
        .box{padding:24px;text-align:center;max-width:240px;opacity:.85}
        h1{font-size:14px;margin:0 0 10px}
        p{margin:6px 0;line-height:1.45;opacity:.75}
        </style>
        <div class="box"><h1>Waiting for the Sidebar extension&hellip;</h1>
        <p>Make sure the Sidebar extension is installed and enabled in this Chrome profile and that the native helper is set up.</p>
        <p>This window connects automatically.</p></div>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    func connect(bridge newBridge: ProfileBridge, windowId: Int) {
        let key = "\(newBridge.id.uuidString)#\(windowId)"
        if loadedKey == key { return }
        if let sub = subscription { bridge?.removeSubscriber(sub) }
        bridge = newBridge
        loadedKey = key
        idMap.removeAll()
        subscription = newBridge.addSubscriber { [weak self] msg in self?.fromExt(msg) }

        var comps = URLComponents()
        comps.scheme = "sidebar"
        comps.host = "app"
        comps.path = "/sidepanel.html"
        comps.queryItems = [
            URLQueryItem(name: "mode", value: "overlay"),
            URLQueryItem(name: "windowId", value: String(windowId)),
            URLQueryItem(name: "profile", value: newBridge.profileDir),
        ]
        pageLoaded = false
        if let url = comps.url {
            webView.load(URLRequest(url: url))
        }
    }

    func teardown() {
        if let sub = subscription { bridge?.removeSubscriber(sub) }
        subscription = nil
        bridge = nil
        userContent.removeScriptMessageHandler(forName: "sidebarBridge")
        webView.stopLoading()
        orderOut(nil)
    }

    // MARK: Page -> app

    private func pageMessage(_ body: Any) {
        guard let s = body as? String, let data = s.data(using: .utf8),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
        switch obj["type"] as? String {
        case "bridge":
            let rawId = obj["id"] ?? NSNull()
            guard let b = bridge, !b.closed else {
                let reply: [String: Any] = ["type": "bridgeResult", "id": rawId, "ok": false,
                                            "error": "Sidebar extension not connected"]
                deliver(reply)
                return
            }
            let prefixed = token + ":" + (rawId as? String ?? String(describing: rawId))
            idMap[prefixed] = rawId
            var m = obj
            m["id"] = prefixed
            if let call = obj["call"] as? String { onBridgeCall?(call) }
            b.sendToExt(m)
        case "host":
            onHost?((obj["action"] as? String) ?? "", obj["value"])
        default:
            break
        }
    }

    // MARK: Extension -> page

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
        webView.evaluateJavaScript("window.__sidebarBridgeReceive && window.__sidebarBridgeReceive(\(lit))", completionHandler: nil)
    }

    func sendHostState(pinned: Bool, pinMode: String, state: String) {
        let obj: [String: Any] = ["pinned": pinned, "pinMode": pinMode, "state": state]
        guard let json = JSONUtil.string(obj) else { return }
        webView.evaluateJavaScript("window.__sidebarHostState && window.__sidebarHostState(\(json))", completionHandler: nil)
    }

    var isPageLoaded: Bool { pageLoaded }

    // MARK: WKNavigationDelegate

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        pageLoaded = true
        onHost?("pageLoaded", nil)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        Log.write("sidebar: web content process terminated; reloading")
        pageLoaded = false
        webView.reload()
    }
}
