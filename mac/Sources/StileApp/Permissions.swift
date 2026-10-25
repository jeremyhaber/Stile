import AppKit
import ApplicationServices

/// A flipped container so a scroll view's document starts at the top.
private final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}

/// Trailing control of a permission row: a green "Allowed" check, or the button that asks for it.
@MainActor
private final class StatusSlot {
    let view = NSStackView()
    let button: NSButton
    private let granted = NSStackView()

    init(buttonTitle: String, target: AnyObject, action: Selector) {
        button = NSButton(title: buttonTitle, target: target, action: action)
        button.bezelStyle = .rounded

        let img = NSImageView()
        if let i = NSImage(systemSymbolName: "checkmark.circle.fill", accessibilityDescription: "Allowed") {
            img.image = i
        }
        img.contentTintColor = .systemGreen
        let label = NSTextField(labelWithString: "Allowed")
        label.font = NSFont.systemFont(ofSize: 12)
        label.textColor = .secondaryLabelColor
        granted.orientation = .horizontal
        granted.spacing = 4
        granted.addArrangedSubview(img)
        granted.addArrangedSubview(label)

        view.orientation = .horizontal
        view.alignment = .centerY
        view.addArrangedSubview(granted)
        view.addArrangedSubview(button)
        view.setContentHuggingPriority(.required, for: .horizontal)
        set(granted: false)
    }

    func set(granted g: Bool) {
        granted.isHidden = !g
        button.isHidden = g
    }
}

/// Permissions onboarding (v3.0): a native welcome window with live status for Accessibility (required),
/// Screen Recording, launch at login, default browser and the Chrome extension. Shown on first launch, from
/// Settings > App > "Review permissions" (host message `reviewPermissions`), and automatically whenever
/// Accessibility is missing. Replaces the old Accessibility-only window.
@MainActor
final class Permissions: NSObject, NSWindowDelegate {
    static let onboardedKey = "permissionsOnboarded"
    private static let screenAskedKey = "screenCaptureAsked"

    /// Needed for the default-browser toggle and the per-profile extension status.
    weak var server: HostServer?

    private var window: NSWindow?
    private var timer: Timer?
    private var onTrusted: (() -> Void)?
    private var trustedFired = false
    private var pollCount = 0

    // Live controls (nil while the window is closed)
    private var axSlot: StatusSlot?
    private var screenSlot: StatusSlot?
    private var loginSwitch: NSSwitch?
    private var defaultSwitch: NSSwitch?
    private var extList: NSStackView?
    private var extSignature = ""
    private var doneButton: NSButton?
    private var cachedDefaultBrowser = false

    static var isTrusted: Bool { AXIsProcessTrusted() }

    /// Screen Recording permission (used only for the window-only colour sample of Chrome).
    static var screenCaptureGranted: Bool { CGPreflightScreenCaptureAccess() }

    @discardableResult
    static func requestScreenCapture() -> Bool { CGRequestScreenCaptureAccess() }

    static func openSettings() {
        openPane("Privacy_Accessibility")
    }

    static func openScreenCaptureSettings() {
        openPane("Privacy_ScreenCapture")
    }

