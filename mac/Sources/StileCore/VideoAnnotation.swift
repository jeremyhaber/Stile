import CoreGraphics
import CoreImage
import CoreText
import Foundation

/// v3.7: a drawing on a recording (rectangle, arrow, text, highlight, count) or a blur box, shown from `start` for `length`.
/// `start` is recording time: it is anchored to the frame it begins at, so it moves with that footage when clips are cut or
/// reordered; `length` is edited-video time, so it shows as one unbroken stretch whatever is cut or reordered after its start. Points are fractions of the video
/// (0...1, top-left origin), so the editor can draw it at any size. Styles follow the screenshot editor
/// (`extension/capture/src/annotate/model.ts`: colours, stroke and font steps, arrow head, text halo, blur strength).
public struct VideoAnnotation: Equatable, Sendable, Identifiable {
    public enum Kind: String, Sendable, CaseIterable {
        case rect, arrow, text, highlight, blur, count
        public var name: String {
            switch self {
            case .rect: return "Rectangle"
            case .arrow: return "Arrow"
            case .text: return "Text"
            case .highlight: return "Highlight"
            case .blur: return "Blur"
            case .count: return "Count"
            }
        }
    }

    /// v3.8: how it comes in and goes out (mirrored), over `Transition.duration`. The editor can turn them all off.
    public enum Transition: String, Sendable, CaseIterable {
        case none, fade, pop, slide, draw
        public var name: String {
            switch self {
            case .none: return "None"
            case .fade: return "Fade"
            case .pop: return "Pop"
            case .slide: return "Slide up"
            case .draw: return "Draw"
            }
        }
        /// Seconds to come in (and go out); was 0.35 for all.
        public var duration: Double { duration(at: .normal) }
        /// Seconds to come in (and go out) at a speed. Fast 0.3; Normal 0.55 (Draw 0.7); Slow 1.0 (Draw 1.2).
        public func duration(at speed: Speed) -> Double {
            switch speed {
            case .fast: return 0.3
            case .normal: return self == .draw ? 0.7 : 0.55
            case .slow: return self == .draw ? 1.2 : 1.0
            }
        }
    }

    /// How fast an annotation's transitions run.
    public enum Speed: String, Sendable, CaseIterable {
        case fast, normal, slow
        public var name: String {
            switch self {
            case .fast: return "Fast"
            case .normal: return "Normal"
            case .slow: return "Slow"
            }
        }
    }

    public var id: Int
    public var kind: Kind
    /// rect, highlight's box... and blur: two corners; arrow: the two ends;
    /// text: its top-left (b unused); count: its centre (b = a)
    public var a: CGPoint
    public var b: CGPoint
    public var color: UInt32
    /// stroke step 0...2 (text: font step 0...3; count: badge size step 0...2)
    public var size: Int
    public var text: String
    /// recording time of the frame it starts on
    public var start: Double
    /// seconds it shows, in the edited video
    public var length: Double
    public var transition: Transition
    public var speed: Speed
    /// count: the number in the badge
    public var number: Int

    public init(id: Int, kind: Kind, a: CGPoint, b: CGPoint, color: UInt32, size: Int, text: String = "", start: Double, length: Double,
                transition: Transition = .fade, number: Int = 0, speed: Speed = .normal) {
        self.speed = speed
        self.id = id; self.kind = kind; self.a = a; self.b = b; self.color = color; self.size = size
        self.text = text; self.start = start; self.length = length; self.transition = transition
        self.number = number
    }

    /// The most a count's number can be (a badge stays legible at three digits).
    public static let maxCountNumber = 999

    /// A count number forced into 1...`maxCountNumber`.
    public static func clampedCountNumber(_ n: Int) -> Int { min(max(n, 1), maxCountNumber) }

    /// One more than the highest count there is (what a fresh counter starts at when badges already exist).
    public static func nextNumber(in list: [VideoAnnotation]) -> Int {
        clampedCountNumber(list.reduce(0) { $1.kind == .count ? max($0, $1.number) : $0 } + 1)
    }

    /// Seconds it shows in the edited video (with `resolved(in:)`: the start is edited-video time too).
    public var end: Double { start + length }

