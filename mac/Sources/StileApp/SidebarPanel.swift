import AppKit
import QuartzCore
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
    var onPointerEnter: (() -> Void)?
    var onPointerExit: (() -> Void)?
    /// Chrome's process id (0 when unknown); key events are forwarded there.
    var chromePid: (() -> pid_t)?
    /// A click inside the panel that did not land on an editable element (Chrome's window should become main again).
    var onNonEditingClick: (() -> Void)?
    /// Called on every left mouse-down inside the panel (before the page sees it).
    var onPanelMouseDown: (() -> Void)?

    /// True while an editable element inside the page has focus (host message `editing`).
    var isEditing = false
    /// Key codes whose keyDown was forwarded to Chrome while editing, so the matching keyUp follows.
    private var forwardedKeyCodes = Set<UInt16>()

    /// True while a left-button press that began inside this panel is held (a tab being dragged out of the sidebar).
    var pressedHere = false

    /// Transparent panel content: holds `container` (clipped to the panel, bottom-left corner only) and the peek shadow strip.
    let root = NSView(frame: .zero)
    /// Holds the web view at the expanded width; the panel's own frame clips it to the visible strip.
    let container = NSView(frame: .zero)
    let shadowStrip = NSView(frame: .zero)
    /// Full screen: a strip above the content (`topInset` tall) painted in Chrome's toolbar colour while its toolbar is
    /// out, so the first frame of a slide up never shows Chrome's rail; clear otherwise.
    let topStrip = NSView(frame: .zero)
    /// 1 px line at the panel's right edge while peeking.
    let hairline = NSView(frame: .zero)
    private var shadowIsDark: Bool?
    let webView: WKWebView
    let handle = ResizeHandleView(frame: .zero)

    private let token = String(UUID().uuidString.prefix(8)).lowercased()
    private var idMap: [String: Any] = [:]
    private var bridge: ProfileBridge?
    private var subscription: UUID?
    private var loadedKey: String?
    private var lastHostJSON = ""
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
        webView = FirstMouseWebView(frame: .zero, configuration: config)

        super.init(contentRect: NSRect(x: 0, y: 0, width: 280, height: 600),
                   styleMask: [.borderless, .nonactivatingPanel],
                   backing: .buffered,
                   defer: false)

        hidesOnDeactivate = false
        isFloatingPanel = false
        level = .normal
        collectionBehavior = [.managed, .fullScreenAuxiliary, .ignoresCycle]
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

        root.wantsLayer = true
        container.wantsLayer = true
        container.layer?.masksToBounds = true
        container.autoresizingMask = [.height]
        root.addSubview(container)
        topStrip.wantsLayer = true
        root.addSubview(topStrip)

        shadowStrip.wantsLayer = true
        let gradient = CAGradientLayer()
        gradient.colors = [NSColor.black.withAlphaComponent(0.07).cgColor, NSColor.black.withAlphaComponent(0).cgColor]
        gradient.startPoint = CGPoint(x: 0, y: 0.5)
        gradient.endPoint = CGPoint(x: 1, y: 0.5)
        shadowStrip.layer = gradient
        shadowStrip.autoresizingMask = [.height]
        shadowStrip.isHidden = true
        root.addSubview(shadowStrip)
        hairline.wantsLayer = true
        hairline.autoresizingMask = [.height]
        hairline.isHidden = true
        root.addSubview(hairline)
        contentView = root

        // Enter/exit for hover reveal and hide (replaces most pointer polling).
        let area = NSTrackingArea(rect: .zero,
                                  options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                                  owner: self, userInfo: nil)
        root.addTrackingArea(area)

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
        handle.currentWidth = { [weak self] in self?.container.frame.width ?? 280 }
        handle.onResizeBegan = { [weak self] in self?.onResizeBegan?() }
        handle.onResize = { [weak self] w in self?.onResize?(w) }
        handle.onResizeEnded = { [weak self] in self?.onResizeEnded?() }
        container.addSubview(handle)

        NotificationCenter.default.addObserver(forName: NSWindow.didBecomeKeyNotification, object: self, queue: .main) { [weak self] note in
            if note.userInfo?["stileSynthetic"] != nil { return }
            Task { @MainActor in self?.onDidBecomeKey?() }
        }

        showWaiting()
    }

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    private var pointerInside = false

    /// WebKit treats a non-key window as inactive and ignores hover. Report key while the pointer is
    /// over the panel. This does not change NSApp.keyWindow, so keystrokes still go to Chrome.
    override var isKeyWindow: Bool { super.isKeyWindow || pointerInside }

    override func mouseEntered(with event: NSEvent) {
        pointerInside = true
        if !super.isKeyWindow {
            NotificationCenter.default.post(name: NSWindow.didBecomeKeyNotification, object: self,
                                            userInfo: ["stileSynthetic": true])
        }
        onPointerEnter?()
    }

    override func mouseExited(with event: NSEvent) {
        pointerInside = false
        if !super.isKeyWindow {
            NotificationCenter.default.post(name: NSWindow.didResignKeyNotification, object: self,
                                            userInfo: ["stileSynthetic": true])
        }
        onPointerExit?()
    }

    override func sendEvent(_ event: NSEvent) {
        switch event.type {
        case .leftMouseDown:
            pressedHere = true
            onPanelMouseDown?()
            super.sendEvent(event)
            return
        case .leftMouseUp:
            pressedHere = false
            super.sendEvent(event)
            // The page reports `editing` asynchronously after focus moves; check once it settled.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) { [weak self] in
                guard let self = self, !self.isEditing, !self.pressedHere else { return }
                self.onNonEditingClick?()
            }
            return
        case .keyDown, .keyUp, .flagsChanged:
            if forwardKey(event) { return }
        default:
            break
        }
        super.sendEvent(event)
    }

    /// Returns true when the event was sent to Chrome instead of the web view.
    private func forwardKey(_ event: NSEvent) -> Bool {
        guard let pid = chromePid?(), pid > 0 else { return false }
        var forward = !isEditing
        if isEditing {
            switch event.type {
            case .keyDown:
                if SidebarPanel.isChromeShortcut(event) {
                    forwardedKeyCodes.insert(event.keyCode)
                    forward = true
                }
            case .keyUp:
                forward = forwardedKeyCodes.remove(event.keyCode) != nil
            default:
                break
            }
        }
        guard forward, let cg = event.cgEvent?.copy() else { return false }
        cg.postToPid(pid)
        return true
    }

    /// Cmd-shortcuts Chrome should get even while a text field has focus.
    private static func isChromeShortcut(_ e: NSEvent) -> Bool {
        let f = e.modifierFlags.intersection(.deviceIndependentFlagsMask)
        guard f.contains(.command), !f.contains(.control) else { return false }
        let shift = f.contains(.shift), opt = f.contains(.option)
        if opt {
            return !shift && (e.keyCode == 123 || e.keyCode == 124)   // Cmd+Option+Left/Right
        }
        if shift && (e.keyCode == 33 || e.keyCode == 30) { return true }   // Cmd+Shift+[ / ]
        let c = e.charactersIgnoringModifiers?.lowercased() ?? ""
        if shift { return c == "t" }
        switch c {
        case "t", "n", "w", "l", "r", ",", "q", "1", "2", "3", "4", "5", "6", "7", "8", "9": return true
        default: return false
        }
    }

    /// Lay the content out. `panelWidth` is the visible strip (the panel itself clips anything wider),
    /// `contentWidth` is the web view's width: the target expanded width, so collapsed is just the same
    /// layout clipped to the rail. `shadow` is the transparent shadow strip right of the content (peek only).
    /// How far the panel runs off the bottom of the screen (full screen, toolbar out: the panel keeps its height so a
    /// toolbar slide only ever moves it). The web view and its edges stop above it; the container's fill covers it.
    var bottomOverflow: CGFloat = 0
    /// Height of `topStrip` at the top of the panel (full screen only).
    var topInset: CGFloat = 0
    private var topStripColor: NSColor?

    private var hole: NSRect?
    private var holeBounds: NSRect = .zero

    /// Makes `rect` (panel coordinates) transparent, which also lets clicks through to the window under it; nil clears.
    func setHole(_ rect: NSRect?) {
        let r = rect.map { $0.intersection(root.bounds) }.flatMap { $0.isEmpty ? nil : $0 }
        if r == hole, r == nil || root.bounds == holeBounds { return }
        hole = r
        holeBounds = root.bounds
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        if let r {
            let mask = CAShapeLayer()
            mask.frame = root.bounds
            let path = CGMutablePath()
            path.addRect(root.bounds)
            path.addRect(r)
            mask.path = path
            mask.fillRule = .evenOdd
            root.layer?.mask = mask
        } else {
            root.layer?.mask = nil
        }
        CATransaction.commit()
    }

    func setTopStrip(_ color: NSColor?) {
        if color == topStripColor { return }
        topStripColor = color
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        topStrip.layer?.backgroundColor = color?.cgColor
        CATransaction.commit()
    }

    func fitContent(panelWidth: CGFloat, contentWidth: CGFloat, shadow: CGFloat = 0) {
        let total = root.bounds.height
        let top = min(max(0, topInset), total)
        let full = total - top
        let y = min(max(0, bottomOverflow), full)
        let h = full - y
        let cw = max(contentWidth, panelWidth)
        topStrip.isHidden = top <= 0
        topStrip.frame = NSRect(x: 0, y: full, width: panelWidth, height: top)
        container.frame = NSRect(x: 0, y: 0, width: cw, height: full)
        webView.frame = NSRect(x: 0, y: y, width: cw, height: h)
        handle.frame = NSRect(x: max(0, panelWidth - 6), y: y, width: 6, height: h)
        shadowStrip.isHidden = shadow <= 0
        shadowStrip.frame = NSRect(x: panelWidth, y: y, width: max(shadow, 0), height: h)
        hairline.isHidden = shadow <= 0
        hairline.frame = NSRect(x: max(0, panelWidth - 1), y: y, width: 1, height: h)
        if shadow > 0 { updateShadowColors() }
    }

    /// Peek shadow: black 7% (light) / 18% (dark) fading to clear over 8 pt, plus a hairline in text colour at 8%.
    private func updateShadowColors() {
        let dark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        if shadowIsDark == dark { return }
        shadowIsDark = dark
        if let g = shadowStrip.layer as? CAGradientLayer {
            g.colors = [NSColor.black.withAlphaComponent(dark ? 0.18 : 0.07).cgColor,
                        NSColor.black.withAlphaComponent(0).cgColor]
        }
        let text: NSColor = dark ? .white : .black
        hairline.layer?.backgroundColor = text.withAlphaComponent(0.08).cgColor
    }

    /// Painted behind the (transparent) web view. When the panel grows, WebKit paints the new strip a few frames
    /// late; without a fill, whatever is under the panel shows through until then.
    var fill: NSColor? {
        didSet { container.layer?.backgroundColor = fill?.cgColor }
    }

    /// Square corners everywhere, except the bottom-left one when the panel sits in the corner of
    /// Chrome's (rounded, 10 pt) window.
    func setCorners(bottomLeft: Bool) {
        guard let layer = container.layer else { return }
        // On macOS (non-flipped layers) MinY is the bottom edge.
        layer.maskedCorners = bottomLeft ? [.layerMinXMinYCorner] : []
        layer.cornerRadius = bottomLeft ? 10 : 0
    }

    // MARK: Content

    func showWaiting() {
        if loadedKey == "waiting" { return }
        if let sub = subscription { bridge?.removeSubscriber(sub) }
        subscription = nil
        bridge = nil
        loadedKey = "waiting"
        pageLoaded = false
        // Never shown over Chrome's tabs (the panel is ordered out until a live connection maps the window).
        let html = "<!doctype html><meta charset=\"utf-8\"><style>:root{color-scheme:light dark}body{margin:0;background:Canvas}</style>"
        webView.loadHTMLString(html, baseURL: nil)
    }

    /// The "Add the Stile extension to this profile" card.
    func showSetup(candidates: [(dir: String, name: String)]) {
        let key = "setup:" + candidates.map { $0.dir }.joined(separator: ",")
        if loadedKey == key { return }
        if let sub = subscription { bridge?.removeSubscriber(sub) }
        subscription = nil
        bridge = nil
        loadedKey = key
        pageLoaded = false
        webView.loadHTMLString(SetupCard.html(candidates: candidates), baseURL: nil)
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
                                            "error": "Stile extension not connected"]
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

    /// Calls window.__sidebarHostState({state, railFound, railControllable, launchAtLogin, accessibility, appVersion, ...}).
    /// Identical consecutive states are skipped unless `force` (e.g. after a page load).
    func sendHostState(_ obj: [String: Any], force: Bool = false) {
        guard let json = JSONUtil.string(obj) else { return }
        if !force && json == lastHostJSON { return }
        lastHostJSON = json
        webView.evaluateJavaScript("window.__sidebarHostState && window.__sidebarHostState(\(json))", completionHandler: nil)
    }

    var isPageLoaded: Bool { pageLoaded }

    // MARK: WKNavigationDelegate

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        pageLoaded = true
        lastHostJSON = ""
        onHost?("pageLoaded", nil)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        Log.write("sidebar: web content process terminated; reloading")
        pageLoaded = false
        lastHostJSON = ""
        webView.reload()
    }
}
