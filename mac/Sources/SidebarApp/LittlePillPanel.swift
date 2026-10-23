import AppKit

/// The button itself: transparent (so Chrome's title bar shows through) with a subtle rounded hover fill.
/// Reports clicks (the panel never becomes key).
@MainActor
private final class LittlePillView: NSView {
    var onClick: (() -> Void)?
    var onHover: ((Bool) -> Void)?

    override var isFlipped: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for a in trackingAreas { removeTrackingArea(a) }
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                                       owner: self, userInfo: nil))
    }

    override func mouseEntered(with event: NSEvent) { onHover?(true) }
    override func mouseExited(with event: NSEvent) { onHover?(false) }

    override func mouseDown(with event: NSEvent) {
        onClick?()
    }
}

/// v3.0: small non-activating button in the title bar of a little window (right side, vertically centred):
/// "Open in Chrome" with an arrow-up-right icon, 22 pt high, no shadow, tooltip "Open as a tab (⌘O)".
/// Clicking it promotes the little window's page to a real tab.
@MainActor
final class LittlePillPanel: NSPanel {
    static let height: CGFloat = 22

    private(set) var pillSize = NSSize(width: 110, height: LittlePillPanel.height)

    /// Called when the button is clicked.
    var onClick: (() -> Void)?

    private let pill = LittlePillView(frame: .zero)
    private let label = NSTextField(labelWithString: "Open in Chrome")
    private let icon = NSImageView(frame: .zero)

    init() {
        super.init(contentRect: NSRect(x: 0, y: 0, width: 110, height: LittlePillPanel.height),
                   styleMask: [.borderless, .nonactivatingPanel],
                   backing: .buffered,
                   defer: false)
        hidesOnDeactivate = false
        isFloatingPanel = false
        level = .normal
        collectionBehavior = [.managed, .ignoresCycle]
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        isReleasedWhenClosed = false
        animationBehavior = .none
        isMovable = false

        pill.wantsLayer = true
        pill.layer?.cornerRadius = 6
        pill.layer?.masksToBounds = true
        pill.toolTip = "Open as a tab (\u{2318}O)"
        pill.onClick = { [weak self] in self?.onClick?() }
        pill.onHover = { [weak self] on in self?.setHover(on) }

        label.font = NSFont.systemFont(ofSize: 11, weight: .medium)
        label.textColor = .secondaryLabelColor
        label.lineBreakMode = .byClipping
        label.isSelectable = false
        pill.addSubview(label)

        if let img = NSImage(systemSymbolName: "arrow.up.right", accessibilityDescription: "Open in Chrome") {
            icon.image = img.withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: 9, weight: .semibold))
        }
        icon.contentTintColor = .secondaryLabelColor
        pill.addSubview(icon)

        layoutPill()
        contentView = pill
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    private func setHover(_ on: Bool) {
        let fill: NSColor = on ? NSColor.labelColor.withAlphaComponent(0.10) : .clear
        pill.layer?.backgroundColor = fill.cgColor
        let text: NSColor = on ? .labelColor : .secondaryLabelColor
        label.textColor = text
        icon.contentTintColor = text
    }

    /// [label][icon] left to right, 8 pt padding.
    private func layoutPill() {
        let h = Self.height
        let labelW = ceil(label.intrinsicContentSize.width)
        let labelH = ceil(label.intrinsicContentSize.height)
        let iconSide: CGFloat = 11
        var x: CGFloat = 8
        label.frame = NSRect(x: x, y: (h - labelH) / 2, width: labelW, height: labelH)
        x += labelW + 4
        icon.frame = NSRect(x: x, y: (h - iconSide) / 2, width: iconSide, height: iconSide)
        x += iconSide + 8
        pillSize = NSSize(width: x, height: h)
        pill.frame = NSRect(origin: .zero, size: pillSize)
        setContentSize(pillSize)
    }

    func hide() {
        if isVisible { orderOut(nil) }
        setHover(false)
    }

    func teardown() {
        hide()
        close()
    }
}