    /// A copy placed on the edited video: `start` is now edited-video time (where its anchor frame is; if that was cut,
    /// where the footage after it now begins), `length` cut short at the end of the video. nil: already edited-video time.
    public func resolved(in edit: EditModel?) -> VideoAnnotation {
        guard let edit else { return self }
        var n = self
        n.start = edit.sequence(ofAnchor: start)
        n.length = max(0, min(length, edit.length - n.start))
        return n
    }

    /// `t`: edited-video time of a `resolved` annotation.
    public func visible(at t: Double) -> Bool { t >= start - 0.001 && t < end }

    /// 0...1: how far in at `t` (and, mirrored, how far from going out); 1 without a transition. Never more than half
    /// the time it shows, so a short one still comes in and goes out.
    public func progress(at t: Double) -> Double {
        guard transition != .none else { return 1 }
        let d = min(transition.duration(at: speed), max(0.001, length / 2))
        return min(1, max(0, min((t - start) / d, (end - t) / d)))
    }

    /// The two corners as a box (fractions).
    public var box: CGRect {
        CGRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(b.x - a.x), height: abs(b.y - a.y))
    }

    /// Moved by `d` (fractions), kept on the video.
    public func moved(by d: CGVector) -> VideoAnnotation {
        var n = self
        let pts = kind == .text || kind == .count ? [a] : [a, b]
        let minX = pts.map(\.x).min()!, maxX = pts.map(\.x).max()!, minY = pts.map(\.y).min()!, maxY = pts.map(\.y).max()!
        let dx = min(max(d.dx, -minX), 1 - maxX), dy = min(max(d.dy, -minY), 1 - maxY)
        n.a = CGPoint(x: a.x + dx, y: a.y + dy)
        n.b = CGPoint(x: b.x + dx, y: b.y + dy)
        return n
    }
}

/// Colours and sizes, the same steps as the screenshot editor.
public enum AnnotationStyle {
    public static let colors: [(name: String, rgb: UInt32)] = [
        ("Red", 0xe5322d), ("Orange", 0xf28c28), ("Yellow", 0xffd60a), ("Green", 0x1fa34a),
        ("Blue", 0x1f6feb), ("Purple", 0x8a3ba6), ("Black", 0x111111), ("White", 0xffffff),
    ]
    public static let defaultColor: UInt32 = 0xe5322d
    public static let highlightColor: UInt32 = 0xffd60a
    public static let highlightAlpha: CGFloat = 0.4
    public static let sizeNames = ["Thin", "Medium", "Thick"]
    public static let fontNames = ["Small", "Medium", "Large", "Extra large"]
    static let strokeF: [CGFloat] = [0.0025, 0.005, 0.009], strokeMin: [CGFloat] = [2, 4, 7]
    static let fontF: [CGFloat] = [0.018, 0.028, 0.045, 0.07], fontMin: [CGFloat] = [14, 18, 26, 38]
    static let badgeF: [CGFloat] = [0.009, 0.014, 0.02], badgeMin: [CGFloat] = [9, 12, 16]
    static let lineHeight: CGFloat = 1.25

    /// What sizes are relative to: the width, capped at 2.5 heights (pixels of the video).
    static func ref(_ s: CGSize) -> CGFloat { max(1, min(s.width, s.height * 2.5)) }
    public static func stroke(_ i: Int, _ s: CGSize) -> CGFloat {
        let k = min(max(i, 0), 2)
        return max(strokeMin[k], (ref(s) * strokeF[k]).rounded())
    }
    public static func font(_ i: Int, _ s: CGSize) -> CGFloat {
        let k = min(max(i, 0), 3)
        return max(fontMin[k], (ref(s) * fontF[k]).rounded())
    }
    /// A count badge's radius for size step `i`.
    public static func badgeRadius(_ i: Int, _ s: CGSize) -> CGFloat {
        let k = min(max(i, 0), 2)
        return max(badgeMin[k], (ref(s) * badgeF[k]).rounded())
    }
    /// The screenshot editor's blur strength for a box of `w` x `h` pixels.
    public static func blurRadius(_ w: CGFloat, _ h: CGFloat) -> CGFloat { min(40, max(8, (min(w, h) / 4).rounded())) }

