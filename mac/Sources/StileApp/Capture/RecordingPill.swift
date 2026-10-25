import AppKit
import StileCore

/// v3.6: the floating pill while recording: red dot + timer, target name, a live mic level meter (when a mic is on),
/// Pause / Resume, Stop, Restart and Discard. A non-activating panel above everything, draggable by its background. It
/// belongs to this app, so display recordings exclude it, and window / Chrome tab recordings never see it.
@MainActor
final class RecordingPill {
    private let panel: NSPanel
    private let dot = DotView()
    private let timer = NSTextField(labelWithString: "0:00")
    private let status = NSTextField(labelWithString: "")
    private let name = NSTextField(labelWithString: "")
    private let meter = MeterView()
    private let pauseButton: NSButton
    private let onPause: () -> Void
    private let onStop: () -> Void
    private let onRestart: () -> Void
    private let onDiscard: () -> Void
    private var paused = false

    init(targetName: String, hasMic: Bool, onPause: @escaping () -> Void, onStop: @escaping () -> Void,
         onRestart: @escaping () -> Void, onDiscard: @escaping () -> Void) {
        self.onPause = onPause
        self.onStop = onStop
        self.onRestart = onRestart
        self.onDiscard = onDiscard
        pauseButton = Self.iconButton("pause.fill", tip: "Pause")
        let stopButton = Self.iconButton("stop.fill", tip: "Stop and open the recording")
        let restartButton = Self.iconButton("arrow.counterclockwise", tip: "Restart: throw this away and start over")
        let discardButton = Self.iconButton("trash", tip: "Discard the recording")

        timer.font = .monospacedDigitSystemFont(ofSize: 13, weight: .semibold)
        timer.textColor = .white
        status.font = .systemFont(ofSize: 11, weight: .semibold)
        status.textColor = SelectionHighlight.Tint.amber.color
        status.isHidden = true
        name.stringValue = targetName
        name.font = .systemFont(ofSize: 11)
        name.textColor = NSColor.white.withAlphaComponent(0.7)
        name.lineBreakMode = .byTruncatingTail
        name.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        meter.isHidden = !hasMic
        dot.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([dot.widthAnchor.constraint(equalToConstant: 10), dot.heightAnchor.constraint(equalToConstant: 10)])
        meter.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([meter.widthAnchor.constraint(equalToConstant: 38), meter.heightAnchor.constraint(equalToConstant: 8)])
        name.widthAnchor.constraint(lessThanOrEqualToConstant: 200).isActive = true

        let micIcon = NSImageView(image: NSImage(systemSymbolName: "mic.fill", accessibilityDescription: "Microphone level") ?? NSImage())
        micIcon.contentTintColor = NSColor.white.withAlphaComponent(0.7)
        micIcon.isHidden = !hasMic
        let stack = NSStackView(views: [dot, timer, status, name, micIcon, meter, pauseButton, stopButton, restartButton, discardButton])
        stack.orientation = .horizontal
        stack.spacing = 8
        stack.setCustomSpacing(12, after: name)
        stack.edgeInsets = NSEdgeInsets(top: 7, left: 12, bottom: 7, right: 8)
        stack.translatesAutoresizingMaskIntoConstraints = false

        let box = NSVisualEffectView()
        box.material = .hudWindow
        box.appearance = NSAppearance(named: .vibrantDark)
        box.state = .active
        box.wantsLayer = true
        box.layer?.cornerRadius = 18
        box.layer?.masksToBounds = true
        box.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: box.leadingAnchor), stack.trailingAnchor.constraint(equalTo: box.trailingAnchor),
            stack.topAnchor.constraint(equalTo: box.topAnchor), stack.bottomAnchor.constraint(equalTo: box.bottomAnchor),
        ])
        panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 420, height: 36), styleMask: [.borderless, .nonactivatingPanel],
                        backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = .screenSaver
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.isMovableByWindowBackground = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.contentView = box
        box.layoutSubtreeIfNeeded()
        panel.setContentSize(box.fittingSize)

        for (b, a) in [(pauseButton, #selector(pauseTapped)), (stopButton, #selector(stopTapped)),
                       (restartButton, #selector(restartTapped)), (discardButton, #selector(discardTapped))] {
            b.target = self
            b.action = a
        }
    }

    private static func iconButton(_ symbol: String, tip: String) -> NSButton {
        let b = NSButton(image: NSImage(systemSymbolName: symbol, accessibilityDescription: tip) ?? NSImage(), target: nil, action: nil)
        b.isBordered = false
        b.bezelStyle = .regularSquare
        b.contentTintColor = .white
        b.toolTip = tip
        b.setAccessibilityLabel(tip)
        b.imageScaling = .scaleProportionallyDown
        b.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([b.widthAnchor.constraint(equalToConstant: 24), b.heightAnchor.constraint(equalToConstant: 22)])
        return b
    }

    /// Bottom-centre of the screen (visible area) holding `quartz`, or under the pointer.
    func place(nearQuartz rect: CGRect?) {
        let area = rect.map { ScreenGeometry.appKit(fromQuartz: $0) }
        let screen = ScreenGeometry.screen(at: area.map { CGPoint(x: $0.midX, y: $0.midY) } ?? NSEvent.mouseLocation)?.visibleFrame
            ?? NSScreen.main?.visibleFrame ?? .zero
        let size = panel.frame.size
        var origin = CGPoint(x: screen.midX - size.width / 2, y: screen.minY + 24)
        // a window smaller than the screen: sit just under it when there is room, so it stays near the action
        if let a = area, a.minY - 12 - size.height >= screen.minY + 4 {
            origin = CGPoint(x: min(max(a.midX - size.width / 2, screen.minX + 4), screen.maxX - size.width - 4), y: a.minY - 12 - size.height)
        }
        panel.setFrameOrigin(origin)
        panel.orderFrontRegardless()
    }

    func setElapsed(_ seconds: Double) { timer.stringValue = RecordingMath.timer(seconds) }
    func setLevel(_ level: Float) { meter.level = paused ? 0 : level }

    /// `reason` nil = the plain "Paused".
    func setPaused(_ on: Bool, reason: String? = nil) {
        paused = on
        status.isHidden = !on
        status.stringValue = on ? (reason ?? "Paused") : ""
        dot.paused = on
        let symbol = on ? "play.fill" : "pause.fill"
        let tip = on ? "Resume" : "Pause"
        pauseButton.image = NSImage(systemSymbolName: symbol, accessibilityDescription: tip)
        pauseButton.toolTip = tip
        pauseButton.setAccessibilityLabel(tip)
        if on { meter.level = 0 }
        guard let box = panel.contentView else { return }
        box.layoutSubtreeIfNeeded()
        let old = panel.frame
        panel.setContentSize(box.fittingSize)
        panel.setFrameOrigin(NSPoint(x: old.midX - panel.frame.width / 2, y: old.minY))
    }

    func close() {
        panel.orderOut(nil)
        panel.close()
    }

    @objc private func pauseTapped() { onPause() }
    @objc private func stopTapped() { onStop() }
    @objc private func restartTapped() { onRestart() }
    @objc private func discardTapped() { onDiscard() }

    // MARK: Views

    /// The red recording dot; blinks gently while recording, turns amber and still when paused.
    private final class DotView: NSView {
        var paused = false { didSet { needsDisplay = true; updateAnimation() } }
        override init(frame: NSRect) {
            super.init(frame: frame)
            wantsLayer = true
            updateAnimation()
        }
        required init?(coder: NSCoder) { fatalError() }
        override var isFlipped: Bool { true }
        override func draw(_ dirtyRect: NSRect) {
            (paused ? SelectionHighlight.Tint.amber.color : SelectionHighlight.Tint.red.color).setFill()
            NSBezierPath(ovalIn: bounds).fill()
        }
        private func updateAnimation() {
            layer?.removeAnimation(forKey: "blink")
            guard !paused else { return }
            let a = CABasicAnimation(keyPath: "opacity")
            a.fromValue = 1
            a.toValue = 0.35
            a.duration = 0.9
            a.autoreverses = true
            a.repeatCount = .infinity
            layer?.add(a, forKey: "blink")
        }
    }

    /// A small horizontal level bar.
    private final class MeterView: NSView {
        var level: Float = 0 { didSet { if abs(oldValue - level) > 0.01 { needsDisplay = true } } }
        override var isFlipped: Bool { true }
        override func draw(_ dirtyRect: NSRect) {
            NSColor.white.withAlphaComponent(0.18).setFill()
            NSBezierPath(roundedRect: bounds, xRadius: 4, yRadius: 4).fill()
            let w = bounds.width * CGFloat(level)
            guard w > 1 else { return }
            (level > 0.9 ? SelectionHighlight.Tint.red.color : NSColor(srgbRed: 0.30, green: 0.80, blue: 0.40, alpha: 1)).setFill()
            NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: w, height: bounds.height), xRadius: 4, yRadius: 4).fill()
        }
    }
}

