import AppKit
import ScreenCaptureKit

/// What the user picked. Rect coordinates are Quartz global points (origin at the top-left of the primary display,
/// the same space as `SCWindow.frame` and `CGDisplayBounds`), whole numbers, inside one display.
enum Selection {
    case rect(CGRect, CGDirectDisplayID)
    case window(SCWindow)
    case display(SCDisplay)
}

/// v3.5a: the shared selection overlay for screenshots (and later scrolling capture and recording).
/// One borderless transparent panel per display at `.screenSaver` level, on every Space, dims the screen and cuts out
/// the selection. Area: drag a rect (live size label, loupe at the pointer; after the drag the arrow keys nudge it and
/// Shift+arrows resize it; Return confirms). Window: the window under the pointer is highlighted, click picks it.
/// Screen: click a display. Space switches area <-> window (when allowed), Esc cancels.
///
///     SelectionOverlay.pick(mode: .area, allowModeSwitch: true) { selection in ... }   // nil = cancelled
///     let s = await SelectionOverlay.pick(mode: .window)
///
/// The overlay is gone when the completion runs. A caller that wants the target to stay visible afterwards (recording
/// before Start) keeps a `SelectionHighlight`.
@MainActor
final class SelectionOverlay {
    enum Mode { case area, window, screen }

    // MARK: Public API

    /// Shows the overlay. `completion` runs exactly once on the main actor. `confirmOnRelease` false keeps an area
    /// selection open after the drag for adjusting (arrows) until Return, even without holding Option.
    static func pick(mode: Mode, allowModeSwitch: Bool = true, confirmOnRelease: Bool = true,
                     completion: @escaping (Selection?) -> Void) {
        guard current == nil else {
            Log.write("capture: overlay already open")
            completion(nil)
            return
        }
        let o = SelectionOverlay(mode: mode, allowSwitch: allowModeSwitch && mode != .screen,
                                 confirmOnRelease: confirmOnRelease, completion: completion)
        current = o
        o.start()
    }

    static func pick(mode: Mode, allowModeSwitch: Bool = true, confirmOnRelease: Bool = true) async -> Selection? {
        await withCheckedContinuation { c in
            pick(mode: mode, allowModeSwitch: allowModeSwitch, confirmOnRelease: confirmOnRelease) { c.resume(returning: $0) }
        }
    }

    static var isActive: Bool { current != nil }

    /// Cancels an open overlay (completion gets nil).
    static func cancelCurrent() { current?.finish(nil) }

    /// The last area picked (Quartz global points), kept in state.json so Repeat Area survives a relaunch.
    /// Nil when none, or when it no longer fits on a connected display.
    static var lastRect: CGRect? {
        get {
            guard let a = HostStore.readState()["lastCaptureRect"] as? [NSNumber], a.count == 4 else { return nil }
            let r = CGRect(x: a[0].doubleValue, y: a[1].doubleValue, width: a[2].doubleValue, height: a[3].doubleValue)
            guard r.width >= 1, r.height >= 1, let id = ScreenGeometry.displayID(containing: r),
                  CGDisplayBounds(id).contains(r) else { return nil }
            return r
        }
        set {
            guard let r = newValue else { return }
            _ = HostStore.updateState(["lastCaptureRect": [r.minX, r.minY, r.width, r.height]])
        }
    }

    // MARK: State

    private static var current: SelectionOverlay?

    private var mode: Mode
    private let allowSwitch: Bool
    private let confirmOnRelease: Bool
    private var completion: ((Selection?) -> Void)?

    private var panels: [OverlayPanel] = []
    private var content: SCShareableContent?
    private var windows: [SCWindow] = []          // pickable windows, front to back
    private var backdrops: [CGDirectDisplayID: CGImage] = [:]   // screen pictures for the loupe

    // all AppKit global coordinates (bottom-left origin) unless named quartz
    fileprivate var pointer = NSEvent.mouseLocation
    fileprivate var rect: CGRect?
    fileprivate var adjusting = false
    fileprivate var dragStart: CGPoint?
    private var dragScreen: NSScreen?
    fileprivate var hoverWindow: SCWindow?
    fileprivate var hoverDisplayID: CGDirectDisplayID?
    private var screenObserver: NSObjectProtocol?

    fileprivate var currentMode: Mode { mode }

    private init(mode: Mode, allowSwitch: Bool, confirmOnRelease: Bool, completion: @escaping (Selection?) -> Void) {
        self.mode = mode
        self.allowSwitch = allowSwitch
        self.confirmOnRelease = confirmOnRelease
        self.completion = completion
    }