    public static func cgColor(_ rgb: UInt32, alpha: CGFloat = 1) -> CGColor {
        CGColor(srgbRed: CGFloat((rgb >> 16) & 0xff) / 255, green: CGFloat((rgb >> 8) & 0xff) / 255, blue: CGFloat(rgb & 0xff) / 255, alpha: alpha)
    }
    /// Dark halo for light text, light halo for dark text.
    public static func readable(on rgb: UInt32) -> UInt32 {
        func lin(_ c: UInt32) -> Double { let v = Double(c) / 255; return v <= 0.03928 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4) }
        let l = 0.2126 * lin((rgb >> 16) & 0xff) + 0.7152 * lin((rgb >> 8) & 0xff) + 0.0722 * lin(rgb & 0xff)
        return l > 0.36 ? 0x111111 : 0xffffff
    }
}

/// Draws annotations. One drawing routine for the editor's live view and the exported video, so they match.
public enum AnnotationRenderer {
    /// Draws the drawings (not blur boxes) of `list` that show at `t` (nil: all) into `ctx`, whose user space is the
    /// video in pixels (`size`) with a top-left origin.
    /// `animate`: play the transitions at `t` (off: everything fully in, as when editing).
    public static func draw(_ list: [VideoAnnotation], at t: Double?, animate: Bool = false, in ctx: CGContext, size: CGSize) {
        for an in list where an.kind != .blur && (t.map { an.visible(at: $0) } ?? true) {
            draw(an, progress: animate ? (t.map { an.progress(at: $0) } ?? 1) : 1, in: ctx, size: size)
        }
    }

