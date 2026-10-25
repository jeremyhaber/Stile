import AppKit
import ScreenCaptureKit
import UniformTypeIdentifiers

/// v3.5a: screenshots of any app, from the menu bar or the global hot keys (Shottr-like). Our own selection overlay
/// (`Capture/SelectionOverlay.swift`) does the picking and ScreenCaptureKit (`Capture/Screenshotter.swift`) takes the
/// picture, so we know which rect / window was chosen (Repeat Area, and later scrolling capture and recording). The
/// picture opens in the app's editor window (`CaptureEditors`) and also goes to the extension, in base64 parts (native
/// messages to Chrome are limited to 1 MB), for its recent captures. The editor works without Chrome; upload needs the
/// S3 settings the extension pushes (`captureConfig`).
@MainActor
final class ScreenCapturer {
    enum Mode: String {
        case screen, area, window, activeWindow, repeatArea, delayed, openFile, clipboard, scrolling

        /// The mode name sent to the extension's recent captures and shown in the editor (v3.5c: the real mode).
        var metaMode: String {
            switch self {
            case .openFile: return "file"
            case .scrolling: return "scroll"
            default: return rawValue
            }
        }
    }

    /// The profile the picture belongs to (the focused Chrome window's, else any): settings and recent captures.
    var bridgeFor: () -> ProfileBridge? = { nil }

    private var running = false
    private var scrollSession: ScrollCapture?
    private let countdown = CountdownBadge()
    private static let partSize = 700_000   // base64 characters per message (a multiple of 4)

    /// Menu item enabling: does the pasteboard hold a picture?
    static var clipboardHasImage: Bool {
        NSPasteboard.general.canReadObject(forClasses: [NSImage.self], options: nil)
    }

    func capture(_ mode: Mode) {
        guard !running, !SelectionOverlay.isActive else { return }
        switch mode {
        case .openFile: openFile(); return
        case .clipboard: loadClipboard(); return
        default: break
        }
        if !Permissions.screenCaptureGranted {
            // Without Screen Recording, ScreenCaptureKit has nothing to give us.
            Log.write("capture: Screen Recording not granted; asking")
            if !Permissions.requestScreenCapture() {
                NotificationCenter.default.post(name: .sidebarReviewPermissions, object: nil)
                return
            }
        }
        running = true
        // The frontmost app now, before the overlay or a delay changes anything: it names the picture.
        let front = NSWorkspace.shared.frontmostApplication
        Log.write("capture: \(mode.rawValue) started")
        switch mode {
        case .screen:
            takeScreen(mode, app: front?.localizedName ?? "")
        case .delayed:
            countdown.run(seconds: 3) { [weak self] in
                guard let self else { return }
                self.takeScreen(mode, app: front?.localizedName ?? "")
            }
        case .area:
            SelectionOverlay.pick(mode: .area, allowModeSwitch: true) { [weak self] sel in
                self?.handle(sel, mode: mode, app: front?.localizedName ?? "")
            }
        case .window:
            SelectionOverlay.pick(mode: .window, allowModeSwitch: true) { [weak self] sel in
                self?.handle(sel, mode: mode, app: front?.localizedName ?? "")
            }
        case .repeatArea:
            guard let r = SelectionOverlay.lastRect, let id = ScreenGeometry.displayID(containing: r) else {
                Log.write("capture: no area to repeat; picking one")
                running = false
                capture(.area)
                return
            }
            handle(.rect(r, id), mode: mode, app: front?.localizedName ?? "")
        case .activeWindow:
            Task { await takeActiveWindow(front) }
        case .scrolling:
            // v3.5b: pick an area, scroll, stitch (Capture/ScrollCapture.swift); the result takes the usual path
            let session = ScrollCapture()
            scrollSession = session
            Task {
                let r = await session.run()
                scrollSession = nil
                guard let r else { running = false; return }
                finished(.scrolling, result: r, app: front?.localizedName ?? "")
            }
        case .openFile, .clipboard:
            break
        }
    }

    // MARK: Taking the picture

