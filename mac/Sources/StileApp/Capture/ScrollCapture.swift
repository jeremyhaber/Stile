import AppKit
import CoreMedia
import ScreenCaptureKit
import StileCore

/// v3.5b: scrolling capture of any app. The user picks an area, then it scrolls by itself; an `SCStream` on that display
/// (sourceRect = the area, ~15 fps) feeds changed frames to the pure `ScrollStitcher` (`StileCore`) on a background queue.
/// Auto-scroll (needs Accessibility) parks the pointer in the area and posts pixel scroll-wheel events at a steady pace; it
/// pauses (and then slows down) while a frame can't be matched, since the stitcher keeps comparing against the last matched
/// frame and scrolling on would carry the page out of its search range for good. It finishes by itself once the picture
/// stops growing (the end of the content), or gives up after a few seconds of unmatched frames,
/// and hands over to manual scrolling as soon as the user moves the pointer. Without Accessibility the user scrolls. A small
/// floating bar beside the area shows the live height with Done / Cancel and flashes "Scroll slower" when a manually
/// scrolled frame could not be matched. Return / Done / Esc keep what was captured, Cancel discards, and a 30 000 px cap
/// finishes by itself. Chrome pages are better served by "Capture Full Chrome Page" (exact, no stitching).
@MainActor
final class ScrollCapture {
    private let highlight = SelectionHighlight()
    private var bar: ScrollBar?
    private var stream: SCStream?
    private var sink: FrameSink?
    private var localMonitor: Any?
    private var globalMonitor: Any?
    private var pointsWide: CGFloat = 0
    private var finished = false
    private var continuation: CheckedContinuation<ScreenshotResult?, Never>?
    private var height = 0
    // auto-scroll
    private var autoTimer: Timer?
    private var scrollPoint = CGPoint.zero   // Quartz points, the middle of the area
    private var step: CGFloat = 0            // points per tick
    private var lastGrowth = Date()
    private var unmatchedSince: Date?       // set while frames can't be matched; scrolling is paused meanwhile
    private static let tick: TimeInterval = 0.1
    private static let endAfter: TimeInterval = 2.0   // no new rows for this long = the end of the content
    private static let giveUpAfter: TimeInterval = 4.0   // still unmatched after this long = stop with what we have

    /// Runs the whole flow. Nil when cancelled or nothing was captured.
    func run() async -> ScreenshotResult? {
        guard case .rect(let rect, let id)? = await SelectionOverlay.pick(mode: .area, allowModeSwitch: false, confirmOnRelease: false) else {
            Log.write("capture: scrolling cancelled")
            return nil
        }
        do {
            try await startStream(rect: rect, displayID: id)
        } catch {
            Log.write("capture: scrolling failed to start: \(error.localizedDescription)")
            teardown()
            return nil
        }
        highlight.show(rect: rect)
        let bar = ScrollBar(onDone: { [weak self] in self?.finish(keep: true) }, onCancel: { [weak self] in self?.finish(keep: false) })
        bar.place(besideQuartz: rect)
        self.bar = bar
        installKeyMonitors()
        if Permissions.isTrusted { startAutoScroll(rect: rect) }
        Log.write("capture: scrolling started on \(Int(rect.width))x\(Int(rect.height)) pt, auto-scroll \(autoTimer != nil ? "on" : "off")")
        return await withCheckedContinuation { c in continuation = c }
    }

    // MARK: Stream

