import AppKit
import StileCore

/// v3.6.2: the screenshot editor's look for the native recording editor, so the two feel like one tool. Colours are the
/// web editor's tokens (`extension/capture/src/tokens.css`), sizes its `editor.module.css` (46 pt bar of ghost buttons,
/// canvas, 28 pt status line, toasts). Keep the two in step when either changes.
enum EditorStyle {
    private static func hex(_ v: UInt32, _ a: CGFloat = 1) -> NSColor {
        NSColor(srgbRed: CGFloat((v >> 16) & 0xff) / 255, green: CGFloat((v >> 8) & 0xff) / 255, blue: CGFloat(v & 0xff) / 255, alpha: a)
    }
    private static func pair(_ light: NSColor, _ dark: NSColor) -> NSColor {
        NSColor(name: nil) { $0.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? dark : light }
    }

    static let bg = pair(hex(0xf3f3f6), hex(0x1f2023))
    static let canvas = pair(hex(0xe3e4e9), hex(0x141517))
    static let surface = pair(hex(0xffffff), hex(0x2a2b2f))
    static let surface3 = pair(hex(0x1c1c1e, 0.08), hex(0xffffff, 0.1))
    static let menuBg = pair(hex(0xffffff), hex(0x2c2d31))
    static let text = pair(hex(0x1c1c1e), hex(0xececf0))
    static let text2 = pair(hex(0x55565c), hex(0xb5b6be))
    static let text3 = pair(hex(0x6f7078), hex(0x92939c))
    static let border = pair(hex(0x1c1c1e, 0.12), hex(0xffffff, 0.1))
    static let borderStrong = pair(hex(0x1c1c1e, 0.22), hex(0xffffff, 0.2))
    static let accent = pair(hex(0x4655e0), hex(0x8d98ff))
    static let accentText = pair(hex(0x3947d1), hex(0xa5aeff))
    static let accentSoft = pair(hex(0x4655e0, 0.14), hex(0x8d98ff, 0.2))
    static let danger = pair(hex(0xd6372f), hex(0xff7a70))

    static let barHeight: CGFloat = 46
    static let statusHeight: CGFloat = 28
}

/// A plain area in one of the editor colours, with optional hairlines (the bar's bottom border, the status line's top one).
final class FillView: NSView {
    var fill: NSColor { didSet { needsDisplay = true } }
    var topLine = false
    var bottomLine = false

    init(_ fill: NSColor, top: Bool = false, bottom: Bool = false) {
        self.fill = fill
        topLine = top
        bottomLine = bottom
        super.init(frame: .zero)
    }
    required init?(coder: NSCoder) { nil }

    override func draw(_ dirtyRect: NSRect) {
        // bounds, not dirtyRect: views don't clip to their bounds by default since macOS 14, and dirtyRect can be wider
        fill.setFill()
        bounds.fill()
        EditorStyle.border.setFill()
        if topLine { NSRect(x: 0, y: bounds.maxY - 1, width: bounds.width, height: 1).fill() }
        if bottomLine { NSRect(x: 0, y: 0, width: bounds.width, height: 1).fill() }
    }
}

/// The web editor's export icons (`icons.tsx`), drawn from the same 24-unit paths so they match exactly.
enum EditorIcon {
    static let copy = make { p in
        p.appendRoundedRect(NSRect(x: 9, y: 9, width: 11, height: 11), xRadius: 2, yRadius: 2)
        p.move(to: NSPoint(x: 5, y: 15)); p.line(to: NSPoint(x: 5, y: 6))
        p.appendArc(withCenter: NSPoint(x: 7, y: 6), radius: 2, startAngle: 180, endAngle: 270)
        p.line(to: NSPoint(x: 15, y: 4))
    }
    static let save = make { p in
        p.move(to: NSPoint(x: 12, y: 4)); p.line(to: NSPoint(x: 12, y: 15))
        p.move(to: NSPoint(x: 7, y: 11)); p.line(to: NSPoint(x: 12, y: 16)); p.line(to: NSPoint(x: 17, y: 11))
        p.move(to: NSPoint(x: 5, y: 20)); p.line(to: NSPoint(x: 19, y: 20))
    }
    static let upload = make { p in
        p.move(to: NSPoint(x: 12, y: 16)); p.line(to: NSPoint(x: 12, y: 5))
        p.move(to: NSPoint(x: 7, y: 9)); p.line(to: NSPoint(x: 12, y: 4)); p.line(to: NSPoint(x: 17, y: 9))
        p.move(to: NSPoint(x: 5, y: 20)); p.line(to: NSPoint(x: 19, y: 20))
    }
    static let grip = make(fill: true) { p in
        for x in [9.0, 15.0] { for y in [6.0, 12.0, 18.0] { p.appendOval(in: NSRect(x: x - 1.5, y: y - 1.5, width: 3, height: 3)) } }
    }