    // MARK: Lifecycle

    private func start() {
        for screen in NSScreen.screens {
            let p = OverlayPanel(screen: screen)
            let v = OverlayView(session: self, screen: screen)
            p.contentView = v
            p.acceptsMouseMovedEvents = true
            panels.append(p)
            p.orderFrontRegardless()
        }
        let under = ScreenGeometry.screen(at: pointer)
        (panels.first { $0.screenRef == under } ?? panels.first)?.makeKey()
        for p in panels { p.makeFirstResponder(p.contentView) }
        updateHover()
        redraw()
        screenObserver = NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification,
                                                                object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.finish(nil) }   // the layout changed under us: start over
        }
        Log.write("capture: overlay opened (\(mode))")
        Task { await loadContent() }
    }

    /// Windows to hover over and (for the loupe) a picture of each screen, fetched once the overlay is up.
    private func loadContent() async {
        do {
            let c = try await Screenshotter.shareableContent()
            guard Self.current === self else { return }
            content = c
            let order = ScreenGeometry.onScreenWindowOrder()
            windows = c.windows
                .filter { w in
                    w.windowLayer == 0 && w.isOnScreen && w.frame.width >= 24 && w.frame.height >= 24
                        && w.owningApplication?.processID != getpid()
                }
                .sorted { (order[$0.windowID] ?? Int.max) < (order[$1.windowID] ?? Int.max) }
            updateHover()
            redraw()
            if mode == .area || allowSwitch {
                for d in c.displays {
                    if let img = try? await Screenshotter.displayImage(d, content: c), Self.current === self {
                        backdrops[d.displayID] = img
                        redraw()
                    }
                }
            }
        } catch {
            Log.write("capture: overlay could not list windows: \(error.localizedDescription)")
        }
    }

    private func finish(_ selection: Selection?) {
        guard let done = completion else { return }
        completion = nil
        if let o = screenObserver { NotificationCenter.default.removeObserver(o) }
        screenObserver = nil
        for p in panels { p.orderOut(nil); p.contentView = nil }
        panels = []
        Self.current = nil
        NSCursor.arrow.set()
        if case .rect(let r, _)? = selection { Self.lastRect = r }
        Log.write("capture: overlay closed (\(selection == nil ? "cancelled" : "picked"))")
        done(selection)
    }

    private func redraw() { for p in panels { p.contentView?.needsDisplay = true } }

    // MARK: Hover

    private var pointerQuartz: CGPoint { CGPoint(x: pointer.x, y: ScreenGeometry.primaryHeight - pointer.y) }

    fileprivate func updateHover() {
        switch mode {
        case .window:
            let q = pointerQuartz
            hoverWindow = windows.first { $0.frame.contains(q) }
        case .screen:
            hoverDisplayID = ScreenGeometry.screen(at: pointer).flatMap { ScreenGeometry.displayID(of: $0) }
        case .area:
            break
        }
    }

    /// The highlighted area in AppKit global coordinates for the current mode, if any.
    fileprivate var highlightRect: CGRect? {
        switch mode {
        case .area: return rect
        case .window: return hoverWindow.map { ScreenGeometry.appKit(fromQuartz: $0.frame) }
        case .screen: return hoverDisplayID.map { ScreenGeometry.appKit(fromQuartz: CGDisplayBounds($0)) }
        }
    }

    fileprivate func backdrop(for screen: NSScreen) -> CGImage? {
        ScreenGeometry.displayID(of: screen).flatMap { backdrops[$0] }
    }

    fileprivate var hoverTitle: String? {
        guard mode == .window, let w = hoverWindow else { return nil }
        let app = w.owningApplication?.applicationName ?? ""
        let t = w.title ?? ""
        return [app, t].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    // MARK: Input (called by the views)

    fileprivate func mouseMoved(_ p: CGPoint) {
        pointer = p
        if mode != .area { updateHover() }
        redraw()
    }

    fileprivate func mouseDown(_ p: CGPoint) {
        pointer = p
        switch mode {
        case .area:
            dragStart = p
            dragScreen = ScreenGeometry.screen(at: p)
            rect = nil
            adjusting = false
        case .window:
            updateHover()
            if let w = hoverWindow { finish(.window(w)) }
        case .screen:
            updateHover()
            if let id = hoverDisplayID, let d = content?.displays.first(where: { $0.displayID == id }) { finish(.display(d)) }
        }
    }

    fileprivate func mouseDragged(_ p: CGPoint) {
        pointer = p
        guard mode == .area, let s = dragStart, let screen = dragScreen else { return }
        rect = Self.rectFrom(s, p).intersection(screen.frame)
        redraw()
    }

    fileprivate func mouseUp(_ p: CGPoint, option: Bool) {
        pointer = p
        guard mode == .area, dragStart != nil else { return }
        dragStart = nil
        guard let r = rect, r.width >= 3, r.height >= 3 else {
            rect = nil   // a click, not a drag
            redraw()
            return
        }
        if confirmOnRelease && !option { confirm() } else { adjusting = true; redraw() }
    }

    fileprivate func keyDown(_ e: NSEvent) {
        switch e.keyCode {
        case 53: finish(nil)                                   // Esc
        case 36, 76: confirm()                                 // Return / keypad Enter
        case 49:                                               // Space: area <-> window
            guard allowSwitch, dragStart == nil else { return }
            mode = mode == .area ? .window : .area
            rect = nil
            adjusting = false
            pointer = NSEvent.mouseLocation
            updateHover()
            redraw()
        case 123, 124, 125, 126:                               // arrows: nudge / (+Shift) resize the rect
            guard mode == .area, adjusting, var r = rect, let screen = ScreenGeometry.screen(at: CGPoint(x: r.midX, y: r.midY)) else { return }
            let step: CGFloat = e.modifierFlags.contains(.option) ? 10 : 1
            let (dx, dy): (CGFloat, CGFloat) = switch e.keyCode {
            case 123: (-step, 0)
            case 124: (step, 0)
            case 125: (0, -step)
            default: (0, step)
            }
            if e.modifierFlags.contains(.shift) {
                // resize, top-left corner fixed: right/up grow, left/down shrink
                let top = r.maxY
                r.size.width = max(3, r.width + dx)
                r.size.height = max(3, r.height + dy)
                r.origin.y = top - r.height
            } else {
                r.origin.x += dx
                r.origin.y += dy
            }
            let f = screen.frame
            r.size.width = min(r.width, f.width)
            r.size.height = min(r.height, f.height)
            r.origin.x = min(max(r.minX, f.minX), f.maxX - r.width)
            r.origin.y = min(max(r.minY, f.minY), f.maxY - r.height)
            rect = r
            redraw()
        default:
            break
        }
    }

    private func confirm() {
        switch mode {
        case .area:
            guard let r = rect, r.width >= 3, r.height >= 3 else { return }
            let q = ScreenGeometry.quartz(fromAppKit: r).integral
            guard let id = ScreenGeometry.displayID(containing: q) else { finish(nil); return }
            finish(.rect(q.intersection(CGDisplayBounds(id)), id))
        case .window:
            if let w = hoverWindow { finish(.window(w)) }
        case .screen:
            if let id = hoverDisplayID, let d = content?.displays.first(where: { $0.displayID == id }) { finish(.display(d)) }
        }
    }

    private static func rectFrom(_ a: CGPoint, _ b: CGPoint) -> CGRect {
        CGRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(a.x - b.x), height: abs(a.y - b.y))
    }
}

