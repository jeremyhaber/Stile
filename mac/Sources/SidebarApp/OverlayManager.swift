import AppKit

/// Owns the tracker, the window mapper and one OverlayController per Chrome window.
@MainActor
final class OverlayManager {
    let server: HostServer
    let tracker = ChromeTracker()
    let mapper = WindowMapper()
    private(set) var controllers: [Int: OverlayController] = [:]

    private var followTimer: Timer?
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
        let rt = Timer(timeInterval: 1.0, target: self, selector: #selector(secondTick), userInfo: nil, repeats: true)
        RunLoop.main.add(rt, forMode: .common)
        railTimer = rt
        bridgesChanged()
    }

    /// Once a second: re-validate rails (and re-scan while unmatched), host state, missing-extension cards.
    @objc private func secondTick() {
        tickCount += 1
        let quiet = Date().timeIntervalSince(tracker.lastGeometryEvent) < 0.5
        if tickCount % 5 == 0, !server.identified.isEmpty, controllers.values.contains(where: { $0.isUnmapped }) {
            mapper.schedule()   // retry matching windows to extension windows
        }
        var candidates: [(dir: String, name: String)]?
        for c in controllers.values {
            c.railTick(quiet: quiet)
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
        var seen = Set<Int>()
        for w in wins {
            seen.insert(w.key)
            let c: OverlayController
            if let existing = controllers[w.key] {
                c = existing
            } else {
                c = OverlayController(window: w)
                c.onLocalGeometryChange = { [weak self] in
                    self?.tracker.noteGeometryEvent()
                    self?.startFollowing()
                }
                controllers[w.key] = c
                c.attach(mapper.map[w.key])
            }
            c.update(window: w, chromeFrontmost: tracker.chromeFrontmost)
        }
        for (k, c) in controllers where !seen.contains(k) {
            c.teardown()
            controllers.removeValue(forKey: k)
        }
        mapper.schedule()
        if Date().timeIntervalSince(tracker.lastGeometryEvent) < 0.3 { startFollowing() }

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

    // MARK: Follow timer (120 Hz while a window is moving or resizing)

    private func startFollowing() {
        if followTimer != nil { return }
        let t = Timer(timeInterval: 1.0 / 120.0, target: self, selector: #selector(followTick),
                      userInfo: nil, repeats: true)
        RunLoop.main.add(t, forMode: .common)
        followTimer = t
    }

    @objc private func followTick() {
        for c in controllers.values { c.followLiveFrame() }
        if Date().timeIntervalSince(tracker.lastGeometryEvent) > 0.3 {
            followTimer?.invalidate()
            followTimer = nil
        }
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
