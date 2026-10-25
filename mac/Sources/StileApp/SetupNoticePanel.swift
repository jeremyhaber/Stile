import AppKit
import WebKit

/// The pill itself: a material-backed rounded view that reports clicks (the panel never becomes key).
@MainActor
private final class NoticePillView: NSVisualEffectView {
    var onClick: (() -> Void)?

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }

    override func mouseDown(with event: NSEvent) {
        onClick?()
    }
}

/// Small non-activating pill anchored bottom-left inside a Chrome window whose profile has no connected
/// extension. Clicking it opens the setup steps (the existing setup card) in a popover above it; the "x"
/// dismisses it for that profile until the app restarts.
@MainActor
final class SetupNoticePanel: NSPanel {
    private static var dismissed = Set<String>()

    static func isDismissed(_ dir: String) -> Bool { dismissed.contains(dir) }

    /// Called after the user dismissed the pill (the controller then re-evaluates visibility).
    var onDismissed: (() -> Void)?

    private(set) var pillSize = NSSize(width: 250, height: 28)
    private var candidates: [(dir: String, name: String)] = []

    private let pill = NoticePillView(frame: .zero)
    private let label = NSTextField(labelWithString: "Stile isn\u{2019}t set up for this profile")
    private let chevron = NSImageView(frame: .zero)
    private let closeButton = NSButton(frame: .zero)

    private var popover: NSPopover?
    private var popoverContent: WKUserContentController?

    init() {
        super.init(contentRect: NSRect(x: 0, y: 0, width: 250, height: 28),
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
        pill.onClick = { [weak self] in self?.togglePopover() }

        label.font = NSFont.systemFont(ofSize: 11)
        label.textColor = .labelColor
        label.lineBreakMode = .byClipping
        label.isSelectable = false
        pill.addSubview(label)

        chevron.image = NSImage(systemSymbolName: "chevron.up", accessibilityDescription: "Show setup steps")
        chevron.contentTintColor = .secondaryLabelColor
        chevron.imageScaling = .scaleProportionallyDown
        pill.addSubview(chevron)

        closeButton.isBordered = false
        closeButton.bezelStyle = .regularSquare
        closeButton.imagePosition = .imageOnly
        closeButton.image = NSImage(systemSymbolName: "xmark", accessibilityDescription: "Dismiss")
        closeButton.contentTintColor = .secondaryLabelColor
        closeButton.toolTip = "Dismiss for this profile until Stile restarts"
        closeButton.target = self
        closeButton.action = #selector(dismissTapped)
        pill.addSubview(closeButton)

        layoutPill()
        contentView = pill
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    /// Fits the label, then lays out [label][chevron][x] left to right.
    private func layoutPill() {
        let h: CGFloat = 28
        let labelW = ceil(label.intrinsicContentSize.width)
        let labelH = ceil(label.intrinsicContentSize.height)
        var x: CGFloat = 12
        label.frame = NSRect(x: x, y: (h - labelH) / 2, width: labelW, height: labelH)
        x += labelW + 6
        chevron.frame = NSRect(x: x, y: (h - 10) / 2, width: 10, height: 10)
        x += 10 + 6
        closeButton.frame = NSRect(x: x, y: (h - 16) / 2, width: 16, height: 16)
        x += 16 + 8
        pillSize = NSSize(width: x, height: h)
        pill.frame = NSRect(origin: .zero, size: pillSize)
    }

    /// Profiles (not yet dismissed) the setup steps should offer.
    func configure(candidates list: [(dir: String, name: String)]) {
        candidates = list
    }

    func hide() {
        closePopover()
        if isVisible { orderOut(nil) }
    }

    func teardown() {
        hide()
        close()
    }

    @objc private func dismissTapped() {
        for c in candidates { Self.dismissed.insert(c.dir) }
        hide()
        onDismissed?()
    }

    // MARK: Setup steps popover

    private func togglePopover() {
        if let p = popover, p.isShown {
            closePopover()
            return
        }
        let ucc = WKUserContentController()
        let trampoline = ScriptMessageTrampoline { [weak self] body in self?.popoverMessage(body) }
        ucc.add(trampoline, name: "sidebarBridge")
        let config = WKWebViewConfiguration()
        config.userContentController = ucc
        let size = NSSize(width: 320, height: 260)
        let web = FirstMouseWebView(frame: NSRect(origin: .zero, size: size), configuration: config)
        web.loadHTMLString(SetupCard.html(candidates: candidates), baseURL: nil)
        let vc = NSViewController()
        vc.view = web
        let pop = NSPopover()
        pop.behavior = .transient
        pop.animates = false
        pop.contentSize = size
        pop.contentViewController = vc
        popover = pop
        popoverContent = ucc
        // Non-flipped view: .maxY is the top edge, so the popover sits above the pill.
        pop.show(relativeTo: pill.bounds, of: pill, preferredEdge: .maxY)
    }

    private func closePopover() {
        popover?.close()
        popover = nil
        popoverContent?.removeScriptMessageHandler(forName: "sidebarBridge")
        popoverContent = nil
    }

    private func popoverMessage(_ body: Any) {
        guard let s = body as? String, let data = s.data(using: .utf8),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              (obj["type"] as? String) == "host" else { return }
        switch obj["action"] as? String {
        case "openExtensions":
            if let dir = obj["value"] as? String, !dir.isEmpty { HostActions.openExtensionsPage(profileDir: dir) }
        case "openStore":
            if let dir = obj["value"] as? String, !dir.isEmpty { HostActions.openStorePage(profileDir: dir) }
        case "revealExtension":
            HostActions.revealExtensionFolder()
        default:
            break
        }
    }
}
