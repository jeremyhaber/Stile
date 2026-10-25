import AppKit

/// v3.6: the pre-start bar. A compact HUD panel under the selection (bottom-centre of the display for a whole screen) that
/// names what will be recorded and holds the audio choices: microphone picker (None + the input devices), system audio
/// toggle, Start (Return) and Cancel (Esc). v3.9: a camera row: a camera (None + the cameras; for Camera only, no None)
/// and the bubble's size; picking one shows the bubble right away so it can be placed. The panel can become key without activating the app, so Return / Esc work
/// through the buttons' key equivalents. The caller keeps the target highlighted while the bar is up; the choices
/// are saved by the caller.
@MainActor
final class RecordingBar {
    struct Choice {
        var micID: String?
        var systemAudio: Bool
        var cameraID: String?
        var cameraSize: CameraBubble.Size
    }

    private let panel: BarPanel
    private let title = NSTextField(labelWithString: "")
    private let note = NSTextField(wrappingLabelWithString: "")
    private let mic = NSPopUpButton(frame: .zero, pullsDown: false)
    private let system = NSButton(checkboxWithTitle: "System audio", target: nil, action: nil)
    private let start = NSButton(title: "Start Recording", target: nil, action: nil)
    private let cancel = NSButton(title: "Cancel", target: nil, action: nil)
    private var devices: [[String: String]] = []
    private let cam = NSPopUpButton(frame: .zero, pullsDown: false)
    private let camSize = NSPopUpButton(frame: .zero, pullsDown: false)
    private var cameras: [[String: String]] = []
    private let cameraOnly: Bool
    /// A camera was picked (nil: none) or its size changed: the caller shows / hides / resizes the bubble.
    var onPickCamera: ((String?, CameraBubble.Size) -> Void)?
    private let onStart: (Choice) -> Void
    private let onCancel: () -> Void
    /// Called when a microphone is picked (the caller asks for permission): returns whether the mic can be used.
    var onPickMic: ((String, @escaping (Bool) -> Void) -> Void)?

    init(label: String, micID: String?, systemAudio: Bool, systemAudioNote: String? = nil,
         cameraID: String? = nil, cameraSize: CameraBubble.Size = .medium, cameraOnly: Bool = false,
         onStart: @escaping (Choice) -> Void, onCancel: @escaping () -> Void) {
        self.onStart = onStart
        self.onCancel = onCancel
        self.cameraOnly = cameraOnly
        devices = CaptureSettings.microphones()
        cameras = CameraBubble.cameras()

        title.stringValue = label
        title.font = .systemFont(ofSize: 12, weight: .semibold)
        title.textColor = .white
        title.lineBreakMode = .byTruncatingMiddle
        title.maximumNumberOfLines = 1
        title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        mic.controlSize = .small
        mic.font = .systemFont(ofSize: 11)
        mic.addItem(withTitle: "No microphone")
        for d in devices { mic.addItem(withTitle: d["name"] ?? "Microphone") }
        if let id = micID, let i = devices.firstIndex(where: { $0["id"] == id }) { mic.selectItem(at: i + 1) } else { mic.selectItem(at: 0) }
        let micIcon = NSImageView(image: NSImage(systemSymbolName: "mic.fill", accessibilityDescription: "Microphone") ?? NSImage())
        micIcon.contentTintColor = .white
        micIcon.setContentHuggingPriority(.required, for: .horizontal)

        system.controlSize = .small
        system.font = .systemFont(ofSize: 11)
        system.state = systemAudio ? .on : .off
        // white label on the dark HUD
        system.attributedTitle = NSAttributedString(string: "System audio", attributes: [
            .foregroundColor: NSColor.white, .font: NSFont.systemFont(ofSize: 11)])
        if let n = systemAudioNote { system.toolTip = n }

        note.font = .systemFont(ofSize: 11)
        note.textColor = NSColor(srgbRed: 0.97, green: 0.66, blue: 0.10, alpha: 1)
        note.preferredMaxLayoutWidth = 330
        note.isHidden = true

        start.bezelStyle = .rounded
        start.controlSize = .small
        start.bezelColor = .controlAccentColor
        start.keyEquivalent = "\r"
        cancel.bezelStyle = .rounded
        cancel.controlSize = .small
        cancel.keyEquivalent = "\u{1b}"

        cam.controlSize = .small
        cam.font = .systemFont(ofSize: 11)
        if !cameraOnly { cam.addItem(withTitle: "No camera") }
        for d in cameras { cam.addItem(withTitle: d["name"] ?? "Camera") }
        let off = cameraOnly ? 0 : 1
        if let id = cameraID, let i = cameras.firstIndex(where: { $0["id"] == id }) { cam.selectItem(at: i + off) } else { cam.selectItem(at: 0) }
        cam.toolTip = cameraOnly ? "The camera to record" : "Adds your camera as a bubble you can drag anywhere (right-click it for size and corners)"
        let camIcon = NSImageView(image: NSImage(systemSymbolName: "video.fill", accessibilityDescription: "Camera") ?? NSImage())
        camIcon.contentTintColor = .white
        camIcon.setContentHuggingPriority(.required, for: .horizontal)
        camSize.controlSize = .small
        camSize.font = .systemFont(ofSize: 11)
        for z in CameraBubble.Size.allCases { camSize.addItem(withTitle: z.name) }
        camSize.selectItem(at: CameraBubble.Size.allCases.firstIndex(of: cameraSize) ?? 1)
        camSize.toolTip = "Bubble size"
        camSize.isHidden = cameraOnly
        system.isHidden = cameraOnly

        let audioRow = NSStackView(views: [micIcon, mic, system])
        audioRow.orientation = .horizontal
        audioRow.spacing = 8
        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let buttons = NSStackView(views: [spacer, cancel, start])
        buttons.orientation = .horizontal
        buttons.spacing = 8
        let cameraRow = NSStackView(views: [camIcon, cam, camSize])
        cameraRow.orientation = .horizontal
        cameraRow.spacing = 8
        let stack = NSStackView(views: [title, cameraRow, audioRow, note, buttons])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        stack.edgeInsets = NSEdgeInsets(top: 10, left: 12, bottom: 10, right: 12)
        stack.translatesAutoresizingMaskIntoConstraints = false
        for v in [title, cameraRow, audioRow, note, buttons] { v.translatesAutoresizingMaskIntoConstraints = false; v.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -24).isActive = true }