    private func takeScreen(_ mode: Mode, app: String) {
        // the display under the pointer
        let id = ScreenGeometry.screen(at: NSEvent.mouseLocation).flatMap { ScreenGeometry.displayID(of: $0) } ?? CGMainDisplayID()
        Task {
            do {
                let content = try await Screenshotter.shareableContent()
                guard let d = Screenshotter.display(id, in: content) ?? content.displays.first else { throw ScreenshotError.noDisplay }
                let r = try await Screenshotter.display(d)
                finished(mode, result: r, app: app)
            } catch {
                fail(mode, error)
            }
        }
    }

    private func takeActiveWindow(_ front: NSRunningApplication?) async {
        do {
            let content = try await Screenshotter.shareableContent()
            let order = ScreenGeometry.onScreenWindowOrder()
            // the frontmost app's frontmost normal window (Stile itself never counts)
            guard let app = front, app.processIdentifier != getpid() else { throw ScreenshotError.noWindow }
            let w = content.windows
                .filter { $0.owningApplication?.processID == app.processIdentifier && $0.windowLayer == 0 && $0.isOnScreen
                    && $0.frame.width >= 24 && $0.frame.height >= 24 }
                .min { (order[$0.windowID] ?? Int.max) < (order[$1.windowID] ?? Int.max) }
            guard let w else { throw ScreenshotError.noWindow }
            let r = try await Screenshotter.window(w, shadow: Settings.captureWindowShadow)
            finished(.activeWindow, result: r, app: app.localizedName ?? "")
        } catch {
            fail(.activeWindow, error)
        }
    }

    private func handle(_ sel: Selection?, mode: Mode, app: String) {
        guard let sel else {
            running = false
            Log.write("capture: \(mode.rawValue) cancelled")
            return
        }
        // let the overlay panels leave the screen before SCK looks (they are excluded anyway; this just keeps timing sane)
        Task {
            do {
                let r: ScreenshotResult
                var title = app
                switch sel {
                case .rect(let rect, let id):
                    r = try await Screenshotter.rect(rect, displayID: id)
                case .window(let w):
                    r = try await Screenshotter.window(w, shadow: Settings.captureWindowShadow)
                    title = w.owningApplication?.applicationName ?? app
                case .display(let d):
                    r = try await Screenshotter.display(d)
                }
                finished(mode, result: r, app: title)
            } catch {
                fail(mode, error)
            }
        }
    }

    private func fail(_ mode: Mode, _ error: Error) {
        running = false
        Log.write("capture: \(mode.rawValue) failed: \(error.localizedDescription)")
        if mode == .activeWindow {
            NSSound.beep()
        }
    }

    // MARK: Open image / clipboard

    private func openFile() {
        running = true
        // the panel needs the app active to take keys; the editor window brings it forward anyway afterwards
        NSApp.activate()
        let panel = NSOpenPanel()
        panel.title = "Open Image"
        panel.allowedContentTypes = [.image]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        let ok = panel.runModal() == .OK
        guard ok, let url = panel.url, let data = try? Data(contentsOf: url) else {
            running = false
            Log.write("capture: open image cancelled")
            return
        }
        guard let png = Self.pngData(from: data) else {
            running = false
            Log.write("capture: open image: not a readable picture")
            return
        }
        finished(.openFile, png: png, app: url.deletingPathExtension().lastPathComponent)
    }

    private func loadClipboard() {
        guard let img = NSPasteboard.general.readObjects(forClasses: [NSImage.self], options: nil)?.first as? NSImage,
              let tiff = img.tiffRepresentation, let png = Self.pngData(from: tiff) else {
            Log.write("capture: clipboard holds no picture")
            return
        }
        running = true
        finished(.clipboard, png: png, app: "Clipboard")
    }

    /// PNG bytes for any readable image data (PNG passes through unchanged).
    private static func pngData(from data: Data) -> Data? {
        if data.starts(with: [0x89, 0x50, 0x4E, 0x47]) { return data }
        guard let rep = NSBitmapImageRep(data: data) else { return nil }
        return rep.representation(using: .png, properties: [:])
    }

    // MARK: After the picture

    private func finished(_ mode: Mode, result: ScreenshotResult, app: String) {
        finished(mode, png: result.png, app: app, dpr: result.dpr, size: (result.width, result.height))
    }