    /// An SF Symbol at the bar's icon size.
    static func symbol(_ name: String) -> NSImage? {
        let img = NSImage(systemSymbolName: name, accessibilityDescription: nil)?.withSymbolConfiguration(.init(pointSize: 13, weight: .medium))
        img?.isTemplate = true
        return img
    }

    private static func make(fill: Bool = false, _ build: @escaping (NSBezierPath) -> Void) -> NSImage {
        let img = NSImage(size: NSSize(width: 15, height: 15), flipped: true) { r in
            let p = NSBezierPath()
            build(p)
            var t = AffineTransform()
            t.scale(r.width / 24)
            p.transform(using: t)
            p.lineWidth = 1.8 * r.width / 24
            p.lineCapStyle = .round
            p.lineJoinStyle = .round
            NSColor.black.set()
            fill ? p.fill() : p.stroke()
            return true
        }
        img.isTemplate = true
        return img
    }
}

/// The web editor's `.ebtn`: borderless, 28 pt, a soft fill on hover, an icon and a semibold label, and an optional key hint
/// (`kbd`). `.mini` is its small "Copy link" button; `isOn` its pressed tool look.
@MainActor
class GhostButton: NSView {
    enum Style { case bar, mini }
    var title: String { didSet { changed() } }
    var image: NSImage? { didSet { changed() } }
    var hint: String? { didSet { changed() } }
    var showsLabel = true { didSet { changed() } }
    var isEnabled = true { didSet { needsDisplay = true } }
    var isOn = false { didSet { needsDisplay = true } }
    var onClick: (() -> Void)?
    let style: Style
    private var hovering = false { didSet { needsDisplay = true } }
    private var pressed = false { didSet { needsDisplay = true } }

    init(_ title: String, image: NSImage? = nil, hint: String? = nil, style: Style = .bar, onClick: (() -> Void)? = nil) {
        self.title = title
        self.image = image
        self.hint = hint
        self.style = style
        self.onClick = onClick
        super.init(frame: .zero)
        setContentHuggingPriority(.required, for: .horizontal)
        setContentCompressionResistancePriority(.required, for: .horizontal)
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel(title)
    }
    required init?(coder: NSCoder) { nil }

    private func changed() {
        invalidateIntrinsicContentSize()
        needsDisplay = true
        setAccessibilityLabel(title)
    }

    private var labelShown: Bool { showsLabel && !title.isEmpty }
    private var font: NSFont { .systemFont(ofSize: style == .mini ? 11.5 : 12.5, weight: .semibold) }
    private var hintFont: NSFont { .systemFont(ofSize: 11, weight: .medium) }
    private var pad: CGFloat { style == .mini ? 8 : (labelShown ? 9 : 6.5) }

    override var intrinsicContentSize: NSSize {
        var w = pad * 2
        if image != nil { w += 15 }
        if labelShown {
            if image != nil { w += 6 }
            w += ceil((title as NSString).size(withAttributes: [.font: font]).width)
            if let h = hint { w += 6 + ceil((h as NSString).size(withAttributes: [.font: hintFont]).width) }
        }
        return NSSize(width: max(style == .mini ? 0 : 28, w), height: style == .mini ? 20 : 28)
    }

