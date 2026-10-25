import AppKit
import ApplicationServices
import AVFoundation
import ScreenCaptureKit
import StileCore

/// v3.6: runs a recording from the menu / hot key to the preview window. Flow: pick the target (the shared selection
/// overlay) -> the recording bar (mic, system audio, Start) while the target stays highlighted -> 3-2-1 countdown
/// (setting) -> recording (red 3 pt border around exactly what is captured, the floating pill, a red stop square in the
/// menu bar) -> Stop -> `RecordingWindows.shared.open(...)` (the preview window, built elsewhere).
///
/// Record Chrome Tab arrives from the extension (`recordTab`, also asked for by the menu through `recordTabRequest`). The app
/// finds the Chrome window (the window mapper when the overlay runs, otherwise by title / z-order), records its page area
/// (`AXWebArea`, read again every 0.25 s so a resized window or a toggled bookmarks bar is followed) and lets the extension
/// drive auto-pause (`recordTabState`), stop (`recordTabClosed`) and retargeting (`recordTabMoved`).
@MainActor
final class RecordingController {
    static let shared = RecordingController()

    enum Kind: String { case screen, window, area, chromeTab, camera }
    private enum Phase { case idle, picking, bar, countdown, recording, finishing }

    weak var manager: OverlayManager?
    weak var server: HostServer?
    /// The menu bar swaps its icon for a red stop square while this is true.
    var onRecordingChanged: ((Bool) -> Void)?

    private struct Tab {
        let bridge: ProfileBridge
        var windowId: Int
        let tabId: Int
        let title: String
    }

    /// Everything about the target, resolved before the bar shows.
    private struct Plan {
        var kind: Kind
        var target: RecordTarget
        var barLabel: String
        var name: String            // "Window — Slack": the pill and the preview
        var app: String             // for the default title
        var anchor: CGRect?         // Quartz points: where the bar, countdown and pill sit
        var windowID: CGWindowID?   // window and tab: the border follows it
        var displayID: CGDirectDisplayID?
        var tab: Tab?
        var tabArea: ChromeTabArea?
        /// What the preview calls the target: "Entire display", "Slack", "Area 1280 × 720", "Chrome tab — …".
        var docTarget: String {
            switch kind {
            case .screen: return "Entire display"
            case .window: return app
            case .area, .chromeTab: return name
            case .camera: return "Camera"
            }
        }
    }

    private var phase: Phase = .idle
    private var plan: Plan?
    private var recorder: RecordingEngine?
    /// v3.9: the camera bubble (screen + camera) or the camera-only preview, from when a camera is picked in the bar.
    private var bubble: CameraBubble?
    private var bar: RecordingBar?
    private var pill: RecordingPill?
    private let countdown = RecordingCountdown()
    private let highlight = SelectionHighlight()
    private var tickTimer: Timer?
    private var tabTimer: Timer?
    private var lastTabRect: CGRect?
    private var manualPause = false
    private var tabHidden = false
    private var chain: Task<Void, Never>?

    var isRecording: Bool { phase == .recording }
    var isBusy: Bool { phase != .idle }

    // MARK: Entry points

    /// Menu items and the hot key's "last used target".
    func start(_ kind: Kind) {
        guard phase == .idle, !SelectionOverlay.isActive else { return }
        guard kind == .camera || ensureScreenAccess() else { return }
        Log.write("record: \(kind.rawValue) requested")
        if kind == .chromeTab { requestChromeTab(); return }
        remember(kind)
        phase = .picking
        Task {
            guard let p = await pickPlan(kind) else {
                Log.write("record: cancelled while picking")
                phase = .idle
                return
            }
            showBar(p)
        }
    }

    /// Control+Option+8: stops a running recording, cancels a pending one, otherwise opens the picker for the last-used target.
    func hotKey() {
        switch phase {
        case .recording: stopRecording()
        case .picking: SelectionOverlay.cancelCurrent()
        case .bar: cancelPending()
        case .countdown: cancelPending()
        case .finishing: break
        case .idle:
            var kind = Kind(rawValue: HostStore.readState()["lastRecordKind"] as? String ?? "") ?? .screen
            if kind == .chromeTab && !(Settings.useChrome && server?.identified.isEmpty == false) { kind = .screen }
            start(kind)
        }
    }

