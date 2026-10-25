import AppKit

/// v3.1: the menu bar (status item) icon and its menu. Shown unless `Settings.showMenuBarIcon` is off.
/// Everything here runs on the main actor; the menu is rebuilt once and its checkmarks refreshed in
/// `menuNeedsUpdate` each time it opens.
@MainActor
final class MenuBarController: NSObject, NSMenuDelegate {
    private weak var manager: OverlayManager?
    private let server: HostServer
    private let capturer: ScreenCapturer
    private var item: NSStatusItem?
    private var observer: NSObjectProtocol?   // lives as long as the app

    private let menu = NSMenu()
    private let captureScreenItem = NSMenuItem(title: "Capture Screen", action: #selector(captureScreen(_:)), keyEquivalent: "3")
    private let captureAreaItem = NSMenuItem(title: "Capture Area", action: #selector(captureArea(_:)), keyEquivalent: "4")
    private let captureWindowItem = NSMenuItem(title: "Capture Window", action: #selector(captureWindow(_:)), keyEquivalent: "5")
    private let captureActiveItem = NSMenuItem(title: "Capture Active Window", action: #selector(captureActiveWindow(_:)), keyEquivalent: "5")
    private let captureRepeatItem = NSMenuItem(title: "Repeat Area Capture", action: #selector(captureRepeatArea(_:)), keyEquivalent: "4")
    private let captureScrollItem = NSMenuItem(title: "Scrolling Capture", action: #selector(captureScrolling(_:)), keyEquivalent: "7")
    private let delayedItem = NSMenuItem(title: "Delayed Screenshot (3s)", action: #selector(captureDelayed(_:)), keyEquivalent: "")
    private let openImageItem = NSMenuItem(title: "Open Image…", action: #selector(openImage(_:)), keyEquivalent: "")
    private let clipboardItem = NSMenuItem(title: "Load From Clipboard", action: #selector(loadClipboard(_:)), keyEquivalent: "")
    private let moreItem = NSMenuItem(title: "More", action: nil, keyEquivalent: "")
    private let recentRecordingsItem = NSMenuItem(title: "Recent Recordings", action: nil, keyEquivalent: "")
    private let recentRecordingsMenu = NSMenu(title: "Recent Recordings")
    private let captureChromeItem = NSMenuItem(title: "Capture Full Chrome Page", action: #selector(captureChromePage(_:)), keyEquivalent: "6")
    private let overlayItem = NSMenuItem(title: "Show sidebar over Chrome’s tabs", action: #selector(toggleOverlay(_:)), keyEquivalent: "s")
    private let pinItem = NSMenuItem(title: "Keep sidebar open", action: #selector(togglePinned(_:)), keyEquivalent: "")
    private let settingsItem = NSMenuItem(title: "Settings…", action: #selector(openSettings(_:)), keyEquivalent: "")
    private let permissionsItem = NSMenuItem(title: "Review permissions…", action: #selector(reviewPermissions(_:)), keyEquivalent: "")
    private let quitItem = NSMenuItem(title: "Quit Stile", action: #selector(quit(_:)), keyEquivalent: "q")
    private let chromeSeparator = NSMenuItem.separator()
    // v3.6: recording
    private let recordScreenItem = NSMenuItem(title: "Record Screen", action: #selector(recordScreen(_:)), keyEquivalent: "")
    private let recordWindowItem = NSMenuItem(title: "Record Window", action: #selector(recordWindow(_:)), keyEquivalent: "")
    private let recordAreaItem = NSMenuItem(title: "Record Area", action: #selector(recordArea(_:)), keyEquivalent: "")
    private let recordChromeItem = NSMenuItem(title: "Record Chrome Tab", action: #selector(recordChromeTab(_:)), keyEquivalent: "")
    private let recordCameraItem = NSMenuItem(title: "Record Camera", action: #selector(recordCamera(_:)), keyEquivalent: "")
    private var recording = false

    init(manager: OverlayManager, server: HostServer, capturer: ScreenCapturer) {
        self.manager = manager
        self.server = server
        self.capturer = capturer
        super.init()
        buildMenu()
        RecordingController.shared.onRecordingChanged = { [weak self] on in self?.setRecording(on) }
        observer = NotificationCenter.default.addObserver(forName: .sidebarSettingsChanged, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.sync() }
        }
        sync()
    }

    private func buildMenu() {
        menu.autoenablesItems = false
        menu.delegate = self

        // Display-only hint: the global hotkey (Control+Option+Shift+S) stays the real trigger.
        overlayItem.keyEquivalentModifierMask = [.control, .option, .shift]
        quitItem.keyEquivalentModifierMask = [.command]

        // Display-only hints too: the global hotkeys (Control+Option+3/4/5/6) are the real triggers.
        let captureItems = [captureScreenItem, captureAreaItem, captureWindowItem, captureActiveItem, captureRepeatItem, captureScrollItem, captureChromeItem]
        let symbols = ["display", "rectangle.dashed", "macwindow", "macwindow.badge.plus", "arrow.counterclockwise", "arrow.down.to.line", "arrow.down.doc"]
        for (it, symbol) in zip(captureItems, symbols) {
            it.keyEquivalentModifierMask = [.control, .option]
            it.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
        }
        captureActiveItem.keyEquivalentModifierMask = [.control, .option, .shift]
        captureRepeatItem.keyEquivalentModifierMask = [.control, .option, .shift]
        delayedItem.image = NSImage(systemSymbolName: "timer", accessibilityDescription: nil)
        openImageItem.image = NSImage(systemSymbolName: "photo", accessibilityDescription: nil)
        clipboardItem.image = NSImage(systemSymbolName: "doc.on.clipboard", accessibilityDescription: nil)
        moreItem.image = NSImage(systemSymbolName: "ellipsis.circle", accessibilityDescription: nil)
        let more = NSMenu(title: "More")
        more.autoenablesItems = false
        for it in [captureRepeatItem, delayedItem, openImageItem, clipboardItem] { it.target = self; more.addItem(it) }
        moreItem.submenu = more

        // v3.6: the recording section (⌃⌥8 stops, or opens the recorder for the last-used target; no per-item hints)
        let recordItems = [recordScreenItem, recordWindowItem, recordAreaItem, recordChromeItem, recordCameraItem]
        for (it, symbol) in zip(recordItems, ["record.circle", "macwindow", "rectangle.dashed.badge.record", "globe", "video"]) {
            it.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
            it.target = self
        }
        recordChromeItem.toolTip = "Records just the page of Chrome’s active tab. Needs the extension connected."
        recordCameraItem.toolTip = "Records just your camera. To add your camera to a screen recording, pick a camera in the recording bar."

        for it in captureItems + [overlayItem, pinItem, settingsItem, permissionsItem, quitItem] { it.target = self }

        // Order: screen, area, window, active window, scrolling capture,
        // [record screen / window / area: 3.6 goes here], Capture Full Chrome Page, More (repeat area, delayed, open, clipboard).
        for it in [captureScreenItem, captureAreaItem, captureWindowItem, captureActiveItem, captureScrollItem] { menu.addItem(it) }
        menu.addItem(captureChromeItem)
        menu.addItem(moreItem)
        menu.addItem(.separator())
        for it in recordItems { menu.addItem(it) }
        recentRecordingsItem.image = NSImage(systemSymbolName: "clock.arrow.circlepath", accessibilityDescription: nil)
        recentRecordingsMenu.autoenablesItems = false
        recentRecordingsItem.submenu = recentRecordingsMenu
        menu.addItem(recentRecordingsItem)
        menu.addItem(.separator())
        menu.addItem(overlayItem)
        menu.addItem(pinItem)
        menu.addItem(chromeSeparator)
        menu.addItem(settingsItem)
        menu.addItem(permissionsItem)
        menu.addItem(.separator())
        menu.addItem(quitItem)
    }

    /// Creates or removes the status item to match `Settings.showMenuBarIcon`.
    func sync() {
        applyMode()
        if Settings.showMenuBarIcon || recording {   // a hidden icon still shows while recording: it is the stop button
            if item == nil {
                let si = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
                if let button = si.button {
                    let img = NSImage(systemSymbolName: "sidebar.left", accessibilityDescription: "Stile")
                    img?.isTemplate = true
                    button.image = img
                    button.setAccessibilityLabel("Stile")
                }
                si.menu = menu
                item = si
            }
            configureItem()
        } else if let si = item {
            NSStatusBar.system.removeStatusItem(si)
            item = nil
        }
    }

    /// v3.5c: capture-only mode shows just the capture items, Settings, Review permissions and Quit.
    private func applyMode() {
        let chrome = Settings.useChrome
        for it in [captureChromeItem, overlayItem, pinItem, chromeSeparator, recordChromeItem] { it.isHidden = !chrome }
    }

    // MARK: NSMenuDelegate

    func menuNeedsUpdate(_ menu: NSMenu) {
        applyMode()
        let enabled = server.overlayEnabled
        overlayItem.state = enabled ? .on : .off
        let focused = manager?.focusedController()
        pinItem.state = (manager?.isFocusedPinned ?? false) ? .on : .off
        pinItem.isEnabled = enabled && focused != nil
        clipboardItem.isEnabled = ScreenCapturer.clipboardHasImage
        captureRepeatItem.isEnabled = true   // with no remembered area it falls back to picking one
        captureChromeItem.isEnabled = manager?.captureBridge() != nil
        recordChromeItem.isEnabled = RecordingController.shared.chromeTabAvailable
        RecentRecordings.shared.populate(recentRecordingsMenu, target: self, open: #selector(openRecentRecording(_:)),
                                         reveal: #selector(revealRecentRecording(_:)), clear: #selector(clearRecentRecordings(_:)))
    }

    // MARK: Recording state

    /// v3.6: while recording the icon is a red stop square and a click stops (no menu).
    func setRecording(_ on: Bool) {
        recording = on
        sync()
    }

    private func configureItem() {
        guard let si = item, let button = si.button else { return }
        if recording {
            let size = NSSize(width: 18, height: 18)
            let img = NSImage(size: size, flipped: false) { r in
                NSColor(srgbRed: 0.92, green: 0.18, blue: 0.16, alpha: 1).setFill()
                NSBezierPath(roundedRect: r.insetBy(dx: 4, dy: 4), xRadius: 2, yRadius: 2).fill()
                return true
            }
            img.isTemplate = false
            button.image = img
            button.setAccessibilityLabel("Stop recording")
            button.toolTip = "Stop recording (⌃⌥8)"
            si.menu = nil
            button.target = self
            button.action = #selector(stopRecordingFromIcon(_:))
        } else {
            let img = NSImage(systemSymbolName: "sidebar.left", accessibilityDescription: "Stile")
            img?.isTemplate = true
            button.image = img
            button.setAccessibilityLabel("Stile")
            button.toolTip = nil
            button.action = nil
            si.menu = menu
        }
    }

    // MARK: Actions

    @objc private func captureScreen(_ sender: Any?) { capturer.capture(.screen) }
    @objc private func captureArea(_ sender: Any?) { capturer.capture(.area) }
    @objc private func captureWindow(_ sender: Any?) { capturer.capture(.window) }
    @objc private func captureActiveWindow(_ sender: Any?) { capturer.capture(.activeWindow) }
    @objc private func captureRepeatArea(_ sender: Any?) { capturer.capture(.repeatArea) }
    @objc private func captureScrolling(_ sender: Any?) { capturer.capture(.scrolling) }
    @objc private func captureDelayed(_ sender: Any?) { capturer.capture(.delayed) }
    @objc private func openImage(_ sender: Any?) { capturer.capture(.openFile) }
    @objc private func loadClipboard(_ sender: Any?) { capturer.capture(.clipboard) }
    @objc private func captureChromePage(_ sender: Any?) { manager?.captureChromePage() }
    @objc private func recordScreen(_ sender: Any?) { RecordingController.shared.start(.screen) }
    @objc private func recordWindow(_ sender: Any?) { RecordingController.shared.start(.window) }
    @objc private func recordArea(_ sender: Any?) { RecordingController.shared.start(.area) }
    @objc private func recordChromeTab(_ sender: Any?) { RecordingController.shared.start(.chromeTab) }
    @objc private func recordCamera(_ sender: Any?) { RecordingController.shared.start(.camera) }
    @objc private func stopRecordingFromIcon(_ sender: Any?) { RecordingController.shared.stopRecording() }

    @objc private func openRecentRecording(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        if !RecordingWindows.shared.reopen(id: id) { NSSound.beep() }
    }
    /// The entry's file in Finder (Option-click), or with no entry the recordings folder.
    @objc private func revealRecentRecording(_ sender: NSMenuItem) {
        if let id = sender.representedObject as? String, let e = RecentRecordings.shared.entry(id: id) {
            NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: e.path)])
        } else {
            let folder = CaptureSettings.shared.recordingFolder
            try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            NSWorkspace.shared.open(folder)
        }
    }
    @objc private func clearRecentRecordings(_ sender: Any?) { RecentRecordings.shared.clear() }

    @objc private func toggleOverlay(_ sender: Any?) {
        manager?.toggleOverlay(requireChromeFrontmost: false)
    }

    @objc private func togglePinned(_ sender: Any?) {
        manager?.togglePinFocused(requireChromeFrontmost: false)
    }

    @objc private func openSettings(_ sender: Any?) {
        AppSettingsWindow.shared.show()   // always the app window (scoped to the focused profile in Chrome mode)
    }

    @objc private func reviewPermissions(_ sender: Any?) {
        NotificationCenter.default.post(name: .sidebarReviewPermissions, object: nil)
    }

    @objc private func quit(_ sender: Any?) {
        manager?.quitApp()
    }
}
