import AppKit
import ApplicationServices
import AVFoundation
import StileCore

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

    init(buttonTitle: String, grantedTitle: String = "Allowed", target: AnyObject, action: Selector) {
        button = NSButton(title: buttonTitle, target: target, action: action)
        button.bezelStyle = .rounded

        let img = NSImageView()
        if let i = NSImage(systemSymbolName: "checkmark.circle.fill", accessibilityDescription: "Allowed") {
            img.image = i
        }
        img.contentTintColor = .systemGreen
        let label = NSTextField(labelWithString: grantedTitle)
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
/// Screen Recording, launch at login, default browser, Chrome's vertical tabs and the Chrome extension. Shown on first launch, from
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
    private var micSlot: StatusSlot?
    private var chromeSlot: StatusSlot?
    private var loginSwitch: NSSwitch?
    private var defaultSwitch: NSSwitch?
    private var extList: NSStackView?
    private var extSignature = ""
    // v3.10: store-install controls (only built when HostSetup.storeIDSet)
    private var installButton: NSButton?
    private var installNote: NSTextField?
    private var installConfirm: NSTextField?
    private var installError: NSTextField?
    private var restartButton: NSButton?
    private var installRequested = false
    private var doneButton: NSButton?
    private var cachedDefaultBrowser = false

    static var isTrusted: Bool { AXIsProcessTrusted() }

    /// Screen Recording permission (used only for the window-only colour sample of Chrome).
    static var screenCaptureGranted: Bool { CGPreflightScreenCaptureAccess() }

    @discardableResult
    static func requestScreenCapture() -> Bool { CGRequestScreenCaptureAccess() }

    /// v3.5c: Microphone (for recording, later). Asked on the first recording with a mic selected, or from here.
    static var microphoneGranted: Bool { AVCaptureDevice.authorizationStatus(for: .audio) == .authorized }

    static func openMicrophoneSettings() {
        openPane("Privacy_Microphone")
    }

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
        trustedFired = false
        let trusted = Self.isTrusted
        if trusted { fireTrusted() }
        if !trusted || !UserDefaults.standard.bool(forKey: Self.onboardedKey) {
            show()
        } else {
            startTimerIfNeeded()
        }
    }

    /// v3.5c capture-only mode: nothing needs Accessibility. The window opens on the first run (or after a mode switch)
    /// and asks for Screen Recording; the Microphone row is optional and for recording.
    func ensureCaptureOnly() {
        if !UserDefaults.standard.bool(forKey: Self.onboardedKey) {
            show()
        } else {
            startTimerIfNeeded()
        }
    }

    /// The mode changed while the window may be open: rebuild it for the new mode.
    func modeChanged() {
        guard let w = window else { return }
        w.close()   // windowWillClose resets the controls; the caller decides whether to show it again
        show()
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

    @objc private func allowMicrophone() {
        if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
            AVCaptureDevice.requestAccess(for: .audio) { [weak self] _ in
                Task { @MainActor in self?.refresh(force: true) }
            }
        } else {
            Self.openMicrophoneSettings()
        }
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

    @objc private func setUpChrome() {
        ChromeSetup.run { [weak self] _ in self?.refresh(force: true) }
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
        micSlot = nil
        chromeSlot = nil
        loginSwitch = nil
        defaultSwitch = nil
        extList = nil
        extSignature = ""
        installButton = nil
        installNote = nil
        installConfirm = nil
        installError = nil
        restartButton = nil
        installRequested = false
        doneButton = nil
        stopTimerIfIdle()
    }

    // MARK: Refresh

    private func refresh(force: Bool) {
        guard window != nil else { return }
        let trusted = Self.isTrusted
        axSlot?.set(granted: trusted)
        screenSlot?.set(granted: Self.screenCaptureGranted)
        micSlot?.set(granted: Self.microphoneGranted)
        doneButton?.isEnabled = trusted || !Settings.useChrome
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
            chromeSlot?.set(granted: ChromeSetup.profilesNeedingSetup().isEmpty)
            refreshExtensions()
        }
    }

    private func refreshExtensions() {
        guard let list = extList else { return }
        let connected = Set((server?.identified ?? []).map { $0.profileDir })
        let profiles = HostStore.readProfiles(withExtras: false)
        let kinds = HostSetup.installedKinds()
        var entries: [(dir: String, name: String, ok: Bool, kind: ExtensionInstallKind?)] = []
        for p in profiles {
            guard let dir = p["dir"] as? String else { continue }
            entries.append((dir: dir, name: (p["name"] as? String) ?? dir, ok: connected.contains(dir), kind: kinds[dir]))
        }
        updateInstallBlock(entries)
        let sig = entries.map { "\($0.name)|\($0.ok)|\($0.kind.map { "\($0)" } ?? "-")" }.joined(separator: ";")
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
            let statusText: String
            switch (e.ok, e.kind) {
            case (true, _): statusText = "Connected"
            case (false, .store?): statusText = "Installed (store)"
            case (false, .unpacked?): statusText = "Installed (unpacked)"
            case (false, nil): statusText = "Not installed"
            }
            let status = NSTextField(labelWithString: statusText)
            status.font = NSFont.systemFont(ofSize: 12)
            status.textColor = e.ok ? .systemGreen : .secondaryLabelColor
            status.alignment = .right
            let spacer = NSView()
            spacer.setContentHuggingPriority(NSLayoutConstraint.Priority(1), for: .horizontal)
            var rowViews: [NSView] = [name, spacer]
            if HostSetup.storeIDSet && !e.ok && e.kind == nil {
                let add = NSButton(title: "Add from Chrome Web Store", target: self, action: #selector(addFromStore(_:)))
                add.bezelStyle = .rounded
                add.controlSize = .small
                add.identifier = NSUserInterfaceItemIdentifier(e.dir)
                rowViews.append(add)
            }
            rowViews.append(status)
            let row = NSStackView(views: rowViews)
            row.orientation = .horizontal
            row.distribution = .fill
            row.alignment = .centerY
            list.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: list.widthAnchor).isActive = true
        }
    }

    /// v3.10: shows the right store-install control for the current profile states (no-op without a store ID).
    private func updateInstallBlock(_ entries: [(dir: String, name: String, ok: Bool, kind: ExtensionInstallKind?)]) {
        guard HostSetup.storeIDSet, let button = installButton else { return }
        let missing = entries.contains { !$0.ok && $0.kind == nil }
        let hasUnpacked = entries.contains { $0.kind == .unpacked }
        let fileThere = ExtensionInstall.externalFileExists(dir: HostPaths.externalExtensionsDir, id: HostSetup.storeExtensionID)
        let requested = installRequested || fileThere
        let failed = !(installError?.stringValue.isEmpty ?? true)
        button.isHidden = !missing || hasUnpacked || requested
        installNote?.isHidden = !(missing && hasUnpacked)
        let confirmed = missing && !hasUnpacked && requested
        installConfirm?.isHidden = !confirmed
        installError?.isHidden = !failed || !missing || hasUnpacked || requested
        restartButton?.isHidden = !(confirmed && ChromeSetup.chromeRunning)
    }

    @objc private func installInAllProfiles() {
        switch ExtensionInstall.writeExternalExtensionFile(dir: HostPaths.externalExtensionsDir, id: HostSetup.storeExtensionID) {
        case .written:
            Log.write("setup: wrote External Extensions file for the store extension")
            installRequested = true
            installError?.stringValue = ""
        case .alreadyPresent:
            Log.write("setup: External Extensions file already present")
            installRequested = true
            installError?.stringValue = ""
        case .failed(let msg):
            Log.write("setup: cannot write External Extensions file: \(msg)")
            installError?.stringValue = "Couldn\u{2019}t add Stile: \(msg)"
        }
        extSignature = ""
        refreshExtensions()
    }

    @objc private func restartChromeClicked() {
        ChromeSetup.restartChrome { [weak self] _ in self?.refresh(force: true) }
    }

    @objc private func addFromStore(_ sender: NSButton) {
        guard let dir = sender.identifier?.rawValue, !dir.isEmpty else { return }
        HostActions.openStorePage(profileDir: dir)
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
        w.title = "Welcome to Stile"
        w.isReleasedWhenClosed = false
        w.delegate = self

        let content = NSView(frame: NSRect(x: 0, y: 0, width: 560, height: 520))

        // Header
        let icon = NSImageView()
        icon.image = NSApp.applicationIconImage
        icon.imageScaling = .scaleProportionallyUpOrDown
        icon.translatesAutoresizingMaskIntoConstraints = false
        let heading = NSTextField(labelWithString: "Welcome to Stile")
        heading.font = NSFont.systemFont(ofSize: 20, weight: .semibold)
        let chromeMode = Settings.useChrome
        let sub = NSTextField(labelWithString: chromeMode
            ? "A few permissions let Stile follow Chrome. Only Accessibility is required."
            : "Capture only: Stile needs Screen Recording to take screenshots. Everything else is optional.")
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
        let mic = StatusSlot(buttonTitle: "Allow\u{2026}", target: self, action: #selector(allowMicrophone))
        micSlot = mic
        let chrome = StatusSlot(buttonTitle: "Set up\u{2026}", grantedTitle: "Ready", target: self, action: #selector(setUpChrome))
        chromeSlot = chrome
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
        let extDetail = label("Stile talks to Chrome through its extension, which is added to each profile you use.",
                              size: 12, secondary: true)
        extDetail.preferredMaxLayoutWidth = 480
        var extViews: [NSView] = [extTitle, extDetail, list, steps, buttons]
        if HostSetup.storeIDSet {
            // v3.10: store install first; the unpacked steps move under a secondary heading.
            let install = NSButton(title: "Install in all profiles", target: self, action: #selector(installInAllProfiles))
            install.bezelStyle = .rounded
            let note = label("A profile has the developer (unpacked) copy loaded, so Stile won\u{2019}t add the store copy " +
                             "automatically. Use Add from Chrome Web Store per profile, or remove the unpacked copy first.",
                             size: 12, secondary: true)
            note.preferredMaxLayoutWidth = 480
            let confirm = label("Chrome adds Stile to each profile the next time it starts and asks you to enable it.",
                                size: 12, secondary: true)
            confirm.preferredMaxLayoutWidth = 480
            let err = label("", size: 12)
            err.textColor = .systemRed
            err.preferredMaxLayoutWidth = 480
            let restart = NSButton(title: "Restart Chrome", target: self, action: #selector(restartChromeClicked))
            restart.bezelStyle = .rounded
            for v in [install, note, confirm, err, restart] as [NSView] { v.isHidden = true }
            installButton = install
            installNote = note
            installConfirm = confirm
            installError = err
            restartButton = restart
            let dev = label("Developer: load unpacked", size: 11, weight: .semibold, secondary: true)
            extViews = [extTitle, extDetail, list, install, note, confirm, err, restart, dev, steps, buttons]
        }
        let extBlock = NSStackView(views: extViews)
        extBlock.orientation = .vertical
        extBlock.alignment = .leading
        extBlock.spacing = 8

        let screenRow = row(title: chromeMode ? "Screen Recording (optional)" : "Screen Recording (required)",
                            detail: chromeMode
                                ? "Matches the sidebar to Chrome\u{2019}s exact colour, and takes screenshots of other apps."
                                : "Lets Stile capture what is on your screen.", trailing: screen.view)
        let micRow = row(title: "Microphone (optional)",
                         detail: "For screen recordings with your voice. Asked again on the first recording if you skip it.",
                         trailing: mic.view)
        let loginRow = row(title: "Launch at login (optional)", detail: "Start Stile when you log in.", trailing: login)
        let items: [NSView] = chromeMode ? [
            row(title: "Accessibility (required)",
                detail: "Lets Stile follow and move Chrome\u{2019}s windows.", trailing: ax.view),
            row(title: "Chrome vertical tabs (recommended)",
                detail: "The sidebar sits over Chrome\u{2019}s vertical tabs. Set up turns them on in every profile " +
                    "(Chrome restarts and reopens your tabs). To do it yourself: right-click Chrome\u{2019}s tab bar " +
                    "\u{2192} Show tabs vertically, in each profile.", trailing: chrome.view),
            screenRow,
            micRow,
            loginRow,
            row(title: "Default browser for links from other apps (optional)",
                detail: "Links from other apps open in a little window in Chrome.", trailing: def),
            extBlock,
        ] : [screenRow, micRow, loginRow]
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
        done.isEnabled = Self.isTrusted || !chromeMode
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