    /// Whether "Record Chrome Tab" can work right now (Chrome mode, an extension connected).
    var chromeTabAvailable: Bool { Settings.useChrome && manager?.captureBridge() != nil }

    private func remember(_ kind: Kind) { _ = HostStore.updateState(["lastRecordKind": kind.rawValue]) }

    private func ensureScreenAccess() -> Bool {
        if Permissions.screenCaptureGranted { return true }
        Log.write("record: Screen Recording not granted; asking")
        if !Permissions.requestScreenCapture() {
            NotificationCenter.default.post(name: .sidebarReviewPermissions, object: nil)
            return false
        }
        return true
    }

    // MARK: Picking

    private func pickPlan(_ kind: Kind) async -> Plan? {
        switch kind {
        case .screen:
            let content = try? await Screenshotter.shareableContent()
            guard let content, !content.displays.isEmpty else { return nil }
            var display = content.displays[0]
            if content.displays.count > 1 {
                guard case .display(let d)? = await SelectionOverlay.pick(mode: .screen, allowModeSwitch: false) else { return nil }
                display = d
            }
            let screenName = NSScreen.screens.first { ScreenGeometry.displayID(of: $0) == display.displayID }?.localizedName ?? "Display"
            return Plan(kind: .screen, target: .display(display.displayID), barLabel: "Recording: Entire display (\(screenName))",
                        name: "Entire display (\(screenName))", app: "Screen", anchor: nil, displayID: display.displayID)
        case .window:
            guard case .window(let w)? = await SelectionOverlay.pick(mode: .window, allowModeSwitch: false) else { return nil }
            let app = w.owningApplication?.applicationName ?? "Window"
            return Plan(kind: .window, target: .window(w.windowID), barLabel: "Recording: Window — \(app)",
                        name: "Window — \(app)", app: app, anchor: w.frame, windowID: w.windowID)
        case .area:
            guard case .rect(let r, let id)? = await SelectionOverlay.pick(mode: .area, allowModeSwitch: false, confirmOnRelease: false) else { return nil }
            SelectionOverlay.lastRect = r
            let size = "\(Int(r.width)) × \(Int(r.height))"
            return Plan(kind: .area, target: .area(r, id), barLabel: "Recording: Area \(size)", name: "Area \(size)", app: "Screen",
                        anchor: r, displayID: id)
        case .chromeTab:
            return nil
        case .camera:
            return Plan(kind: .camera, target: .camera, barLabel: "Recording: Camera", name: "Camera", app: "Camera", anchor: nil)
        }
    }

    // MARK: The bar