/// 3-2-1 in the middle of what will be recorded. Ours, so display recordings exclude it; it is gone before the first frame.
@MainActor
final class RecordingCountdown {
    private var panel: NSPanel?
    private var timer: Timer?
    private var done: (() -> Void)?

    var isRunning: Bool { panel != nil }

    func run(seconds: Int, centreQuartz rect: CGRect?, done: @escaping () -> Void) {
        self.done = done
        let label = NSTextField(labelWithString: "\(seconds)")
        label.font = .monospacedDigitSystemFont(ofSize: 64, weight: .bold)
        label.textColor = .white
        label.alignment = .center
        label.frame = NSRect(x: 0, y: 24, width: 120, height: 76)
        let box = NSView(frame: NSRect(x: 0, y: 0, width: 120, height: 120))
        box.wantsLayer = true
        box.layer?.backgroundColor = NSColor.black.withAlphaComponent(0.72).cgColor
        box.layer?.cornerRadius = 28
        box.addSubview(label)
        let p = NSPanel(contentRect: box.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = false
        p.level = .screenSaver
        p.ignoresMouseEvents = true
        p.isReleasedWhenClosed = false
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        p.contentView = box
        let c = rect.map { ScreenGeometry.appKit(fromQuartz: $0) }.map { CGPoint(x: $0.midX, y: $0.midY) }
            ?? ScreenGeometry.screen(at: NSEvent.mouseLocation).map { CGPoint(x: $0.frame.midX, y: $0.frame.midY) } ?? .zero
        p.setFrameOrigin(NSPoint(x: c.x - 60, y: c.y - 60))
        p.orderFrontRegardless()
        panel = p
        var left = seconds
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] t in
            MainActor.assumeIsolated {
                guard let self else { t.invalidate(); return }
                left -= 1
                if left > 0 { label.stringValue = "\(left)"; return }
                t.invalidate()
                let d = self.done
                self.cancel()
                // a beat for the badge to leave the screen (SCK excludes it anyway)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { d?() }
            }
        }
    }

    /// Removes the badge without running `done`.
    func cancel() {
        timer?.invalidate()
        timer = nil
        panel?.orderOut(nil)
        panel = nil
        done = nil
    }
}
