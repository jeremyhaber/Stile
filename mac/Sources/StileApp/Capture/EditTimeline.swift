import AppKit
import StileCore

/// v3.7: the recording editor's timeline, Premiere-style (replaces 3.6's trim timeline). The top track is the edited
/// video: each clip is a block with its filmstrip; Split cuts the clip under the playhead in two, and deleting a clip
/// closes the gap (ripple delete). A red mark on a clip's edge marks removed footage: drag that edge out to bring it
/// back (an edge can always be dragged in to trim). Below, lanes of annotation bars (greedily packed, one bar per
/// annotation): drag a bar to move when it shows, its ends to change how long (at least 0.25 s). Times on screen are
/// sequence time (the edited video); an annotation keeps the recording time of the frame it starts on, which
/// `VideoAnnotation.resolved(in:)` maps to one unbroken stretch (its `length` is edited-video time).
///
/// v3.8: drag a clip's middle to put it anywhere in the row (a line shows where it goes); the time ruler above the clips
/// moves the playhead (click or drag; so does the empty space and a click on a clip).
///
/// v3.9: the Cut tool (C): over the clips the pointer is a pair of scissors and a line shows where the cut goes; a click
/// cuts the clip there. Within `CutSnap.distance` of the playhead the line snaps onto it (⌥ turns that off). Each cut also
/// has a bow-tie marker for its transition (see `drawSeams`); crossfades overlap clips, which `EditModel` accounts for in
/// `sequenceStart(of:)`.
///
/// The ruler and clips are fixed; the annotation lanes sit in a scroll view under them that shows at most `maxLanes`
/// lanes and scrolls beyond. `LanesView` draws the bars and hands mouse events back here, so one x mapping serves both
/// and geometry stays in "unscrolled" space (`pt(_:)` undoes the scroll).
@MainActor
final class EditTimeline: NSView {
    private(set) var edit = EditModel(duration: 0)
    private(set) var annotations: [VideoAnnotation] = []
    private(set) var selectedClip: Int? { didSet { if oldValue != selectedClip { needsDisplay = true; onSelectClip?(selectedClip) } } }
    var selectedAnnotation: Int? { didSet { if oldValue != selectedAnnotation { needsDisplay = true; revealSelected() } } }
    /// Sequence time.
    var playhead: Double = 0 { didSet { if oldValue != playhead { needsDisplay = true; lanesView.needsDisplay = true } } }
    /// Evenly spaced frames of the whole recording (nil = not generated yet).
    var thumbnails: [CGImage?] = [] { didSet { needsDisplay = true } }
    var aspect: CGFloat = 16 / 9 { didSet { needsDisplay = true } }
    var isEnabled = true { didSet { alphaValue = isEnabled ? 1 : 0.5 } }
    /// The Cut tool: clicks on clips cut them.
    var cutMode = false { didSet { if oldValue != cutMode { hover = nil; hoverSeam = nil; cutX = nil; cutSnapped = false; window?.invalidateCursorRects(for: self); needsDisplay = true } } }
    private var cutX: CGFloat? { didSet { if oldValue != cutX { needsDisplay = true } } }
    /// The hover line is snapped onto the playhead (a click then cuts exactly at the playhead, like S).
    private var cutSnapped = false { didSet { if oldValue != cutSnapped { needsDisplay = true } } }
    private var lastCutPointer: CGFloat?

    /// Where a pointer at `px` cuts: the playhead when within the snap distance (unless ⌥ is held), else under the pointer.
    private func cutPoint(_ px: CGFloat, option: Bool) -> (x: CGFloat, snapped: Bool) {
        let hx = x(playhead)
        if CutSnap.snaps(pointerX: Double(px), playheadX: Double(hx), disabled: option) { return (hx, true) }
        return (px, false)
    }
    override func flagsChanged(with event: NSEvent) {
        super.flagsChanged(with: event)
        if cutMode, let px = lastCutPointer, cutX != nil { let c = cutPoint(px, option: event.modifierFlags.contains(.option)); cutX = c.x; cutSnapped = c.snapped }
    }

    /// Show this sequence time in the player.
    var onScrub: ((Double) -> Void)?
    /// A gesture is about to change the edit or an annotation (the owner takes an undo snapshot).
    var onWillChange: (() -> Void)?
    /// Live, while dragging.
    var onChanging: (() -> Void)?
    /// A gesture that changed something ended.
    var onCommitted: (() -> Void)?
    var onSelectClip: ((Int?) -> Void)?
    var onSelectAnnotation: ((Int?) -> Void)?
    /// Right-click menu actions the owner carries out (so they go through its undo).
    /// nil = at the playhead (what S does).
    var onSplit: ((Double?) -> Void)?
    var onDeleteClip: ((Int) -> Void)?
    var onDeleteAnnotation: ((Int) -> Void)?
    /// v3.9: the style chosen for the seam before clip `i` (nil: the edit-wide style again); the owner puts it through undo.
    var onSeamStyle: ((Int, CutTransition.Style?) -> Void)?

