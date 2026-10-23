import AppKit
import ApplicationServices

enum SidebarState {
    case hidden
    case peek
    case pinned

    var name: String {
        switch self {
        case .hidden: return "hidden"
        case .peek: return "peek"
        case .pinned: return "pinned"
        }
    }
}

/// One per Chrome window: owns the tab-strip cover and the sidebar panel and follows the window.
@MainActor
final class OverlayController {
    let key: Int
    private(set) var window: ChromeWindow
    let cover = TopCoverPanel()
    let sidebar = SidebarPanel()

    private(set) var state: SidebarState = .hidden
    private var visible = false
    private var chromeFrontmost = false
    private var busy = false
    private var animating = false
    private var animToken = 0
    private var resizing = false

    private var tabH: CGFloat = 40
    private var trafficW: CGFloat = 78
    private var metricsAt = Date.distantPast
    private var metricsOverride = -1
    private var metricsDetected = false

    private var pinnedPush = false      // geometry mode captured when pinned
    private var shrunkBy: CGFloat = 0   // how much we shrank Chrome's window from the left
    private var sidebarWidth: CGFloat = Settings.sidebarWidth

    private var themeColor: NSColor?
    private var themeDark = CoverView.systemIsDark()

    private var bridge: ProfileBridge?
    private var chromeWindowId: Int?

    private let dwell = OneShot()
    private let hideTimer = OneShot()
    private var dragOrigin = CGPoint.zero

    /// Tell the manager that a geometry change was made locally (so it runs the follow timer).
    var onLocalGeometryChange: (() -> Void)?

    init(window: ChromeWindow) {
        self.key = window.key
        self.window = window
        wireUp()
    }

    private func wireUp() {
        cover.coverView.onToggleSidebar = { [weak self] in
            guard let self = self else { return }
            self.setPinned(self.state != .pinned)
        }
        cover.coverView.onNewTab = { [weak self] in self?.newTab() }
        cover.coverView.onDragBegan = { [weak self] in
            guard let self = self else { return }
            self.dragOrigin = self.window.frame.origin
        }
        cover.coverView.onDrag = { [weak self] delta in self?.dragWindow(by: delta) }
        cover.coverView.onDoubleClick = { [weak self] in self?.doubleClickTitleBar() }

        sidebar.onHost = { [weak self] action, value in self?.handleHost(action, value) }
        sidebar.onBridgeCall = { [weak self] call in self?.pageCalled(call) }
        sidebar.onDidBecomeKey = { [weak self] in self?.reorderSidebar() }
        sidebar.onResizeBegan = { [weak self] in self?.resizing = true }
        sidebar.onResize = { [weak self] w in self?.liveResize(to: w) }
        sidebar.onResizeEnded = { [weak self] in
            guard let self = self else { return }
            self.resizing = false
            Settings.sidebarWidth = self.sidebarWidth
        }
    }

    // MARK: Lifecycle

    func teardown() {
        dwell.cancel()
        hideTimer.cancel()
        if state == .pinned { restoreWindowFromPush() }
        cover.orderOut(nil)
        sidebar.teardown()
    }

    func attach(_ mapping: WindowMapper.Mapping?) {
        if let m = mapping, !m.bridge.closed {
            if bridge !== m.bridge || chromeWindowId != m.windowId {
                bridge = m.bridge
                chromeWindowId = m.windowId
                sidebar.connect(bridge: m.bridge, windowId: m.windowId)
            }
        } else if bridge != nil || chromeWindowId != nil {
            bridge = nil
            chromeWindowId = nil
            sidebar.showWaiting()
            cover.coverView.setTitle("")
        }
    }

    func update(window w: ChromeWindow, chromeFrontmost f: Bool) {
        let wasVisible = visible
        window = w
        chromeFrontmost = f
        visible = w.visible
        if !visible {
            hideAll()
            return
        }
        refreshMetrics(force: !wasVisible)
        layout()
    }

    func settingsChanged() {
        sidebarWidth = Settings.sidebarWidth
        if state == .pinned {
            let wantPush = Settings.pinMode == "push"
            if wantPush != pinnedPush {
                restoreWindowFromPush()
                applyPinGeometry()
            } else if pinnedPush && shrunkBy > 0 {
                adjustShrink(toWidth: sidebarWidth)
            }
        }
        refreshMetrics(force: true)
        layout()
        pushHostState()
    }