        let box = NSVisualEffectView()
        box.material = .hudWindow
        box.appearance = NSAppearance(named: .vibrantDark)
        box.state = .active
        box.wantsLayer = true
        box.layer?.cornerRadius = 12
        box.layer?.masksToBounds = true
        box.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: box.leadingAnchor), stack.trailingAnchor.constraint(equalTo: box.trailingAnchor),
            stack.topAnchor.constraint(equalTo: box.topAnchor), stack.bottomAnchor.constraint(equalTo: box.bottomAnchor),
            stack.widthAnchor.constraint(equalToConstant: 360),
        ])
        panel = BarPanel(contentRect: NSRect(x: 0, y: 0, width: 360, height: 110))
        panel.contentView = box
        box.layoutSubtreeIfNeeded()
        panel.setContentSize(box.fittingSize)

        for (b, a) in [(start, #selector(startTapped)), (cancel, #selector(cancelTapped))] { b.target = self; b.action = a }
        mic.target = self
        mic.action = #selector(micChanged)
        cam.target = self
        cam.action = #selector(cameraChanged)
        camSize.target = self
        camSize.action = #selector(cameraChanged)
        camSize.isEnabled = choice.cameraID != nil
        panel.onEscape = { [weak self] in self?.cancelTapped() }
    }

    /// The current choice (nil mic = none).
    var choice: Choice {
        let i = mic.indexOfSelectedItem
        let c = cam.indexOfSelectedItem - (cameraOnly ? 0 : 1)
        return Choice(micID: i > 0 && i - 1 < devices.count ? devices[i - 1]["id"] : nil, systemAudio: system.state == .on && !cameraOnly,
                      cameraID: c >= 0 && c < cameras.count ? cameras[c]["id"] : nil,
                      cameraSize: CameraBubble.Size.allCases[max(0, camSize.indexOfSelectedItem)])
    }

    /// A message under the audio row ("Microphone access is off: recording without it"). Nil hides it.
    func setNote(_ text: String?) {
        note.stringValue = text ?? ""
        note.isHidden = text == nil
        guard let box = panel.contentView else { return }
        box.layoutSubtreeIfNeeded()
        let old = panel.frame
        panel.setContentSize(box.fittingSize)
        // keep the top edge where it was
        panel.setFrameOrigin(NSPoint(x: old.minX, y: old.maxY - panel.frame.height))
    }

    func selectNoMic() { mic.selectItem(at: 0) }
    func selectNoCamera() { if !cameraOnly { cam.selectItem(at: 0); camSize.isEnabled = false } }

    /// A note when there's no camera at all (Camera only can't start).
    var hasCameras: Bool { !cameras.isEmpty }

    @objc private func cameraChanged() {
        camSize.isEnabled = choice.cameraID != nil
        onPickCamera?(choice.cameraID, choice.cameraSize)
    }

    /// Under the target (Quartz points), else above it, else inside the display's bottom-centre. Nil rect = bottom-centre
    /// of the screen under the pointer.
    func place(belowQuartz rect: CGRect?) {
        let size = panel.frame.size
        let area = rect.map { ScreenGeometry.appKit(fromQuartz: $0) }
        let screen = ScreenGeometry.screen(at: area.map { CGPoint(x: $0.midX, y: $0.midY) } ?? NSEvent.mouseLocation)?.visibleFrame
            ?? NSScreen.main?.visibleFrame ?? .zero
        var origin: CGPoint
        if let a = area, a.width < screen.width - 40 || a.height < screen.height - 120 {
            origin = CGPoint(x: a.midX - size.width / 2, y: a.minY - 12 - size.height)
            if origin.y < screen.minY + 4 { origin.y = a.maxY + 12 }
            if origin.y + size.height > screen.maxY - 4 { origin.y = screen.minY + 24 }   // no room either side: inside, at the bottom
        } else {
            origin = CGPoint(x: screen.midX - size.width / 2, y: screen.minY + 48)
        }
        origin.x = min(max(origin.x, screen.minX + 4), screen.maxX - size.width - 4)
        panel.setFrameOrigin(origin)
        panel.orderFrontRegardless()
        panel.makeKey()
    }

    func close() {
        panel.orderOut(nil)
        panel.close()
    }

    @objc private func startTapped() { onStart(choice) }
    @objc private func cancelTapped() { onCancel() }

    @objc private func micChanged() {
        setNote(nil)
        guard let id = choice.micID else { return }
        onPickMic?(id) { [weak self] ok in
            guard let self, !ok else { return }
            self.selectNoMic()
            self.setNote("Microphone access is off, so this will record without a microphone. Turn it on in System Settings → Privacy & Security → Microphone.")
        }
    }
}

/// Key without activating the app (Return / Esc reach the buttons), floating above everything.
private final class BarPanel: NSPanel {
    var onEscape: (() -> Void)?

    init(contentRect: NSRect) {
        super.init(contentRect: contentRect, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        level = .screenSaver
        hidesOnDeactivate = false
        isReleasedWhenClosed = false
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    }

    override var canBecomeKey: Bool { true }
    override func cancelOperation(_ sender: Any?) { onEscape?() }
}
