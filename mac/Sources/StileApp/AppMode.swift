import AppKit

extension Settings {
    private static let useChromeKey = "useChrome"

    /// v3.5c: "Use Stile with Chrome". Off = capture only (no Chrome tracking, overlay, follow loop, event taps, close
    /// interceptor or little links). Existing installs and anything undecided count as on.
    static var useChrome: Bool {
        get { UserDefaults.standard.object(forKey: useChromeKey) as? Bool ?? true }
        set {
            UserDefaults.standard.set(newValue, forKey: useChromeKey)
            NotificationCenter.default.post(name: .stileModeChanged, object: nil)
            post()
        }
    }

    /// The person has picked a mode (or it was inferred for an existing install).
    static var modeDecided: Bool { UserDefaults.standard.object(forKey: useChromeKey) != nil }
}

enum AppMode {
    /// A launch before 3.5c left traces: the welcome was dismissed, a state file exists or Chrome's host manifest is there.
    /// Such installs keep Chrome mode without being asked.
    static func inferExistingInstall() {
        guard !Settings.modeDecided else { return }
        let fm = FileManager.default
        let existing = UserDefaults.standard.bool(forKey: "permissionsOnboarded")
            || fm.fileExists(atPath: HostPaths.stateFile)
            || fm.fileExists(atPath: HostPaths.nativeMessagingDir + "/" + HostSetup.hostName + ".json")
        if existing {
            UserDefaults.standard.set(true, forKey: "useChrome")
            Log.write("mode: existing install, staying with Chrome mode")
        }
    }
}

/// First-run choice: two clear options. Shown before the permissions onboarding, which then asks only for what the
/// chosen mode needs.
@MainActor
final class ModeChoiceWindow: NSObject, NSWindowDelegate {
    private var window: NSWindow?
    private var done: ((Bool) -> Void)?
    private var chosen = false

    func show(_ done: @escaping (Bool) -> Void) {
        self.done = done
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 520, height: 330), styleMask: [.titled, .closable],
                         backing: .buffered, defer: false)
        w.title = "Welcome to Stile"
        w.isReleasedWhenClosed = false
        w.delegate = self

        let icon = NSImageView()
        icon.image = NSApp.applicationIconImage
        icon.imageScaling = .scaleProportionallyUpOrDown
        icon.translatesAutoresizingMaskIntoConstraints = false
        let heading = NSTextField(labelWithString: "How will you use Stile?")
        heading.font = NSFont.systemFont(ofSize: 20, weight: .semibold)
        let sub = NSTextField(labelWithString: "You can change this later in Stile\u{2019}s settings.")
        sub.font = NSFont.systemFont(ofSize: 12)
        sub.textColor = .secondaryLabelColor

        let chrome = option(title: "Stile for Chrome (sidebar + capture)",
                            detail: "The Arc-style sidebar over Chrome\u{2019}s vertical tabs, plus screenshots of anything on screen. " +
                                "Needs Accessibility and the Chrome extension.", tag: 1)
        let capture = option(title: "Capture only",
                             detail: "Just screenshots (and recordings later) from the menu bar. Only needs Screen Recording; " +
                                "Chrome is left alone.", tag: 0)
        let stack = NSStackView(views: [icon, heading, sub, chrome, capture])
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 10
        stack.setCustomSpacing(16, after: sub)
        stack.translatesAutoresizingMaskIntoConstraints = false
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 520, height: 330))
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            icon.widthAnchor.constraint(equalToConstant: 56), icon.heightAnchor.constraint(equalToConstant: 56),
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 20),
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 28),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -28),
            chrome.widthAnchor.constraint(equalTo: stack.widthAnchor), capture.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
        w.contentView = content
        w.center()
        NSApp.activate(ignoringOtherApps: true)
        w.makeKeyAndOrderFront(nil)
        window = w
    }

    /// A big push-button row: bold title, wrapped detail.
    private func option(title: String, detail: String, tag: Int) -> NSView {
        let b = NSButton(title: "", target: self, action: #selector(picked(_:)))
        b.tag = tag
        b.bezelStyle = .regularSquare
        b.isBordered = true
        b.translatesAutoresizingMaskIntoConstraints = false
        let t = NSTextField(labelWithString: title)
        t.font = NSFont.systemFont(ofSize: 14, weight: .semibold)
        let d = NSTextField(wrappingLabelWithString: detail)
        d.font = NSFont.systemFont(ofSize: 12)
        d.textColor = .secondaryLabelColor
        d.preferredMaxLayoutWidth = 440
        let col = NSStackView(views: [t, d])
        col.orientation = .vertical
        col.alignment = .leading
        col.spacing = 3
        col.translatesAutoresizingMaskIntoConstraints = false
        b.addSubview(col)
        NSLayoutConstraint.activate([
            col.leadingAnchor.constraint(equalTo: b.leadingAnchor, constant: 14),
            col.trailingAnchor.constraint(equalTo: b.trailingAnchor, constant: -14),
            col.topAnchor.constraint(equalTo: b.topAnchor, constant: 10),
            col.bottomAnchor.constraint(equalTo: b.bottomAnchor, constant: -10),
        ])
        return b
    }

    @objc private func picked(_ sender: NSButton) {
        chosen = true
        let useChrome = sender.tag == 1
        window?.close()
        done?(useChrome)
        done = nil
    }

    func windowWillClose(_ notification: Notification) {
        // closing the window without choosing keeps the default (Chrome), so nothing stays half-started
        if !chosen { done?(true); done = nil }
        window = nil
    }
}