    // MARK: Metrics

    private func refreshMetrics(force: Bool) {
        let override = Settings.tabBarHeight
        if override != metricsOverride { metricsOverride = override; metricsAt = .distantPast }
        let stale = !metricsDetected && Date().timeIntervalSince(metricsAt) > 4
        guard force || stale else { return }
        metricsAt = Date()
        metricsDetected = false
        if override > 0 {
            tabH = CGFloat(override)
            metricsDetected = true
        } else if let top = AX.toolbarTop(in: window.element, maxDepth: 6, maxNodes: 150) {
            let h = top - window.frame.minY
            if (20...80).contains(h) {
                tabH = h
                metricsDetected = true
            } else {
                tabH = 40
            }
        } else {
            tabH = 40
        }
        if let zoom = AX.element(window.element, AXName.zoomButton), let zf = AX.frame(zoom) {
            let w = zf.maxX - window.frame.minX + 8
            trafficW = (40...200).contains(w) ? w : 78
        } else {
            trafficW = 78
        }
    }

    // MARK: Geometry

    private var windowAX: CGRect { window.frame }

    private func sidebarAXRect(width: CGFloat? = nil) -> CGRect {
        let w = windowAX
        let sw = width ?? sidebarWidth
        if state == .pinned && pinnedPush {
            return CGRect(x: w.minX - sw, y: w.minY, width: sw, height: w.height)
        }
        return CGRect(x: w.minX, y: w.minY + tabH, width: sw, height: max(0, w.height - tabH))
    }

    private var edgeZoneNS: CGRect {
        let w = windowAX
        return Geometry.flip(CGRect(x: w.minX, y: w.minY + tabH, width: 4, height: max(0, w.height - tabH)))
    }

    private func orderAbove(_ panel: NSPanel) {
        if window.cgID != 0 {
            panel.order(.above, relativeTo: Int(window.cgID))
        } else {
            panel.orderFront(nil)
        }
    }

    private func reorderSidebar() {
        guard visible, state != .hidden else { return }
        orderAbove(sidebar)
    }

    func layout() {
        guard visible else { return }
        let w = windowAX
        if Settings.coverEnabled {
            let r = CGRect(x: w.minX + trafficW, y: w.minY, width: max(0, w.width - trafficW), height: tabH)
            cover.setFrame(Geometry.flip(r), display: true)
            orderAbove(cover)
        } else {
            cover.orderOut(nil)
        }

        switch state {
        case .hidden:
            if !animating { sidebar.orderOut(nil) }
        case .peek, .pinned:
            if !animating {
                let target = Geometry.flip(sidebarAXRect())
                sidebar.setFrame(target, display: true)
                sidebar.fitContent(width: target.width)
                orderAbove(sidebar)
            }
        }
    }

    private func hideAll() {
        dwell.cancel()
        hideTimer.cancel()
        animToken += 1
        animating = false
        if state == .peek { state = .hidden }
        cover.orderOut(nil)
        sidebar.orderOut(nil)
    }

    /// Update from the live AX frame (called at display rate while the window moves).
    func followLiveFrame() {
        guard visible, let f = AX.frame(window.element), f != window.frame else { return }
        window.frame = f
        layout()
    }

    // MARK: State

    func setPinned(_ on: Bool) {
        if on {
            guard state != .pinned else { return }
            dwell.cancel()
            hideTimer.cancel()
            animToken += 1
            animating = false
            applyPinGeometry()
            state = .pinned
        } else {
            guard state == .pinned else { return }
            restoreWindowFromPush()
            state = .peek
            animToken += 1
            animating = false
            scheduleHideIfOutside()
        }
        layout()
        pushHostState()
    }

    private func showPeek() {
        guard state == .hidden, visible else { return }
        state = .peek
        let target = Geometry.flip(sidebarAXRect())
        var start = target
        if !sidebar.isVisible { start.size.width = 1 } else { start = sidebar.frame }
        sidebar.setFrame(start, display: false)
        sidebar.fitContent(width: target.width)
        orderAbove(sidebar)
        animateSidebar(to: target, duration: 0.14) { [weak self] in self?.layout() }
        pushHostState()
    }

