import AppKit
import StileCore

/// v3.7: the drawing layer over the recording's picture (exactly the video's rect). With a drawing tool, drag to add a
/// rectangle, arrow, highlight or blur box, click to type text or to drop a numbered count; with Select, click an annotation to select it, drag
/// to move it, drag its handles to reshape it, double-click text to edit it. Drawings are drawn here live with the
/// export's own renderer (`AnnotationRenderer`); blur boxes are blurred by the player's video composition, so only their
/// outline is drawn here. Only annotations showing at the current time can be seen and edited.
@MainActor
final class AnnotationCanvas: NSView, NSTextFieldDelegate {
    enum Tool: String, CaseIterable {
        case select, rect, arrow, text, highlight, blur, count
        var kind: VideoAnnotation.Kind? {
            switch self {
            case .select: return nil
            case .rect: return .rect
            case .arrow: return .arrow
            case .text: return .text
            case .highlight: return .highlight
            case .blur: return .blur
            case .count: return .count
            }
        }
    }

    var tool: Tool = .select {
        didSet { if oldValue != tool { endTextEditing(commit: true); window?.invalidateCursorRects(for: self); needsDisplay = true } }
    }
    private(set) var annotations: [VideoAnnotation] = []
    var selected: Int? { didSet { if oldValue != selected { needsDisplay = true } } }
    /// The edit the annotations sit on, and the edited-video time shown.
    var edit: EditModel? { didSet { if oldValue != edit { needsDisplay = true } } }
    var time: Double = 0 { didSet { if oldValue != time { needsDisplay = true } } }
    var videoSize = CGSize(width: 1280, height: 720) { didSet { needsDisplay = true } }
    /// Play the transitions (while the video plays and they're on); paused, everything shows fully, to edit.
    var animate = false { didSet { if oldValue != animate { needsDisplay = true } } }
    /// The transition a new annotation of a kind gets.
    var transitionFor: ((VideoAnnotation.Kind) -> VideoAnnotation.Transition)?
    /// The transition speed a new annotation of a kind gets.
    var speedFor: ((VideoAnnotation.Kind) -> VideoAnnotation.Speed)?
    /// The colour and size a new annotation of a kind gets.
    var styleFor: ((VideoAnnotation.Kind) -> (color: UInt32, size: Int))?
    /// When a new annotation shows (the recording time it starts at, and for how long) and a fresh id.
    var timesForNew: ((VideoAnnotation.Kind) -> (start: Double, length: Double))?
    var nextID: (() -> Int)?
    /// The number for a count being placed (the editor's counter moves on).
    var takeCountNumber: (() -> Int)?

    var onWillChange: (() -> Void)?
    var onChanging: (() -> Void)?
    var onCommitted: (() -> Void)?
    var onSelect: ((Int?) -> Void)?
    /// A drawing was drawn out: back to Select, like the screenshot editor (count stays for the next one).
    var onDrawn: (() -> Void)?
    /// A click on the picture with nothing to select (plays / pauses).
    var onBackgroundClick: (() -> Void)?

