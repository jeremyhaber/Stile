import AppKit

/// What the header view is asked to do for a click (set by the OverlayController).
@MainActor
final class TopBarView: NSView, NSViewToolTipOwner {
    // Model (all frames in view coordinates: top-left origin, equal to window-relative AX points).
    var bg: NSColor = .windowBackgroundColor { didSet { needsDisplay = true } }
    var dark = false { didSet { needsDisplay = true } }
    /// Chrome frontmost and this its focused window; otherwise the lights are grey.
    var active = true { didSet { needsDisplay = true } }
    /// Close, minimize, zoom frames (empty when Chrome's buttons could not be read).
    var lights: [CGRect] = [] { didSet { needsDisplay = true } }
    var toggleRect: CGRect? { didSet { needsDisplay = true; refreshToolTip() } }
    /// The window is in our Fill state: the zoom glyph shows inward arrows.
    var fillGlyph = false { didSet { needsDisplay = true } }
    /// Top-left corner radius (Chrome's window corner); 0 in full screen.
    var cornerRadius: CGFloat = 10 { didSet { needsDisplay = true } }

    var onClose: (() -> Void)?
    var onMinimize: (() -> Void)?
    /// Zoom click; the flag is true when Option was held.
    var onZoom: ((Bool) -> Void)?
    /// Hover (0.6 s) or click-and-hold on the zoom button: the controller builds the menu.
    var menuProvider: (() -> (NSMenu, [AnyObject]))?
    var onToggle: (() -> Void)?
    /// Mouse-down on empty header space (true for the second click of a double-click).
    var onWindowDrag: ((Bool) -> Void)?
    var toggleTip: (() -> String)?
    /// Any left mouse-down on the header (before it is handled): the controller focuses the window.
    var onMouseDown: (() -> Void)?

    private enum Hit { case light(Int), toggle, empty }

    private var hoverLights = false
    private var hoverToggle = false
    private var pressedLight: Int?
    private var pressedToggle = false
    private var menuOpen = false
    private var holdFired = false
    private let hoverTimer = OneShot()
    private let holdTimer = OneShot()
    private var toolTipTag: NSView.ToolTipTag?

