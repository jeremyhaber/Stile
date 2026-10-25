import AppKit
import WebKit

/// v3.4: the screenshot editor in an app window (Shottr-like) rather than a Chrome popup. It is the extension's own
/// React editor (`capture/capture.html?host=app`) served from the web root; the page asks the app for everything Chrome
/// used to do (see `extension/capture/src/host.ts`): the picture (served at `/__capture/<id>.png`), copy, save, the S3
/// request (no CORS for URLSession), the link, drag-out and closing.
@MainActor
final class CaptureDocument {
    let id: String
    let png: Data
    /// the extension's capture meta: id, time, url, title, mode, width, height, dpr, note, link
    var meta: [String: Any]
    var config: [String: Any]
    let theme: String?
    /// the profile the capture belongs to (links go back to its recent captures)
    weak var bridge: ProfileBridge?

    init(id: String, png: Data, meta: [String: Any], config: [String: Any], theme: String?, bridge: ProfileBridge?) {
        self.id = id
        self.png = png
        self.meta = meta
        self.config = config
        self.theme = theme
        self.bridge = bridge
    }
}

@MainActor
final class CaptureEditors {
    static let shared = CaptureEditors()
    private var windows: [String: CaptureEditorWindow] = [:]

    var hasOpen: Bool { !windows.isEmpty }

    /// Dock icon (and Command+Tab) while an editor window is open; menu bar only otherwise.
    private func setInDock(_ on: Bool) {
        DockPresence.update()   // shared: editors, recording previews and the settings window all keep the Dock icon
    }

    /// Dock icon clicked: the most recent editor window comes forward.
    func reopen() -> Bool {
        guard let w = windows.values.max(by: { $0.opened < $1.opened }) else { return false }
        w.bringForward()
        return true
    }

    /// The picture for the scheme handler (`/__capture/<id>.png`).
    func png(for id: String) -> Data? { windows[id]?.doc.png }

    /// New settings reach the open editors: the app's capture settings (v3.5c: the single source of truth) plus the
    /// profile's colour. `bridge` limits it to that profile's editors (and ones not tied to a profile).
    func refreshConfigs(from bridge: ProfileBridge? = nil) {
        for w in windows.values where bridge == nil || w.doc.bridge == nil || w.doc.bridge === bridge {
            w.doc.config = CaptureSettings.shared.editorConfig(sidebarColor: w.doc.bridge?.captureConfig["sidebarColor"])
            w.pushConfig()
        }
    }

    @discardableResult
    func open(_ doc: CaptureDocument) -> Bool {
        if let w = windows[doc.id] {
            w.bringForward()
            return true
        }
        let w = CaptureEditorWindow(doc: doc)
        w.onClosed = { [weak self] in
            guard let self else { return }
            windows[doc.id] = nil
            if windows.isEmpty { setInDock(false) }
        }
        if windows.isEmpty { setInDock(true) }
        windows[doc.id] = w
        w.bringForward()
        Log.write("capture: editor window opened for \(doc.id) (\(doc.png.count) bytes)")
        return true
    }
}

/// Records the last mouse-down: the page's drag handle asks for a native drag a moment later, and an AppKit drag
/// session must start from a mouse event.
private final class EditorNSWindow: NSWindow {
    var lastMouseDown: NSEvent?
    override func sendEvent(_ event: NSEvent) {
        if event.type == .leftMouseDown { lastMouseDown = event }
        super.sendEvent(event)
    }
}

@MainActor
final class CaptureEditorWindow: NSObject, NSWindowDelegate, WKScriptMessageHandlerWithReply, NSDraggingSource {
    let doc: CaptureDocument
    var onClosed: (() -> Void)?
    private let window: EditorNSWindow
    private let webView: WKWebView
    private var allowClose = false
    let opened = Date()

    private static let schemeHandler = WebSchemeHandler()