    override func draw(_ dirtyRect: NSRect) {
        let r = bounds
        let shape = NSBezierPath(roundedRect: r, xRadius: style == .mini ? 6 : 7, yRadius: style == .mini ? 6 : 7)
        if style == .mini {
            (hovering && isEnabled ? EditorStyle.borderStrong : EditorStyle.surface3).setFill()
            shape.fill()
        } else if isOn {
            EditorStyle.accentSoft.setFill()
            shape.fill()
        } else if isEnabled && (hovering || pressed) {
            (pressed ? EditorStyle.borderStrong : EditorStyle.surface3).setFill()
            shape.fill()
        }
        let color = !isEnabled ? EditorStyle.text3 : isOn ? EditorStyle.accentText : EditorStyle.text
        var x = labelShown ? pad : (r.width - 15) / 2
        if let img = image {
            let box = NSRect(x: x, y: r.midY - 7.5, width: 15, height: 15)
            drawTinted(img, in: box, color: color)
            x += 15 + 6
        }
        guard labelShown else { return }
        if image == nil { x = pad }
        let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color]
        let size = (title as NSString).size(withAttributes: attrs)
        (title as NSString).draw(at: NSPoint(x: x, y: r.midY - size.height / 2), withAttributes: attrs)
        if let h = hint {
            let ha: [NSAttributedString.Key: Any] = [.font: hintFont, .foregroundColor: isEnabled ? EditorStyle.text2 : EditorStyle.text3]
            let hs = (h as NSString).size(withAttributes: ha)
            (h as NSString).draw(at: NSPoint(x: x + ceil(size.width) + 6, y: r.midY - hs.height / 2), withAttributes: ha)
        }
    }

    /// A template image in `color`, aspect-fit and centred in `box`.
    private func drawTinted(_ img: NSImage, in box: NSRect, color: NSColor) {
        let k = min(box.width / max(1, img.size.width), box.height / max(1, img.size.height), 1.2)
        let s = NSSize(width: img.size.width * k, height: img.size.height * k)
        let dst = NSRect(x: box.midX - s.width / 2, y: box.midY - s.height / 2, width: s.width, height: s.height)
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        ctx.saveGState()
        ctx.beginTransparencyLayer(in: dst, auxiliaryInfo: nil)
        img.draw(in: dst)
        color.setFill()
        dst.fill(using: .sourceAtop)
        ctx.endTransparencyLayer()
        ctx.restoreGState()
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for t in trackingAreas { removeTrackingArea(t) }
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self))
    }
    override func mouseEntered(with event: NSEvent) { hovering = true }
    override func mouseExited(with event: NSEvent) { hovering = false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) { if isEnabled { pressed = true } }
    override func mouseDragged(with event: NSEvent) {
        guard isEnabled else { return }
        pressed = bounds.contains(convert(event.locationInWindow, from: nil))
    }
    override func mouseUp(with event: NSEvent) {
        let inside = bounds.contains(convert(event.locationInWindow, from: nil))
        let was = pressed
        pressed = false
        if was && inside && isEnabled { onClick?() }
    }
    override func accessibilityPerformPress() -> Bool {
        guard isEnabled else { return false }
        onClick?()
        return true
    }
}