    private func startStream(rect: CGRect, displayID: CGDirectDisplayID) async throws {
        let content = try await Screenshotter.shareableContent()
        guard let d = Screenshotter.display(displayID, in: content) else { throw ScreenshotError.noDisplay }
        // our own windows (overlay, outline, the bar) stay out of the frames
        let filter = SCContentFilter(display: d, excludingApplications: Screenshotter.ownApplications(in: content), exceptingWindows: [])
        let scale = CGFloat(filter.pointPixelScale)
        let bounds = CGDisplayBounds(displayID)
        let local = rect.offsetBy(dx: -bounds.minX, dy: -bounds.minY).intersection(CGRect(origin: .zero, size: bounds.size))
        guard !local.isNull, local.width >= 8, local.height >= 8 else { throw ScreenshotError.noDisplay }
        let cfg = SCStreamConfiguration()
        cfg.sourceRect = local
        cfg.width = max(1, Int((local.width * scale).rounded()))
        cfg.height = max(1, Int((local.height * scale).rounded()))
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: 15)
        cfg.pixelFormat = kCVPixelFormatType_32BGRA
        cfg.showsCursor = false
        cfg.queueDepth = 4
        pointsWide = local.width
        let sink = FrameSink { [weak self] outcome, height in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.frameProcessed(outcome, height: height) } }
        } onStop: { [weak self] error in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.streamStopped(error) } }
        }
        let s = SCStream(filter: filter, configuration: cfg, delegate: sink)
        try s.addStreamOutput(sink, type: .screen, sampleHandlerQueue: sink.queue)
        try await s.startCapture()
        stream = s
        self.sink = sink
    }

    private func frameProcessed(_ outcome: ScrollStitcher.Outcome, height h: Int) {
        guard !finished else { return }
        height = h
        switch outcome {
        case .skipped:
            if autoTimer != nil {
                if unmatchedSince == nil { unmatchedSince = Date(); step = max(8, (step * 0.7).rounded()) }
            } else {
                bar?.flash("Scroll slower")
            }
        case .capReached:
            Log.write("capture: scrolling reached the height cap (\(h) px)")
            finish(keep: true)
        case .started, .appended, .prepended:
            if unmatchedSince != nil { unmatchedSince = nil; lastGrowth = Date() }   // resuming: the pause doesn't count
            // .appended(0) is a match with no new rows (the page didn't move, or something animated in place): not progress
            if outcome != .appended(0) && outcome != .prepended(0) { lastGrowth = Date() }
            bar?.setHeight(h)
        case .unchanged:
            break
        }
    }

    private func streamStopped(_ error: Error) {
        guard !finished else { return }
        Log.write("capture: scrolling stream stopped: \(error.localizedDescription)")
        finish(keep: true)
    }

    // MARK: Auto-scroll

    /// Scroll events go to the window under the pointer, so the pointer is parked in the middle of the area. About 0.8 of
    /// the area's height per second keeps each 15 fps frame well inside the stitcher's search range.
    private func startAutoScroll(rect: CGRect) {
        scrollPoint = CGPoint(x: rect.midX, y: rect.midY)
        step = max(8, (rect.height * 0.08).rounded())
        CGWarpMouseCursorPosition(scrollPoint)
        bar?.auto = true
        // give the stream a first frame of the starting position before anything moves
        lastGrowth = Date().addingTimeInterval(0.4)
        autoTimer = Timer.scheduledTimer(withTimeInterval: Self.tick, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.autoTick() }
        }
        autoTimer?.fireDate = Date().addingTimeInterval(0.4)
    }

    private func autoTick() {
        guard !finished else { return }
        // the user grabbed the pointer: stop and let them scroll (or click Done)
        if let p = CGEvent(source: nil)?.location, hypot(p.x - scrollPoint.x, p.y - scrollPoint.y) > 4 {
            Log.write("capture: auto-scroll handed over to the user")
            stopAutoScroll()
            return
        }
        if let since = unmatchedSince {
            if Date().timeIntervalSince(since) > Self.giveUpAfter {
                Log.write("capture: auto-scroll gave up: frames stopped matching (something on the page changed in place)")
                finish(keep: true)
            }
            return   // wait for the page to settle; the next matching frame resumes scrolling
        }
        if Date().timeIntervalSince(lastGrowth) > Self.endAfter {
            Log.write("capture: auto-scroll reached the end")
            finish(keep: true)
            return
        }
        let e = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: -Int32(step), wheel2: 0, wheel3: 0)
        e?.location = scrollPoint
        e?.post(tap: .cghidEventTap)
    }

    private func stopAutoScroll() {
        autoTimer?.invalidate()
        autoTimer = nil
        bar?.auto = false
    }

    // MARK: Keys

    /// Return = Done, Esc = Done (or cancel when nothing scrolled). The bar never takes focus (the user is scrolling in
    /// another app), so the global monitor catches the keys there; it needs Accessibility, like the rest of Stile.
    private func installKeyMonitors() {
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] e in
            guard let self, self.handleKey(e.keyCode) else { return e }
            return nil
        }
        globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] e in
            let code = e.keyCode
            DispatchQueue.main.async { MainActor.assumeIsolated { _ = self?.handleKey(code) } }
        }
    }

    private func handleKey(_ code: UInt16) -> Bool {
        switch code {
        case 36, 76: finish(keep: true); return true
        case 53: finish(keep: true); return true
        default: return false
        }
    }

    // MARK: Finish

    private func finish(keep: Bool) {
        guard !finished else { return }
        finished = true
        let s = stream, sink = sink
        teardown()
        Task {
            try? await s?.stopCapture()
            guard keep, let sink, let (image, frames) = sink.result() else {
                Log.write("capture: scrolling discarded")
                continuation?.resume(returning: nil)
                continuation = nil
                return
            }
            guard frames > 1 else {
                // never scrolled: nothing to stitch
                Log.write("capture: scrolling ended without any scrolling")
                continuation?.resume(returning: nil)
                continuation = nil
                return
            }
            let wide = pointsWide
            let result = await Task.detached(priority: .userInitiated) { try? Screenshotter.encode(image, pointsWide: wide) }.value
            Log.write("capture: scrolling done, \(image.width)x\(image.height) px from \(frames) frames")
            continuation?.resume(returning: result)
            continuation = nil
        }
    }

    private func teardown() {
        stopAutoScroll()
        if let m = localMonitor { NSEvent.removeMonitor(m); localMonitor = nil }
        if let m = globalMonitor { NSEvent.removeMonitor(m); globalMonitor = nil }
        highlight.hide()
        bar?.close()
        bar = nil
    }
}