    private func showBar(_ p: Plan) {
        plan = p
        phase = .bar
        applyHighlight(tint: .accent)
        let saved = CaptureSettings.shared.recording
        var micID = (saved["micDeviceId"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        var note: String?
        if micID != nil, [.denied, .restricted].contains(AVCaptureDevice.authorizationStatus(for: .audio)) {
            micID = nil
            note = "Microphone access is off, so this will record without a microphone. Turn it on in System Settings → Privacy & Security → Microphone."
        }
        let tabNote = p.kind == .chromeTab ? "Records the audio of all of Chrome, not just this tab." : nil
        let camSize = CameraBubble.Size(rawValue: saved["cameraSize"] as? String ?? "") ?? .medium
        // screen kinds start with the camera used last time (or none); Camera only with the last one or the first
        var camID = (saved["cameraDeviceId"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        if p.kind == .camera, camID == nil { camID = CameraBubble.cameras().first?["id"] }
        let b = RecordingBar(label: p.barLabel, micID: micID, systemAudio: (saved["systemAudio"] as? Bool) ?? false,
                             systemAudioNote: tabNote, cameraID: camID, cameraSize: camSize, cameraOnly: p.kind == .camera,
                             onStart: { [weak self] choice in self?.barStarted(choice) },
                             onCancel: { [weak self] in self?.cancelPending() })
        b.onPickMic = { _, done in Task { done(await Self.micAuthorized(prompt: true)) } }
        b.onPickCamera = { [weak self] id, size in self?.showCamera(id, size: size) }
        b.place(belowQuartz: p.anchor)
        if let n = note { b.setNote(n) }
        if p.kind == .camera && !b.hasCameras { b.setNote("No camera found. Connect one, then try again.") }
        bar = b
        if let camID { showCamera(camID, size: camSize) }
    }

    /// Shows the bubble (or, for Camera only, the preview) for camera `id`; nil hides it. Asks for camera access first.
    private func showCamera(_ id: String?, size: CameraBubble.Size) {
        guard let p = plan else { return }
        if let b = bubble, b.camera.uniqueID == id {
            if b.size != size { b.setSize(size) }
            return
        }
        closeCamera()
        guard let id else { return }
        Task {
            guard await CameraBubble.authorized(prompt: true) else {
                bar?.selectNoCamera()
                bar?.setNote("Camera access is off. Turn it on in System Settings → Privacy & Security → Camera.")
                return
            }
            guard phase == .bar, plan?.kind == p.kind, bubble == nil, let b = CameraBubble(cameraID: id, size: size, previewOnly: p.kind == .camera) else { return }
            b.area = p.anchor ?? p.displayID.map { CGDisplayBounds($0) }
            b.show(at: .bottomLeft)
            bubble = b
            if p.kind != .camera { Screenshotter.extraCaptureWindows = { [weak b] in b.map { [$0.windowID] } ?? [] } }
            Log.write("record: camera \(b.camera.localizedName) shown")
        }
    }

    private func closeCamera() {
        bubble?.close()
        bubble = nil
        Screenshotter.extraCaptureWindows = { [] }
    }

    private static func micAuthorized(prompt: Bool) async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return true
        case .notDetermined: return prompt ? await AVCaptureDevice.requestAccess(for: .audio) : false
        default: return false
        }
    }

    private func barStarted(_ choice: RecordingBar.Choice) {
        guard phase == .bar, plan != nil else { return }
        if plan?.kind == .camera && bubble == nil {
            bar?.setNote(bar?.hasCameras == true ? "Allow the camera first (System Settings → Privacy & Security → Camera)." : "No camera found.")
            return NSSound.beep()
        }
        var rec: [String: Any] = ["micDeviceId": choice.micID ?? "", "systemAudio": choice.systemAudio, "cameraSize": choice.cameraSize.rawValue]
        if plan?.kind != .camera { rec["cameraDeviceId"] = choice.cameraID ?? "" }
        CaptureSettings.shared.apply(["recording": rec])
        bar?.close()
        bar = nil
        Task {
            var mic = choice.micID
            if mic != nil, !(await Self.micAuthorized(prompt: true)) {
                Log.write("record: microphone not allowed; recording without it")
                mic = nil
            }
            guard phase == .bar else { return }   // cancelled while the permission prompt was up
            let r = CaptureSettings.shared.recording
            let options = Recorder.Options(
                micID: mic, systemAudio: choice.systemAudio, fps: r["fps"] as? Int ?? 30, hevc: (r["codec"] as? String) == "hevc",
                maxLongSide: RecordingMath.maxLongSide(forSetting: r["maxResolution"] as? String ?? "1080p"),
                showCursor: r["showCursor"] as? Bool ?? true)
            if r["countdown"] as? Bool ?? true {
                phase = .countdown
                countdown.run(seconds: 3, centreQuartz: plan?.anchor) { [weak self] in self?.begin(options) }
            } else {
                begin(options)
            }
        }
    }

    /// Esc / Cancel in the bar, or the hot key while the bar or the countdown is up.
    private func cancelPending() {
        guard phase == .bar || phase == .countdown else { return }
        Log.write("record: cancelled before start")
        bar?.close()
        bar = nil
        countdown.cancel()
        highlight.hide()
        stopTabTracking()
        closeCamera()
        plan = nil
        phase = .idle
    }

    // MARK: Recording

    private func begin(_ options: Recorder.Options) {
        guard phase == .countdown || phase == .bar, let p = plan else { return }
        let rec: RecordingEngine
        if p.kind == .camera, let b = bubble {
            rec = CameraRecorder(session: b.session, micID: options.micID)
        } else {
            rec = Recorder(target: p.target, options: options)
        }
        rec.onFailure = { [weak self] message in
            Log.write("record: stopping after a stream failure (\(message))")
            self?.stopRecording()
        }
        Task {
            do {
                try await rec.start()
            } catch {
                Log.write("record: failed to start: \(error.localizedDescription)")
                cancelPending()
                phase = .idle
                alert("Could not start the recording", error.localizedDescription)
                return
            }
            guard phase == .countdown || phase == .bar else { await rec.discard(); return }
            recorder = rec
            phase = .recording
            manualPause = false
            tabHidden = false
            applyHighlight(tint: .red)
            let pill = RecordingPill(targetName: p.name, hasMic: options.micID != nil,
                                     onPause: { [weak self] in self?.togglePause() },
                                     onStop: { [weak self] in self?.stopRecording() },
                                     onRestart: { [weak self] in self?.restart() },
                                     onDiscard: { [weak self] in self?.confirmDiscard() })
            pill.place(nearQuartz: p.kind == .camera ? bubble?.frameQuartz : p.anchor)
            self.pill = pill
            tickTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self, let r = self.recorder else { return }
                    self.pill?.setElapsed(r.elapsed)
                    self.pill?.setLevel(r.micLevel)
                }
            }
            onRecordingChanged?(true)
            if let t = p.tab { t.bridge.sendToExt(["type": "recordingTab", "tabId": t.tabId]) }
        }
    }