/// The web editor's toast: a small rounded card above the bottom of the canvas that fades after a moment.
@MainActor
final class ToastView: NSView {
    private let label = NSTextField(labelWithString: "")
    private let actionButton = NSButton(title: "", target: nil, action: nil)
    private var action: (() -> Void)?
    private var labelToEdge: NSLayoutConstraint!
    private var labelToButton: NSLayoutConstraint!
    private var token = 0

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        alphaValue = 0
        isHidden = true
        label.font = .systemFont(ofSize: 13)
        label.textColor = EditorStyle.text
        label.lineBreakMode = .byTruncatingTail
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        actionButton.isBordered = false
        actionButton.font = .systemFont(ofSize: 13, weight: .semibold)
        actionButton.target = self
        actionButton.action = #selector(actionPressed)
        actionButton.isHidden = true
        actionButton.translatesAutoresizingMaskIntoConstraints = false
        addSubview(actionButton)
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        labelToEdge = label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14)
        labelToButton = label.trailingAnchor.constraint(equalTo: actionButton.leadingAnchor, constant: -12)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
            labelToEdge,
            label.topAnchor.constraint(equalTo: topAnchor, constant: 8),
            label.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -8),
            actionButton.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
            actionButton.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
        shadow = NSShadow()
        layer?.shadowOpacity = 0.22
        layer?.shadowRadius = 11
        layer?.shadowOffset = CGSize(width: 0, height: -6)
        setAccessibilityRole(.staticText)
    }
    required init?(coder: NSCoder) { nil }

    override func draw(_ dirtyRect: NSRect) {
        let p = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 10, yRadius: 10)
        EditorStyle.menuBg.setFill()
        p.fill()
        EditorStyle.border.setStroke()
        p.lineWidth = 1
        p.stroke()
    }

    @objc private func actionPressed() { action?() }

    /// `action`: a button on the card (it stays up a little longer so it can be reached).
    func show(_ text: String, action: (title: String, run: () -> Void)? = nil) {
        label.stringValue = text
        self.action = action?.run
        actionButton.isHidden = action == nil
        actionButton.attributedTitle = NSAttributedString(string: action?.title ?? "", attributes: [
            .font: NSFont.systemFont(ofSize: 13, weight: .semibold), .foregroundColor: EditorStyle.accentText])
        labelToEdge.isActive = action == nil
        labelToButton.isActive = action != nil
        token += 1
        let t = token
        isHidden = false
        NSAccessibility.post(element: self, notification: .announcementRequested,
                             userInfo: [.announcement: text, .priority: NSAccessibilityPriorityLevel.high.rawValue])
        NSAnimationContext.runAnimationGroup { $0.duration = 0.14; animator().alphaValue = 1 }
        DispatchQueue.main.asyncAfter(deadline: .now() + (action == nil ? 2.8 : 5)) { [weak self] in
            guard let self, self.token == t else { return }
            NSAnimationContext.runAnimationGroup({ $0.duration = 0.2; self.animator().alphaValue = 0 }) {
                MainActor.assumeIsolated { if self.token == t { self.isHidden = true } }
            }
        }
    }
}

/// The web editor's floating properties card (`.floating`): a rounded surface with a shadow, over the top of the canvas.
@MainActor
final class FloatingBar: NSView {
    let stack = NSStackView()

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.shadowOpacity = 0.18
        layer?.shadowRadius = 11
        layer?.shadowOffset = CGSize(width: 0, height: -4)
        stack.spacing = 4
        stack.edgeInsets = NSEdgeInsets(top: 5, left: 8, bottom: 5, right: 8)
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor), stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor), stack.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }
    required init?(coder: NSCoder) { nil }

    override func draw(_ dirtyRect: NSRect) {
        let p = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 12, yRadius: 12)
        EditorStyle.surface.setFill()
        p.fill()
        EditorStyle.border.setStroke()
        p.stroke()
    }

    /// A thin divider between groups.
    func divider() -> NSView {
        let v = FillView(EditorStyle.borderStrong)
        v.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([v.widthAnchor.constraint(equalToConstant: 1), v.heightAnchor.constraint(equalToConstant: 18)])
        return v
    }
}

/// A colour swatch: a filled circle, ringed in the accent colour when it's the current one.
@MainActor
final class SwatchButton: GhostButton {
    let rgb: UInt32
    init(name: String, rgb: UInt32, onClick: @escaping () -> Void) {
        self.rgb = rgb
        super.init(name, onClick: onClick)
        showsLabel = false
        toolTip = name
    }
    required init?(coder: NSCoder) { nil }
    override var intrinsicContentSize: NSSize { NSSize(width: 24, height: 24) }
    override func draw(_ dirtyRect: NSRect) {
        let r = NSRect(x: bounds.midX - 8, y: bounds.midY - 8, width: 16, height: 16)
        if isOn {
            let ring = NSBezierPath(ovalIn: r.insetBy(dx: -3, dy: -3))
            ring.lineWidth = 2
            EditorStyle.accentText.setStroke()
            ring.stroke()
        }
        let c = NSBezierPath(ovalIn: r)
        (NSColor(cgColor: AnnotationStyle.cgColor(rgb)) ?? .black).setFill()
        c.fill()
        EditorStyle.borderStrong.setStroke()
        c.lineWidth = 1
        c.stroke()
    }
}
