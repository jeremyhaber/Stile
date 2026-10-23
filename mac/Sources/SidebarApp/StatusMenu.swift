import AppKit
import ServiceManagement

@MainActor
final class StatusMenu: NSObject, NSMenuDelegate {
    private let item: NSStatusItem
    private let menu = NSMenu()
    private let manager: OverlayManager
    private let server: BridgeServer

    private let statusLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let pinItem = NSMenuItem(title: "Pin sidebar", action: #selector(StatusMenu.togglePin), keyEquivalent: "s")
    private let pushItem = NSMenuItem(title: "Move the page over", action: #selector(StatusMenu.setPush), keyEquivalent: "")
    private let floatItem = NSMenuItem(title: "Float over the page", action: #selector(StatusMenu.setFloat), keyEquivalent: "")
    private let coverItem = NSMenuItem(title: "Cover Chrome's tab bar", action: #selector(StatusMenu.toggleCover), keyEquivalent: "")
    private let loginItem = NSMenuItem(title: "Open at login", action: #selector(StatusMenu.toggleLogin), keyEquivalent: "")
    private var heightItems: [(Int, NSMenuItem)] = []

    init(manager: OverlayManager, server: BridgeServer) {
        self.manager = manager
        self.server = server
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        super.init()

        if let button = item.button {
            button.image = NSImage(systemSymbolName: "sidebar.left", accessibilityDescription: "Sidebar")
            button.toolTip = "Sidebar"
        }

        menu.delegate = self
        menu.autoenablesItems = false

        statusLine.isEnabled = false
        menu.addItem(statusLine)
        menu.addItem(.separator())

        pinItem.target = self
        pinItem.keyEquivalentModifierMask = [.control, .option]
        menu.addItem(pinItem)

        let modeMenu = NSMenu()
        for i in [pushItem, floatItem] {
            i.target = self
            modeMenu.addItem(i)
        }
        let modeParent = NSMenuItem(title: "When pinned", action: nil, keyEquivalent: "")
        modeParent.submenu = modeMenu
        menu.addItem(modeParent)

        coverItem.target = self
        menu.addItem(coverItem)

        let heightMenu = NSMenu()
        for (value, title) in [(0, "Auto"), (36, "36"), (40, "40"), (44, "44"), (48, "48")] {
            let mi = NSMenuItem(title: title, action: #selector(setHeight(_:)), keyEquivalent: "")
            mi.target = self
            mi.tag = value
            heightMenu.addItem(mi)
            heightItems.append((value, mi))
        }
        let heightParent = NSMenuItem(title: "Tab bar height", action: nil, keyEquivalent: "")
        heightParent.submenu = heightMenu
        menu.addItem(heightParent)

        menu.addItem(.separator())
        loginItem.target = self
        menu.addItem(loginItem)

        let ax = NSMenuItem(title: "Accessibility settings\u{2026}", action: #selector(openAX), keyEquivalent: "")
        ax.target = self
        menu.addItem(ax)

        menu.addItem(.separator())
        let quitItem = NSMenuItem(title: "Quit Sidebar", action: #selector(StatusMenu.quit), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)

        item.menu = menu
        refresh()
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        refresh()
    }

    private func refresh() {
        let n = server.identified.count
        if !Permissions.isTrusted {
            statusLine.title = "Accessibility access needed"
        } else if n == 0 {
            statusLine.title = "Extension not connected"
        } else {
            statusLine.title = n == 1 ? "Connected: 1 Chrome profile" : "Connected: \(n) Chrome profiles"
        }
        pinItem.title = manager.isFocusedPinned ? "Unpin sidebar" : "Pin sidebar"
        let mode = Settings.pinMode
        pushItem.state = mode == "push" ? .on : .off
        floatItem.state = mode == "float" ? .on : .off
        coverItem.state = Settings.coverEnabled ? .on : .off
        let h = Settings.tabBarHeight
        for (value, mi) in heightItems { mi.state = value == h ? .on : .off }
        loginItem.state = SMAppService.mainApp.status == .enabled ? .on : .off
        pinItem.isEnabled = true
        for i in [pushItem, floatItem, coverItem, loginItem] { i.isEnabled = true }
        for (_, mi) in heightItems { mi.isEnabled = true }
    }

    @objc private func togglePin() { manager.togglePinFocused(requireChromeFrontmost: false) }
    @objc private func setPush() { Settings.pinMode = "push"; refresh() }
    @objc private func setFloat() { Settings.pinMode = "float"; refresh() }
    @objc private func toggleCover() { Settings.coverEnabled = !Settings.coverEnabled; refresh() }
    @objc private func setHeight(_ sender: NSMenuItem) { Settings.tabBarHeight = sender.tag; refresh() }

    @objc private func toggleLogin() {
        do {
            if SMAppService.mainApp.status == .enabled {
                try SMAppService.mainApp.unregister()
            } else {
                try SMAppService.mainApp.register()
            }
        } catch {
            Log.write("login item toggle failed: \(error.localizedDescription)")
        }
        refresh()
    }

    @objc private func openAX() { Permissions.openSettings() }

    @objc private func quit() {
        NSApp.terminate(nil)
    }
}