    private let rulerH: CGFloat = 16
    private let clipH: CGFloat = 44
    private let laneH: CGFloat = 17
    private let laneGap: CGFloat = 3
    /// Lanes shown before the area scrolls.
    private let maxLanes = 4
    private let scroll = NSScrollView()
    private let lanesView = LanesView()
    private let pad: CGFloat = 2
    private let edgeHit: CGFloat = 6
    private var lanes: [Int: Int] = [:]
    private var laneCount = 0
    private var drag: Drag?
    private var dragX: CGFloat = 0
    private var changed = false
    /// While an edge is dragged the scale stays put (the edited length changes under the pointer).
    private var frozenLength: Double?
    /// Left-edge drags: clips from `index` on are drawn `delta` seconds later, so the edge follows the pointer; the gap
    /// closes on release.
    private var displayShift: (index: Int, delta: Double)?
    private var hover: (clip: Int, edge: EditModel.Edge)? { didSet { needsDisplay = true } }
    /// The seam (before clip i) the pointer is near: its marker shows even when transitions are off.
    private var hoverSeam: Int? { didSet { if oldValue != hoverSeam { needsDisplay = true } } }

    private enum Drag {
        case scrub
        /// a clip's middle: a click selects it and moves the playhead; past 4 pt it's picked up to go elsewhere (`gap`)
        case clip(Int, downX: CGFloat, moved: Bool, gap: Int?)
        case clipEdge(Int, EditModel.Edge, downX: CGFloat, sourceAtDown: Double)
        /// `grab`: seconds (sequence time) from the bar's left end to the pointer when it was grabbed
        case annBody(Int, grab: Double, downX: CGFloat, moved: Bool)
        case annEdge(Int, EditModel.Edge)
    }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("Timeline")
        lanesView.timeline = self
        scroll.documentView = lanesView
        scroll.drawsBackground = false
        scroll.borderType = .noBorder
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = false
        scroll.scrollerStyle = .overlay
        scroll.autohidesScrollers = true
        scroll.verticalScrollElasticity = .none
        scroll.contentView.drawsBackground = false
        scroll.contentView.postsBoundsChangedNotifications = true
        NotificationCenter.default.addObserver(self, selector: #selector(lanesScrolled), name: NSView.boundsDidChangeNotification, object: scroll.contentView)
        addSubview(scroll)
        layoutLanes()
    }
    deinit { NotificationCenter.default.removeObserver(self) }
    @objc private func lanesScrolled() { lanesView.window?.invalidateCursorRects(for: lanesView) }
    required init?(coder: NSCoder) { nil }

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override var needsDisplay: Bool { didSet { if needsDisplay { lanesView.needsDisplay = true } } }
    override var toolTip: String? { didSet { lanesView.toolTip = toolTip } }

    /// Height of `n` lanes with the 6 pt top margin.
    private func lanesHeight(_ n: Int) -> CGFloat { n > 0 ? 6 + CGFloat(n) * (laneH + laneGap) - laneGap : 0 }

    override var intrinsicContentSize: NSSize {
        NSSize(width: NSView.noIntrinsicMetric, height: pad + rulerH + clipH + lanesHeight(min(laneCount, maxLanes)) + pad)
    }

    override func layout() {
        super.layout()
        layoutLanes()
    }

    /// The scroll view fills the lanes area under the clips; its document is as tall as all the lanes.
    private func layoutLanes() {
        let top = pad + rulerH + clipH
        scroll.frame = NSRect(x: 0, y: top, width: bounds.width, height: lanesHeight(min(laneCount, maxLanes)))
        lanesView.frame = NSRect(x: 0, y: 0, width: bounds.width, height: lanesHeight(laneCount))
        scroll.isHidden = laneCount == 0
        window?.invalidateCursorRects(for: lanesView)
    }

    /// Scroll the selected annotation's lane into view.
    private func revealSelected() {
        guard let id = selectedAnnotation, let an = annotations.first(where: { $0.id == id }), let r = barRect(an) else { return }
        lanesView.scrollToVisible(r.offsetBy(dx: 0, dy: -track.maxY).insetBy(dx: 0, dy: -laneGap))
    }

    /// An event's position in unscrolled timeline space (lane y as if the lanes area weren't scrolled).
    private func pt(_ event: NSEvent) -> NSPoint {
        var p = convert(event.locationInWindow, from: nil)
        if p.y >= track.maxY { p.y += scroll.contentView.bounds.origin.y }
        return p
    }

    // MARK: Model in

    func setEdit(_ e: EditModel) {
        edit = e
        if let i = selectedClip, !e.clips.indices.contains(i) { selectedClip = nil }
        changedLayout()
    }

    func setAnnotations(_ list: [VideoAnnotation]) {
        annotations = list
        if drag == nil { assignLanes() }
        changedLayout()
        revealSelected()
    }

    func select(clip i: Int?) { selectedClip = i.flatMap { edit.clips.indices.contains($0) ? $0 : nil } }

    private func changedLayout() {
        needsDisplay = true
        window?.invalidateCursorRects(for: self)
        window?.invalidateCursorRects(for: lanesView)
        setAccessibilityValueDescription("\(edit.clips.count) clip\(edit.clips.count == 1 ? "" : "s"), \(RecordingMath.preciseTimer(edit.length)) long"
            + (annotations.isEmpty ? "" : ", \(annotations.count) annotation\(annotations.count == 1 ? "" : "s")"))
    }