// MARK: - Frame sink (background queue)

/// Receives SCStream frames on its own serial queue, copies them and runs the stitcher there; only the outcome goes back to
/// the main thread. `stitcher` is touched on `queue` only (and by `result()` through `queue.sync`).
private final class FrameSink: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    let queue = DispatchQueue(label: "stile.scrollcapture", qos: .userInitiated)
    private var stitcher = ScrollStitcher()
    private let onFrame: (ScrollStitcher.Outcome, Int) -> Void
    private let onStop: (Error) -> Void
    private var colorSpace: CGColorSpace?

    init(onFrame: @escaping (ScrollStitcher.Outcome, Int) -> Void, onStop: @escaping (Error) -> Void) {
        self.onFrame = onFrame
        self.onStop = onStop
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let raw = attachments.first?[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete,
              let buffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        guard CVPixelBufferGetPixelFormatType(buffer) == kCVPixelFormatType_32BGRA else { return }
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        let frame = CVPixelBufferGetBaseAddress(buffer).map {
            PixelFrame(bgra: $0, width: CVPixelBufferGetWidth(buffer), height: CVPixelBufferGetHeight(buffer),
                       bytesPerRow: CVPixelBufferGetBytesPerRow(buffer))
        }
        CVPixelBufferUnlockBaseAddress(buffer, .readOnly)
        guard let frame else { return }
        if colorSpace == nil, let cs = CVImageBufferGetColorSpace(buffer)?.takeUnretainedValue() { colorSpace = cs }
        let outcome = stitcher.add(frame)
        if outcome != .unchanged { onFrame(outcome, stitcher.height) }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) { onStop(error) }

    /// The stitched picture and the number of frames used.
    func result() -> (CGImage, Int)? {
        queue.sync {
            guard let img = stitcher.finish()?.makeCGImage(colorSpace: colorSpace) else { return nil }
            return (img, stitcher.frameCount)
        }
    }
}

// MARK: - The bar

/// "Auto-scrolling · 1 240 px   [Done] [Cancel]" ("Scroll to capture" when the user scrolls): a non-activating panel beside the area, so the app being scrolled
/// keeps focus. It belongs to this app, so the stream excludes it.
@MainActor
private final class ScrollBar {
    private let panel: NSPanel
    private let label = NSTextField(labelWithString: "Scroll to capture")
    private let onDone: () -> Void
    private let onCancel: () -> Void
    private var flashTimer: Timer?
    private var heightText = ""
    var auto = false { didSet { if flashTimer == nil { showText() } } }