    init(doc: CaptureDocument) {
        self.doc = doc
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(Self.schemeHandler, forURLScheme: "sidebar")
        let ucc = WKUserContentController()
        config.userContentController = ucc
        webView = WKWebView(frame: .zero, configuration: config)
        window = EditorNSWindow(contentRect: Self.initialFrame(doc.meta), styleMask: [.titled, .closable, .miniaturizable, .resizable],
                                backing: .buffered, defer: false)
        super.init()
        // a weak trampoline: the content controller retains its handlers
        ucc.addScriptMessageHandler(ReplyTrampoline(self), contentWorld: .page, name: "stileCapture")
        window.title = (doc.meta["title"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "Screenshot"
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 520, height: 360)
        window.contentView = webView
        window.delegate = self
        window.tabbingMode = .disallowed
        var q = "capture/capture.html?host=app&id=\(doc.id.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? doc.id)"
        if let t = doc.theme, t == "light" || t == "dark" { q += "&theme=\(t)" }
        if let url = URL(string: "sidebar://app/\(q)") { webView.load(URLRequest(url: url)) }
    }

    func bringForward() {
        NSApp.activate(ignoringOtherApps: true)
        if window.isMiniaturized { window.deminiaturize(nil) }
        window.makeKeyAndOrderFront(nil)
    }

    /// The picture at its real size (pixels / dpr) plus the editor's chrome, within 85% of the screen under the pointer.
    private static func initialFrame(_ meta: [String: Any]) -> NSRect {
        let dpr = max(1, (meta["dpr"] as? NSNumber)?.doubleValue ?? 1)
        let w = (meta["width"] as? NSNumber)?.doubleValue ?? 1000
        let h = (meta["height"] as? NSNumber)?.doubleValue ?? 700
        let p = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { NSMouseInRect(p, $0.frame, false) } ?? NSScreen.main
        let vis = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let cw = min(vis.width * 0.85, max(780, w / dpr + 48))
        let ch = min(vis.height * 0.85 - 28, max(460, h / dpr + 48 + 46 + 28))
        return NSRect(x: vis.midX - cw / 2, y: vis.midY - ch / 2, width: cw, height: ch)
    }

    func pushConfig() {
        guard let v = Self.plist(doc.config), let data = try? JSONSerialization.data(withJSONObject: v),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.__stileConfig && window.__stileConfig(\(json))", completionHandler: nil)
    }

    // MARK: NSWindowDelegate

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if allowClose { return true }
        // the page decides: unsaved annotations ask "Discard changes?" first, then it sends `close`
        webView.evaluateJavaScript("window.__stileRequestClose ? (window.__stileRequestClose(), true) : false") { [weak self] r, _ in
            if (r as? Bool) != true { self?.forceClose() }
        }
        return false
    }

    func windowWillClose(_ notification: Notification) {
        webView.configuration.userContentController.removeAllScriptMessageHandlers()
        onClosed?()
    }

    private func forceClose() {
        allowClose = true
        window.close()
    }

