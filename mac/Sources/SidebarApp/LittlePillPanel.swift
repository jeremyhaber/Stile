import AppKit

/// The pill itself: a material-backed rounded view that reports clicks (the panel never becomes key).
@MainActor
private final class LittlePillView: NSVisualEffectView {
    var onClick: (() -> Void)?

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }

    override func mouseDown(with event: NSEvent) {
        onClick?()
    }
}

/// Small non-activating pill at the top-right inside a little window: "Open as tab  \u{2318}O".
/// Same look as the setup notice pill. Clicking it promotes the little window's link to a real tab.
@MainActor
final class LittlePillPanel: NSPanel {
    private(set) var pillSize = NSSize(width: 110, height: 28)

    /// Called when the pill is clicked.
    var onClick: (() -> Void)?

    private let pill = LittlePillView(frame: .zero)
    private let label = NSTextField(labelWithString: "Open as tab")
    private let shortcut = NSTextField(labelWithString: "\u{2318}O")

    init() {
        super.init(contentRect: NSRect(x: 0, y: 0, width: 110, height: 28),
                   styleMask: [.borderless, .nonactivatingPanel],
                   backing: .buffered,
                   defer: false)
        hidesOnDeactivate = false
        isFloatingPanel = false
        level = .normal
        collectionBehavior = [.managed, .ignoresCycle]
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        isReleasedWhenClosed = false
        animationBehavior = .none
        isMovable = false

        pill.material = .popover
        pill.blendingMode = .behindWindow
        pill.state = .active
        pill.wantsLayer = true
        pill.layer?.cornerRadius = 14
        pill.layer?.masksToBounds = true
        pill.onClick = { [weak self] in self?.onClick?() }

        label.font = NSFont.systemFont(ofSize: 11)
        label.textColor = .labelColor
        label.lineBreakMode = .byClipping
        label.isSelectable = false
        pill.addSubview(label)

        shortcut.font = NSFont.systemFont(ofSize: 11)
        shortcut.textColor = .secondaryLabelColor
        shortcut.lineBreakMode = .byClipping
        shortcut.isSelectable = false
        pill.addSubview(shortcut)

        layoutPill()
        contentView = pill
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    /// [label][shortcut] left to right.
    private func layoutPill() {
        let h: CGFloat = 28
        let labelW = ceil(label.intrinsicContentSize.width)
        let labelH = ceil(label.intrinsicContentSize.height)
        let scW = ceil(shortcut.intrinsicContentSize.width)
        let scH = ceil(shortcut.intrinsicContentSize.height)
        var x: CGFloat = 12
        label.frame = NSRect(x: x, y: (h - labelH) / 2, width: labelW, height: labelH)
        x += labelW + 6
        shortcut.frame = NSRect(x: x, y: (h - scH) / 2, width: scW, height: scH)
        x += scW + 12
        pillSize = NSSize(width: x, height: h)
        pill.frame = NSRect(origin: .zero, size: pillSize)
        setContentSize(pillSize)
    }

    func hide() {
        if isVisible { orderOut(nil) }
    }

    func teardown() {
        hide()
        close()
    }
}