    /// `progress` 0...1 of its transition (1: fully in).
    public static func draw(_ an: VideoAnnotation, progress: Double = 1, in ctx: CGContext, size: CGSize) {
        func px(_ p: CGPoint) -> CGPoint { CGPoint(x: p.x * size.width, y: p.y * size.height) }
        let w = AnnotationStyle.stroke(an.size, size)
        let color = AnnotationStyle.cgColor(an.color)
        let p = CGFloat(min(1, max(0, progress)))
        guard p > 0 else { return }
        ctx.saveGState()
        defer { ctx.restoreGState() }
        // the box it moves / scales around
        let bounds = bounds(of: an, size: size)
        let eased = 1 - pow(1 - p, 3)   // ease out
        var reveal: CGFloat = 1          // .draw: how much is drawn
        if p < 1 {
            switch an.transition {
            case .none: break
            case .fade:
                ctx.setAlpha(eased)
            case .pop:
                // a little overshoot, then settle
                let k = 1 + 2.2 * pow(p - 1, 3) + 1.2 * pow(p - 1, 2)
                let sc = 0.6 + 0.4 * k
                ctx.setAlpha(min(1, p * 2))
                ctx.translateBy(x: bounds.midX, y: bounds.midY)
                ctx.scaleBy(x: sc, y: sc)
                ctx.translateBy(x: -bounds.midX, y: -bounds.midY)
            case .slide:
                ctx.setAlpha(eased)
                ctx.translateBy(x: 0, y: (1 - eased) * size.height * 0.04)
            case .draw:
                reveal = eased
            }
        }
        switch an.kind {
        case .rect:
            ctx.setStrokeColor(color)
            ctx.setLineWidth(w)
            ctx.setLineJoin(.miter)
            if reveal < 1 {
                // the outline drawn clockwise from the top-left
                let len = 2 * (bounds.width + bounds.height)
                ctx.setLineDash(phase: 0, lengths: [len * reveal, len])
                ctx.move(to: CGPoint(x: bounds.minX, y: bounds.minY))
                ctx.addLine(to: CGPoint(x: bounds.maxX, y: bounds.minY))
                ctx.addLine(to: CGPoint(x: bounds.maxX, y: bounds.maxY))
                ctx.addLine(to: CGPoint(x: bounds.minX, y: bounds.maxY))
                ctx.closePath()
                ctx.strokePath()
            } else {
                ctx.stroke(bounds)
            }
        case .highlight:
            ctx.setFillColor(AnnotationStyle.cgColor(an.color, alpha: AnnotationStyle.highlightAlpha))
            ctx.fill(CGRect(x: bounds.minX, y: bounds.minY, width: bounds.width * reveal, height: bounds.height))   // a marker stroke
        case .arrow:
            let tail = px(an.a), tip = px(an.b)
            let parts = arrowParts(tail, tip, width: w)
            ctx.setStrokeColor(color)
            ctx.setFillColor(color)
            ctx.setLineWidth(w)
            ctx.setLineCap(.round)
            // .draw: the shaft grows from the tail, then the head appears
            let shaft = min(1, reveal / 0.8)
            ctx.move(to: tail)
            ctx.addLine(to: CGPoint(x: tail.x + (parts.shaftEnd.x - tail.x) * shaft, y: tail.y + (parts.shaftEnd.y - tail.y) * shaft))
            ctx.strokePath()
            if reveal >= 0.8 {
                if reveal < 1 { ctx.setAlpha((reveal - 0.8) / 0.2) }
                ctx.move(to: parts.head[0])
                ctx.addLine(to: parts.head[1])
                ctx.addLine(to: parts.head[2])
                ctx.closePath()
                ctx.fillPath()
            }
        case .text:
            if reveal < 1 { ctx.clip(to: CGRect(x: bounds.minX - 20, y: bounds.minY - 20, width: (bounds.width + 20) * reveal + 20, height: bounds.height + 40)) }
            let fs = AnnotationStyle.font(an.size, size)
            let origin = px(an.a)
            let halo = AnnotationStyle.cgColor(AnnotationStyle.readable(on: an.color))
            ctx.textMatrix = CGAffineTransform(scaleX: 1, y: -1)   // the context is top-left; glyphs stay upright
            for (i, line) in lines(of: an.text).enumerated() {
                let l = ctLine(line, fs, color: color)
                let y = origin.y + CGFloat(i) * fs * AnnotationStyle.lineHeight + fs * 0.92
                ctx.textPosition = CGPoint(x: origin.x, y: y)
                ctx.setTextDrawingMode(.stroke)
                ctx.setLineWidth(max(2, fs * 0.14))
                ctx.setLineJoin(.round)
                ctx.setStrokeColor(halo)
                CTLineDraw(ctLine(line, fs, color: halo), ctx)
                ctx.textPosition = CGPoint(x: origin.x, y: y)
                ctx.setTextDrawingMode(.fill)
                CTLineDraw(l, ctx)
            }
        case .blur:
            break
        case .count:
            let c = px(an.a), r = AnnotationStyle.badgeRadius(an.size, size)
            let ink = AnnotationStyle.cgColor(AnnotationStyle.readable(on: an.color))
            ctx.setFillColor(color)
            ctx.fillEllipse(in: CGRect(x: c.x - r, y: c.y - r, width: r * 2, height: r * 2))
            ctx.setStrokeColor(ink)
            ctx.setLineWidth(max(2, r * 0.12))
            ctx.strokeEllipse(in: CGRect(x: c.x - r, y: c.y - r, width: r * 2, height: r * 2))
            drawCentered(String(an.number), size: (r * Self.badgeDigitScale(an.number)).rounded(), at: CGPoint(x: c.x, y: c.y + r * 0.04), color: ink, in: ctx)
        }
    }

    /// Font size, in badge radii: full for one or two digits, smaller so three still sit inside the circle.
    static func badgeDigitScale(_ n: Int) -> CGFloat {
        switch String(n).count { case ...1: return 1.1; case 2: return 0.95; default: return 0.72 }
    }

    /// `s` centred on `c` (the context is top-left; glyphs stay upright).
    private static func drawCentered(_ s: String, size fs: CGFloat, at c: CGPoint, color: CGColor, in ctx: CGContext) {
        let line = ctLine(s, fs, color: color)
        let w = CGFloat(CTLineGetTypographicBounds(line, nil, nil, nil))
        let cap = CTFontGetCapHeight(font(fs))
        ctx.textMatrix = CGAffineTransform(scaleX: 1, y: -1)
        ctx.textPosition = CGPoint(x: c.x - w / 2, y: c.y + cap / 2)
        ctx.setTextDrawingMode(.fill)
        CTLineDraw(line, ctx)
    }