    private static func openPane(_ name: String) {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(name)") {
            NSWorkspace.shared.open(url)
        }
    }

    // MARK: Entry points

    /// Calls `onTrusted` (once) as soon as Accessibility is granted, now or later. The window opens when
    /// Accessibility is missing or the welcome has never been dismissed.
    func ensure(_ onTrusted: @escaping () -> Void) {
        self.onTrusted = onTrusted
        let trusted = Self.isTrusted
        if trusted { fireTrusted() }
        if !trusted || !UserDefaults.standard.bool(forKey: Self.onboardedKey) {
            show()
        } else {
            startTimerIfNeeded()
        }
    }

    /// Opens (or raises) the window.
    func show() {
        if let w = window {
            NSApp.activate(ignoringOtherApps: true)
            w.makeKeyAndOrderFront(nil)
            refresh(force: true)
            return
        }
        buildWindow()
        refresh(force: true)
        startTimerIfNeeded()
    }

    // MARK: Polling

    private func startTimerIfNeeded() {
        if timer != nil { return }
        if trustedFired && window == nil { return }
        timer = Timer.scheduledTimer(timeInterval: 1.0, target: self, selector: #selector(poll),
                                     userInfo: nil, repeats: true)
    }

    private func stopTimerIfIdle() {
        if trustedFired && window == nil {
            timer?.invalidate()
            timer = nil
        }
    }

    @objc private func poll() {
        pollCount += 1
        if Self.isTrusted && !trustedFired { fireTrusted() }
        if window != nil { refresh(force: false) }
        stopTimerIfIdle()
    }

    private func fireTrusted() {
        trustedFired = true
        let cb = onTrusted
        onTrusted = nil
        cb?()
    }

    // MARK: Actions

    @objc private func allowAccessibility() {
        let options = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
        Self.openSettings()
    }

    @objc private func allowScreenRecording() {
        let asked = UserDefaults.standard.bool(forKey: Self.screenAskedKey)
        let granted = Self.requestScreenCapture()
        UserDefaults.standard.set(true, forKey: Self.screenAskedKey)
        // macOS only prompts once; after that the pane is the only way.
        if !granted && asked { Self.openScreenCaptureSettings() }
    }

    @objc private func loginToggled(_ sender: NSSwitch) {
        LoginItem.set(sender.state == .on)
        Settings.post()
        sender.state = LoginItem.enabled ? .on : .off
    }

    @objc private func defaultToggled(_ sender: NSSwitch) {
        let on = sender.state == .on
        guard let server = server else {
            sender.state = on ? .off : .on
            return
        }
        sender.isEnabled = false
        server.setDefaultBrowser(on, from: nil) { [weak self, weak sender] now, err in
            if let e = err { Log.write("permissions: default browser change failed: \(e)") }
            self?.cachedDefaultBrowser = now
            sender?.state = now ? .on : .off
            sender?.isEnabled = true
        }
    }

    @objc private func showExtensionFolder() {
        HostActions.revealExtensionFolder()
    }

    @objc private func openExtensionsPage() {
        let profiles = HostStore.readProfiles(withExtras: false).compactMap { $0["dir"] as? String }
        let connected = Set((server?.identified ?? []).map { $0.profileDir })
        let dir = profiles.first(where: { !connected.contains($0) }) ?? profiles.first ?? "Default"
        HostActions.openExtensionsPage(profileDir: dir)
    }

    @objc private func doneClicked() {
        window?.close()
    }

    @objc private func skipClicked() {
        window?.close()
    }

    func windowWillClose(_ notification: Notification) {
        UserDefaults.standard.set(true, forKey: Self.onboardedKey)
        window = nil
        axSlot = nil
        screenSlot = nil
        loginSwitch = nil
        defaultSwitch = nil
        extList = nil
        extSignature = ""
        doneButton = nil
        stopTimerIfIdle()
    }

    // MARK: Refresh

    private func refresh(force: Bool) {
        guard window != nil else { return }
        let trusted = Self.isTrusted
        axSlot?.set(granted: trusted)
        screenSlot?.set(granted: Self.screenCaptureGranted)
        doneButton?.isEnabled = trusted
        let slow = force || pollCount % 3 == 0
        if let sw = loginSwitch {
            let want: NSControl.StateValue = LoginItem.enabled ? .on : .off
            if sw.state != want { sw.state = want }
        }
        if slow {
            if let sw = defaultSwitch, sw.isEnabled {
                cachedDefaultBrowser = (HostStore.currentSettings()["defaultBrowser"] as? Bool) ?? false
                let want: NSControl.StateValue = cachedDefaultBrowser ? .on : .off
                if sw.state != want { sw.state = want }
            }
            refreshExtensions()
        }
    }

    private func refreshExtensions() {
        guard let list = extList else { return }
        let connected = Set((server?.identified ?? []).map { $0.profileDir })
        let profiles = HostStore.readProfiles(withExtras: false)
        var entries: [(name: String, ok: Bool)] = []
        for p in profiles {
            guard let dir = p["dir"] as? String else { continue }
            entries.append((name: (p["name"] as? String) ?? dir, ok: connected.contains(dir)))
        }
        let sig = entries.map { "\($0.name)|\($0.ok)" }.joined(separator: ";")
        if sig == extSignature { return }
        extSignature = sig
        for v in list.arrangedSubviews {
            list.removeArrangedSubview(v)
            v.removeFromSuperview()
        }
        if entries.isEmpty {
            let none = NSTextField(labelWithString: "No Chrome profiles found.")
            none.font = NSFont.systemFont(ofSize: 12)
            none.textColor = .secondaryLabelColor
            list.addArrangedSubview(none)
            return
        }
        for e in entries {
            let name = NSTextField(labelWithString: e.name)
            name.font = NSFont.systemFont(ofSize: 12)
            let status = NSTextField(labelWithString: e.ok ? "Connected" : "Not installed")
            status.font = NSFont.systemFont(ofSize: 12)
            status.textColor = e.ok ? .systemGreen : .secondaryLabelColor
            status.alignment = .right
            let spacer = NSView()
            spacer.setContentHuggingPriority(NSLayoutConstraint.Priority(1), for: .horizontal)
            let row = NSStackView(views: [name, spacer, status])
            row.orientation = .horizontal
            row.distribution = .fill
            row.alignment = .centerY
            list.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: list.widthAnchor).isActive = true
        }
    }

    // MARK: Window

    private func label(_ text: String, size: CGFloat, weight: NSFont.Weight = .regular, secondary: Bool = false) -> NSTextField {
        let f = NSTextField(wrappingLabelWithString: text)
        f.font = NSFont.systemFont(ofSize: size, weight: weight)
        if secondary { f.textColor = .secondaryLabelColor }
        f.isSelectable = false
        return f
    }

    /// Title + description on the left, `trailing` control on the right.
    private func row(title: String, detail: String, trailing: NSView) -> NSStackView {
        let t = label(title, size: 13, weight: .semibold)
        let d = label(detail, size: 12, secondary: true)
        d.preferredMaxLayoutWidth = 340
        let texts = NSStackView(views: [t, d])
        texts.orientation = .vertical
        texts.alignment = .leading
        texts.spacing = 2
        let r = NSStackView(views: [texts, trailing])
        r.orientation = .horizontal
        r.alignment = .centerY
        r.distribution = .fill
        r.spacing = 16
        trailing.setContentHuggingPriority(.required, for: .horizontal)
        texts.setContentHuggingPriority(.defaultLow, for: .horizontal)
        return r
    }

    private func separator() -> NSBox {
        let b = NSBox()
        b.boxType = .separator
        return b
    }

    private func buildWindow() {
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 560, height: 520),
                         styleMask: [.titled, .closable],
                         backing: .buffered, defer: false)
        w.title = "Welcome to Sidebar"
        w.isReleasedWhenClosed = false
        w.delegate = self

        let content = NSView(frame: NSRect(x: 0, y: 0, width: 560, height: 520))

        // Header
        let icon = NSImageView()
        icon.image = NSApp.applicationIconImage
        icon.imageScaling = .scaleProportionallyUpOrDown
        icon.translatesAutoresizingMaskIntoConstraints = false
        let heading = NSTextField(labelWithString: "Welcome to Sidebar")
        heading.font = NSFont.systemFont(ofSize: 20, weight: .semibold)
        let sub = NSTextField(labelWithString: "A few permissions let Sidebar follow Chrome. Only Accessibility is required.")
        sub.font = NSFont.systemFont(ofSize: 12)
        sub.textColor = .secondaryLabelColor
        let header = NSStackView(views: [icon, heading, sub])
        header.orientation = .vertical
        header.alignment = .centerX
        header.spacing = 6
        header.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            icon.widthAnchor.constraint(equalToConstant: 64),
            icon.heightAnchor.constraint(equalToConstant: 64),
        ])

        // Rows
        let ax = StatusSlot(buttonTitle: "Allow\u{2026}", target: self, action: #selector(allowAccessibility))
        axSlot = ax
        let screen = StatusSlot(buttonTitle: "Allow\u{2026}", target: self, action: #selector(allowScreenRecording))
        screenSlot = screen
        let login = NSSwitch()
        login.target = self
        login.action = #selector(loginToggled(_:))
        loginSwitch = login
        let def = NSSwitch()
        def.target = self
        def.action = #selector(defaultToggled(_:))
        defaultSwitch = def

        let list = NSStackView()
        list.orientation = .vertical
        list.alignment = .leading
        list.spacing = 4
        extList = list

        let steps = label("1. Open the Chrome extensions page.\n2. Turn on Developer mode (top right).\n" +
                          "3. Click Load unpacked and choose the extension folder.", size: 12, secondary: true)
        steps.preferredMaxLayoutWidth = 480
        let showFolder = NSButton(title: "Show extension folder", target: self, action: #selector(showExtensionFolder))
        showFolder.bezelStyle = .rounded
        let openExt = NSButton(title: "Open Chrome extensions page", target: self, action: #selector(openExtensionsPage))
        openExt.bezelStyle = .rounded
        let buttons = NSStackView(views: [showFolder, openExt])
        buttons.orientation = .horizontal
        buttons.spacing = 8

        let extTitle = label("Chrome extension", size: 13, weight: .semibold)
        let extDetail = label("Sidebar talks to Chrome through its extension, which is added to each profile you use.",
                              size: 12, secondary: true)
        extDetail.preferredMaxLayoutWidth = 480
        let extBlock = NSStackView(views: [extTitle, extDetail, list, steps, buttons])
        extBlock.orientation = .vertical
        extBlock.alignment = .leading
        extBlock.spacing = 8

        let items: [NSView] = [
            row(title: "Accessibility (required)",
                detail: "Lets Sidebar follow and move Chrome\u{2019}s windows.", trailing: ax.view),
            row(title: "Screen Recording (optional)",
                detail: "Matches the sidebar to Chrome\u{2019}s exact colour.", trailing: screen.view),
            row(title: "Launch at login (optional)",
                detail: "Start Sidebar when you log in.", trailing: login),
            row(title: "Default browser for links from other apps (optional)",
                detail: "Links from other apps open in a little window in Chrome.", trailing: def),
            extBlock,
        ]
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 14
        stack.translatesAutoresizingMaskIntoConstraints = false
        for (i, v) in items.enumerated() {
            stack.addArrangedSubview(v)
            v.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
            if i < items.count - 1 {
                let sep = separator()
                stack.addArrangedSubview(sep)
                sep.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
            }
        }

        let doc = FlippedView()
        doc.translatesAutoresizingMaskIntoConstraints = false
        doc.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: doc.leadingAnchor, constant: 28),
            stack.trailingAnchor.constraint(equalTo: doc.trailingAnchor, constant: -28),
            stack.topAnchor.constraint(equalTo: doc.topAnchor, constant: 8),
            stack.bottomAnchor.constraint(equalTo: doc.bottomAnchor, constant: -16),
        ])
        let scroll = NSScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
        scroll.borderType = .noBorder
        scroll.documentView = doc
        let clip = scroll.contentView
        NSLayoutConstraint.activate([
            doc.topAnchor.constraint(equalTo: clip.topAnchor),
            doc.leadingAnchor.constraint(equalTo: clip.leadingAnchor),
            doc.trailingAnchor.constraint(equalTo: clip.trailingAnchor),
        ])

        // Footer
        let footerLine = separator()
        footerLine.translatesAutoresizingMaskIntoConstraints = false
        let skip = NSButton(title: "Skip for now", target: self, action: #selector(skipClicked))
        skip.bezelStyle = .rounded
        let done = NSButton(title: "Done", target: self, action: #selector(doneClicked))
        done.bezelStyle = .rounded
        done.keyEquivalent = "\r"
        done.isEnabled = Self.isTrusted
        doneButton = done
        let footerSpacer = NSView()
        footerSpacer.setContentHuggingPriority(NSLayoutConstraint.Priority(1), for: .horizontal)
        let footer = NSStackView(views: [skip, footerSpacer, done])
        footer.orientation = .horizontal
        footer.distribution = .fill
        footer.alignment = .centerY
        footer.translatesAutoresizingMaskIntoConstraints = false

        content.addSubview(header)
        content.addSubview(scroll)
        content.addSubview(footerLine)
        content.addSubview(footer)
        NSLayoutConstraint.activate([
            header.topAnchor.constraint(equalTo: content.topAnchor, constant: 20),
            header.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            scroll.topAnchor.constraint(equalTo: header.bottomAnchor, constant: 14),
            scroll.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: footerLine.topAnchor),
            footerLine.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            footerLine.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            footerLine.bottomAnchor.constraint(equalTo: footer.topAnchor, constant: -10),
            footer.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
            footer.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20),
            footer.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -14),
        ])

        w.contentView = content
        w.center()
        NSApp.activate(ignoringOtherApps: true)
        w.makeKeyAndOrderFront(nil)
        window = w
    }
}