    func togglePause() {
        guard phase == .recording else { return }
        manualPause.toggle()
        syncPause()
    }

    /// Applies "paused by the user" or "the tab is not visible" to the recorder and the pill, in order with other changes.
    private func syncPause() {
        let want = manualPause || tabHidden
        pill?.setPaused(want, reason: want ? (tabHidden && !manualPause ? "Paused: tab not visible" : "Paused") : nil)
        highlight.tint = want ? .amber : .red
        serial { [weak self] in
            guard let self, let r = self.recorder, self.phase == .recording else { return }
            if want, r.state == .recording { await r.pause() }
            else if !want, r.state == .paused {
                do { try await r.resume() } catch {
                    Log.write("record: resume failed: \(error.localizedDescription)")
                    self.stopRecording()
                }
            }
        }
    }

    func stopRecording() {
        guard phase == .recording, let rec = recorder, let p = plan else { return }
        phase = .finishing
        tearDownUI()
        serial { [weak self] in
            do {
                let r = try await rec.stop()
                let f = DateFormatter()
                f.dateFormat = "yyyy-MM-dd 'at' HH.mm"
                RecordingWindows.shared.open(RecordingDocument(
                    url: r.url, title: "Recording — \(p.app) — \(f.string(from: Date()))", target: p.docTarget,
                    duration: r.duration, createdAt: Date(), hasAudio: r.hasAudio))
            } catch {
                Log.write("record: stop failed: \(error.localizedDescription)")
                self?.alert("Could not save the recording", error.localizedDescription)
            }
            self?.finishSession()
        }
    }

    private func restart() {
        guard phase == .recording, let rec = recorder else { return }
        Log.write("record: restart")
        manualPause = false
        serial { [weak self] in
            await rec.discard()
            do { try await rec.start() } catch {
                Log.write("record: restart failed: \(error.localizedDescription)")
                self?.stopRecording()
                return
            }
            self?.syncPause()
        }
    }

    private func confirmDiscard() {
        guard phase == .recording else { return }
        let a = NSAlert()
        a.messageText = "Discard this recording?"
        a.informativeText = "It will be deleted and can’t be brought back."
        a.addButton(withTitle: "Discard")
        a.addButton(withTitle: "Keep Recording")
        a.buttons[0].hasDestructiveAction = true
        NSApp.activate(ignoringOtherApps: true)
        guard a.runModal() == .alertFirstButtonReturn, phase == .recording, let rec = recorder else { return }
        phase = .finishing
        tearDownUI()
        serial { [weak self] in
            await rec.discard()
            self?.finishSession()
        }
    }

