import AppKit
import ApplicationServices

@MainActor
final class Permissions: NSObject {
    private var window: NSWindow?
    private var timer: Timer?
    private var onTrusted: (() -> Void)?

    static var isTrusted: Bool { AXIsProcessTrusted() }

    static func openSettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
            NSWorkspace.shared.open(url)
        }
    }

    /// Prompts once, and until trusted shows an onboarding window and polls every second.
    func ensure(_ onTrusted: @escaping () -> Void) {
        self.onTrusted = onTrusted
        let options = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
        if AXIsProcessTrustedWithOptions(options) {
            finish()
            return
        }
        showWindow()
        timer = Timer.scheduledTimer(timeInterval: 1.0, target: self, selector: #selector(poll),
                                     userInfo: nil, repeats: true)
    }

    @objc private func poll() {
        if Self.isTrusted { finish() }
    }

    private func finish() {
        timer?.invalidate()
        timer = nil
        window?.close()
        window = nil
        let cb = onTrusted
        onTrusted = nil
        cb?()
    }

    @objc private func openClicked() {
        Self.openSettings()
    }

    private func showWindow() {
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 420, height: 190),
                         styleMask: [.titled, .closable],
                         backing: .buffered, defer: false)
        w.title = "Sidebar needs Accessibility access"
        w.isReleasedWhenClosed = false

        let heading = NSTextField(labelWithString: "Allow Sidebar to control Chrome's windows")
        heading.font = NSFont.boldSystemFont(ofSize: 14)
        let body = NSTextField(wrappingLabelWithString:
            "Sidebar follows Chrome's windows and draws its sidebar and tab-bar cover on top of them. " +
            "That needs Accessibility permission. Open System Settings, enable Sidebar under Privacy & Security > Accessibility, " +
            "and this window will close by itself.")
        body.font = NSFont.systemFont(ofSize: 12)
        body.preferredMaxLayoutWidth = 380
        let button = NSButton(title: "Open Accessibility Settings", target: self, action: #selector(openClicked))
        button.bezelStyle = .rounded

        let stack = NSStackView(views: [heading, body, button])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 12
        stack.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)
        stack.translatesAutoresizingMaskIntoConstraints = false

        let content = NSView(frame: w.contentRect(forFrameRect: w.frame))
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            stack.topAnchor.constraint(equalTo: content.topAnchor),
        ])
        w.contentView = content
        w.center()
        NSApp.activate(ignoringOtherApps: true)
        w.makeKeyAndOrderFront(nil)
        window = w
    }
}