    override var isFlipped: Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for a in trackingAreas { removeTrackingArea(a) }
        addTrackingArea(NSTrackingArea(rect: .zero,
                                       options: [.mouseEnteredAndExited, .mouseMoved, .activeAlways, .inVisibleRect],
                                       owner: self, userInfo: nil))
    }

    // MARK: Hit testing

    private var lightsHoverRect: CGRect? {
        guard let first = lights.first else { return nil }
        return lights.dropFirst().reduce(first) { $0.union($1) }.insetBy(dx: -4, dy: -4)
    }

    private func hit(_ p: NSPoint) -> Hit {
        for (i, f) in lights.enumerated() {
            let r = max(8, min(f.width, f.height) / 2)
            if hypot(p.x - f.midX, p.y - f.midY) <= r { return .light(i) }
        }
        if let t = toggleRect, t.contains(p) { return .toggle }
        return .empty
    }

    private func updateHover(_ p: NSPoint?) {
        var lightsNow = false, toggleNow = false
        var overZoom = false
        if let p = p {
            lightsNow = lightsHoverRect?.contains(p) ?? false
            if case .toggle = hit(p) { toggleNow = true }
            if case .light(2) = hit(p) { overZoom = true }
        }
        if lightsNow != hoverLights || toggleNow != hoverToggle {
            hoverLights = lightsNow
            hoverToggle = toggleNow
            needsDisplay = true
        }
        if overZoom, !menuOpen, !hoverTimer.isScheduled {
            hoverTimer.schedule(after: 0.6) { [weak self] in
                self?.hoverTimer.clear()
                self?.openMenu()
            }
        } else if !overZoom {
            hoverTimer.cancel()
        }
    }

    func resetInteraction() {
        hoverTimer.cancel()
        holdTimer.cancel()
        hoverLights = false
        hoverToggle = false
        pressedLight = nil
        pressedToggle = false
        needsDisplay = true
    }

    override func mouseEntered(with event: NSEvent) { updateHover(convert(event.locationInWindow, from: nil)) }
    override func mouseMoved(with event: NSEvent) { updateHover(convert(event.locationInWindow, from: nil)) }
    override func mouseExited(with event: NSEvent) { updateHover(nil) }

    // MARK: Clicks

    override func mouseDown(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        holdFired = false
        onMouseDown?()
        switch hit(p) {
        case .light(let i):
            pressedLight = i
            needsDisplay = true
            if i == 2 {
                hoverTimer.cancel()
                holdTimer.schedule(after: 0.5) { [weak self] in
                    guard let self = self else { return }
                    self.holdTimer.clear()
                    self.holdFired = true
                    self.openMenu()
                }
            }
        case .toggle:
            pressedToggle = true
            needsDisplay = true
        case .empty:
            onWindowDrag?(event.clickCount >= 2)
        }
    }

    override func mouseUp(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        holdTimer.cancel()
        let light = pressedLight
        let toggle = pressedToggle
        pressedLight = nil
        pressedToggle = false
        needsDisplay = true
        if holdFired { holdFired = false; return }
        if let i = light, case .light(let j) = hit(p), i == j {
            switch i {
            case 0: onClose?()
            case 1: onMinimize?()
            default: onZoom?(event.modifierFlags.contains(.option))
            }
        } else if toggle, case .toggle = hit(p) {
            onToggle?()
        }
    }

    private func openMenu() {
        guard !menuOpen, let provider = menuProvider, lights.count == 3 else { return }
        let (menu, keepAlive) = provider()
        let z = lights[2]
        menuOpen = true
        needsDisplay = true
        menu.popUp(positioning: nil, at: NSPoint(x: z.minX - 2, y: z.maxY + 6), in: self)   // returns when closed
        _ = keepAlive
        menuOpen = false
        pressedLight = nil
        holdTimer.cancel()
        needsDisplay = true
    }

    // MARK: Tooltip

    private func refreshToolTip() {
        if let t = toolTipTag { removeToolTip(t); toolTipTag = nil }
        if let r = toggleRect { toolTipTag = addToolTip(r, owner: self, userData: nil) }
    }

    func view(_ view: NSView, stringForToolTip tag: NSView.ToolTipTag, point: NSPoint,
              userData data: UnsafeMutableRawPointer?) -> String {
        toggleTip?() ?? ""
    }

    // MARK: Drawing

    private static let fills: [NSColor] = [
        NSColor(srgbRed: 1.0, green: 0.373, blue: 0.341, alpha: 1),     // #FF5F57
        NSColor(srgbRed: 0.996, green: 0.737, blue: 0.180, alpha: 1),   // #FEBC2E
        NSColor(srgbRed: 0.157, green: 0.784, blue: 0.251, alpha: 1),   // #28C840
    ]
    private static let borders: [NSColor] = [
        NSColor(srgbRed: 0.878, green: 0.267, blue: 0.243, alpha: 1),   // #E0443E
        NSColor(srgbRed: 0.871, green: 0.631, blue: 0.137, alpha: 1),   // #DEA123
        NSColor(srgbRed: 0.102, green: 0.671, blue: 0.161, alpha: 1),   // #1AAB29
    ]

    override func draw(_ dirtyRect: NSRect) {
        bg.setFill()
        let b = bounds
        if cornerRadius > 0 {
            // Only the top-left corner is rounded (Chrome's window corner); the view is flipped, so y = 0 is the top.
            let r = cornerRadius
            let path = NSBezierPath()
            path.move(to: NSPoint(x: b.minX + r, y: b.minY))
            path.line(to: NSPoint(x: b.maxX, y: b.minY))
            path.line(to: NSPoint(x: b.maxX, y: b.maxY))
            path.line(to: NSPoint(x: b.minX, y: b.maxY))
            path.line(to: NSPoint(x: b.minX, y: b.minY + r))
            path.appendArc(withCenter: NSPoint(x: b.minX + r, y: b.minY + r), radius: r, startAngle: 180, endAngle: 270)
            path.close()
            path.fill()
        } else {
            b.fill()
        }

        let showGlyphs = hoverLights || menuOpen
        for (i, f) in lights.prefix(3).enumerated() {
            let rect = NSRect(x: f.midX - 6, y: f.midY - 6, width: 12, height: 12)
            var fill: NSColor
            var border: NSColor
            // Like macOS, hovering lights up an inactive window's buttons too.
            if active || showGlyphs {
                fill = Self.fills[i]
                border = Self.borders[i]
            } else {
                fill = dark ? NSColor(srgbRed: 0.302, green: 0.302, blue: 0.302, alpha: 1)
                            : NSColor(srgbRed: 0.867, green: 0.867, blue: 0.867, alpha: 1)
                border = (dark ? NSColor.white : NSColor.black).withAlphaComponent(0.12)
            }
            if pressedLight == i {
                fill = ColorParse.mix(fill, .black, amount: 0.15)
                border = ColorParse.mix(border, .black, amount: 0.15)
            }
            fill.setFill()
            NSBezierPath(ovalIn: rect).fill()
            border.setStroke()
            let ring = NSBezierPath(ovalIn: rect.insetBy(dx: 0.25, dy: 0.25))
            ring.lineWidth = 0.5
            ring.stroke()
            if showGlyphs { drawGlyph(i, center: NSPoint(x: f.midX, y: f.midY)) }
        }

        if let t = toggleRect {
            if hoverToggle || pressedToggle {
                let a: CGFloat = pressedToggle ? 0.14 : 0.08
                (dark ? NSColor.white : NSColor.black).withAlphaComponent(a).setFill()
                NSBezierPath(roundedRect: t, xRadius: 6, yRadius: 6).fill()
            }
            if let img = toggleImage() {
                let s = img.size
                img.draw(in: NSRect(x: t.midX - s.width / 2, y: t.midY - s.height / 2, width: s.width, height: s.height),
                         from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
            }
        }
    }

    private func toggleImage() -> NSImage? {
        let cfg = NSImage.SymbolConfiguration(pointSize: 16, weight: .regular)
        guard let base = NSImage(systemSymbolName: "sidebar.left", accessibilityDescription: "Sidebar")?
            .withSymbolConfiguration(cfg) else { return nil }
        let color = (dark ? NSColor.white : NSColor.black).withAlphaComponent(dark ? 0.78 : 0.62)
        let out = NSImage(size: base.size, flipped: false) { r in
            base.draw(in: r)
            color.set()
            r.fill(using: .sourceAtop)
            return true
        }
        return out
    }

    private func drawGlyph(_ i: Int, center c: NSPoint) {
        let ink = NSColor(white: 0.1, alpha: 0.6)
        ink.setStroke()
        ink.setFill()
        switch i {
        case 0:
            let p = NSBezierPath()
            p.lineWidth = 1.2
            p.lineCapStyle = .round
            p.move(to: NSPoint(x: c.x - 2.6, y: c.y - 2.6)); p.line(to: NSPoint(x: c.x + 2.6, y: c.y + 2.6))
            p.move(to: NSPoint(x: c.x - 2.6, y: c.y + 2.6)); p.line(to: NSPoint(x: c.x + 2.6, y: c.y - 2.6))
            p.stroke()
        case 1:
            let p = NSBezierPath()
            p.lineWidth = 1.2
            p.lineCapStyle = .round
            p.move(to: NSPoint(x: c.x - 3, y: c.y)); p.line(to: NSPoint(x: c.x + 3, y: c.y))
            p.stroke()
        default:
            // Right triangles in the upper-right and lower-left; right angle outward (enter) or inward (Fill state).
            func tri(_ corner: NSPoint, _ dx: CGFloat, _ dy: CGFloat) {
                let p = NSBezierPath()
                p.move(to: corner)
                p.line(to: NSPoint(x: corner.x + dx, y: corner.y))
                p.line(to: NSPoint(x: corner.x, y: corner.y + dy))
                p.close()
                p.fill()
            }
            if fillGlyph {
                tri(NSPoint(x: c.x + 0.7, y: c.y - 0.7), 3.2, -3.2)
                tri(NSPoint(x: c.x - 0.7, y: c.y + 0.7), -3.2, 3.2)
            } else {
                tri(NSPoint(x: c.x + 3.4, y: c.y - 3.4), -3.6, 3.6)
                tri(NSPoint(x: c.x - 3.4, y: c.y + 3.4), 3.6, -3.6)
            }
        }
    }
}

/// v3.1: the native header drawn over Chrome's vertical-tabs header (own traffic lights, sidebar toggle,
/// draggable empty space). Non-activating, never key, so Chrome keeps focus; all geometry comes from the
/// OverlayController.
@MainActor
final class TopBarPanel: NSPanel {
    let bar = TopBarView(frame: .zero)

    init() {
        super.init(contentRect: NSRect(x: 0, y: 0, width: 200, height: 40),
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
        acceptsMouseMovedEvents = true
        bar.autoresizingMask = [.width, .height]
        contentView = bar
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    func hide() {
        bar.resetInteraction()
        orderOut(nil)
    }
}