    /// Opens the editor and sends the picture to the extension's recent captures. `dpr` and `size` are read from the
    /// PNG when not given (opened files, clipboard: a Retina screenshot file is 144 dpi, so pixels / points is the scale).
    private func finished(_ mode: Mode, png data: Data, app: String, dpr givenDpr: Double? = nil, size: (Int, Int)? = nil) {
        running = false
        let rep = NSBitmapImageRep(data: data)
        var dpr = givenDpr ?? 1.0
        if givenDpr == nil, let rep, rep.size.width > 0 {
            dpr = (Double(rep.pixelsWide) / Double(rep.size.width) * 100).rounded() / 100
        }
        let id = "app" + UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(16).lowercased()
        let (w, h) = size ?? (rep?.pixelsWide ?? 0, rep?.pixelsHigh ?? 0)
        let meta: [String: Any] = [
            "id": id, "time": Int(Date().timeIntervalSince1970 * 1000), "url": "", "title": app, "mode": mode.metaMode,
            "width": w, "height": h, "dpr": dpr, "note": "", "link": "",
        ]
        let bridge = bridgeFor().flatMap { $0.closed ? nil : $0 }
        CaptureEditors.shared.open(CaptureDocument(id: id, png: data, meta: meta, config: CaptureSettings.shared.editorConfig(sidebarColor: bridge?.captureConfig["sidebarColor"]),
                                                   theme: nil, bridge: bridge))
        guard let bridge else {
            Log.write("capture: \(mode.rawValue) opened in the editor (no extension connected: not in recent captures)")
            return
        }
        // also into the profile's recent captures (the extension doesn't open its own editor: `open: false`)
        let b64 = data.base64EncodedString()
        let parts = max(1, (b64.count + Self.partSize - 1) / Self.partSize)
        var start = b64.startIndex
        for part in 0..<parts {
            let end = b64.index(start, offsetBy: Self.partSize, limitedBy: b64.endIndex) ?? b64.endIndex
            bridge.sendToExt([
                "type": "nativeCapture", "id": id, "part": part, "parts": parts, "data": String(b64[start..<end]),
                "mode": mode.metaMode, "title": app, "dpr": dpr, "open": false,
            ])
            start = end
        }
        Log.write("capture: \(mode.rawValue) opened in the editor and sent to recent captures (\(data.count) bytes, \(parts) parts, dpr \(dpr))")
    }
}

/// The "3, 2, 1" badge near the pointer for Delayed Screenshot. A tiny click-through panel; it belongs to this app, so the
/// picture never contains it.
@MainActor
private final class CountdownBadge {
    private var panel: NSPanel?
    private var timer: Timer?

    func run(seconds: Int, done: @escaping () -> Void) {
        let label = NSTextField(labelWithString: "\(seconds)")
        label.font = .monospacedDigitSystemFont(ofSize: 28, weight: .semibold)
        label.textColor = .white
        label.alignment = .center
        label.frame = NSRect(x: 0, y: 14, width: 64, height: 36)
        let box = NSView(frame: NSRect(x: 0, y: 0, width: 64, height: 64))
        box.wantsLayer = true
        box.layer?.backgroundColor = NSColor.black.withAlphaComponent(0.78).cgColor
        box.layer?.cornerRadius = 16
        box.addSubview(label)
        let p = NSPanel(contentRect: box.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = false
        p.level = .screenSaver
        p.ignoresMouseEvents = true
        p.isReleasedWhenClosed = false
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        p.contentView = box
        let m = NSEvent.mouseLocation
        p.setFrameOrigin(NSPoint(x: m.x + 18, y: m.y - 18 - 64))
        p.orderFrontRegardless()
        panel = p

        var left = seconds
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] t in
            MainActor.assumeIsolated {
                guard let self else { t.invalidate(); return }
                left -= 1
                if left > 0 {
                    label.stringValue = "\(left)"
                    return
                }
                t.invalidate()
                self.timer = nil
                self.panel?.orderOut(nil)
                self.panel = nil
                // a beat for the badge to leave the screen (SCK excludes it anyway)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { done() }
            }
        }
    }
}