    /// What an annotation covers, in video pixels (top-left origin): its box, text's box, a count's badge.
    public static func bounds(of an: VideoAnnotation, size: CGSize) -> CGRect {
        switch an.kind {
        case .text: return textBox(an, size: size)
        case .count:
            let r = AnnotationStyle.badgeRadius(an.size, size)
            return CGRect(x: an.a.x * size.width - r, y: an.a.y * size.height - r, width: r * 2, height: r * 2)
        default:
            return CGRect(x: an.box.minX * size.width, y: an.box.minY * size.height, width: an.box.width * size.width, height: an.box.height * size.height)
        }
    }

    /// A text annotation's box in video pixels (top-left origin).
    public static func textBox(_ an: VideoAnnotation, size: CGSize) -> CGRect {
        let fs = AnnotationStyle.font(an.size, size)
        let ls = lines(of: an.text)
        let w = ls.map { CTLineGetTypographicBounds(ctLine($0, fs, color: CGColor(gray: 0, alpha: 1)), nil, nil, nil) }.max() ?? 0
        return CGRect(x: an.a.x * size.width, y: an.a.y * size.height, width: max(fs * 0.6, CGFloat(w)),
                      height: CGFloat(max(1, ls.count)) * fs * AnnotationStyle.lineHeight)
    }

    static func lines(of text: String) -> [String] {
        let l = text.components(separatedBy: "\n")
        return l.isEmpty ? [""] : l
    }

    private static func font(_ size: CGFloat) -> CTFont {
        CTFontCreateUIFontForLanguage(.emphasizedSystem, size, nil) ?? CTFontCreateWithName("Helvetica-Bold" as CFString, size, nil)
    }

    private static func ctLine(_ s: String, _ size: CGFloat, color: CGColor) -> CTLine {
        let font = font(size)
        let attrs: [NSAttributedString.Key: Any] = [NSAttributedString.Key(kCTFontAttributeName as String): font,
                                                    NSAttributedString.Key(kCTForegroundColorAttributeName as String): color]
        return CTLineCreateWithAttributedString(NSAttributedString(string: s, attributes: attrs))
    }

    /// The screenshot editor's arrow: shaft end and the three head corners.
    public static func arrowParts(_ a: CGPoint, _ b: CGPoint, width: CGFloat) -> (shaftEnd: CGPoint, head: [CGPoint]) {
        let dx = b.x - a.x, dy = b.y - a.y, len = hypot(dx, dy)
        guard len > 0 else { return (b, [b, b, b]) }
        let ux = dx / len, uy = dy / len
        let headLen = min(len, max(width * 4.5, 12)), half = headLen * 0.42
        let base = CGPoint(x: b.x - ux * headLen, y: b.y - uy * headLen)
        return (CGPoint(x: b.x - ux * headLen * 0.8, y: b.y - uy * headLen * 0.8),
                [b, CGPoint(x: base.x - uy * half, y: base.y + ux * half), CGPoint(x: base.x + uy * half, y: base.y - ux * half)])
    }
}

/// Applies annotations to video frames (Core Image; called on AVFoundation's threads). `blurOnly` is the editor's
/// preview, where the drawings are live vectors on top; the export draws everything. The drawings are cached per set
/// of visible annotations, since they don't change from frame to frame.
public final class AnnotationFrameRenderer: @unchecked Sendable {
    private let lock = NSLock()
    private var list: [VideoAnnotation] = []
    private var editModel: EditModel?
    private var cacheKey: [Int] = []
    private var cacheSize: CGSize = .zero
    private var cache: CIImage?
    private let blurOnly: Bool
    private var animateFlag: Bool

    public init(blurOnly: Bool, annotations: [VideoAnnotation] = [], edit: EditModel? = nil, animate: Bool = true) {
        self.blurOnly = blurOnly
        list = annotations
        editModel = edit
        animateFlag = animate
    }

    /// Play the transitions (off: the editor while paused, or transitions turned off).
    public var animate: Bool {
        get { lock.lock(); defer { lock.unlock() }; return animateFlag }
        set { lock.lock(); animateFlag = newValue; lock.unlock() }
    }

    public var annotations: [VideoAnnotation] {
        get { lock.lock(); defer { lock.unlock() }; return list }
        set { lock.lock(); list = newValue; cache = nil; cacheKey = []; lock.unlock() }
    }

