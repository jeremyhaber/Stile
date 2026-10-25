import AppKit

/// Owns the tracker, the window mapper and one OverlayController per Chrome window.
@MainActor
final class OverlayManager {
    let server: HostServer
    let tracker = ChromeTracker()
    let mapper = WindowMapper()
    let closer = CloseInterceptor()
    let dragger = DragController()
    private(set) var controllers: [Int: OverlayController] = [:]

    /// v3.6.1: Stile's panels over each Chrome window, by the Chrome window's id (see `Screenshotter.overlayPanels`).
    func capturePanels() -> [CGWindowID: [CGWindowID]] {
        var out: [CGWindowID: [CGWindowID]] = [:]
        for c in controllers.values where c.window.cgID != 0 {
            let ids = c.capturePanelIDs
            if !ids.isEmpty { out[c.window.cgID] = ids }
        }
        return out
    }

    private var followTimer: Timer?
    private var displayLink: AnyObject?     // CADisplayLink on macOS 14+
    private var followActive = false
    private var followLastActivity = Date.distantPast
    private var railTimer: Timer?
    private var lastFocusedKey: Int?
    private var tickCount = 0
    private var downLocation: NSPoint?
    private var monitors: [Any] = []
    private var bridgeSubscriptions: [UUID: (ProfileBridge, UUID)] = [:]
    private var observers: [NSObjectProtocol] = []
    private var started = false
    private var anyConnectedSince: Date?
    /// Global on/off (state.json `overlayEnabled`, owned by the host server).
    private(set) var overlayEnabled = true

    // v3.0: app state pushed to every connected extension (`{type:"appState", state}`)
    private let appStateTimer = OneShot()
    private var lastAppState: [UUID: String] = [:]
    private var defaultBrowserCache: (value: Bool, at: Date)?
    private var appStatePoll: Timer?

    init(server: HostServer) {
        self.server = server
        // Works before `start()` (which waits for Accessibility): the settings page must be able to open the
        // permission panes and the permissions window exactly then.
        server.onAppMessage = { [weak self] type, msg, bridge in
            runOnMain { self?.handleAppMessage(type, msg, from: bridge) }
        }
        let t = Timer(timeInterval: 2.0, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.scheduleAppState() }
        }
        RunLoop.main.add(t, forMode: .common)
        appStatePoll = t
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
        closer.onRolesChanged = { [weak self] in self?.applyMapping() }
        dragger.manager = self
        dragger.syncTap()
        closer.ensureTap()

        tracker.onUpdate = { [weak self] in self?.trackerUpdated() }
        tracker.onFocusedElementChanged = { [weak self] in
            // Keyboard reveals of the full-screen toolbar (⌘L, ⌘T) come without any pointer movement.
            guard let self = self else { return }
            for c in self.controllers.values { c.chromeFocusChanged() }
        }
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

    /// v3.5c: capture-only mode. Everything `start()` set up goes away (tracker, follow loop, event taps, monitors,
    /// timers, overlay panels); the appState relay and the app-message hub keep working. `start()` can run again.
    func stop() {
        guard started else { return }
        started = false
        if followActive { stopFollowing() }
        for m in monitors { NSEvent.removeMonitor(m) }
        monitors.removeAll()
        for o in observers {
            NotificationCenter.default.removeObserver(o)
            DistributedNotificationCenter.default().removeObserver(o)
        }
        observers.removeAll()
        railTimer?.invalidate()
        railTimer = nil
        for (_, e) in bridgeSubscriptions { e.0.removeSubscriber(e.1) }
        bridgeSubscriptions.removeAll()
        tracker.onUpdate = nil
        tracker.onFocusedElementChanged = nil
        tracker.stop()
        closer.stop()
        closer.refreshTargets([])
        for c in controllers.values { c.teardown() }
        controllers.removeAll()
        anyConnectedSince = nil
        dragger.syncTap()   // lockstep drags need Chrome mode: the tap goes away
        dragger.updateSnapshot()
        scheduleAppState()
        Log.write("overlay: stopped (capture-only mode)")
    }

    /// Once a second: re-validate rails (and re-scan while unmatched), host state, missing-extension cards.
    @objc private func secondTick() {
        if followActive { return }   // nothing expensive while following
        tickCount += 1
        closer.ensureTap()
        dragger.syncTap()
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
        if supportChanged { refreshTaps() }
        scheduleAppState()
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
        scheduleAppState()
    }

