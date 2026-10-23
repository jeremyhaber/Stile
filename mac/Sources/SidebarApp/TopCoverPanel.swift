import AppKit

@MainActor
final class CoverView: NSView {
    var onToggleSidebar: (() -> Void)?
    var onNewTab: (() -> Void)?
    var onDragBegan: (() -> Void)?
    var onDrag: ((CGSize) -> Void)?
    var onDoubleClick: (() -> Void)?

    private let toggleButton = NSButton()
    private let plusButton = NSButton()
    private let titleLabel = NSTextField(labelWithString: "")
    private var dragStart: NSPoint?
    private var fillColor = NSColor.windowBackgroundColor

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true

        configure(toggleButton, symbol: "sidebar.left", label: "Toggle sidebar", action: #selector(toggleTapped))
        configure(plusButton, symbol: "plus", label: "New tab", action: #selector(plusTapped))
        addSubview(toggleButton)
        addSubview(plusButton)

        titleLabel.alignment = .center
        titleLabel.lineBreakMode = .byTruncatingTail
        titleLabel.font = NSFont.systemFont(ofSize: 12)
        titleLabel.isSelectable = false
        addSubview(titleLabel)
        applyTheme(background: NSColor.windowBackgroundColor, dark: Self.systemIsDark())
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) not supported") }

    private func configure(_ b: NSButton, symbol: String, label: String, action: Selector) {
        b.isBordered = false
        b.bezelStyle = .regularSquare
        b.imagePosition = .imageOnly
        b.image = NSImage(systemSymbolName: symbol, accessibilityDescription: label)
        b.target = self
        b.action = action
        b.setAccessibilityLabel(label)
        b.toolTip = label
    }

    static func systemIsDark() -> Bool {
        NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
    }

    func applyTheme(background: NSColor, dark: Bool) {
        fillColor = background
        layer?.backgroundColor = background.cgColor
        let fg = dark ? NSColor(white: 1, alpha: 0.85) : NSColor(white: 0, alpha: 0.75)
        titleLabel.textColor = fg
        toggleButton.contentTintColor = fg
        plusButton.contentTintColor = fg
    }

    func setTitle(_ s: String) {
        titleLabel.stringValue = s
    }

    override func layout() {
        super.layout()
        let h = bounds.height
        let bh: CGFloat = 24
        toggleButton.frame = NSRect(x: 6, y: (h - bh) / 2, width: 28, height: bh)
        plusButton.frame = NSRect(x: bounds.width - 34, y: (h - bh) / 2, width: 28, height: bh)
        let margin: CGFloat = 44
        let tw = max(0, bounds.width - margin * 2)
        let th = titleLabel.intrinsicContentSize.height
        titleLabel.frame = NSRect(x: margin, y: (h - th) / 2, width: tw, height: th)
    }

    @objc private func toggleTapped() { onToggleSidebar?() }
    @objc private func plusTapped() { onNewTab?() }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }

    override func mouseDown(with event: NSEvent) {
        if event.clickCount >= 2 {
            dragStart = nil
            onDoubleClick?()
            return
        }
        dragStart = NSEvent.mouseLocation
        onDragBegan?()
    }

    override func mouseDragged(with event: NSEvent) {
        guard let start = dragStart else { return }
        let now = NSEvent.mouseLocation
        // Screen (NS) y grows upward; AX y grows downward.
        onDrag?(CGSize(width: now.x - start.x, height: -(now.y - start.y)))
    }

    override func mouseUp(with event: NSEvent) {
        dragStart = nil
    }
}

/// Borderless, non-activating panel that covers Chrome's tab strip.
@MainActor
final class TopCoverPanel: NSPanel {
    let coverView = CoverView(frame: .zero)

    init() {
        super.init(contentRect: NSRect(x: 0, y: 0, width: 200, height: 40),
                   styleMask: [.borderless, .nonactivatingPanel],
                   backing: .buffered,
                   defer: false)
        hidesOnDeactivate = false
        isFloatingPanel = false
        level = .normal
        collectionBehavior = [.managed, .ignoresCycle]
        isOpaque = true
        hasShadow = false
        isReleasedWhenClosed = false
        animationBehavior = .none
        isMovable = false
        backgroundColor = NSColor.windowBackgroundColor
        contentView = coverView
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}
