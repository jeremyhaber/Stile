import AppKit
import ScreenCaptureKit

/// v3.5a: a click-through outline around a screen rect, a window or a whole display. The selection overlay disappears
/// once a target is picked; callers that need the target to stay visible (recording before Start and while recording,
/// scrolling capture) keep one of these. It lives in this app, so SCK captures exclude it.
/// All rects are Quartz global points (top-left origin), like `Selection.rect`.
@MainActor
final class SelectionHighlight {
    enum Style { case solid, dashed }
    enum Tint {
        case accent, red, amber
        var color: NSColor {
            switch self {
            case .accent: return .controlAccentColor
            case .red: return NSColor(srgbRed: 0.92, green: 0.18, blue: 0.16, alpha: 1)
            case .amber: return NSColor(srgbRed: 0.97, green: 0.66, blue: 0.10, alpha: 1)
            }
        }
    }

    var tint: Tint { didSet { view.needsDisplay = true } }
    var style: Style { didSet { view.needsDisplay = true } }
    let lineWidth: CGFloat

    private let panel: NSPanel
    private let view: HighlightView
    private var timer: Timer?
    private var trackedWindow: CGWindowID?
    private var shown: CGRect?   // Quartz

    init(tint: Tint = .accent, style: Style = .solid, lineWidth: CGFloat = 3) {
        self.tint = tint
        self.style = style
        self.lineWidth = lineWidth
        view = HighlightView()
        panel = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .screenSaver
        panel.ignoresMouseEvents = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.contentView = view
        view.owner = self
    }

    /// Outlines a rect (drawn just outside it, so the stroke is not part of the picked area).
    func show(rect: CGRect) {
        stopTracking()
        place(rect, inside: false)
    }

    /// Outlines the edge of a display (drawn inside it: there is no room outside).
    func show(displayID: CGDirectDisplayID) {
        stopTracking()
        place(CGDisplayBounds(displayID), inside: true)
    }

    /// Outlines a window and follows it as it moves or resizes; hides while it is minimised or off screen.
    func show(window: SCWindow) {
        stopTracking()
        trackedWindow = window.windowID
        place(window.frame, inside: false)
        timer = Timer.scheduledTimer(withTimeInterval: 0.08, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
    }

    func hide() {
        stopTracking()
        shown = nil
        panel.orderOut(nil)
    }

    private func tick() {
        guard let id = trackedWindow else { return }
        guard let f = ScreenGeometry.frame(ofWindow: id) else {
            panel.orderOut(nil)   // minimised / closed: keep polling in case it comes back
            shown = nil
            return
        }
        if f != shown || !panel.isVisible { place(f, inside: false) }
    }

    private func stopTracking() {
        timer?.invalidate()
        timer = nil
        trackedWindow = nil
    }

    private func place(_ quartz: CGRect, inside: Bool) {
        shown = quartz
        var r = ScreenGeometry.appKit(fromQuartz: quartz)
        if !inside { r = r.insetBy(dx: -lineWidth, dy: -lineWidth) }
        view.inside = inside
        panel.setFrame(r, display: false)
        view.needsDisplay = true
        panel.orderFrontRegardless()
    }

    private final class HighlightView: NSView {
        weak var owner: SelectionHighlight?
        var inside = false
        override var isFlipped: Bool { true }
        override func draw(_ dirtyRect: NSRect) {
            guard let o = owner else { return }
            let w = o.lineWidth
            let path = NSBezierPath(rect: bounds.insetBy(dx: w / 2, dy: w / 2))
            path.lineWidth = w
            if o.style == .dashed { path.setLineDash([8, 5], count: 2, phase: 0) }
            o.tint.color.setStroke()
            path.stroke()
        }
    }
}