    private func tearDownUI() {
        tickTimer?.invalidate()
        tickTimer = nil
        stopTabTracking()
        highlight.hide()
        pill?.close()
        pill = nil
        closeCamera()
        onRecordingChanged?(false)
        if let t = plan?.tab { t.bridge.sendToExt(["type": "recordingTab", "tabId": NSNull()]) }
    }

    private func finishSession() {
        recorder = nil
        plan = nil
        phase = .idle
    }

    private func serial(_ op: @escaping () async -> Void) {
        let prev = chain
        chain = Task { @MainActor in
            await prev?.value
            await op()
        }
    }

    private func alert(_ title: String, _ text: String) {
        let a = NSAlert()
        a.messageText = title
        a.informativeText = text
        a.addButton(withTitle: "OK")
        NSApp.activate(ignoringOtherApps: true)
        a.runModal()
    }

    // MARK: Borders

    /// The outline around exactly what is captured. Accent while choosing, red while recording, amber when paused.
    private func applyHighlight(tint: SelectionHighlight.Tint) {
        guard let p = plan else { return }
        highlight.tint = tint
        highlight.style = (p.kind == .area && tint != .accent) ? .dashed : .solid
        switch p.target {
        case .display(let id): highlight.show(displayID: id)
        case .area(let r, _): highlight.show(rect: r)
        case .window(let wid):
            // SelectionHighlight follows an SCWindow; only its id is used, so a stand-in lookup is enough
            followWindow(wid)
        case .chromeTab:
            startTabTracking()
        case .camera:
            highlight.hide()   // nothing on screen is recorded
        }
    }

    private func followWindow(_ id: CGWindowID) {
        Task {
            guard let content = try? await Screenshotter.shareableContent(onScreenOnly: false),
                  let w = content.windows.first(where: { $0.windowID == id }), plan != nil else { return }
            highlight.show(window: w)
        }
    }

    // MARK: Chrome tab

    private func requestChromeTab() {
        guard Settings.useChrome, let b = manager?.captureBridge() else {
            Log.write("record: no extension connected for a Chrome tab recording")
            NSSound.beep()
            return
        }
        // the extension answers with `recordTab` for the active tab of its last focused window
        b.sendToExt(["type": "recordTabRequest"])
    }

    /// Messages from the extension: recordTab, recordTabState, recordTabClosed, recordTabMoved.
    func handleExtensionMessage(_ type: String, _ m: [String: Any], from bridge: ProfileBridge) {
        let tabId = JSONUtil.int(m["tabId"])
        switch type {
        case "recordTab":
            guard let wid = JSONUtil.int(m["windowId"]), let tabId else { return }
            startChromeTab(Tab(bridge: bridge, windowId: wid, tabId: tabId, title: (m["title"] as? String) ?? ""))
        case "recordTabState":
            guard phase == .recording, let t = plan?.tab, t.tabId == tabId, let active = m["active"] as? Bool else { return }
            Log.write("record: tab \(active ? "visible again" : "not visible")")
            tabHidden = !active
            syncPause()
        case "recordTabClosed":
            guard let t = plan?.tab, t.tabId == tabId else { return }
            Log.write("record: the recorded tab was closed")
            if phase == .recording { stopRecording() } else { cancelPending() }
        case "recordTabMoved":
            guard phase == .recording, let t = plan?.tab, t.tabId == tabId, let wid = JSONUtil.int(m["windowId"]), wid != t.windowId else { return }
            retargetTab(newWindowId: wid)
        default:
            break
        }
    }