    /// Where an annotation shows in the edited video (sequence time).
    private func span(_ an: VideoAnnotation) -> ClosedRange<Double> {
        let r = an.resolved(in: edit)
        return r.start...max(r.start, r.end)
    }

    /// Greedy lanes in order of when they show: an annotation takes the first lane free over its whole span.
    private func assignLanes() {
        var ends: [Double] = []
        lanes = [:]
        let spans = annotations.map { an -> (VideoAnnotation, Double, Double) in
            let r = span(an)
            return (an, r.lowerBound, r.upperBound)
        }
        for (an, s, e) in spans.sorted(by: { ($0.1, $0.0.id) < ($1.1, $1.0.id) }) {
            if let l = ends.firstIndex(where: { $0 <= s + 0.001 }) { lanes[an.id] = l; ends[l] = e }
            else { lanes[an.id] = ends.count; ends.append(e) }
        }
        if ends.count != laneCount {
            laneCount = ends.count
            invalidateIntrinsicContentSize()
            layoutLanes()
        }
    }

    // MARK: Geometry

    private var ruler: NSRect { NSRect(x: track.minX, y: pad, width: track.width, height: rulerH) }
    private var track: NSRect { NSRect(x: bounds.minX + edgeHit, y: pad + rulerH, width: max(1, bounds.width - edgeHit * 2), height: clipH) }
    private var scaleLength: Double { max(0.001, frozenLength ?? edit.length) }

    private func x(_ seq: Double) -> CGFloat { track.minX + track.width * CGFloat(seq / scaleLength) }
    private func seq(_ x: CGFloat) -> Double { Double((x - track.minX) / track.width) * scaleLength }
    private var secondsPerPoint: Double { scaleLength / Double(track.width) }

    private func shift(_ i: Int) -> Double { displayShift.map { i >= $0.index ? $0.delta : 0 } ?? 0 }

    private func clipRect(_ i: Int) -> NSRect {
        let s = edit.sequenceStart(of: i) + shift(i), c = edit.clips[i]
        let x0 = x(s), x1 = x(s + c.length)
        return NSRect(x: x0, y: track.minY, width: max(2, x1 - x0), height: clipH)
    }

    /// The bar of an annotation.
    private func barRect(_ an: VideoAnnotation) -> NSRect? {
        guard let lane = lanes[an.id] else { return nil }
        let y = track.maxY + 6 + CGFloat(lane) * (laneH + laneGap), r = span(an)
        return NSRect(x: x(r.lowerBound), y: y, width: max(6, x(r.upperBound) - x(r.lowerBound)), height: laneH)
    }

    // MARK: Transition markers

    /// The middle of seam `i`'s transition (a crossfade's overlap, else the cut itself).
    private func seamX(_ i: Int) -> CGFloat { x(edit.sequenceStart(of: i) + shift(i) + edit.overlap(ofSeam: i) / 2) }
    private var showsSeamMarkers: Bool {
        edit.clips.count > 1 && (edit.transitionStyle != .none || edit.clips.indices.contains { edit.hasSeamOverride($0) })
    }
    private func seamVisible(_ i: Int) -> Bool { showsSeamMarkers || hoverSeam == i }
    private func seamBadge(_ i: Int) -> NSRect { NSRect(x: seamX(i) - 7, y: track.minY + 3, width: 14, height: 14) }
    private func seamHit(_ p: NSPoint) -> Int? {
        guard edit.clips.count > 1, displayShift == nil, frozenLength == nil else { return nil }
        return (1..<edit.clips.count).first { seamVisible($0) && seamBadge($0).insetBy(dx: -2, dy: -2).contains(p) }
    }
    private func seamNear(_ p: NSPoint) -> Int? {
        guard edit.clips.count > 1, p.y >= track.minY - 2, p.y <= track.maxY + 2 else { return nil }
        return (1..<edit.clips.count).first { abs(p.x - seamX($0)) <= 10 }
    }

    /// The choices for seam `i`: the edit-wide style, or one of its own.
    private func seamMenuItems(_ i: Int) -> [NSMenuItem] {
        var items: [NSMenuItem] = []
        let general = ActionItem("Same as Edit (\(edit.transitionStyle.name))") { [weak self] in self?.onSeamStyle?(i, nil) }
        general.state = edit.hasSeamOverride(i) ? .off : .on
        items.append(general)
        items.append(.separator())
        for st in CutTransition.Style.allCases {
            let item = ActionItem(st.name) { [weak self] in self?.onSeamStyle?(i, st) }
            item.state = edit.hasSeamOverride(i) && edit.seamStyle(i) == st ? .on : .off
            items.append(item)
        }
        return items
    }

    private func showSeamMenu(_ i: Int) {
        let menu = NSMenu()
        menu.autoenablesItems = false
        seamMenuItems(i).forEach { menu.addItem($0) }
        let b = seamBadge(i)
        menu.popUp(positioning: nil, at: NSPoint(x: b.minX, y: b.maxY + 4), in: self)
    }

