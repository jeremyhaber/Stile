import AppKit
import WebKit

/// Serves Contents/Resources/web/ under sidebar://app/
@MainActor
final class WebSchemeHandler: NSObject, WKURLSchemeHandler {
    private let root: URL

    override init() {
        root = (Bundle.main.resourceURL ?? URL(fileURLWithPath: "/")).appendingPathComponent("web", isDirectory: true)
        super.init()
    }

    static func mimeType(for ext: String) -> String {
        switch ext.lowercased() {
        case "html", "htm": return "text/html"
        case "js", "mjs": return "text/javascript"
        case "css": return "text/css"
        case "png": return "image/png"
        case "svg": return "image/svg+xml"
        case "json": return "application/json"
        case "ico": return "image/x-icon"
        case "woff2": return "font/woff2"
        default: return "application/octet-stream"
        }
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else {
            urlSchemeTask.didFailWithError(URLError(.badURL))
            return
        }
        var path = url.path
        if path.isEmpty || path == "/" { path = "/sidepanel.html" }
        // v3.4: the picture of an open screenshot editor window
        if path.hasPrefix("/__capture/"), path.hasSuffix(".png") {
            let id = String(path.dropFirst("/__capture/".count).dropLast(4))
            if let png = CaptureEditors.shared.png(for: id) {
                respond(urlSchemeTask, url: url, status: 200, mime: "image/png", data: png)
            } else {
                respond(urlSchemeTask, url: url, status: 404, mime: "text/plain", data: Data("Not found".utf8))
            }
            return
        }
        let relative = String(path.drop(while: { $0 == "/" }))
        if relative.contains("..") {
            respond(urlSchemeTask, url: url, status: 403, mime: "text/plain", data: Data("Forbidden".utf8))
            return
        }
        let file = root.appendingPathComponent(relative)
        if let data = try? Data(contentsOf: file) {
            respond(urlSchemeTask, url: url, status: 200,
                    mime: Self.mimeType(for: file.pathExtension), data: data)
        } else {
            respond(urlSchemeTask, url: url, status: 404, mime: "text/plain", data: Data("Not found".utf8))
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}

    private func respond(_ task: WKURLSchemeTask, url: URL, status: Int, mime: String, data: Data) {
        let isText = mime.hasPrefix("text/") || mime == "application/json"
        let headers = [
            "Content-Type": isText ? "\(mime); charset=utf-8" : mime,
            "Content-Length": String(data.count),
            "Cache-Control": "no-store",
            "Access-Control-Allow-Origin": "*",
        ]
        if let resp = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers) {
            task.didReceive(resp)
        } else {
            task.didReceive(URLResponse(url: url, mimeType: mime, expectedContentLength: data.count, textEncodingName: nil))
        }
        task.didReceive(data)
        task.didFinish()
    }
}

/// Weak trampoline so WKUserContentController doesn't retain the panel.
@MainActor
final class ScriptMessageTrampoline: NSObject, WKScriptMessageHandler {
    private let handler: (Any) -> Void

    init(_ handler: @escaping (Any) -> Void) {
        self.handler = handler
        super.init()
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        handler(message.body)
    }
}

/// Native 6 px drag handle on the sidebar's right edge.
@MainActor
final class ResizeHandleView: NSView {
    var onResizeBegan: (() -> Void)?
    var onResize: ((CGFloat) -> Void)?   // proposed absolute width
    var onResizeEnded: (() -> Void)?
    var currentWidth: () -> CGFloat = { 280 }

    private var startX: CGFloat = 0
    private var startWidth: CGFloat = 0

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .resizeLeftRight)
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }

    override func mouseDown(with event: NSEvent) {
        startX = NSEvent.mouseLocation.x
        startWidth = currentWidth()
        onResizeBegan?()
    }

    override func mouseDragged(with event: NSEvent) {
        let dx = NSEvent.mouseLocation.x - startX
        onResize?(startWidth + dx)
    }

    override func mouseUp(with event: NSEvent) {
        onResizeEnded?()
    }
}

/// WKWebView that handles the click that also makes its (non-activating) panel key, so buttons work on
/// the first click instead of needing a second one.
final class FirstMouseWebView: WKWebView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    /// Chrome is frontmost, so Stile is never the active app and WebKit's own tracking areas
    /// (`.activeInActiveApp` / `.activeInKeyWindow`) never deliver mouseMoved/mouseEntered, which kills
    /// CSS :hover. Swap them for `.activeAlways` equivalents. Areas already `.activeAlways` are left
    /// alone, so our replacements are not re-replaced on later passes.
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        let stale: NSTrackingArea.Options = [.activeInActiveApp, .activeInKeyWindow, .activeWhenFirstResponder]
        for area in trackingAreas where !area.options.contains(.activeAlways) {
            removeTrackingArea(area)
            var options = area.options.subtracting(stale)
            options.insert(.activeAlways)
            addTrackingArea(NSTrackingArea(rect: area.rect, options: options, owner: area.owner, userInfo: area.userInfo))
        }
    }
}