    private func settingsChanged() {
        let on = server.overlayEnabled
        if on != overlayEnabled {
            overlayEnabled = on
            Log.write("overlay: \(on ? "enabled" : "disabled")")
            for c in controllers.values { c.setOverlayEnabled(on) }
            refreshTaps()
        }
        for c in controllers.values { c.settingsChanged() }
        dragger.syncTap()
        scheduleAppState()
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
                c.onWindowDrag = { [weak self] key, doubleClick in
                    self?.dragger.beginFromPanel(windowKey: key, doubleClick: doubleClick)
                }
                c.onTopBarClose = { [weak self] key, el in self?.closer.performClose(key: key, window: el) }
                c.onLayoutSettled = { [weak self] in self?.dragger.updateSnapshot() }
                c.onHostStatePushed = { [weak self] in self?.scheduleAppState() }
                c.overlayEnabled = overlayEnabled
                controllers[w.key] = c
                c.setLittle(closer.isLittle(mapper.map[w.key]))
                c.attach(mapper.map[w.key])
            }
            c.isFocusedChromeWindow = (w.key == focusedNow)
            c.update(window: w, chromeFrontmost: tracker.chromeFrontmost)
        }
        for (k, c) in controllers where !seen.contains(k) {
            c.teardown()
            controllers.removeValue(forKey: k)
        }
        refreshTaps()
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
        for (k, c) in controllers {
            c.setLittle(closer.isLittle(mapper.map[k]))
            c.attach(mapper.map[k])
        }
        refreshTaps()
    }

    /// Re-publishes what both event taps (tap thread) decide from.
    private func refreshTaps() {
        closer.refreshTargets(supportedWindows())
        dragger.updateSnapshot()
    }

    /// Windows eligible for close interception: everything except unsupported (unmapped incognito etc.) windows
    /// and little windows.
    private func supportedWindows() -> [ChromeWindow] {
        tracker.windows.filter { controllers[$0.key]?.unsupported != true && controllers[$0.key]?.isLittle != true }
    }

    /// The profile of Chrome's most recently focused mapped window (for links from other apps).
    func preferredBridge() -> ProfileBridge? {
        if let k = tracker.focusedWindowKey(), let m = mapper.map[k], !m.bridge.closed { return m.bridge }
        return nil
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
            // A plain click must stay cheap: no follow loop, no AX, no window-server queries. Just remember where
            // the press began; following starts once the pointer actually drags.
            downLocation = loc
            if overlayEnabled && tracker.chromeFrontmost {
                for c in controllers.values { c.dragBegan(mouse: loc) }
            }
        case .leftMouseDragged:
            if overlayEnabled && tracker.chromeFrontmost {
                if !followActive {
                    guard let d = downLocation, hypot(loc.x - d.x, loc.y - d.y) > 3 else { return }
                }
                followLastActivity = Date()
                startFollowing()
                for c in controllers.values { c.dragMoved(mouse: loc) }
            }
        case .leftMouseUp:
            downLocation = nil
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

    // MARK: App state and app settings (v3.0)

    private func scheduleAppState() {
        if appStateTimer.isScheduled { return }
        appStateTimer.schedule(after: 0.05) { [weak self] in
            self?.appStateTimer.clear()
            self?.broadcastAppState()
        }
    }

    /// `defaultBrowser` as the host reports it (little links on AND this app is the default handler); the
    /// NSWorkspace probe behind it is cached for a few seconds.
    private func defaultBrowserNow() -> Bool {
        if let c = defaultBrowserCache, Date().timeIntervalSince(c.at) < 4 { return c.value }
        let v = (HostStore.currentSettings()["defaultBrowser"] as? Bool) ?? false
        defaultBrowserCache = (v, Date())
        return v
    }

    /// The state for one profile's extension: the host state object of that profile's windows (the focused one,
    /// else the first visible one) plus app-wide fields.
    private func appStateObject(for b: ProfileBridge) -> [String: Any] {
        let mine = controllers.values.filter { $0.mappedBridge === b && !$0.isLittle }.sorted { $0.key < $1.key }
        let c = mine.first(where: { $0.isFocusedChromeWindow && $0.window.visible })
            ?? mine.first(where: { $0.window.visible }) ?? mine.first
        var obj: [String: Any] = c?.hostStateObject() ?? [
            "state": "collapsed", "pinned": false, "railFound": false, "railControllable": false,
            "launchAtLogin": LoginItem.enabled, "accessibility": Permissions.isTrusted,
            "appVersion": AppInfo.version, "peekWidth": Int(Settings.peekWidth),
            "screenCapture": Permissions.screenCaptureGranted, "compact": true, "railWidth": 48,
            "topBar": false, "greenButtonAction": Settings.greenButtonAction,
            "overlayEnabled": overlayEnabled, "showMenuBarIcon": Settings.showMenuBarIcon, "chromeColor": NSNull(),
        ]
        // App-wide fields (the same for every profile).
        obj["defaultBrowser"] = defaultBrowserNow()
        obj["overlayRunning"] = server.overlayRunning
        obj["profileDir"] = b.profileDir
        obj["windowCount"] = mine.count
        obj["mapped"] = c != nil
        obj["connectedProfiles"] = server.identified.map { $0.profileDir }.sorted()
        // v3.5c: the mode, and the app-owned capture settings (no secret; `secretSet` says whether there is one)
        obj["useChrome"] = Settings.useChrome
        obj["capture"] = CaptureSettings.shared.publicDict()
        obj["microphones"] = microphonesNow()
        obj["microphone"] = Permissions.microphoneGranted
        return obj
    }

    private var micCache: (list: [[String: String]], at: Date)?
    private func microphonesNow() -> [[String: String]] {
        if let c = micCache, Date().timeIntervalSince(c.at) < 15 { return c.list }
        let l = CaptureSettings.microphones()
        micCache = (l, Date())
        return l
    }

    /// Queues an `appState` push to every connected extension (capture settings or the mode changed).
    func pushAppState() { scheduleAppState() }

    private func broadcastAppState() {
        let live = server.identified
        for b in live {
            let obj = appStateObject(for: b)
            guard let json = JSONUtil.string(obj) else { continue }
            if lastAppState[b.id] == json { continue }
            lastAppState[b.id] = json
            b.sendToExt(["type": "appState", "state": obj])
        }
        let liveIds = Set(live.map { $0.id })
        for id in Array(lastAppState.keys) where !liveIds.contains(id) { lastAppState.removeValue(forKey: id) }
    }

    /// Messages relayed by the HostServer: `getAppState` and `appSetting {name, value}` (the two settings the
    /// server handles itself, setOverlayEnabled and setDefaultBrowser, never get here).
    private func handleAppMessage(_ type: String, _ m: [String: Any], from b: ProfileBridge) {
        if type == "getAppState" {
            let obj = appStateObject(for: b)
            if let json = JSONUtil.string(obj) { lastAppState[b.id] = json }
            b.reply(m, ["type": "appState", "state": obj])
            return
        }
        if type == "getCaptureSettings" {
            b.reply(m, ["type": "captureSettings", "settings": CaptureSettings.shared.publicDict(full: (m["full"] as? Bool) == true)])
            return
        }
        guard type == "appSetting", let name = m["name"] as? String else { return }
        let value = m["value"]
        let on = (value as? Bool) ?? ((value as? NSNumber)?.boolValue ?? false)
        let mine = controllers.values.filter { $0.mappedBridge === b }.sorted { $0.key < $1.key }
        switch name {
        case "setShowMenuBarIcon":
            Settings.showMenuBarIcon = on   // posts; the menu bar controller adds or removes the status item
        case "setGreenButtonAction":
            Settings.greenButtonAction = (value as? String) == "fill" ? "fill" : "full"   // posts
            Settings.greenButtonNotePending = false
        case "setPinned":
            // Same effect as the page's `setPinned` host message: the focused window of this profile, else its
            // first visible one.
            let candidates = mine.filter { !$0.isLittle }
            if let c = candidates.first(where: { $0.isFocusedChromeWindow && $0.window.visible })
                ?? candidates.first(where: { $0.window.visible }) {
                c.setPinned(on)
            }
        case "setLaunchAtLogin":
            LoginItem.set(on)
            Settings.post()
        case "requestScreenCapture":
            if let c = mine.first(where: { $0.isFocusedChromeWindow }) ?? mine.first {
                c.startCaptureRequest()   // asks, then re-checks every second for 30 s
            } else {
                Permissions.requestScreenCapture()
            }
        case "openAccessibilitySettings":
            Permissions.openSettings()
        case "rescanRail":
            for c in mine where c.window.visible { c.forceRescan() }
        case "quitApp":
            quitApp()
        case "reviewPermissions":
            NotificationCenter.default.post(name: .sidebarReviewPermissions, object: nil)
        case "setCaptureSettings":
            if let patch = value as? [String: Any] { CaptureSettings.shared.apply(patch) }   // posts; pushed back as appState
        case "chooseCaptureFolder":
            CaptureSettings.shared.chooseFolder(key: (value as? String) == "recordings" ? "recordingFolder" : "screenshotFolder")
        case "setUseChrome":
            Settings.useChrome = on   // posts .stileModeChanged; the app delegate starts or stops the Chrome side
        default:
            Log.write("host: appSetting '\(name)' not handled by the overlay manager")
        }
        scheduleAppState()
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

    /// The connection that receives screenshots: the focused Chrome window's profile, else the first one.
    func captureBridge() -> ProfileBridge? {
        if let b = preferredBridge() { return b }
        if let b = focusedController()?.mappedBridge, !b.closed { return b }
        return server.identified.first
    }

    /// Menu bar / Control+Option+6: the extension's full-page capture of the last focused Chrome window.
    func captureChromePage() {
        guard let b = captureBridge() else {
            Log.write("capture: no extension connected for a Chrome page capture")
            NSSound.beep()
            return
        }
        b.sendToExt(["type": "capture", "mode": "full"])
    }

    /// Writes the quit flag (so the connector doesn't relaunch the app) and terminates.
    func quitApp() {
        FileManager.default.createFile(atPath: HostPaths.quitFlagPath, contents: nil)
        NSApp.terminate(nil)
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