    private func drawSeams(ctx: CGContext) {
        guard edit.clips.count > 1 else { return }
        for i in 1..<edit.clips.count {
            let st = edit.seamStyle(i), d = edit.transitionDuration(ofSeam: i)
            if d > 0 {   // the stretch of the timeline the transition covers
                let s0 = edit.sequenceStart(of: i) + shift(i)
                let a = st.overlaps ? s0 : s0 - d / 2, b = st.overlaps ? s0 + d : s0 + d / 2
                let r = NSRect(x: x(a), y: track.minY, width: max(2, x(b) - x(a)), height: clipH)
                (st == .dipWhite ? NSColor.white.withAlphaComponent(0.5) : st == .dipBlack ? NSColor.black.withAlphaComponent(0.55)
                    : NSColor.white.withAlphaComponent(0.28)).setFill()
                r.intersection(track).fill()
            }
            guard seamVisible(i) else { continue }
            let r = seamBadge(i), c = NSPoint(x: r.midX, y: r.midY)
            let active = d > 0
            let fill: NSColor = !active ? NSColor.black.withAlphaComponent(0.55) : st == .dipWhite ? .white : st == .dipBlack ? .black : EditorStyle.accent
            fill.setFill()
            NSBezierPath(roundedRect: r, xRadius: 4, yRadius: 4).fill()
            let edgeColor = NSColor.white.withAlphaComponent(active ? 0.9 : 0.6)
            edgeColor.setStroke()
            let outline = NSBezierPath(roundedRect: r.insetBy(dx: 0.5, dy: 0.5), xRadius: 4, yRadius: 4)
            outline.lineWidth = 1
            outline.stroke()
            // a bow tie: two clips meeting
            let glyph = NSBezierPath()
            glyph.move(to: NSPoint(x: c.x - 4, y: c.y - 3.5)); glyph.line(to: NSPoint(x: c.x, y: c.y)); glyph.line(to: NSPoint(x: c.x - 4, y: c.y + 3.5)); glyph.close()
            glyph.move(to: NSPoint(x: c.x + 4, y: c.y - 3.5)); glyph.line(to: NSPoint(x: c.x, y: c.y)); glyph.line(to: NSPoint(x: c.x + 4, y: c.y + 3.5)); glyph.close()
            if active {
                (st == .dipWhite ? NSColor.black : NSColor.white).setFill()
                glyph.fill()
            } else {
                glyph.lineWidth = 1
                glyph.stroke()
            }
        }
    }

    /// The x of gap `k` (before clip `k`; `count`: the end).
    private func gapX(_ k: Int) -> CGFloat { k < edit.clips.count ? clipRect(k).minX : x(edit.length) }

    /// The gap nearest `px` a picked-up clip `i` would go to (nil: where it is).
    private func gap(for i: Int, at px: CGFloat) -> Int? {
        let k = (0...edit.clips.count).min { abs(gapX($0) - px) < abs(gapX($1) - px) } ?? i
        return k == i || k == i + 1 ? nil : k
    }

    override func resetCursorRects() {
        addCursorRect(ruler, cursor: .pointingHand)
        if cutMode {
            addCursorRect(NSRect(x: track.minX, y: track.minY - 2, width: x(edit.length) - track.minX, height: clipH + 4), cursor: Self.scissors)
            return
        }
        for i in edit.clips.indices {
            let r = clipRect(i)
            addCursorRect(r.insetBy(dx: edgeHit, dy: 0), cursor: .openHand)
            addCursorRect(NSRect(x: r.minX - edgeHit / 2, y: r.minY, width: edgeHit, height: r.height), cursor: .resizeLeftRight)
            addCursorRect(NSRect(x: r.maxX - edgeHit / 2, y: r.minY, width: edgeHit, height: r.height), cursor: .resizeLeftRight)
        }
        if showsSeamMarkers && edit.clips.count > 1 { for i in 1..<edit.clips.count { addCursorRect(seamBadge(i), cursor: .pointingHand) } }
    }