    private func startChromeTab(_ tab: Tab) {
        guard phase == .idle, !SelectionOverlay.isActive else {
            Log.write("record: already busy; ignoring recordTab")
            NSSound.beep()
            return
        }
        guard ensureScreenAccess() else { return }
        remember(.chromeTab)
        phase = .picking
        Task {
            guard let (w, ax) = await resolveChromeWindow(bridge: tab.bridge, windowId: tab.windowId, title: tab.title) else {
                Log.write("record: could not find the Chrome window for tab \(tab.tabId)")
                phase = .idle
                alert("Could not find the Chrome window", "Make sure Chrome is open on this desktop and not minimised, then try again.")
                return
            }
            let area = ChromeTabArea(windowID: w.windowID, pid: w.owningApplication?.processID ?? 0, axWindow: ax)
            guard let global = area.pageRectGlobal(), let wf = ScreenGeometry.frame(ofWindow: w.windowID) ?? Optional(w.frame),
                  let rel = RecordingMath.relativeRect(global, in: wf) else {
                phase = .idle
                alert("Could not find the page area", "The Chrome window is not visible. Bring it back and try again.")
                return
            }
            let title = tab.title.isEmpty ? "Chrome tab" : String(tab.title.prefix(60))
            var p = Plan(kind: .chromeTab, target: .chromeTab(window: w.windowID, page: rel), barLabel: "Recording: Chrome tab — \(title)",
                         name: "Chrome tab — \(title)", app: "Chrome", anchor: global, windowID: w.windowID)
            p.tab = tab
            p.tabArea = area
            showBar(p)
        }
    }

    /// The Chrome window (SCK) and its AX element for an extension window id. With the overlay running the window mapper
    /// knows it; otherwise (capture-only mode, or no mapping yet) the Chrome window whose title holds the tab's title, else
    /// the frontmost Chrome window.
    private func resolveChromeWindow(bridge: ProfileBridge, windowId: Int, title: String) async -> (SCWindow, AXUIElement?)? {
        guard let content = try? await Screenshotter.shareableContent(onScreenOnly: false) else { return nil }
        if let m = manager {
            for (key, mp) in m.mapper.map where mp.bridge === bridge && mp.windowId == windowId {
                if let cw = m.tracker.windows.first(where: { $0.key == key }), cw.cgID != 0,
                   let w = content.windows.first(where: { $0.windowID == cw.cgID }) {
                    return (w, cw.element)
                }
            }
        }
        let chrome = content.windows.filter {
            $0.owningApplication?.bundleIdentifier == ChromeTracker.bundleID && $0.windowLayer == 0
                && $0.frame.width > 300 && $0.frame.height > 200
        }
        let order = ScreenGeometry.onScreenWindowOrder()
        let ranked = chrome.sorted { (order[$0.windowID] ?? Int.max) < (order[$1.windowID] ?? Int.max) }
        let pick = (title.isEmpty ? nil : ranked.first { $0.title?.contains(title) == true }) ?? ranked.first
        guard let w = pick else { return nil }
        Log.write("record: window mapper had no match; using Chrome window \(w.windowID)")
        return (w, ChromeTabArea.axWindow(pid: w.owningApplication?.processID ?? 0, windowID: w.windowID))
    }

    private func retargetTab(newWindowId: Int) {
        guard var p = plan, var t = p.tab else { return }
        Task {
            guard let (w, ax) = await resolveChromeWindow(bridge: t.bridge, windowId: newWindowId, title: t.title) else {
                Log.write("record: the tab moved to a window that can't be found; stopping")
                stopRecording()
                return
            }
            let area = ChromeTabArea(windowID: w.windowID, pid: w.owningApplication?.processID ?? 0, axWindow: ax)
            guard let global = area.pageRectGlobal(), let wf = ScreenGeometry.frame(ofWindow: w.windowID),
                  let rel = RecordingMath.relativeRect(global, in: wf), let rec = recorder else { return }
            t.windowId = newWindowId
            p.tab = t
            p.tabArea = area
            p.windowID = w.windowID
            p.target = .chromeTab(window: w.windowID, page: rel)
            plan = p
            lastTabRect = nil
            serial { try? await (rec as? Recorder)?.retarget(p.target) }
        }
    }