    /// The edit the annotations sit on (nil: their times are edited-video time already).
    public var edit: EditModel? {
        get { lock.lock(); defer { lock.unlock() }; return editModel }
        set { lock.lock(); editModel = newValue; lock.unlock() }
    }

    /// Edited-video time of recording time `s`.
    public func sequence(ofSource s: Double) -> Double { edit?.sequence(ofSource: s) ?? s }

    /// `frame` (extent at the origin) with the annotations showing at edited-video time `t`.
    public func apply(to frame: CIImage, at t: Double) -> CIImage {
        lock.lock()
        let visible = list.map { $0.resolved(in: editModel) }.filter { $0.visible(at: t) }
        let animate = animateFlag
        lock.unlock()
        func progress(_ an: VideoAnnotation) -> Double { animate ? an.progress(at: t) : 1 }
        guard !visible.isEmpty else { return frame }
        let ext = frame.extent
        var out = frame
        // blur boxes blur the picture first, so drawings on top stay crisp
        for an in visible where an.kind == .blur {
            let r = CGRect(x: ext.minX + an.box.minX * ext.width, y: ext.minY + (1 - an.box.maxY) * ext.height,
                           width: an.box.width * ext.width, height: an.box.height * ext.height).integral.intersection(ext)
            guard r.width >= 2, r.height >= 2 else { continue }
            var blurred = out.clampedToExtent().applyingGaussianBlur(sigma: Double(AnnotationStyle.blurRadius(r.width, r.height))).cropped(to: r)
            let p = progress(an)
            if p < 1 {   // every transition fades a blur in
                blurred = blurred.applyingFilter("CIColorMatrix", parameters: ["inputAVector": CIVector(x: 0, y: 0, z: 0, w: CGFloat(p))])
            }
            out = blurred.composited(over: out)
        }
        guard !blurOnly else { return out }
        let drawings = visible.filter { $0.kind != .blur }
        guard !drawings.isEmpty, let overlay = overlay(for: drawings, size: ext.size, progress: drawings.map(progress)) else { return out }
        return overlay.transformed(by: CGAffineTransform(translationX: ext.minX, y: ext.minY)).composited(over: out)
    }

    /// The drawings at their transition progress; cached while they're all fully in (most frames).
    private func overlay(for drawings: [VideoAnnotation], size: CGSize, progress: [Double]) -> CIImage? {
        let key = drawings.map(\.id)
        let still = progress.allSatisfy { $0 >= 1 }
        lock.lock()
        if still, key == cacheKey, size == cacheSize, let c = cache { lock.unlock(); return c }
        lock.unlock()
        let w = Int(size.width), h = Int(size.height)
        guard w > 0, h > 0, let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                                                space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        ctx.translateBy(x: 0, y: CGFloat(h))
        ctx.scaleBy(x: 1, y: -1)
        for (an, p) in zip(drawings, progress) { AnnotationRenderer.draw(an, progress: p, in: ctx, size: size) }
        guard let img = ctx.makeImage() else { return nil }
        let ci = CIImage(cgImage: img)
        guard still else { return ci }
        lock.lock()
        cache = ci
        cacheKey = key
        cacheSize = size
        lock.unlock()
        return ci
    }
}

/// The count tool's "next number": placing a badge takes it and moves on, Reset starts over at 1, and typing a badge's
/// number continues from that number. Held by the editor and saved with each undo step.
public struct CountCounter: Equatable, Sendable {
    public private(set) var next: Int

    /// Starts after the highest badge in `list` (1 with none).
    public init(existing list: [VideoAnnotation] = []) { next = VideoAnnotation.nextNumber(in: list) }

    /// The number for a badge being placed; the counter moves to the one after it.
    public mutating func place() -> Int {
        let n = VideoAnnotation.clampedCountNumber(next)
        next = VideoAnnotation.clampedCountNumber(n + 1)
        return n
    }

    /// The next badge starts a new count at 1 (existing badges keep their numbers).
    public mutating func reset() { next = 1 }

    /// A badge's number was typed in: subsequent badges continue from it. Returns the number as stored.
    @discardableResult
    public mutating func override(_ number: Int) -> Int {
        let n = VideoAnnotation.clampedCountNumber(number)
        next = VideoAnnotation.clampedCountNumber(n + 1)
        return n
    }
}