    /// The bars' cursors, in the lanes view's own space (AppKit clips them to what's scrolled into view).
    fileprivate func addBarCursors(to v: NSView) {
        for an in annotations {
            guard let r = barRect(an)?.offsetBy(dx: 0, dy: -track.maxY) else { continue }
            v.addCursorRect(r.insetBy(dx: 5, dy: 0), cursor: .openHand)
            v.addCursorRect(NSRect(x: r.minX - 2, y: r.minY, width: 7, height: r.height), cursor: .resizeLeftRight)
            v.addCursorRect(NSRect(x: r.maxX - 5, y: r.minY, width: 7, height: r.height), cursor: .resizeLeftRight)
        }
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for t in trackingAreas { removeTrackingArea(t) }
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self))
    }
    override func mouseMoved(with event: NSEvent) {
        if cutMode {
            let p = pt(event)
            lastCutPointer = p.x
            if p.y >= track.minY - 2 && p.y <= track.maxY + 2 && p.x >= track.minX && p.x <= x(edit.length) {
                let c = cutPoint(p.x, option: event.modifierFlags.contains(.option))
                cutX = c.x; cutSnapped = c.snapped
            } else { cutX = nil; cutSnapped = false }
            return
        }
        let p = pt(event)
        hoverSeam = drag == nil ? seamNear(p) : nil
        if case .clipEdge(let i, let e, _, _) = target(at: p) { hover = (i, e) } else if hover != nil { hover = nil }
    }
    override func mouseExited(with event: NSEvent) { if drag == nil { hover = nil }; hoverSeam = nil; cutX = nil; cutSnapped = false; lastCutPointer = nil }

    /// Scissors with a white outline (readable on any filmstrip), the hot spot where the blades cross.
    static let scissors: NSCursor = {
        let size = NSSize(width: 24, height: 24)
        let img = NSImage(size: size, flipped: false) { r in
            guard let sym = NSImage(systemSymbolName: "scissors", accessibilityDescription: nil)?
                .withSymbolConfiguration(.init(pointSize: 15, weight: .bold)) else { return false }
            func tinted(_ c: NSColor) -> NSImage {
                NSImage(size: sym.size, flipped: false) { rr in
                    sym.draw(in: rr)
                    c.set()
                    rr.fill(using: .sourceAtop)
                    return true
                }
            }
            let o = NSRect(x: (r.width - sym.size.width) / 2, y: (r.height - sym.size.height) / 2, width: sym.size.width, height: sym.size.height)
            let white = tinted(.white), black = tinted(.black)
            for dx in [-1.5, 0, 1.5] as [CGFloat] { for dy in [-1.5, 0, 1.5] as [CGFloat] { white.draw(in: o.offsetBy(dx: dx, dy: dy)) } }
            black.draw(in: o)
            return true
        }
        return NSCursor(image: img, hotSpot: NSPoint(x: 12, y: 12))
    }()

    // MARK: Drawing

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        drawRuler()
        // the empty track behind the clips (shows past the end while an edge is dragged)
        EditorStyle.surface3.setFill()
        NSBezierPath(roundedRect: track, xRadius: 5, yRadius: 5).fill()

        var lifted: (Int, CGFloat, Int?)?
        if case .clip(let i, let downX, true, let g)? = drag { lifted = (i, dragX - downX, g) }
        for i in edit.clips.indices {
            drawClip(i, in: clipRect(i).insetBy(dx: 1, dy: 0), ctx: ctx, alpha: lifted?.0 == i ? 0.3 : 1)
        }
        drawSeams(ctx: ctx)
        // a picked-up clip: a raised copy under the pointer, and a line where it will go
        if let (i, dx, g) = lifted {
            if let g {
                let gx = gapX(g)
                EditorStyle.accent.setFill()
                NSBezierPath(roundedRect: NSRect(x: gx - 2, y: track.minY - 3, width: 4, height: clipH + 6), xRadius: 2, yRadius: 2).fill()
            }
            NSGraphicsContext.saveGraphicsState()
            let sh = NSShadow()
            sh.shadowColor = NSColor.black.withAlphaComponent(0.4)
            sh.shadowBlurRadius = 8
            sh.shadowOffset = NSSize(width: 0, height: -3)
            sh.set()
            drawClip(i, in: clipRect(i).insetBy(dx: 1, dy: 0).offsetBy(dx: dx, dy: -4), ctx: ctx, alpha: 0.92, raised: true)
            NSGraphicsContext.restoreGraphicsState()
        }

        // the Cut tool: where a click would cut
        if cutMode, let rx = cutX {
            let l = NSBezierPath()
            l.move(to: NSPoint(x: rx, y: track.minY - 3))
            l.line(to: NSPoint(x: rx, y: track.maxY + 3))
            l.lineWidth = cutSnapped ? 3 : 2
            NSColor.systemRed.setStroke()
            l.stroke()
            if cutSnapped {   // magnetised onto the playhead: a white core and end caps
                let w = NSBezierPath()
                w.move(to: NSPoint(x: rx, y: track.minY - 3)); w.line(to: NSPoint(x: rx, y: track.maxY + 3))
                w.lineWidth = 1
                NSColor.white.setStroke()
                w.stroke()
                NSColor.systemRed.setFill()
                for ey in [track.minY - 3, track.maxY + 3] { NSBezierPath(ovalIn: NSRect(x: rx - 3.5, y: ey - 3.5, width: 7, height: 7)).fill() }
            }
            let t = RecordingMath.preciseTimer(cutSnapped ? playhead : seq(rx)) as NSString
            let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.monospacedDigitSystemFont(ofSize: 10, weight: .semibold), .foregroundColor: NSColor.white]
            let sz = t.size(withAttributes: attrs)
            let box = NSRect(x: min(rx + 4, track.maxX - sz.width - 8), y: track.minY + 3, width: sz.width + 8, height: sz.height + 2)
            NSColor.systemRed.setFill()
            NSBezierPath(roundedRect: box, xRadius: 3, yRadius: 3).fill()
            t.draw(at: NSPoint(x: box.minX + 4, y: box.minY + 1), withAttributes: attrs)
        }

        // playhead: white with a dark edge, over the ruler and the clips (`LanesView` continues it over the lanes)
        let px = x(playhead).rounded() + 0.5
        drawPlayheadLine(x: px, from: bounds.minY, to: track.maxY)
        let head = NSBezierPath()
        head.move(to: NSPoint(x: px - 5, y: bounds.minY))
        head.line(to: NSPoint(x: px + 5, y: bounds.minY))
        head.line(to: NSPoint(x: px, y: bounds.minY + 7))
        head.close()
        head.fill()
    }

    private func drawPlayheadLine(x px: CGFloat, from y0: CGFloat, to y1: CGFloat) {
        let line = NSRect(x: px - 1, y: y0, width: 2, height: y1 - y0)
        NSColor.black.withAlphaComponent(0.5).setFill()
        line.insetBy(dx: -1, dy: 0).fill()
        NSColor.white.setFill()
        line.fill()
    }

    /// The lanes view's drawing: the bars, then the playhead's line (it has no head; the ruler's is above).
    fileprivate func drawLanes(height: CGFloat) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        ctx.saveGState()
        ctx.translateBy(x: 0, y: -track.maxY)   // bars are laid out in unscrolled timeline space
        for an in annotations {
            let fill: NSColor = an.kind == .blur ? NSColor(white: 0.55, alpha: 1) : NSColor(cgColor: AnnotationStyle.cgColor(an.color)) ?? .systemRed
            let fg = NSColor(cgColor: AnnotationStyle.cgColor(an.kind == .blur ? 0xffffff : AnnotationStyle.readable(on: an.color))) ?? .white
            var label = an.kind.name
            if an.kind == .count { label = "Count \(an.number)" }
            if an.kind == .text, !an.text.isEmpty { label = "“\(an.text.replacingOccurrences(of: "\n", with: " "))”" }
            if let r = barRect(an) {
                let p = NSBezierPath(roundedRect: r, xRadius: 4, yRadius: 4)
                fill.withAlphaComponent(0.9).setFill()
                p.fill()
                EditorStyle.borderStrong.setStroke()   // keeps a white or yellow bar visible on the light background
                p.lineWidth = 1
                p.stroke()
                if an.id == selectedAnnotation {
                    p.lineWidth = 2
                    NSColor.systemYellow.setStroke()
                    p.stroke()
                }
                let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 10.5, weight: .semibold), .foregroundColor: fg]
                NSGraphicsContext.saveGraphicsState()
                NSBezierPath(rect: r.insetBy(dx: 5, dy: 0)).addClip()
                (label as NSString).draw(at: NSPoint(x: r.minX + 6, y: r.midY - 7), withAttributes: attrs)
                NSGraphicsContext.restoreGraphicsState()
            }
        }
        ctx.restoreGState()
        drawPlayheadLine(x: x(playhead).rounded() + 0.5, from: 0, to: height)
    }

    /// Ticks and times over the edited video, a label at least 64 pt apart.
    private func drawRuler() {
        let len = scaleLength
        guard len > 0, track.width > 0 else { return }
        let step = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600].first { CGFloat($0 / len) * track.width >= 64 } ?? 1200
        let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.monospacedDigitSystemFont(ofSize: 9.5, weight: .regular), .foregroundColor: EditorStyle.text3]
        EditorStyle.text3.setFill()
        var t = 0.0
        while t <= len + 0.001 {
            let tx = x(t).rounded() + 0.5
            NSRect(x: tx - 0.5, y: ruler.maxY - 5, width: 1, height: 5).fill()
            // minor ticks between labels
            for m in 1..<4 {
                let mx = x(t + step * Double(m) / 4).rounded() + 0.5
                if mx < track.maxX { NSRect(x: mx - 0.5, y: ruler.maxY - 3, width: 1, height: 3).fill() }
            }
            let label = (step < 1 ? RecordingMath.preciseTimer(t) : RecordingMath.timer(t)) as NSString   // 0.5 s steps need tenths
            let w = label.size(withAttributes: attrs).width
            if tx + 3 + w < track.maxX { label.draw(at: NSPoint(x: tx + 3, y: ruler.minY), withAttributes: attrs) }
            t += step
        }
    }

    private func drawClip(_ i: Int, in r: NSRect, ctx: CGContext, alpha: CGFloat, raised: Bool = false) {
        let c = edit.clips[i]
        let tileW = max(16, clipH * aspect)
        ctx.saveGState()
        ctx.setAlpha(alpha)
        ctx.beginTransparencyLayer(auxiliaryInfo: nil)
        NSGraphicsContext.saveGraphicsState()
        NSBezierPath(roundedRect: r, xRadius: 5, yRadius: 5).addClip()
        NSColor.black.setFill()
        r.fill()
        if !thumbnails.isEmpty, edit.duration > 0 {
            var tx = r.minX
            while tx < r.maxX {
                let mid = min(r.maxX, tx + tileW / 2)
                let src = c.start + Double((mid - r.minX) / max(1, r.width)) * c.length
                let k = min(thumbnails.count - 1, max(0, Int(src / edit.duration * Double(thumbnails.count))))
                if let img = thumbnails[k] {
                    let t = NSRect(x: tx, y: r.minY, width: tileW, height: r.height)
                    ctx.saveGState()
                    ctx.translateBy(x: 0, y: t.maxY + t.minY)
                    ctx.scaleBy(x: 1, y: -1)
                    ctx.draw(img, in: t)
                    ctx.restoreGState()
                }
                tx += tileW
            }
        }
        NSGraphicsContext.restoreGraphicsState()
        // outline: the selected (or picked-up) clip in yellow
        let sel = i == selectedClip || raised
        let path = NSBezierPath(roundedRect: r.insetBy(dx: sel ? 1 : 0.5, dy: sel ? 1 : 0.5), xRadius: 5, yRadius: 5)
        path.lineWidth = sel ? 2.5 : 1
        (sel ? NSColor.systemYellow : NSColor.white.withAlphaComponent(0.25)).setStroke()
        path.stroke()
        // removed footage at an edge: a red mark (drag the edge out to bring it back)
        for e in [EditModel.Edge.start, .end] where !raised && edit.hasHiddenMedia(i, e) {
            let ex = e == .start ? r.minX : r.maxX
            let dir: CGFloat = e == .start ? 1 : -1
            NSColor.systemRed.setFill()
            NSRect(x: e == .start ? ex : ex - 2.5, y: r.minY, width: 2.5, height: r.height).fill()
            for y in [r.minY, r.maxY] {
                let p = NSBezierPath()
                p.move(to: NSPoint(x: ex, y: y))
                p.line(to: NSPoint(x: ex + dir * 11, y: y))
                p.line(to: NSPoint(x: ex, y: y + (y == r.minY ? 11 : -11)))
                p.close()
                p.fill()
            }
        }
        // the edge under the pointer (or being dragged): a yellow handle
        if !raised, let h = activeEdge, h.clip == i {
            let ex = h.edge == .start ? r.minX : r.maxX - 4
            NSColor.systemYellow.setFill()
            NSBezierPath(roundedRect: NSRect(x: ex, y: r.minY, width: 4, height: r.height), xRadius: 2, yRadius: 2).fill()
        }
        ctx.endTransparencyLayer()
        ctx.restoreGState()
    }

    private var activeEdge: (clip: Int, edge: EditModel.Edge)? {
        if case .clipEdge(let i, let e, _, _)? = drag { return (i, e) }
        return hover
    }

    // MARK: Mouse

    private func target(at p: NSPoint) -> Drag {
        for an in annotations.reversed() {
            guard let r = barRect(an), r.insetBy(dx: -3, dy: -2).contains(p) else { continue }
            if r.width > 14 {
                if p.x <= r.minX + 5 { return .annEdge(an.id, .start) }
                if p.x >= r.maxX - 5 { return .annEdge(an.id, .end) }
            }
            return .annBody(an.id, grab: seq(p.x) - span(an).lowerBound, downX: p.x, moved: false)
        }
        guard p.y >= track.minY - 2, p.y <= track.maxY + 2 else { return .scrub }
        // the nearest clip edge within reach; at a boundary between two clips the side of the pointer decides
        var best: (Int, EditModel.Edge, CGFloat)?
        for i in edit.clips.indices {
            let r = clipRect(i)
            for (e, ex) in [(EditModel.Edge.start, r.minX), (.end, r.maxX)] {
                let d = abs(p.x - ex)
                guard d <= edgeHit else { continue }
                let sideOK = e == .start ? p.x >= ex - 2 || i == 0 : p.x <= ex + 2 || i == edit.clips.count - 1
                if sideOK, best == nil || d < best!.2 { best = (i, e, d) }
            }
        }
        if let (i, e, _) = best { return .clipEdge(i, e, downX: p.x, sourceAtDown: e == .start ? edit.clips[i].start : edit.clips[i].end) }
        if let i = edit.clipIndex(atSequence: seq(p.x)), clipRect(i).contains(p) { return .clip(i, downX: p.x, moved: false, gap: nil) }
        return .scrub
    }

    override func mouseDown(with event: NSEvent) {
        guard isEnabled else { return }
        window?.makeFirstResponder(self)
        let p = pt(event)
        if cutMode, p.y >= track.minY - 2, p.y <= track.maxY + 2, p.x >= track.minX, p.x <= x(edit.length) {
            let c = cutPoint(p.x, option: event.modifierFlags.contains(.option))
            onSplit?(c.snapped ? nil : seq(p.x))
            return
        }
        if let i = seamHit(p) { return showSeamMenu(i) }
        let d = target(at: p)
        drag = d
        dragX = p.x
        changed = false
        switch d {
        case .annBody(let id, _, _, _), .annEdge(let id, _):
            selectedAnnotation = id
            onSelectAnnotation?(id)
        case .clip(let i, _, _, _):
            selectedClip = i
            selectedAnnotation = nil
            onSelectAnnotation?(nil)
            scrub(to: p.x)
        case .clipEdge(let i, _, _, _):
            selectedClip = i
            frozenLength = edit.length
        case .scrub:
            if !ruler.insetBy(dx: 0, dy: -2).contains(p) { selectedClip = nil }
            scrub(to: p.x)
        }
    }

    private func scrub(to x: CGFloat) {
        playhead = min(edit.length, max(0, seq(x)))
        onScrub?(playhead)
    }

    private func willChange() {
        guard !changed else { return }
        changed = true
        onWillChange?()
    }

    override func mouseDragged(with event: NSEvent) {
        guard let d = drag else { return }
        let x = pt(event).x
        dragX = x
        switch d {
        case .scrub:
            scrub(to: x)
        case .clip(let i, let downX, let moved, _):
            guard moved || abs(x - downX) >= 4, edit.clips.count > 1 else { return }
            if !moved { NSCursor.closedHand.set() }
            drag = .clip(i, downX: downX, moved: true, gap: gap(for: i, at: x))
            needsDisplay = true
        case .clipEdge(let i, let e, let downX, let s0):
            let target = s0 + Double(x - downX) * secondsPerPoint
            var next = edit
            next.moveEdge(i, e, toSource: target)
            guard next != edit else { return }
            willChange()
            edit = next
            if e == .start { displayShift = (i, edit.clips[i].start - s0) }
            // show the frame at the edge being dragged
            let c = edit.clips[i]
            playhead = edit.sequenceStart(of: i) + (e == .start ? 0 : c.length) + shift(i)
            onScrub?(e == .start ? edit.sequenceStart(of: i) : edit.sequenceStart(of: i) + max(0, c.length - 0.02))
            onChanging?()
            needsDisplay = true
        case .annBody(let id, let grab, let downX, let moved):
            guard moved || abs(x - downX) >= 3, let k = annotations.firstIndex(where: { $0.id == id }) else { return }
            if !moved {
                drag = .annBody(id, grab: grab, downX: downX, moved: true)
                NSCursor.closedHand.set()
            }
            var an = annotations[k]
            // it starts where the bar's left end is dropped: anchored to the frame there
            let s = edit.source(atSequence: min(max(0, edit.length - an.length), max(0, seq(x) - grab)))
            guard s != an.start else { return }
            willChange()
            an.start = s
            annotations[k] = an
            onChanging?()
            needsDisplay = true
        case .annEdge(let id, let e):
            guard let k = annotations.firstIndex(where: { $0.id == id }) else { return }
            var an = annotations[k]
            let r = span(an), t = min(edit.length, max(0, seq(x)))
            if e == .start {
                let s = min(t, r.upperBound - 0.25)
                an.start = edit.source(atSequence: s)
                an.length = r.upperBound - s
            } else {
                an.length = max(0.25, t - r.lowerBound)
            }
            guard an != annotations[k] else { return }
            willChange()
            annotations[k] = an
            onChanging?()
            needsDisplay = true
        }
    }

    override func mouseUp(with event: NSEvent) {
        let d = drag
        drag = nil
        frozenLength = nil
        displayShift = nil
        if case .clip(let i, _, true, let g?)? = d {
            var next = edit
            if let j = next.moveClip(i, toGap: g) {
                willChange()
                edit = next
                selectedClip = j
            }
        }
        if changed {
            changed = false
            assignLanes()
            onCommitted?()
        }
        changedLayout()
    }

    /// Right-click: split here or delete this clip; delete an annotation.
    override func menu(for event: NSEvent) -> NSMenu? {
        guard isEnabled, edit.length > 0 else { return nil }
        let p = pt(event)
        let menu = NSMenu()
        menu.autoenablesItems = false
        if let i = seamHit(p) { seamMenuItems(i).forEach { menu.addItem($0) }; return menu }
        switch target(at: p) {
        case .annBody(let id, _, _, _), .annEdge(let id, _):
            menu.addItem(ActionItem("Delete Annotation") { [weak self] in self?.onDeleteAnnotation?(id) })
        case .clip(let i, _, _, _), .clipEdge(let i, _, _, _):
            let t = seq(p.x)
            menu.addItem(ActionItem("Split Here") { [weak self] in self?.onSplit?(t) })
            if edit.clips.count > 1 {
                menu.addItem(ActionItem("Delete Clip") { [weak self] in self?.onDeleteClip?(i) })
            }
            if i > 0 {   // also the way to set a cut's transition without the marker
                let sub = NSMenu()
                sub.autoenablesItems = false
                seamMenuItems(i).forEach { sub.addItem($0) }
                let item = NSMenuItem(title: "Transition Into This Clip", action: nil, keyEquivalent: "")
                item.submenu = sub
                menu.addItem(item)
            }
        case .scrub:
            return nil
        }
        return menu
    }
}

/// The annotation lanes' document view: draws through the timeline and hands the mouse back to it.
@MainActor
final class LanesView: NSView {
    weak var timeline: EditTimeline?
    override var isFlipped: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func draw(_ dirtyRect: NSRect) { timeline?.drawLanes(height: bounds.height) }
    override func resetCursorRects() { timeline?.addBarCursors(to: self) }
    override func mouseDown(with event: NSEvent) { timeline?.mouseDown(with: event) }
    override func mouseDragged(with event: NSEvent) { timeline?.mouseDragged(with: event) }
    override func mouseUp(with event: NSEvent) { timeline?.mouseUp(with: event) }
    override func mouseMoved(with event: NSEvent) { timeline?.mouseMoved(with: event) }
    override func menu(for event: NSEvent) -> NSMenu? { timeline?.menu(for: event) }
}

/// A menu item that runs a closure.
final class ActionItem: NSMenuItem {
    private let run: () -> Void
    init(_ title: String, _ run: @escaping () -> Void) {
        self.run = run
        super.init(title: title, action: #selector(fire), keyEquivalent: "")
        target = self
    }
    required init(coder: NSCoder) { fatalError() }
    @objc private func fire() { run() }
}