    private func hidePeek() {
        guard state == .peek else { return }
        state = .hidden
        var end = sidebar.frame
        end.size.width = 1
        animateSidebar(to: end, duration: 0.12) { [weak self] in
            guard let self = self else { return }
            if self.state == .hidden { self.sidebar.orderOut(nil) }
        }
        pushHostState()
    }

    private func animateSidebar(to target: NSRect, duration: TimeInterval, completion: @escaping @MainActor () -> Void) {
        animating = true
        animToken += 1
        let token = animToken
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = duration
            ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
            self.sidebar.animator().setFrame(target, display: true)
        }, completionHandler: { [weak self] in
            Task { @MainActor in
                guard let self = self, self.animToken == token else { return }
                self.animating = false
                completion()
            }
        })
    }

    // MARK: Pin geometry (push mode)

    private func applyPinGeometry() {
        pinnedPush = Settings.pinMode == "push"
        shrunkBy = 0
        guard pinnedPush else { return }
        let f = window.frame
        let sw = sidebarWidth
        let visibleMinX = Geometry.screen(forAXRect: f)?.visibleFrame.minX ?? 0
        if f.minX - sw >= visibleMinX { return }   // free space on the left; nothing to resize

        let newWidth = f.width - sw
        guard newWidth >= 400 else {
            pinnedPush = false                      // window too small to push; float instead
            return
        }
        AX.setPosition(window.element, CGPoint(x: f.minX + sw, y: f.minY))
        AX.setSize(window.element, CGSize(width: newWidth, height: f.height))
        if let actual = AX.frame(window.element) {
            // Chrome may have refused the full shrink (minimum width). Keep the right edge in place.
            if abs(actual.maxX - f.maxX) > 1 {
                AX.setPosition(window.element, CGPoint(x: f.maxX - actual.width, y: f.minY))
            }
            let now = AX.frame(window.element) ?? actual
            shrunkBy = max(0, now.minX - f.minX)
            window.frame = now
        } else {
            shrunkBy = sw
        }
        onLocalGeometryChange?()
    }

    private func adjustShrink(toWidth newW: CGFloat) {
        let delta = newW - shrunkBy
        guard abs(delta) >= 1, let f = AX.frame(window.element) else { return }
        let nw = f.width - delta
        guard nw >= 400 else { return }
        AX.setPosition(window.element, CGPoint(x: f.minX + delta, y: f.minY))
        AX.setSize(window.element, CGSize(width: nw, height: f.height))
        if let now = AX.frame(window.element) {
            shrunkBy = max(0, shrunkBy + (now.minX - f.minX))
            window.frame = now
        }
        onLocalGeometryChange?()
    }

    private func restoreWindowFromPush() {
        defer { shrunkBy = 0 }
        guard shrunkBy > 0, let f = AX.frame(window.element) else { return }
        AX.setPosition(window.element, CGPoint(x: f.minX - shrunkBy, y: f.minY))
        AX.setSize(window.element, CGSize(width: f.width + shrunkBy, height: f.height))
        if let now = AX.frame(window.element) { window.frame = now }
        onLocalGeometryChange?()
    }

    private func liveResize(to proposed: CGFloat) {
        let w = min(max(proposed, Settings.minWidth), Settings.maxWidth)
        guard abs(w - sidebarWidth) >= 1 else { return }
        if state == .pinned && pinnedPush && shrunkBy > 0 {
            adjustShrink(toWidth: w)
        }
        sidebarWidth = w
        layout()
    }

    // MARK: Pointer / hover

    private func pointerInsideSidebar(_ p: NSPoint) -> Bool {
        if sidebar.isVisible && sidebar.frame.insetBy(dx: -2, dy: -2).contains(p) { return true }
        return edgeZoneNS.contains(p)
    }

    func pointerMoved(_ p: NSPoint, chromeFrontmost f: Bool) {
        chromeFrontmost = f
        guard visible else { return }
        switch state {
        case .hidden:
            if f && edgeZoneNS.contains(p) {
                if !dwell.isScheduled {
                    dwell.schedule(after: 0.08) { [weak self] in
                        self?.dwell.clear()
                        self?.dwellFired()
                    }
                }
            } else {
                dwell.cancel()
            }
        case .peek:
            if pointerInsideSidebar(p) || resizing {
                hideTimer.cancel()
            } else {
                scheduleHideIfOutside()
            }
        case .pinned:
            break
        }
    }

    private func dwellFired() {
        guard state == .hidden, visible, chromeFrontmost else { return }
        if edgeZoneNS.contains(NSEvent.mouseLocation) { showPeek() }
    }

    private func scheduleHideIfOutside() {
        guard state == .peek, !busy, !hideTimer.isScheduled else { return }
        if pointerInsideSidebar(NSEvent.mouseLocation) { return }
        hideTimer.schedule(after: 0.35) { [weak self] in
            self?.hideTimer.clear()
            self?.evaluatePeekHide()
        }
    }

    private func evaluatePeekHide() {
        guard state == .peek else { return }
        if busy || resizing || pointerInsideSidebar(NSEvent.mouseLocation) { return }
        hidePeek()
    }

    // MARK: Host messages from the web UI

    private func handleHost(_ action: String, _ value: Any?) {
        switch action {
        case "ready", "pageLoaded":
            pushHostState()
        case "setPinned":
            setPinned((value as? Bool) ?? ((value as? NSNumber)?.boolValue ?? false))
        case "setPinMode":
            if let s = value as? String, s == "push" || s == "float" {
                Settings.pinMode = s    // posts a notification; the manager calls settingsChanged on every controller
            }
        case "theme":
            if let d = value as? [String: Any] {
                if let c = d["color"] as? String { themeColor = ColorParse.parse(c) }
                if let dark = d["dark"] as? Bool { themeDark = dark }
                applyTheme()
            }
        case "busy":
            busy = (value as? Bool) ?? ((value as? NSNumber)?.boolValue ?? false)
            if busy { hideTimer.cancel() } else { scheduleHideIfOutside() }
        case "activeTitle":
            if let d = value as? [String: Any] {
                cover.coverView.setTitle((d["title"] as? String) ?? "")
            }
        default:
            break
        }
    }

    private func applyTheme() {
        let base = themeDark ? NSColor(srgbRed: 0.125, green: 0.129, blue: 0.141, alpha: 1)
                             : NSColor(srgbRed: 0.945, green: 0.953, blue: 0.957, alpha: 1)
        let bg = themeColor.map { ColorParse.mix(base, $0, amount: 0.14) } ?? base
        cover.coverView.applyTheme(background: bg, dark: themeDark)
        cover.backgroundColor = bg
    }

    func pushHostState() {
        sidebar.sendHostState(pinned: state == .pinned, pinMode: Settings.pinMode, state: state == .pinned ? "pinned" : "peek")
    }

    // MARK: Actions

    private func newTab() {
        guard let b = bridge, let id = chromeWindowId else { return }
        b.callDetached("tabs.create", [["windowId": id]])
        reassertChrome()
    }

    private func dragWindow(by delta: CGSize) {
        let origin = CGPoint(x: dragOrigin.x + delta.width, y: dragOrigin.y + delta.height)
        if AX.setPosition(window.element, origin) {
            window.frame.origin = origin
            layout()
            onLocalGeometryChange?()
        }
    }

    private func doubleClickTitleBar() {
        let pref = UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") ?? "Maximize"
        switch pref {
        case "Minimize":
            AX.setBool(window.element, AXName.minimized, true)
        case "None":
            break
        default:
            if let zoom = AX.element(window.element, AXName.zoomButton) {
                AX.perform(zoom, AXName.actionPress)
            }
        }
    }

    private func pageCalled(_ call: String) {
        if call == "sidebar.cmd" || call.hasPrefix("tabs.") || call.hasPrefix("windows.") {
            reassertChrome()
        }
    }

    /// If Chrome is no longer frontmost after the page activated something, raise its window again.
    private func reassertChrome() {
        let pid = AX.pid(window.element)
        if NSWorkspace.shared.frontmostApplication?.processIdentifier != pid {
            AX.perform(window.element, AXName.actionRaise)
        }
    }
}
