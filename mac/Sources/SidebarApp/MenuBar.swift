import AppKit

/// v3.1: the menu bar (status item) icon and its menu. Shown unless `Settings.showMenuBarIcon` is off.
/// Everything here runs on the main actor; the menu is rebuilt once and its checkmarks refreshed in
/// `menuNeedsUpdate` each time it opens.
@MainActor
final class MenuBarController: NSObject, NSMenuDelegate {
    private weak var manager: OverlayManager?
    private let server: HostServer
    private var item: NSStatusItem?
    private var observer: NSObjectProtocol?   // lives as long as the app

    private let menu = NSMenu()
    private let overlayItem = NSMenuItem(title: "Show sidebar over Chrome’s tabs", action: #selector(toggleOverlay(_:)), keyEquivalent: "s")
    private let pinItem = NSMenuItem(title: "Keep sidebar open", action: #selector(togglePinned(_:)), keyEquivalent: "")
    private let lockstepItem = NSMenuItem(title: "Move Chrome and the sidebar together", action: #selector(toggleLockstep(_:)), keyEquivalent: "")
    private let settingsItem = NSMenuItem(title: "Settings…", action: #selector(openSettings(_:)), keyEquivalent: "")
    private let permissionsItem = NSMenuItem(title: "Review permissions…", action: #selector(reviewPermissions(_:)), keyEquivalent: "")
    private let quitItem = NSMenuItem(title: "Quit Sidebar", action: #selector(quit(_:)), keyEquivalent: "q")

    init(manager: OverlayManager, server: HostServer) {
        self.manager = manager
        self.server = server
        super.init()
        buildMenu()
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

        for it in [overlayItem, pinItem, lockstepItem, settingsItem, permissionsItem, quitItem] { it.target = self }

        menu.addItem(overlayItem)
        menu.addItem(pinItem)
        menu.addItem(lockstepItem)
        menu.addItem(.separator())
        menu.addItem(settingsItem)
        menu.addItem(permissionsItem)
        menu.addItem(.separator())
        menu.addItem(quitItem)
    }

    /// Creates or removes the status item to match `Settings.showMenuBarIcon`.
    func sync() {
        if Settings.showMenuBarIcon {
            if item == nil {
                let si = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
                if let button = si.button {
                    let img = NSImage(systemSymbolName: "sidebar.left", accessibilityDescription: "Sidebar")
                    img?.isTemplate = true
                    button.image = img
                    button.setAccessibilityLabel("Sidebar")
                }
                si.menu = menu
                item = si
            }
        } else if let si = item {
            NSStatusBar.system.removeStatusItem(si)
            item = nil
        }
    }

    // MARK: NSMenuDelegate

    func menuNeedsUpdate(_ menu: NSMenu) {
        let enabled = server.overlayEnabled
        overlayItem.state = enabled ? .on : .off
        lockstepItem.state = Settings.lockstepDrag ? .on : .off
        let focused = manager?.focusedController()
        pinItem.state = (manager?.isFocusedPinned ?? false) ? .on : .off
        pinItem.isEnabled = enabled && focused != nil
    }

    // MARK: Actions

    @objc private func toggleOverlay(_ sender: Any?) {
        manager?.toggleOverlay(requireChromeFrontmost: false)
    }

    @objc private func togglePinned(_ sender: Any?) {
        manager?.togglePinFocused(requireChromeFrontmost: false)
    }

    @objc private func toggleLockstep(_ sender: Any?) {
        Settings.lockstepDrag = !Settings.lockstepDrag   // posts; the manager calls settingsChanged
    }

    @objc private func openSettings(_ sender: Any?) {
        manager?.openExtensionSettings()
    }

    @objc private func reviewPermissions(_ sender: Any?) {
        NotificationCenter.default.post(name: .sidebarReviewPermissions, object: nil)
    }

    @objc private func quit(_ sender: Any?) {
        manager?.quitApp()
    }
}
