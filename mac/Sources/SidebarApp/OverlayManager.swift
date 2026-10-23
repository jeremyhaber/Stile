import AppKit

/// Owns the tracker, the window mapper and one OverlayController per Chrome window.
@MainActor
final class OverlayManager {
    let server: HostServer
    let tracker = ChromeTracker()
    let mapper = WindowMapper()
    let closer = CloseInterceptor()
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
    private var anyConnectedSince: Date?
    /// Global on/off (state.json `overlayEnabled`, owned by the host server).
    private(set) var overlayEnabled = true

    init(server: HostServer) {
        self.server = server
    }

    func start() {
        if started { return }
        started = true
        overlayEnabled = server.overlayEnabled

        mapper.windowsProvider = { [weak self] in self?.tracker.windows ?? [] }
        mapper.bridgesProvider = { [weak self] in self?.server.identified ?? [] }
        mapper.onChange = { [weak self] in self?.applyMapping() }

        closer.mappingProvider = { [weak self] key in
            guard let self = self, self.controllers[key]?.unsupported != true else { return nil }
            return self.mapper.map[key]
        }
        closer.chromePid = { [weak self] in self?.tracker.pid ?? 0 }
        closer.focusedWindowKey = { [weak self] in self?.tracker.focusedWindowKey() }
        closer.ensureTap()

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
        // Handled synchronously on the main thread so the panel is placed in the same event, not a hop later.
        if let g = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .leftMouseDragged, .leftMouseUp],
                                                     handler: { [weak self] event in
            let t = event.type
            let loc = NSEvent.mouseLocation
            runOnMain { self?.mouseButtonEvent(t, at: loc) }
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
        closer.ensureTap()
        let quiet = Date().timeIntervalSince(tracker.lastGeometryEvent) < 0.5
        let anyConnected = !server.identified.isEmpty
        let wanting = controllers.values.filter { $0.wantsMapping }
        if anyConnected, !wanting.isEmpty,
           tickCount % 5 == 0 || wanting.contains(where: { !$0.unsupported }) {
            mapper.schedule()   // retry matching windows to extension windows (every second during the 3 s grace)
        }
        var candidates: [(dir: String, name: String)]?
        func missing() -> [(dir: String, name: String)] {
            if candidates == nil { candidates = server.missingProfiles() }
            return candidates ?? []
        }
        var supportChanged = false
        for c in controllers.values {
            let lacking = (anyConnected && c.wantsMapping) ? missing() : []
            if c.evaluateSupport(anyConnected: anyConnected, connectedSince: anyConnectedSince, lacking: lacking) {
                supportChanged = true
            }
            c.railTick(quiet: quiet)
            if tickCount % 5 == 0 { c.sampleColor(push: false) }   // cheap; only pushed when it changed
            if c.needsSetupCheck {
                // With any profile connected, only a window positively identified as lacking the extension gets the card.
                c.applySetup(candidates: anyConnected ? c.lackingProfiles : missing())
            }
            c.pushHostState()
        }
        if supportChanged { closer.refreshTargets(supportedWindows()) }
    }

    // MARK: Events

    private func bridgesChanged() {
        // Subscribe to window events on each bridge once; drop subscriptions of closed bridges.
        let live = server.identified
        if live.isEmpty {
            anyConnectedSince = nil
        } else if anyConnectedSince == nil {
            anyConnectedSince = Date()
        }
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
        closer.bridgesChanged(live)
        mapper.schedule()
        applyMapping()
    }

    private func settingsChanged() {
        let on = server.overlayEnabled
        if on != overlayEnabled {
            overlayEnabled = on
            Log.write("overlay: \(on ? "enabled" : "disabled")")
            for c in controllers.values { c.setOverlayEnabled(on) }
            closer.refreshTargets(supportedWindows())
        }
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
                c.overlayEnabled = overlayEnabled
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
        closer.refreshTargets(supportedWindows())
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
        closer.refreshTargets(supportedWindows())
    }

    /// Windows eligible for close interception: everything except unsupported (unmapped incognito etc.) windows.
    private func supportedWindows() -> [ChromeWindow] {
        tracker.windows.filter { controllers[$0.key]?.unsupported != true }
    }

    private func pointerMoved() {
        guard overlayEnabled else { return }
        let p = NSEvent.mouseLocation
        let front = tracker.chromeFrontmost
        for c in controllers.values { c.pointerMoved(p, chromeFrontmost: front) }
    }

    // MARK: Follow loop (display link / 120 Hz while a window is moving or resizing)

    private func mouseButtonEvent(_ type: NSEvent.EventType, at loc: NSPoint) {
        switch type {
        case .leftMouseDown:
            if overlayEnabled && tracker.chromeFrontmost {
                followLastActivity = Date()
                startFollowing()
                for c in controllers.values { c.dragBegan(mouse: loc) }
            }
        case .leftMouseDragged:
            if overlayEnabled && tracker.chromeFrontmost {
                followLastActivity = Date()
                startFollowing()
                for c in controllers.values { c.dragMoved(mouse: loc) }
            }
        case .leftMouseUp:
            for c in controllers.values { c.dragEnded() }
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
        let mouse = NSEvent.mouseLocation
        for c in visible { c.followTick(real: bounds[c.window.cgID], mouse: mouse) }
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

    /// Control+Option+Shift+S: flips `overlayEnabled` (saved, broadcast to every extension connection).
    func toggleOverlay(requireChromeFrontmost: Bool) {
        if requireChromeFrontmost && !tracker.chromeFrontmost { return }
        server.setOverlayEnabled(!server.overlayEnabled, from: nil)
    }

    func togglePinFocused(requireChromeFrontmost: Bool) {
        if !overlayEnabled { return }
        if requireChromeFrontmost && !tracker.chromeFrontmost { return }
        guard let c = focusedController() else { return }
        c.setPinned(c.state != .pinned)
    }

    var isFocusedPinned: Bool {
        focusedController()?.state == .pinned
    }
}

/// Runs a block on the main actor right away when already on the main thread (NSEvent monitor callbacks are),
/// otherwise hops asynchronously.
func runOnMain(_ body: @escaping @MainActor () -> Void) {
    if Thread.isMainThread, #available(macOS 14.0, *) {
        MainActor.assumeIsolated(body)
    } else {
        Task { @MainActor in body() }
    }
}
