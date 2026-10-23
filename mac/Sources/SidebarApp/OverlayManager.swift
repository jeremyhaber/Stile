import AppKit

/// Owns the tracker, the window mapper and one OverlayController per Chrome window.
@MainActor
final class OverlayManager {
    let server: HostServer
    let tracker = ChromeTracker()
    let mapper = WindowMapper()
    private(set) var controllers: [Int: OverlayController] = [:]

    private var followTimer: Timer?
    private var displayLink: AnyObject?     // CADisplayLink on macOS 14+
    private var followActive = false
    private var followLastActivity = Date.distantPast
    private var railTimer: Timer?
    private var lastFocusedKey: Int?
    private var tickCount = 0
    private var monitors: [Any] = []
    private var bridgeSubscriptions: [UUID: (ProfileBridge, UUID)] = [:]
    private var observers: [NSObjectProtocol] = []
    private var started = false

    init(server: HostServer) {
        self.server = server
    }

    func start() {
        if started { return }
        started = true

        mapper.windowsProvider = { [weak self] in self?.tracker.windows ?? [] }
        mapper.bridgesProvider = { [weak self] in self?.server.identified ?? [] }
        mapper.onChange = { [weak self] in self?.applyMapping() }

        tracker.onUpdate = { [weak self] in self?.trackerUpdated() }
        tracker.start()

        let nc = NotificationCenter.default
        observers.append(nc.addObserver(forName: .sidebarBridgesChanged, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.bridgesChanged() }
        })
        observers.append(nc.addObserver(forName: .sidebarSettingsChanged, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.settingsChanged() }
        })
        observers.append(nc.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.trackerUpdated() }
        })

        let mask: NSEvent.EventTypeMask = [.mouseMoved, .leftMouseDragged]
        if let g = NSEvent.addGlobalMonitorForEvents(matching: mask, handler: { [weak self] _ in
            Task { @MainActor in self?.pointerMoved() }
        }) {
            monitors.append(g)
        }
        if let l = NSEvent.addLocalMonitorForEvents(matching: mask, handler: { [weak self] event in
            Task { @MainActor in self?.pointerMoved() }
            return event
        }) {
            monitors.append(l)
        }
        // Follow on input, not on Chrome's late AX notifications: a left-button press or drag while Chrome is
        // frontmost starts the follow loop immediately.
        if let g = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .leftMouseDragged, .leftMouseUp],
                                                     handler: { [weak self] event in
            let t = event.type
            Task { @MainActor in self?.mouseButtonEvent(t) }
        }) {
            monitors.append(g)
        }
        // Chrome re-tints its frame when the system appearance changes.
        observers.append(DistributedNotificationCenter.default().addObserver(
            forName: Notification.Name("AppleInterfaceThemeChangedNotification"), object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.appearanceChanged() }
        })
        let rt = Timer(timeInterval: 1.0, target: self, selector: #selector(secondTick), userInfo: nil, repeats: true)
        RunLoop.main.add(rt, forMode: .common)
        railTimer = rt
        bridgesChanged()
    }

    /// Once a second: re-validate rails (and re-scan while unmatched), host state, missing-extension cards.
    @objc private func secondTick() {
        if followActive { return }   // nothing expensive while following
        tickCount += 1
        let quiet = Date().timeIntervalSince(tracker.lastGeometryEvent) < 0.5
        if tickCount % 5 == 0, !server.identified.isEmpty, controllers.values.contains(where: { $0.isUnmapped }) {
            mapper.schedule()   // retry matching windows to extension windows
        }
        var candidates: [(dir: String, name: String)]?
        for c in controllers.values {
            c.railTick(quiet: quiet)
            if tickCount % 5 == 0 { c.sampleColor(push: false) }   // cheap; only pushed when it changed
            if c.needsSetupCheck {
                if candidates == nil { candidates = server.missingProfiles() }
                c.applySetup(candidates: candidates ?? [])
            }
            c.pushHostState()
        }
    }

    // MARK: Events

    private func bridgesChanged() {
        // Subscribe to window events on each bridge once; drop subscriptions of closed bridges.
        let live = server.identified
        for b in live where bridgeSubscriptions[b.id] == nil {
            let token = b.addSubscriber { [weak self] msg in
                guard (msg["type"] as? String) == "bridgeEvent",
                      let name = msg["name"] as? String, name.hasPrefix("windows.") else { return }
                self?.mapper.schedule()
            }
            bridgeSubscriptions[b.id] = (b, token)
        }
        for (id, entry) in bridgeSubscriptions where entry.0.closed {
            bridgeSubscriptions.removeValue(forKey: id)
        }
        mapper.schedule()
        applyMapping()
    }

    private func settingsChanged() {
        for c in controllers.values { c.settingsChanged() }
    }

    private func trackerUpdated() {
        let wins = tracker.windows
        let focusedNow = tracker.focusedWindowKey()
        var seen = Set<Int>()
        for w in wins {
            seen.insert(w.key)
            let c: OverlayController
            if let existing = controllers[w.key] {
                c = existing
            } else {
                c = OverlayController(window: w)
                c.onLocalGeometryChange = { [weak self] in
                    guard let self = self else { return }
                    self.tracker.noteGeometryEvent()
                    self.tracker.paused = true   // no AX refreshes until following ends
                    self.followLastActivity = Date()
                    self.startFollowing()
                }
                controllers[w.key] = c
                c.attach(mapper.map[w.key])
            }
            c.isFocusedChromeWindow = (w.key == focusedNow)
            c.update(window: w, chromeFrontmost: tracker.chromeFrontmost)
        }
        for (k, c) in controllers where !seen.contains(k) {
            c.teardown()
            controllers.removeValue(forKey: k)
        }
        mapper.schedule()
        if Date().timeIntervalSince(tracker.lastGeometryEvent) < 0.3 {
            followLastActivity = Date()
            startFollowing()
        }

        // Focus change: look at Chrome's rail again for the newly focused window.
        let focused = tracker.focusedWindowKey()
        if focused != lastFocusedKey {
            lastFocusedKey = focused
            if let k = focused, let c = controllers[k] { c.rescan(reason: "focus change") }
        }
    }

    private func applyMapping() {
        for (k, c) in controllers { c.attach(mapper.map[k]) }
    }

    private func pointerMoved() {
        let p = NSEvent.mouseLocation
        let front = tracker.chromeFrontmost
        for c in controllers.values { c.pointerMoved(p, chromeFrontmost: front) }
    }

    // MARK: Follow loop (display link / 120 Hz while a window is moving or resizing)

    private func mouseButtonEvent(_ type: NSEvent.EventType) {
        switch type {
        case .leftMouseDown, .leftMouseDragged:
            if tracker.chromeFrontmost {
                followLastActivity = Date()
                startFollowing()
            }
        default:
            break
        }
    }

    private func appearanceChanged() {
        // Give Chrome a moment to repaint before sampling.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
            guard let self = self else { return }
            for c in self.controllers.values { c.sampleColor() }
        }
    }

    private func startFollowing() {
        if followActive { return }
        followActive = true
        if #available(macOS 14.0, *), let screen = NSScreen.main ?? NSScreen.screens.first {
            let link = screen.displayLink(target: self, selector: #selector(displayLinkFired(_:)))
            link.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)
            link.add(to: .main, forMode: .common)
            displayLink = link
        } else {
            let t = Timer(timeInterval: 1.0 / 120.0, target: self, selector: #selector(followTick),
                          userInfo: nil, repeats: true)
            RunLoop.main.add(t, forMode: .common)
            followTimer = t
        }
    }

    @available(macOS 14.0, *)
    @objc private func displayLinkFired(_ link: CADisplayLink) {
        followTick()
    }

    @objc private func followTick() {
        guard followActive else { return }
        let visible = controllers.values.filter { $0.window.visible && $0.window.cgID != 0 }
        let bounds = CGInfo.boundsMap(ids: visible.map { $0.window.cgID })
        for c in visible { c.followBounds(bounds[c.window.cgID]) }
        if NSEvent.pressedMouseButtons & 1 != 0 { followLastActivity = Date() }
        let last = max(followLastActivity, tracker.lastGeometryEvent)
        if Date().timeIntervalSince(last) > 0.3 { stopFollowing() }
    }

    private func stopFollowing() {
        followActive = false
        followTimer?.invalidate()
        followTimer = nil
        if #available(macOS 14.0, *) {
            (displayLink as? CADisplayLink)?.invalidate()
        }
        displayLink = nil
        tracker.paused = false
        tracker.refresh(force: true)   // one AX refresh with the final frames
        for c in controllers.values { c.endFollowing() }
    }

    // MARK: Commands

    /// The controller for Chrome's focused window (or the first visible one).
    func focusedController() -> OverlayController? {
        if let k = tracker.focusedWindowKey(), let c = controllers[k] { return c }
        return controllers.values.first(where: { $0.window.visible })
    }

    func togglePinFocused(requireChromeFrontmost: Bool) {
        if requireChromeFrontmost && !tracker.chromeFrontmost { return }
        guard let c = focusedController() else { return }
        c.setPinned(c.state != .pinned)
    }

    var isFocusedPinned: Bool {
        focusedController()?.state == .pinned
    }
}