    private var drag: Drag?
    private var changed = false
    private var editor: NSTextField?
    private var editingID: Int?
    private enum Drag {
        case create(Int)
        case move(Int, from: CGPoint, original: VideoAnnotation)
        case handle(Int, Handle, original: VideoAnnotation)
    }
    /// rect / highlight / blur corners; arrow ends
    private enum Handle { case topLeft, topRight, bottomLeft, bottomRight, tail, tip }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("Video")
    }
    required init?(coder: NSCoder) { nil }

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    func setAnnotations(_ list: [VideoAnnotation]) {
        annotations = list
        if let s = selected, !list.contains(where: { $0.id == s }) { selected = nil }
        needsDisplay = true
    }

    private var visible: [VideoAnnotation] { annotations.filter { $0.resolved(in: edit).visible(at: time) } }

    // MARK: Geometry

    /// view points -> fractions of the video, and back
    private func frac(_ p: NSPoint) -> CGPoint {
        CGPoint(x: min(1, max(0, p.x / max(1, bounds.width))), y: min(1, max(0, p.y / max(1, bounds.height))))
    }
    private func view(_ f: CGPoint) -> NSPoint { NSPoint(x: f.x * bounds.width, y: f.y * bounds.height) }
    private var scale: CGFloat { bounds.width / max(1, videoSize.width) }

    /// An annotation's outline in view points.
    private func frame(of an: VideoAnnotation) -> NSRect {
        switch an.kind {
        case .text, .count:
            let b = AnnotationRenderer.bounds(of: an, size: videoSize)
            return NSRect(x: b.minX * scale, y: b.minY * scale, width: b.width * scale, height: b.height * scale)
        default:
            return span(of: an)
        }
    }

    /// The box its two points make, in view points.
    private func span(of an: VideoAnnotation) -> NSRect {
        let a = view(an.a), b = view(an.b)
        return NSRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(b.x - a.x), height: abs(b.y - a.y))
    }

    private func handles(of an: VideoAnnotation) -> [(Handle, NSPoint)] {
        switch an.kind {
        case .arrow: return [(.tail, view(an.a)), (.tip, view(an.b))]
        case .text, .count: return []
        default:
            let r = span(of: an)
            return [(.topLeft, NSPoint(x: r.minX, y: r.minY)), (.topRight, NSPoint(x: r.maxX, y: r.minY)),
                    (.bottomLeft, NSPoint(x: r.minX, y: r.maxY)), (.bottomRight, NSPoint(x: r.maxX, y: r.maxY))]
        }
    }

    private func hit(_ an: VideoAnnotation, _ p: NSPoint) -> Bool {
        switch an.kind {
        case .arrow:
            let a = view(an.a), b = view(an.b)
            let dx = b.x - a.x, dy = b.y - a.y, len2 = max(0.0001, dx * dx + dy * dy)
            let t = min(1, max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
            let tol = max(7, AnnotationStyle.stroke(an.size, videoSize) * scale)
            return hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)) <= tol
        case .count:
            let c = view(an.a)
            return hypot(p.x - c.x, p.y - c.y) <= AnnotationStyle.badgeRadius(an.size, videoSize) * scale + 4
        default:
            return frame(of: an).insetBy(dx: -5, dy: -5).contains(p)
        }
    }

    override func resetCursorRects() {
        switch tool {
        case .select: break
        case .text: addCursorRect(bounds, cursor: .iBeam)
        default: addCursorRect(bounds, cursor: .crosshair)
        }
    }

    // MARK: Drawing

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        let shown = visible.filter { $0.id != editingID }
        ctx.saveGState()
        ctx.scaleBy(x: scale, y: scale)
        AnnotationRenderer.draw(shown.map { $0.resolved(in: edit) }, at: time, animate: animate, in: ctx, size: videoSize)
        ctx.restoreGState()

        // blur boxes are blurred by the player; here: their outline while blurring is the tool or one is selected or
        // being drawn (frosted until it's let go and the player re-renders)
        for an in shown where an.kind == .blur && (tool == .blur || an.id == selected || isDragging(an.id)) {
            let r = frame(of: an)
            if isDragging(an.id) {
                NSColor.white.withAlphaComponent(0.35).setFill()
                r.fill()
            }
            dashed(r)
        }

        guard let id = selected, let an = shown.first(where: { $0.id == id }) else { return }
        if an.kind != .arrow { dashed(frame(of: an).insetBy(dx: -3, dy: -3)) }
        for (_, p) in handles(of: an) {
            let r = NSRect(x: p.x - 4.5, y: p.y - 4.5, width: 9, height: 9)
            NSColor.white.setFill()
            NSBezierPath(roundedRect: r, xRadius: 2, yRadius: 2).fill()
            EditorStyle.accent.setStroke()
            let b = NSBezierPath(roundedRect: r, xRadius: 2, yRadius: 2)
            b.lineWidth = 1.5
            b.stroke()
        }
    }

    private func dashed(_ r: NSRect) {
        let p = NSBezierPath(rect: r)
        p.lineWidth = 1.5
        NSColor.black.withAlphaComponent(0.5).setStroke()
        p.stroke()
        p.setLineDash([5, 4], count: 2, phase: 0)
        NSColor.white.setStroke()
        p.stroke()
    }

    private func isDragging(_ id: Int) -> Bool {
        switch drag {
        case .create(let i)?, .move(let i, _, _)?, .handle(let i, _, _)?: return i == id
        default: return false
        }
    }

    // MARK: Mouse

    override func mouseDown(with event: NSEvent) {
        endTextEditing(commit: true)
        window?.makeFirstResponder(self)
        let p = convert(event.locationInWindow, from: nil)
        changed = false
        drag = nil
        let top = visible.reversed().first { hit($0, p) }

        // the selected one's handles work with any tool (so a box just drawn can be reshaped before going back to Select)
        if tool != .select, let id = selected, let an = visible.first(where: { $0.id == id }),
           let h = handles(of: an).first(where: { hypot($0.1.x - p.x, $0.1.y - p.y) <= 8 }) {
            drag = .handle(id, h.0, original: an)
            return
        }
        if tool == .select || (tool == .text && top?.kind == .text) {
            if let id = selected, let an = visible.first(where: { $0.id == id }),
               let h = handles(of: an).first(where: { hypot($0.1.x - p.x, $0.1.y - p.y) <= 8 }) {
                drag = .handle(id, h.0, original: an)
                return
            }
            guard let an = top else {
                if selected != nil { select(nil) } else { onBackgroundClick?() }
                return
            }
            select(an.id)
            if an.kind == .text && (event.clickCount == 2 || tool == .text) { return beginTextEditing(an) }
            drag = .move(an.id, from: p, original: an)
            return
        }
        guard let kind = tool.kind, let id = nextID?() else { return }
        let style = styleFor?(kind) ?? (color: AnnotationStyle.defaultColor, size: 1)
        let times = timesForNew?(kind) ?? (start: edit?.source(atSequence: time) ?? time, length: 4)
        let f = frac(p)
        let an = VideoAnnotation(id: id, kind: kind, a: f, b: f, color: style.color, size: style.size, start: times.start, length: times.length,
                                 transition: transitionFor?(kind) ?? .fade, speed: speedFor?(kind) ?? .normal)
        if kind == .text { return beginTextEditing(an, isNew: true) }
        if kind == .count {
            // a click drops it, numbered from the editor's counter; the drag that follows places it
            var an = an
            willChange()   // the undo step is taken before the counter moves, so undo restores it
            an.number = takeCountNumber?() ?? VideoAnnotation.nextNumber(in: annotations)
            annotations.append(an)
            select(id)
            drag = .move(id, from: p, original: an)
            needsDisplay = true
            return
        }
        drag = .create(id)
        pending = an
    }

    /// A new drawing, added on its first drag (a click without one adds nothing).
    private var pending: VideoAnnotation?
    /// A new text, added when typing ends with some text.
    private var pendingText: VideoAnnotation?

    override func mouseDragged(with event: NSEvent) {
        guard let d = drag else { return }
        let p = convert(event.locationInWindow, from: nil)
        let f = frac(p)
        switch d {
        case .create(let id):
            if var an = pending {
                willChange()
                an.b = f
                annotations.append(an)
                pending = nil
                select(id)
            } else if let k = index(id) {
                annotations[k].b = f
            }
        case .move(let id, let from, let original):
            guard let k = index(id), hypot(p.x - from.x, p.y - from.y) >= 2 || changed else { return }
            willChange()
            annotations[k] = original.moved(by: CGVector(dx: (p.x - from.x) / max(1, bounds.width), dy: (p.y - from.y) / max(1, bounds.height)))
        case .handle(let id, let h, let original):
            guard let k = index(id) else { return }
            willChange()
            var an = original
            let box = original.box
            switch h {
            case .tail: an.a = f
            case .tip: an.b = f
            case .topLeft: an.a = f; an.b = CGPoint(x: box.maxX, y: box.maxY)
            case .topRight: an.a = CGPoint(x: box.minX, y: f.y); an.b = CGPoint(x: f.x, y: box.maxY)
            case .bottomLeft: an.a = CGPoint(x: f.x, y: box.minY); an.b = CGPoint(x: box.maxX, y: f.y)
            case .bottomRight: an.a = CGPoint(x: box.minX, y: box.minY); an.b = f
            }
            annotations[k] = an
        }
        needsDisplay = true
        onChanging?()
    }

    override func mouseUp(with event: NSEvent) {
        let d = drag
        drag = nil
        pending = nil
        // a drawing too small to see is dropped
        if case .create(let id)? = d, let k = index(id) {
            let an = annotations[k], r = span(of: an)
            let line = an.kind == .arrow
            if (line && hypot(r.width, r.height) < 6) || (!line && (r.width < 4 || r.height < 4)) {
                annotations.remove(at: k)
                select(nil)
            }
        }
        needsDisplay = true
        if changed {
            changed = false
            onCommitted?()
        }
        if case .create(let id)? = d, index(id) != nil, tool != .count { onDrawn?() }
    }

    private func index(_ id: Int) -> Int? { annotations.firstIndex { $0.id == id } }

    private func willChange() {
        guard !changed else { return }
        changed = true
        onWillChange?()
    }

    private func select(_ id: Int?) {
        selected = id
        onSelect?(id)
    }

    /// Changes from the properties bar (colour, size) or Delete: through the same undo / commit path.
    func update(_ id: Int, _ f: (inout VideoAnnotation) -> Void) {
        guard let k = index(id) else { return }
        var an = annotations[k]
        f(&an)
        guard an != annotations[k] else { return }
        onWillChange?()
        annotations[k] = an
        needsDisplay = true
        onCommitted?()
    }

    func delete(_ id: Int) {
        guard let k = index(id) else { return }
        onWillChange?()
        annotations.remove(at: k)
        if selected == id { select(nil) }
        needsDisplay = true
        onCommitted?()
    }

    // MARK: Text

    private func beginTextEditing(_ an: VideoAnnotation, isNew: Bool = false) {
        let fs = AnnotationStyle.font(an.size, videoSize) * scale
        let field = NSTextField()
        field.isBordered = false
        field.drawsBackground = true
        field.backgroundColor = NSColor.black.withAlphaComponent(0.35)
        field.focusRingType = .none
        field.font = .systemFont(ofSize: fs, weight: .bold)
        field.textColor = NSColor(cgColor: AnnotationStyle.cgColor(an.color)) ?? .white
        field.stringValue = an.text
        field.placeholderString = "Text"
        field.delegate = self
        field.cell?.isScrollable = true
        let o = view(an.a)
        field.frame = NSRect(x: o.x, y: o.y, width: max(160, frame(of: an).width + fs * 2), height: fs * 1.4)
        addSubview(field)
        if isNew { pendingText = an }
        editingID = an.id
        editor = field
        window?.makeFirstResponder(field)
        needsDisplay = true
    }

    func controlTextDidChange(_ obj: Notification) {
        guard let f = editor else { return }
        let w = (f.stringValue as NSString).size(withAttributes: [.font: f.font!]).width + (f.font?.pointSize ?? 14) * 2
        f.frame.size.width = max(160, min(bounds.width - f.frame.minX, w))
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy sel: Selector) -> Bool {
        if sel == #selector(NSResponder.cancelOperation(_:)) { endTextEditing(commit: false); return true }
        if sel == #selector(NSResponder.insertNewline(_:)) { endTextEditing(commit: true); return true }
        return false
    }

    func controlTextDidEndEditing(_ obj: Notification) { endTextEditing(commit: true) }

    /// Puts the typed text in (a new text annotation is added only now, and only when something was typed).
    func endTextEditing(commit: Bool) {
        guard let f = editor, let id = editingID else { return }
        editor = nil
        editingID = nil
        let text = f.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        f.delegate = nil
        f.removeFromSuperview()
        window?.makeFirstResponder(self)
        defer { pendingText = nil; needsDisplay = true }
        guard commit else { return }
        if var an = pendingText, an.id == id {
            guard !text.isEmpty else { return }
            onWillChange?()
            an.text = text
            annotations.append(an)
            select(id)
            onCommitted?()
        } else if let k = index(id) {
            if text.isEmpty { delete(id) } else if annotations[k].text != text { update(id) { $0.text = text } }
        }
    }

    var isEditingText: Bool { editor != nil }
}