    private func startTabTracking() {
        stopTabTracking()
        tabTick()
        tabTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tabTick() }
        }
    }

    private func stopTabTracking() {
        tabTimer?.invalidate()
        tabTimer = nil
        lastTabRect = nil
    }

    /// Follows the page area: moves the border, and feeds a changed size to the recording.
    private func tabTick() {
        guard let p = plan, let area = p.tabArea, let wid = p.windowID else { return }
        guard let global = area.pageRectGlobal(), let wf = ScreenGeometry.frame(ofWindow: wid) else {
            highlight.hide()   // minimised or gone: the border waits
            lastTabRect = nil
            return
        }
        guard global != lastTabRect else { return }
        lastTabRect = global
        highlight.show(rect: global)
        plan?.anchor = global
        if phase == .recording, let rel = RecordingMath.relativeRect(global, in: wf) {
            (recorder as? Recorder)?.updateTabPage(rel)
        }
    }
}

// MARK: - The page area of a Chrome window

/// The `AXWebArea` frame of a Chrome window (the page without tabs, toolbar and bookmarks bar), in global Quartz points.
/// The element is cached and its frame re-read cheaply; the tree is walked again only when it goes stale (tab switches,
/// navigation). Without Accessibility (capture-only mode) or when Chrome doesn't expose web content, a fixed 88 pt
/// toolbar height is assumed: close, not exact.
@MainActor
final class ChromeTabArea {
    private let windowID: CGWindowID
    private let axWindow: AXUIElement?
    private var webArea: AXUIElement?
    private var lastFailedWalk = Date.distantPast
    static let fallbackToolbar: CGFloat = 88

    init(windowID: CGWindowID, pid: pid_t, axWindow: AXUIElement?) {
        self.windowID = windowID
        self.axWindow = axWindow
        if pid != 0, Permissions.isTrusted {
            // asks Chrome to build its web accessibility tree (it does so lazily)
            AXUIElementSetAttributeValue(AXUIElementCreateApplication(pid), "AXManualAccessibility" as CFString, kCFBooleanTrue)
        }
    }

    /// The AX window element of a Chrome process by CGWindowID (needs Accessibility).
    static func axWindow(pid: pid_t, windowID: CGWindowID) -> AXUIElement? {
        guard pid != 0, Permissions.isTrusted else { return nil }
        let app = AXUIElementCreateApplication(pid)
        return (AX.children(app, AXName.windows) ?? []).first { AX.cgWindowID($0) == windowID }
    }

    /// Nil when the window is off screen (minimised, another Space).
    func pageRectGlobal() -> CGRect? {
        guard let wf = ScreenGeometry.frame(ofWindow: windowID) else { return nil }
        let slack = wf.insetBy(dx: -6, dy: -6)
        if let cached = webArea {
            if let f = AX.frame(cached), f.width >= 50, f.height >= 50, slack.contains(f) { return f }
            webArea = nil
        }
        if let ax = axWindow, Permissions.isTrusted, Date().timeIntervalSince(lastFailedWalk) > 2 {
            if let (el, f) = findWebArea(in: ax, within: slack) {
                webArea = el
                return f
            }
            lastFailedWalk = Date()
        }
        return CGRect(x: wf.minX, y: wf.minY + Self.fallbackToolbar, width: wf.width, height: max(0, wf.height - Self.fallbackToolbar))
    }

    private func findWebArea(in window: AXUIElement, within bounds: CGRect) -> (AXUIElement, CGRect)? {
        var found: [(AXUIElement, CGRect)] = []
        var queue: [(AXUIElement, Int)] = [(window, 0)]
        var i = 0
        while i < queue.count, i < 1500 {
            let (el, depth) = queue[i]
            i += 1
            if depth > 0, AX.string(el, AXName.role) == "AXWebArea" {
                if let f = AX.frame(el), bounds.contains(f) { found.append((el, f)) }
                continue   // never descend into the page itself
            }
            if depth < 14, let kids = AX.children(el) { for k in kids { queue.append((k, depth + 1)) } }
        }
        guard let best = RecordingMath.pickPage(found.map { $0.1 }), let hit = found.first(where: { $0.1 == best }) else { return nil }
        return hit
    }
}