    // MARK: Requests from the page

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        guard let m = message.body as? [String: Any], let op = m["op"] as? String else {
            return replyHandler(nil, "bad request")
        }
        switch op {
        case "load":
            replyHandler(Self.plist(["meta": doc.meta, "config": doc.config]), nil)
        case "copyImage":
            guard let data = (m["data"] as? String).flatMap({ Data(base64Encoded: $0) }) else { return replyHandler(nil, "no picture") }
            Self.copyImage(data)
            replyHandler(true, nil)
        case "copyText":
            let pb = NSPasteboard.general
            pb.clearContents()
            pb.setString(m["text"] as? String ?? "", forType: .string)
            replyHandler(true, nil)
        case "save":
            guard let data = (m["data"] as? String).flatMap({ Data(base64Encoded: $0) }) else { return replyHandler(nil, "no picture") }
            save(data, name: m["name"] as? String ?? "Screenshot.png", ask: (m["askWhere"] as? Bool) == true, reply: replyHandler)
        case "fetch":
            Self.proxyFetch(m, reply: replyHandler)
        case "setLink":
            let link = m["link"] as? String ?? ""
            doc.meta["link"] = link
            doc.bridge?.sendToExt(["type": "nativeCaptureLink", "id": doc.id, "link": link])
            replyHandler(true, nil)
        case "dragOut":
            guard let data = (m["data"] as? String).flatMap({ Data(base64Encoded: $0) }) else { return replyHandler(nil, "no picture") }
            dragOut(data, name: m["name"] as? String ?? "Screenshot.png")
            replyHandler(true, nil)
        case "close":
            replyHandler(true, nil)
            forceClose()
        default:
            replyHandler(nil, "unknown op \(op)")
        }
    }

    /// JSON values without NSNull (not every WebKit version converts it)
    private static func plist(_ v: Any) -> Any? {
        switch v {
        case is NSNull: return nil
        case let d as [String: Any]:
            var out: [String: Any] = [:]
            for (k, x) in d { if let y = plist(x) { out[k] = y } }
            return out
        case let a as [Any]: return a.compactMap { plist($0) }
        default: return v
        }
    }

    private static func copyImage(_ png: Data) {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setData(png, forType: .png)
        // some apps only read TIFF; skip it for huge pictures (it is uncompressed)
        if let rep = NSBitmapImageRep(data: png), rep.pixelsWide * rep.pixelsHigh <= 40_000_000,
           let tiff = rep.tiffRepresentation {
            pb.setData(tiff, forType: .tiff)
        }
    }

    private func save(_ data: Data, name: String, ask: Bool, reply: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        // v3.5c: the app's save folder and file name pattern (the page's own name is only a fallback)
        let settings = CaptureSettings.shared
        let safe = settings.fileName(app: doc.meta["title"] as? String ?? "")
        let folder = settings.screenshotFolder
        func write(_ url: URL, _ label: String) {
            do {
                try data.write(to: url, options: .atomic)
                Log.write("capture: saved \(url.path)")
                reply(["path": url.path, "folder": label], nil)
            } catch {
                reply(nil, error.localizedDescription)
            }
        }
        if ask {
            let panel = NSSavePanel()
            panel.allowedContentTypes = [.png]
            panel.nameFieldStringValue = safe
            try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            panel.directoryURL = folder
            panel.beginSheetModal(for: window) { r in
                guard r == .OK, let url = panel.url else { return reply(nil, nil) }
                write(url, url.deletingLastPathComponent().lastPathComponent)
            }
            return
        }
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        } catch {
            return reply(nil, error.localizedDescription)
        }
        write(Self.unique(folder.appendingPathComponent(safe)), folder.lastPathComponent)
    }

    /// "name.png", then "name (1).png", ... like Chrome's uniquify
    private static func unique(_ url: URL) -> URL {
        let fm = FileManager.default
        guard fm.fileExists(atPath: url.path) else { return url }
        let base = url.deletingPathExtension().lastPathComponent, ext = url.pathExtension
        for i in 1... {
            let u = url.deletingLastPathComponent().appendingPathComponent("\(base) (\(i)).\(ext)")
            if !fm.fileExists(atPath: u.path) { return u }
        }
        return url
    }

    /// Also used by the app-hosted settings window (the connection test).
    static func proxyFetch(_ m: [String: Any], reply: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        guard let s = m["url"] as? String, let url = URL(string: s), ["http", "https"].contains(url.scheme ?? "") else {
            return reply(nil, "bad url")
        }
        var req = URLRequest(url: url)
        req.httpMethod = m["method"] as? String ?? "GET"
        for (k, v) in m["headers"] as? [String: Any] ?? [:] { req.setValue("\(v)", forHTTPHeaderField: k) }
        if let b = m["body"] as? String { req.httpBody = Data(base64Encoded: b) }
        URLSession.shared.dataTask(with: req) { data, resp, error in
            let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
            let body = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            let err = error?.localizedDescription
            DispatchQueue.main.async {
                if let err { return reply(nil, err) }
                reply(["status": status, "statusText": HTTPURLResponse.localizedString(forStatusCode: status), "body": body], nil)
            }
        }.resume()
    }

    private func dragOut(_ png: Data, name: String) {
        guard let event = window.lastMouseDown, NSEvent.pressedMouseButtons & 1 == 1 else { return }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("stile-drag-\(UUID().uuidString)", isDirectory: true)
        let file = dir.appendingPathComponent(name.replacingOccurrences(of: "/", with: "-"))
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try png.write(to: file)
        } catch {
            Log.write("capture: drag file failed: \(error)")
            return
        }
        let item = NSDraggingItem(pasteboardWriter: file as NSURL)
        let p = webView.convert(event.locationInWindow, from: nil)
        let icon = NSImage(data: png) ?? NSImage()
        let k = min(1, 160 / max(1, max(icon.size.width, icon.size.height)))
        item.setDraggingFrame(NSRect(x: p.x - icon.size.width * k / 2, y: p.y - icon.size.height * k / 2,
                                     width: icon.size.width * k, height: icon.size.height * k), contents: icon)
        webView.beginDraggingSession(with: [item], event: event, source: self)
    }

    nonisolated func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation {
        .copy
    }
}

/// Weak trampoline so the content controller doesn't retain the window controller.
@MainActor
private final class ReplyTrampoline: NSObject, WKScriptMessageHandlerWithReply {
    private weak var target: CaptureEditorWindow?
    init(_ target: CaptureEditorWindow) { self.target = target }
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        guard let t = target else { return replyHandler(nil, "closed") }
        t.userContentController(ucc, didReceive: message, replyHandler: replyHandler)
    }
}