    init(onDone: @escaping () -> Void, onCancel: @escaping () -> Void) {
        self.onDone = onDone
        self.onCancel = onCancel
        label.font = .systemFont(ofSize: 12, weight: .medium)
        label.textColor = .white
        label.lineBreakMode = .byClipping
        label.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let done = Self.button("Done", #selector(doneTapped), prominent: true)
        let cancel = Self.button("Cancel", #selector(cancelTapped), prominent: false)
        let stack = NSStackView(views: [label, done, cancel])
        stack.orientation = .horizontal
        stack.spacing = 8
        stack.edgeInsets = NSEdgeInsets(top: 8, left: 12, bottom: 8, right: 10)
        let box = NSVisualEffectView()
        box.material = .hudWindow
        box.appearance = NSAppearance(named: .vibrantDark)
        box.state = .active
        box.wantsLayer = true
        box.layer?.cornerRadius = 10
        box.layer?.masksToBounds = true
        stack.translatesAutoresizingMaskIntoConstraints = false
        box.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: box.leadingAnchor), stack.trailingAnchor.constraint(equalTo: box.trailingAnchor),
            stack.topAnchor.constraint(equalTo: box.topAnchor), stack.bottomAnchor.constraint(equalTo: box.bottomAnchor),
            label.widthAnchor.constraint(greaterThanOrEqualToConstant: 150),
        ])
        panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 320, height: 40), styleMask: [.borderless, .nonactivatingPanel],
                        backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = .screenSaver
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.contentView = box
        box.layoutSubtreeIfNeeded()
        panel.setContentSize(box.fittingSize)
        done.target = self
        cancel.target = self
    }

    private static func button(_ title: String, _ action: Selector, prominent: Bool) -> NSButton {
        let b = NSButton(title: title, target: nil, action: action)
        b.bezelStyle = .rounded
        b.controlSize = .small
        if prominent { b.bezelColor = .controlAccentColor }
        return b
    }

    @objc private func doneTapped() { onDone() }
    @objc private func cancelTapped() { onCancel() }

    /// Beside the area (Quartz points): to the right if it fits on that screen, else the left, else below / above, clamped.
    func place(besideQuartz rect: CGRect) {
        let area = ScreenGeometry.appKit(fromQuartz: rect)
        let size = panel.frame.size
        let screen = ScreenGeometry.screen(at: CGPoint(x: area.midX, y: area.midY))?.visibleFrame ?? area
        let gap: CGFloat = 12
        var origin = CGPoint(x: area.maxX + gap, y: area.maxY - size.height)
        if origin.x + size.width > screen.maxX {
            origin.x = area.minX - gap - size.width
            if origin.x < screen.minX {
                origin = CGPoint(x: area.midX - size.width / 2, y: area.minY - gap - size.height)
                if origin.y < screen.minY { origin.y = area.maxY + gap }
            }
        }
        origin.x = min(max(origin.x, screen.minX + 4), screen.maxX - size.width - 4)
        origin.y = min(max(origin.y, screen.minY + 4), screen.maxY - size.height - 4)
        panel.setFrameOrigin(origin)
        panel.orderFrontRegardless()
    }

    func setHeight(_ px: Int) {
        let f = NumberFormatter()
        f.numberStyle = .decimal
        heightText = f.string(from: NSNumber(value: px)) ?? "\(px)"
        if flashTimer == nil { showText() }
    }

    func flash(_ text: String) {
        label.stringValue = text
        label.textColor = NSColor(srgbRed: 0.97, green: 0.66, blue: 0.10, alpha: 1)
        flashTimer?.invalidate()
        flashTimer = Timer.scheduledTimer(withTimeInterval: 1.2, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.flashTimer = nil
                self?.showText()
            }
        }
    }

    private func showText() {
        label.textColor = .white
        let verb = auto ? "Auto-scrolling" : "Scroll to capture"
        label.stringValue = heightText.isEmpty ? verb : "\(verb) · \(heightText) px"
    }

    func close() {
        flashTimer?.invalidate()
        panel.orderOut(nil)
        panel.close()
    }
}