// MARK: - Panel and view

private final class OverlayPanel: NSPanel {
    let screenRef: NSScreen

    init(screen: NSScreen) {
        screenRef = screen
        super.init(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        setFrame(screen.frame, display: false)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        level = .screenSaver
        hidesOnDeactivate = false
        isReleasedWhenClosed = false
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    }

    // key, so the arrow / Return / Esc / Space keys reach us even though the app stays inactive
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

private final class OverlayView: NSView {
    unowned let session: SelectionOverlay
    let screen: NSScreen

    init(session: SelectionOverlay, screen: NSScreen) {
        self.session = session
        self.screen = screen
        super.init(frame: NSRect(origin: .zero, size: screen.frame.size))
        autoresizingMask = [.width, .height]
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.activeAlways, .mouseMoved, .mouseEnteredAndExited, .cursorUpdate, .inVisibleRect],
                                       owner: self, userInfo: nil))
    }
    required init?(coder: NSCoder) { fatalError() }

    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    private var cursor: NSCursor {
        let area = MainActor.assumeIsolated { session.currentMode == .area }
        return area ? .crosshair : .pointingHand
    }
    override func resetCursorRects() { addCursorRect(bounds, cursor: cursor) }
    override func cursorUpdate(with event: NSEvent) { cursor.set() }

    // MARK: Events (global AppKit coordinates via NSEvent.mouseLocation)

    private func point() -> CGPoint { NSEvent.mouseLocation }

    override func mouseMoved(with event: NSEvent) { cursor.set(); MainActor.assumeIsolated { session.mouseMoved(point()) } }
    override func mouseDown(with event: NSEvent) { MainActor.assumeIsolated { session.mouseDown(point()) } }
    override func mouseDragged(with event: NSEvent) { MainActor.assumeIsolated { session.mouseDragged(point()) } }
    override func mouseUp(with event: NSEvent) {
        let opt = event.modifierFlags.contains(.option)
        MainActor.assumeIsolated { session.mouseUp(point(), option: opt) }
    }
    override func keyDown(with event: NSEvent) { MainActor.assumeIsolated { session.keyDown(event) } }
    override func rightMouseDown(with event: NSEvent) { MainActor.assumeIsolated { session.keyDown(Self.escEvent) } }

    private static let escEvent: NSEvent = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: 0,
                                                            context: nil, characters: "\u{1b}", charactersIgnoringModifiers: "\u{1b}",
                                                            isARepeat: false, keyCode: 53)!

    // MARK: Drawing

    /// global AppKit rect -> this view's coordinates
    private func local(_ r: CGRect) -> CGRect { r.offsetBy(dx: -screen.frame.minX, dy: -screen.frame.minY) }

    override func draw(_ dirtyRect: NSRect) {
        MainActor.assumeIsolated { drawOverlay() }
    }

    @MainActor private func drawOverlay() {
        let s = session
        let cut = s.highlightRect.map { local($0).intersection(bounds) }.flatMap { $0.isNull || $0.isEmpty ? nil : $0 }

        // dim, with the selection cut out. The cut-out keeps a ~1% veil: a fully transparent pixel would let clicks fall
        // through to the app below instead of reaching the overlay.
        let dim = NSBezierPath(rect: bounds)
        if let cut { dim.appendRect(cut) }
        dim.windingRule = .evenOdd
        NSColor.black.withAlphaComponent(0.32).setFill()
        dim.fill()
        if let cut {
            NSColor.black.withAlphaComponent(0.01).setFill()
            cut.fill()
        }

        if let cut {
            let hovering = s.currentMode != .area
            if hovering {
                NSColor.controlAccentColor.withAlphaComponent(0.18).setFill()
                cut.fill()
            }
            let line = NSBezierPath(rect: cut.insetBy(dx: 0.5, dy: 0.5))
            line.lineWidth = hovering ? 3 : 1
            (hovering ? NSColor.controlAccentColor : NSColor.white).setStroke()
            line.stroke()
            if !hovering && s.adjusting { drawHandles(cut) }

            // size label under the rect (above when there's no room)
            if let g = s.highlightRect {
                let scale = screen.backingScaleFactor
                var text = "\(Int(g.width.rounded())) × \(Int(g.height.rounded()))"
                if scale > 1 { text += "  ·  \(Int((g.width * scale).rounded())) × \(Int((g.height * scale).rounded())) px" }
                if let t = s.hoverTitle { text = t + "  ·  " + text }
                if s.currentMode == .screen { text = "Click to capture this display  ·  " + text }
                let size = Self.labelSize(text)
                var o = CGPoint(x: cut.maxX - size.width, y: cut.minY - size.height - 6)
                if o.y < 4 { o.y = min(cut.maxY - size.height - 6, bounds.maxY - size.height - 4) }
                o.x = min(max(4, o.x), bounds.maxX - size.width - 4)
                Self.drawLabel(text, at: o)
            }
        }

        if s.currentMode == .area, !s.adjusting, NSMouseInRect(s.pointer, screen.frame, false) {
            drawLoupe()
        }
        if s.currentMode == .area, s.rect == nil {
            Self.drawHint(in: bounds, text: "Drag to select  ·  Space: window  ·  Esc: cancel")
        } else if s.currentMode == .window, s.hoverWindow == nil {
            Self.drawHint(in: bounds, text: "Click a window  ·  Space: area  ·  Esc: cancel")
        }
    }

    private func drawHandles(_ r: CGRect) {
        let pts = [CGPoint(x: r.minX, y: r.minY), CGPoint(x: r.maxX, y: r.minY), CGPoint(x: r.minX, y: r.maxY), CGPoint(x: r.maxX, y: r.maxY),
                   CGPoint(x: r.midX, y: r.minY), CGPoint(x: r.midX, y: r.maxY), CGPoint(x: r.minX, y: r.midY), CGPoint(x: r.maxX, y: r.midY)]
        for p in pts {
            let h = NSRect(x: p.x - 3, y: p.y - 3, width: 6, height: 6)
            NSColor.white.setFill(); h.fill()
            NSColor.black.withAlphaComponent(0.5).setStroke(); NSBezierPath(rect: h).stroke()
        }
    }

    /// A magnified view of the pixels around the pointer, from the screen picture taken when the overlay opened.
    @MainActor private func drawLoupe() {
        guard let img = session.backdrop(for: screen), let ctx = NSGraphicsContext.current?.cgContext else { return }
        let p = session.pointer
        let lp = CGPoint(x: p.x - screen.frame.minX, y: p.y - screen.frame.minY)
        let d: CGFloat = 112
        var o = CGPoint(x: lp.x + 22, y: lp.y - 22 - d)
        if o.x + d > bounds.maxX - 4 { o.x = lp.x - 22 - d }
        if o.y < 4 { o.y = lp.y + 22 }
        let box = CGRect(x: o.x, y: o.y, width: d, height: d)

        // source pixels: 15x15 around the pointer, in image pixels from the screen's top-left
        let scale = CGFloat(img.width) / screen.frame.width
        let cx = (lp.x * scale).rounded(.down), cy = ((bounds.height - lp.y) * scale).rounded(.down)
        let n: CGFloat = 15
        let src = CGRect(x: cx - (n - 1) / 2, y: cy - (n - 1) / 2, width: n, height: n)
        ctx.saveGState()
        ctx.addEllipse(in: box)
        ctx.clip()
        NSColor.black.setFill()
        box.fill()
        if let crop = img.cropping(to: src.intersection(CGRect(x: 0, y: 0, width: img.width, height: img.height))) {
            ctx.interpolationQuality = .none
            // keep the crop aligned when it is clipped by the screen edge
            let cell = d / n
            let clipped = src.intersection(CGRect(x: 0, y: 0, width: img.width, height: img.height))
            let dst = CGRect(x: box.minX + (clipped.minX - src.minX) * cell,
                             y: box.minY + (src.maxY - clipped.maxY) * cell,
                             width: clipped.width * cell, height: clipped.height * cell)
            ctx.draw(crop, in: dst)
        }
        // the centre pixel
        let cell = d / n
        let mid = CGRect(x: box.midX - cell / 2, y: box.midY - cell / 2, width: cell, height: cell)
        NSColor.white.setStroke()
        let m = NSBezierPath(rect: mid); m.lineWidth = 1.5; m.stroke()
        NSColor.black.withAlphaComponent(0.6).setStroke()
        let m2 = NSBezierPath(rect: mid.insetBy(dx: -1.5, dy: -1.5)); m2.lineWidth = 1; m2.stroke()
        ctx.restoreGState()
        NSColor.white.setStroke()
        let ring = NSBezierPath(ovalIn: box.insetBy(dx: 1, dy: 1)); ring.lineWidth = 2; ring.stroke()

        let q = ScreenGeometry.quartzPoint(fromAppKit: p)
        let text = "\(Int(q.x)), \(Int(q.y))"
        let size = Self.labelSize(text)
        Self.drawLabel(text, at: CGPoint(x: box.midX - size.width / 2, y: box.minY - size.height - 4))
    }

    // MARK: Text helpers

    private static let labelAttrs: [NSAttributedString.Key: Any] = [
        .font: NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .medium), .foregroundColor: NSColor.white,
    ]

    private static func labelSize(_ text: String) -> CGSize {
        let s = (text as NSString).size(withAttributes: labelAttrs)
        return CGSize(width: ceil(s.width) + 14, height: ceil(s.height) + 6)
    }

    private static func drawLabel(_ text: String, at o: CGPoint) {
        let size = labelSize(text)
        let r = CGRect(origin: o, size: size)
        NSColor.black.withAlphaComponent(0.78).setFill()
        NSBezierPath(roundedRect: r, xRadius: 5, yRadius: 5).fill()
        (text as NSString).draw(at: CGPoint(x: r.minX + 7, y: r.minY + 3), withAttributes: labelAttrs)
    }

    private static func drawHint(in b: CGRect, text: String) {
        let size = labelSize(text)
        drawLabel(text, at: CGPoint(x: b.midX - size.width / 2, y: b.maxY - 70))
    }
}

extension ScreenGeometry {
    static func quartzPoint(fromAppKit p: CGPoint) -> CGPoint { CGPoint(x: p.x, y: primaryHeight - p.y) }
}
