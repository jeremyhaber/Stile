import AppKit
import AVFoundation
import AVKit
import StileCore
import UniformTypeIdentifiers

/// What the recorder hands over when a recording stops: the finished MP4 (a temp file) and what the preview shows.
struct RecordingDocument {
    let url: URL
    let title: String
    /// "Entire display", "Slack", "Area 1280 × 720", "Chrome tab — …": names the default title
    let target: String
    let duration: Double
    let createdAt: Date
    let hasAudio: Bool
}

/// v3.6: preview windows for finished recordings (native: AVKit plays the video, and the web editor's scheme handler has no
/// byte ranges to seek video with). Trimming is our own always-visible `TrimTimeline` under the video; the look is the
/// screenshot editor's (`EditorChrome.swift`). Like the screenshot editors, one is open means the app shows in the Dock and
/// Command+Tab; none left, back to the menu bar.
@MainActor
final class RecordingWindows {
    static let shared = RecordingWindows()
    private var windows: [String: RecordingWindow] = [:]

    var hasOpen: Bool { !windows.isEmpty }

    /// Dock icon (and Command+Tab) while any editor or preview window is open; menu bar only otherwise.
    func updateDockPolicy() {
        DockPresence.update()
    }

    func open(_ doc: RecordingDocument) {
        let id = RecentRecordings.id(for: doc.url)
        if let w = windows[id] { return w.bringForward() }
        var entry = RecentRecordings.shared.entry(id: id)
        if entry == nil {
            let e = RecentRecording(id: id, title: Self.title(of: doc), target: doc.target, path: doc.url.path, saved: false, link: "",
                                    duration: doc.duration, date: doc.createdAt, hasAudio: doc.hasAudio)
            RecentRecordings.shared.upsert(e)
            entry = e
        }
        launch(RecordingWindow(doc: doc, entry: entry!))
    }

    /// A menu bar "Recent Recordings" click. False when the file is gone.
    @discardableResult
    func reopen(id: String) -> Bool {
        if let w = windows[id] { w.bringForward(); return true }
        guard let e = RecentRecordings.shared.entry(id: id), FileManager.default.fileExists(atPath: e.path) else { return false }
        let doc = RecordingDocument(url: URL(fileURLWithPath: e.path), title: e.title, target: e.target, duration: e.duration, createdAt: e.date, hasAudio: e.hasAudio)
        RecentRecordings.shared.upsert(e)   // to the front
        launch(RecordingWindow(doc: doc, entry: e))
        return true
    }

    /// See `STILE_PREVIEW_RECORDING` in App.swift. The app quits when the window closes.
    func previewForDevelopment(_ url: URL) {
        let id = "dev-" + url.deletingPathExtension().lastPathComponent
        let e = RecentRecording(id: id, title: "", target: "Window — Preview", path: url.path, saved: true, link: "",
                                duration: 0, date: Date(), hasAudio: true)
        let doc = RecordingDocument(url: url, title: "", target: e.target, duration: 0, createdAt: e.date, hasAudio: true)
        let w = RecordingWindow(doc: doc, entry: e)
        w.onClosed = { NSApp.terminate(nil) }
        windows[w.id] = w
        w.show()
    }

    /// Dock icon clicked: the most recent preview comes forward.
    func reopenFront() -> Bool {
        guard let w = windows.values.max(by: { $0.opened < $1.opened }) else { return false }
        w.bringForward()
        return true
    }

    private func launch(_ w: RecordingWindow) {
        w.onClosed = { [weak self, id = w.id] in
            self?.windows[id] = nil
            self?.updateDockPolicy()
        }
        windows[w.id] = w
        updateDockPolicy()
        w.show()
        Log.write("recording: preview opened for \(w.id) (\(w.sourceURL.lastPathComponent))")
    }

    static func title(of doc: RecordingDocument) -> String {
        let t = doc.title.trimmingCharacters(in: .whitespacesAndNewlines)
        if !t.isEmpty { return t }
        let f = DateFormatter()
        f.dateStyle = .medium
        f.timeStyle = .short
        return "Recording — \(doc.target) — \(f.string(from: doc.createdAt))"
    }
}

// MARK: - Window

/// Command+S (save as…) works wherever the focus is in the window; so do ⌘Z / ⇧⌘Z / ⌘K and the playback and editing
/// keys, except while typing (the title, a text annotation).
private final class RecordingNSWindow: NSWindow {
    var onSaveAs: (() -> Void)?
    /// A key without Command: true when it was a playback / editing key.
    var onKey: ((NSEvent) -> Bool)?
    /// ⌘ + a letter (Shift as given): true when handled (undo, redo, split).
    var onCommand: ((String, Bool) -> Bool)?
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        let c = event.charactersIgnoringModifiers?.lowercased() ?? ""
        if mods == .command, c == "s" {
            onSaveAs?()
            return true
        }
        // undo in the title field is the field's own
        if !(firstResponder is NSText), mods == .command || mods == [.command, .shift], onCommand?(c, mods.contains(.shift)) == true { return true }
        return super.performKeyEquivalent(with: event)
    }
    override func sendEvent(_ event: NSEvent) {
        if event.type == .keyDown, !(firstResponder is NSText), !event.modifierFlags.contains(.command),
           attachedSheet == nil, onKey?(event) == true { return }
        super.sendEvent(event)
    }
}

/// The grip after Upload, styled like the screenshot editor's: drag it to Finder, Slack, Mail, a browser upload field...
private final class DragGrip: GhostButton, NSDraggingSource {
    /// the file to drag (nil: not ready) and the icon shown under the pointer
    var fileProvider: (() -> URL?)?
    var iconProvider: (() -> NSImage)?
    var onDragged: (() -> Void)?
    private var down: NSEvent?

    init() {
        super.init("", image: EditorIcon.grip)
        toolTip = "Drag the recording into another app or folder"
        setAccessibilityLabel("Drag the recording")
        setAccessibilityRole(.image)
    }
    required init?(coder: NSCoder) { nil }

    override func resetCursorRects() { addCursorRect(bounds, cursor: .openHand) }
    override func mouseDown(with event: NSEvent) { down = event }
    override func mouseUp(with event: NSEvent) { down = nil }
    override func mouseDragged(with event: NSEvent) {
        guard isEnabled, let start = down, let url = fileProvider?() else { return }
        down = nil
        let item = NSDraggingItem(pasteboardWriter: url as NSURL)
        let img = iconProvider?() ?? NSImage()
        let k = min(1, 160 / max(1, max(img.size.width, img.size.height)))
        let size = NSSize(width: img.size.width * k, height: img.size.height * k)
        let p = convert(start.locationInWindow, from: nil)
        item.setDraggingFrame(NSRect(x: p.x - size.width / 2, y: p.y - size.height / 2, width: size.width, height: size.height), contents: img)
        beginDraggingSession(with: [item], event: start, source: self)
        onDragged?()
    }
    nonisolated func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation { .copy }
}

private final class DotView: NSView {
    override func draw(_ dirtyRect: NSRect) {
        EditorStyle.text3.setFill()
        NSBezierPath(ovalIn: bounds).fill()
    }
}

/// The title field, in the web editor's control look (surface fill, hairline border, 6 pt corners).
private final class FieldBox: NSView {
    let field = NSTextField()
    init() {
        super.init(frame: .zero)
        field.isBordered = false
        field.drawsBackground = false
        field.focusRingType = .none
        field.font = .systemFont(ofSize: 12.5)
        field.textColor = EditorStyle.text
        field.lineBreakMode = .byTruncatingTail
        field.cell?.isScrollable = true
        field.translatesAutoresizingMaskIntoConstraints = false
        addSubview(field)
        NSLayoutConstraint.activate([
            field.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            field.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            field.centerYAnchor.constraint(equalTo: centerYAnchor),
            heightAnchor.constraint(equalToConstant: 26),
        ])
    }
    required init?(coder: NSCoder) { nil }
    override func draw(_ dirtyRect: NSRect) {
        let p = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 6, yRadius: 6)
        EditorStyle.surface.setFill()
        p.fill()
        (window?.firstResponder === field.currentEditor() && field.currentEditor() != nil ? EditorStyle.accentText : EditorStyle.borderStrong).setStroke()
        p.lineWidth = 1
        p.stroke()
    }
}

@MainActor
final class RecordingWindow: NSObject, NSWindowDelegate, NSTextFieldDelegate {
    let id: String
    let sourceURL: URL
    let opened = Date()
    var onClosed: (() -> Void)?

    private let doc: RecordingDocument
    private let asset: AVURLAsset
    private let window: RecordingNSWindow
    private let playerView = AVPlayerView()
    private let player: AVPlayer
    private let drawing = AnnotationCanvas()
    private let props = FloatingBar()
    private let titleBox = FieldBox()
    private var titleField: NSTextField { titleBox.field }
    private let infoLabel = NSTextField(labelWithString: "")
    private let timeline = EditTimeline()
    private let playButton = GhostButton("", image: EditorIcon.symbol("play.fill"))
    private let timeLabel = NSTextField(labelWithString: "0:00.0")
    private let editLabel = NSTextField(labelWithString: "")
    private var toolButtons: [AnnotationCanvas.Tool: GhostButton] = [:]
    private let cutButton = GhostButton("Cut", image: EditorIcon.symbol("scissors"), hint: "C")
    private let deleteClipButton = GhostButton("Delete Clip", image: EditorIcon.symbol("trash"), hint: "⌫")
    private let setStartButton = GhostButton("Set Start", image: EditorIcon.symbol("arrow.right.to.line"), hint: "I")
    private let setEndButton = GhostButton("Set End", image: EditorIcon.symbol("arrow.left.to.line"), hint: "O")
    private let undoButton = GhostButton("", image: EditorIcon.symbol("arrow.uturn.backward"))
    private let redoButton = GhostButton("", image: EditorIcon.symbol("arrow.uturn.forward"))
    private let resetButton = GhostButton("Reset", image: EditorIcon.symbol("arrow.counterclockwise"))
    private let animateButton = GhostButton("Animate", image: EditorIcon.symbol("sparkles"))
    /// v3.9: transitions between clips.
    private let transitionsButton = GhostButton("Transitions", image: EditorIcon.symbol("rectangle.on.rectangle"))
    /// The player plays the edit built by `EditComposition` (transitions; its time is the edited video's) rather than the
    /// recording itself (recording time, clip by clip).
    private var compMode = false
    private var rebuildWork: DispatchWorkItem?
    private var buildGeneration = 0
    /// v3.8: annotations' transitions on / off (preview and export), remembered.
    private var animationsOn = UserDefaults.standard.object(forKey: "recordingAnimations") as? Bool ?? true
    private var toolTransition: [VideoAnnotation.Kind: VideoAnnotation.Transition] = [:]
    private var barRowView: NSStackView?
    private var editRowView: NSStackView?
    private var toolSpeed: [VideoAnnotation.Kind: VideoAnnotation.Speed] = [:]
    private var boundaryObserver: Any?
    private var timeObserver: Any?
    private var rateObserver: NSKeyValueObservation?
    private var endObserver: NSObjectProtocol?
    private let saveButton = GhostButton("Save", image: EditorIcon.save)
    private let copyButton = GhostButton("Copy", image: EditorIcon.copy)
    private let uploadButton = GhostButton("Upload", image: EditorIcon.upload)
    private let grip = DragGrip()
    private let statusLabel = NSTextField(labelWithString: "")
    private let progress = NSProgressIndicator()
    private let actionButton = GhostButton("", style: .mini)
    private let toast = ToastView()
    private var videoSize = CGSize(width: 1280, height: 720)
    private var aspectConstraint: NSLayoutConstraint?

    // the edit: clips, annotations, undo
    private var edit = EditModel(duration: 0) {
        didSet { drawing.edit = edit; previewFrames.edit = edit }   // annotations are placed on the edit
    }
    private var annotations: [VideoAnnotation] = []
    private var annotationRevision = 0
    private var nextAnnotationID = 1
    private struct Snapshot { var edit: EditModel; var annotations: [VideoAnnotation]; var counter: CountCounter }
    /// The count tool's next number; saved with each undo step.
    private var counter = CountCounter()
    private var undoStack: [Snapshot] = []
    private var redoStack: [Snapshot] = []
    private var toolStyle: [VideoAnnotation.Kind: (color: UInt32, size: Int)] = [
        .rect: (AnnotationStyle.defaultColor, 1), .arrow: (AnnotationStyle.defaultColor, 1), .text: (AnnotationStyle.defaultColor, 1),
        .highlight: (AnnotationStyle.highlightColor, 1), .blur: (0, 0),
        .count: (AnnotationStyle.defaultColor, 1),
    ]
    /// Blur boxes in the player (the drawings are live vectors in `drawing`).
    private let previewFrames = AnnotationFrameRenderer(blurOnly: true)
    private var previewCompositionOn = false
    private var previewComposition: AVVideoComposition?
    private var prepareLater: DispatchWorkItem?

    // what happened to the recording (closing an untouched one asks "Discard recording?")
    private var saved: Bool
    private var copied = false
    private var uploaded: Bool
    private var link: String
    private var savedURL: URL?
    private var titleEdited = false
    private var allowClose = false
    private var discarded = false

    private var assetDuration: CMTime = .zero
    private var baseFile: URL?          // the exported file for `baseKey` (edited recordings)
    private var baseKey: String?
    private var prepTask: Task<URL, Error>?
    private var prepKey: String?
    private var uploadTask: Task<Void, Never>?
    private var actionKind: ActionKind = .none
    private enum ActionKind { case none, cancel, reveal, copyLink }
    private let workDir: URL

    init(doc: RecordingDocument, entry: RecentRecording) {
        self.doc = doc
        id = entry.id
        sourceURL = doc.url
        saved = entry.saved
        link = entry.link
        uploaded = !entry.link.isEmpty
        asset = AVURLAsset(url: doc.url)
        player = AVPlayer(playerItem: AVPlayerItem(asset: asset))
        workDir = FileManager.default.temporaryDirectory.appendingPathComponent("stile-recording-\(entry.id)", isDirectory: true)
        window = RecordingNSWindow(contentRect: NSRect(x: 0, y: 0, width: 880, height: 640), styleMask: [.titled, .closable, .miniaturizable, .resizable],
                                   backing: .buffered, defer: false)
        super.init()
        if saved { savedURL = doc.url }
        titleField.stringValue = RecordingWindows.title(of: doc)
        buildUI()
        window.title = titleField.stringValue
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 720, height: 480)
        window.tabbingMode = .disallowed
        window.delegate = self
        window.onSaveAs = { [weak self] in self?.saveAs() }
        window.onKey = { [weak self] in self?.handleKey($0) ?? false }
        window.onCommand = { [weak self] in self?.handleCommand($0, shift: $1) ?? false }
        updateInfo()
        if !link.isEmpty { setStatus("Link: \(link)", action: .copyLink) }
    }

    // MARK: UI

    /// Same layout as the screenshot editor: a 46 pt bar (exports | drawing tools | title), the video on the canvas with
    /// a floating properties card, then the editing row and the timeline, and the 28 pt status line.
    private func buildUI() {
        playerView.player = player
        // no AVKit controls: their scrubber always shows the whole recording, not the edit
        playerView.controlsStyle = .none
        playerView.showsFullScreenToggleButton = false
        playerView.allowsPictureInPicturePlayback = false

        // bar: exports
        copyButton.onClick = { [weak self] in self?.copyClicked() }
        copyButton.toolTip = "Copy the file, then paste it into Slack, Mail or Finder"
        saveButton.onClick = { [weak self] in self?.saveClicked() }
        saveButton.toolTip = "Save to the recordings folder (⌘S chooses a place)"
        uploadButton.onClick = { [weak self] in self?.uploadClicked() }
        uploadButton.toolTip = "Upload to your storage and copy the link"
        grip.fileProvider = { [weak self] in self?.fileForDrag() }
        grip.iconProvider = { [weak self] in self?.dragIcon() ?? NSImage() }
        grip.onDragged = { [weak self] in self?.toast.show("Dragged out") }
        let exports = NSStackView(views: [copyButton, saveButton, uploadButton, grip])
        exports.spacing = 2

        // bar: drawing tools (where the screenshot editor has its annotation tools)
        let toolDefs: [(AnnotationCanvas.Tool, String, String, String)] = [
            (.select, "Select", "cursorarrow", "V"), (.rect, "Rectangle", "rectangle", "R"), (.arrow, "Arrow", "arrow.up.right", "A"),
            (.text, "Text", "textformat", "T"), (.highlight, "Highlight", "highlighter", "H"), (.blur, "Blur", "drop", "B"),
            (.count, "Count", "number.circle", "N"),
        ]
        var toolViews: [NSView] = []
        for (t, name, symbol, key) in toolDefs {
            let b = GhostButton(name, image: EditorIcon.symbol(symbol), hint: key)
            b.toolTip = "\(name) (\(key))"
            b.onClick = { [weak self] in self?.setTool(t) }
            toolButtons[t] = b
            toolViews.append(b)
        }
        toolButtons[.select]?.isOn = true
        let tools = NSStackView(views: toolViews)
        tools.spacing = 1
        tools.setAccessibilityRole(.toolbar)
        tools.setAccessibilityLabel("Drawing tools")

        // bar: title (names the file)
        titleField.delegate = self
        titleField.placeholderString = "Title"
        titleField.setAccessibilityLabel("Title (used as the file name)")
        titleBox.toolTip = "The title is used as the file name"
        // The title takes what's left: 110...360 pt, 240 preferred, and it gives way first. (It used to overflow at wide
        // windows because the text field inside, whose intrinsic width is its text, out-ranked the box's soft 240 pt width.)
        titleField.setContentCompressionResistancePriority(.init(1), for: .horizontal)
        titleField.setContentHuggingPriority(.init(1), for: .horizontal)
        titleBox.translatesAutoresizingMaskIntoConstraints = false
        let titleW = titleBox.widthAnchor.constraint(equalToConstant: 240)
        titleW.priority = .init(260)
        titleW.isActive = true
        titleBox.widthAnchor.constraint(greaterThanOrEqualToConstant: 110).isActive = true
        titleBox.widthAnchor.constraint(lessThanOrEqualToConstant: 360).isActive = true
        titleBox.setContentCompressionResistancePriority(.init(10), for: .horizontal)
        titleBox.setContentHuggingPriority(.init(10), for: .horizontal)

        let vsep = FillView(EditorStyle.borderStrong)
        vsep.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([vsep.widthAnchor.constraint(equalToConstant: 1), vsep.heightAnchor.constraint(equalToConstant: 18)])
        let lspace = NSView(), rspace = NSView()
        for v in [lspace, rspace] { v.setContentHuggingPriority(.init(1), for: .horizontal) }
        let barRow = NSStackView(views: [exports, vsep, lspace, tools, rspace, titleBox])
        barRowView = barRow
        lspace.widthAnchor.constraint(equalTo: rspace.widthAnchor).isActive = true   // the tools centred between the groups
        barRow.spacing = 6
        barRow.setCustomSpacing(12, after: exports)
        barRow.setCustomSpacing(12, after: vsep)
        let bar = FillView(EditorStyle.bg, bottom: true)
        pin(barRow, in: bar, insets: NSEdgeInsets(top: 0, left: 10, bottom: 0, right: 10))
        bar.heightAnchor.constraint(equalToConstant: EditorStyle.barHeight).isActive = true

        // canvas: the video at its aspect ratio, centred, 16 pt from the edges; the drawing layer exactly over it
        let canvas = FillView(EditorStyle.canvas)
        playerView.translatesAutoresizingMaskIntoConstraints = false
        canvas.addSubview(playerView)
        let fillW = playerView.widthAnchor.constraint(equalTo: canvas.widthAnchor, constant: -32)
        let fillH = playerView.heightAnchor.constraint(equalTo: canvas.heightAnchor, constant: -32)
        // Below NSLayoutPriorityDragThatCannotResizeWindow (490): the video fits the canvas, it never sizes the window. At
        // 750 a tall recording made the window's content demand its full height (taller than the screen), the window
        // clamped to the screen and the bar at the top of the content slid out of view.
        fillW.priority = .init(400)
        fillH.priority = .init(400)
        NSLayoutConstraint.activate([
            playerView.centerXAnchor.constraint(equalTo: canvas.centerXAnchor),
            playerView.centerYAnchor.constraint(equalTo: canvas.centerYAnchor),
            playerView.widthAnchor.constraint(lessThanOrEqualTo: canvas.widthAnchor, constant: -32),
            playerView.heightAnchor.constraint(lessThanOrEqualTo: canvas.heightAnchor, constant: -32),
            fillW, fillH,
        ])
        setAspect(videoSize)
        drawing.translatesAutoresizingMaskIntoConstraints = false
        canvas.addSubview(drawing)
        NSLayoutConstraint.activate([
            drawing.leadingAnchor.constraint(equalTo: playerView.leadingAnchor), drawing.trailingAnchor.constraint(equalTo: playerView.trailingAnchor),
            drawing.topAnchor.constraint(equalTo: playerView.topAnchor), drawing.bottomAnchor.constraint(equalTo: playerView.bottomAnchor),
        ])
        drawing.styleFor = { [weak self] k in self?.toolStyle[k] ?? (color: AnnotationStyle.defaultColor, size: 1) }
        drawing.timesForNew = { [weak self] k in self?.timesForNew(k) ?? (start: 0, length: 4) }
        drawing.transitionFor = { [weak self] k in self?.toolTransition[k] ?? .fade }
        drawing.speedFor = { [weak self] k in self?.toolSpeed[k] ?? .normal }
        drawing.nextID = { [weak self] in
            guard let self else { return 0 }
            nextAnnotationID += 1
            return nextAnnotationID
        }
        drawing.takeCountNumber = { [weak self] in self?.counter.place() ?? 1 }
        drawing.onWillChange = { [weak self] in self?.pushUndo() }
        drawing.onChanging = { [weak self] in
            guard let self else { return }
            annotations = drawing.annotations
            timeline.setAnnotations(annotations)
        }
        drawing.onCommitted = { [weak self] in
            guard let self else { return }
            annotations = drawing.annotations
            annotationsChanged()
        }
        drawing.onSelect = { [weak self] id in
            self?.timeline.selectedAnnotation = id
            self?.updateProps()
        }
        drawing.onDrawn = { [weak self] in self?.setTool(.select) }
        drawing.onBackgroundClick = { [weak self] in self?.togglePlay() }

        props.translatesAutoresizingMaskIntoConstraints = false
        props.isHidden = true
        canvas.addSubview(props)
        NSLayoutConstraint.activate([
            props.centerXAnchor.constraint(equalTo: canvas.centerXAnchor),
            props.topAnchor.constraint(equalTo: canvas.topAnchor, constant: 10),
            props.widthAnchor.constraint(lessThanOrEqualTo: canvas.widthAnchor, constant: -24),
        ])
        toast.translatesAutoresizingMaskIntoConstraints = false
        canvas.addSubview(toast)
        NSLayoutConstraint.activate([
            toast.centerXAnchor.constraint(equalTo: canvas.centerXAnchor),
            toast.bottomAnchor.constraint(equalTo: canvas.bottomAnchor, constant: -16),
            toast.widthAnchor.constraint(lessThanOrEqualTo: canvas.widthAnchor, constant: -32),
        ])

        // editing row: play, time | cut, delete, set start / end | undo, redo, reset
        playButton.onClick = { [weak self] in self?.togglePlay() }
        playButton.toolTip = "Play / pause (Space)"
        playButton.setAccessibilityLabel("Play")
        timeLabel.font = .monospacedDigitSystemFont(ofSize: 12, weight: .regular)
        timeLabel.textColor = EditorStyle.text
        timeLabel.setContentHuggingPriority(.required, for: .horizontal)
        timeLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
        cutButton.onClick = { [weak self] in self?.toggleCut() }
        cutButton.setAccessibilityLabel("Cut tool")
        cutButton.toolTip = "Cut tool: click a clip to cut it there; snaps to the playhead, hold ⌥ to override (C; Esc to stop). S or ⌘K cuts at the playhead"
        deleteClipButton.onClick = { [weak self] in self?.deleteSelectedClip() }
        deleteClipButton.toolTip = "Remove the selected clip; the rest closes up. Drag the edge next to it back out to restore (Delete)"
        setStartButton.onClick = { [weak self] in self?.setStart() }
        setStartButton.toolTip = "Remove everything before the playhead (I)"
        setEndButton.onClick = { [weak self] in self?.setEnd() }
        setEndButton.toolTip = "Remove everything after the playhead (O)"
        undoButton.onClick = { [weak self] in self?.undo() }
        undoButton.toolTip = "Undo (⌘Z)"
        undoButton.setAccessibilityLabel("Undo")
        redoButton.onClick = { [weak self] in self?.redo() }
        redoButton.toolTip = "Redo (⇧⌘Z)"
        redoButton.setAccessibilityLabel("Redo")
        resetButton.onClick = { [weak self] in self?.resetEdit() }
        animateButton.onClick = { [weak self] in self?.toggleAnimations() }
        animateButton.isOn = animationsOn
        animateButton.toolTip = "Play the annotations' transitions (fade, pop, slide, draw). Off: they just appear"
        resetButton.toolTip = "Bring back everything that was cut"
        transitionsButton.onClick = { [weak self] in self?.showTransitionsMenu() }
        transitionsButton.toolTip = "Transitions between clips: crossfade, or fade through black or white (picture and sound). Click a marker between two clips on the timeline to set that cut on its own"
        transitionsButton.setAccessibilityLabel("Transitions between clips")
        let espace = NSView()
        espace.setContentHuggingPriority(.init(1), for: .horizontal)
        let esep = FillView(EditorStyle.borderStrong)
        esep.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([esep.widthAnchor.constraint(equalToConstant: 1), esep.heightAnchor.constraint(equalToConstant: 18)])
        let editRow = NSStackView(views: [playButton, timeLabel, espace, cutButton, deleteClipButton, setStartButton, setEndButton, esep,
                                          transitionsButton, animateButton, undoButton, redoButton, resetButton])
        editRow.spacing = 2
        editRowView = editRow
        editRow.setCustomSpacing(8, after: playButton)
        editRow.setCustomSpacing(8, after: setEndButton)
        editRow.setCustomSpacing(8, after: esep)

        timeline.toolTip = "S cuts at the playhead · select a clip and press Delete to remove it · drag an edge with a red notch out to restore · click a marker between clips for a transition"
        timeline.onScrub = { [weak self] t in self?.seekSequence(t) }
        timeline.onWillChange = { [weak self] in self?.pushUndo() }
        timeline.onChanging = { [weak self] in
            guard let self else { return }
            edit = timeline.edit
            annotations = timeline.annotations
            drawing.setAnnotations(annotations)
            updateEditLabels()
        }
        timeline.onCommitted = { [weak self] in
            guard let self else { return }
            // the snapshot taken when the gesture began says whether it moved an annotation or the clips
            let annChanged = undoStack.last?.annotations != timeline.annotations
            edit = timeline.edit
            annotations = timeline.annotations
            editChanged()
            if annChanged { annotationsChanged() }
        }
        timeline.onSelectClip = { [weak self] _ in self?.updateButtonStates() }
        timeline.onSelectAnnotation = { [weak self] id in self?.selectAnnotation(id) }
        timeline.onSplit = { [weak self] t in self?.split(atSequence: t) }
        timeline.onDeleteClip = { [weak self] i in self?.deleteClip(i) }
        timeline.onSeamStyle = { [weak self] i, style in self?.setSeamStyle(i, style) }
        timeline.onDeleteAnnotation = { [weak self] id in self?.drawing.delete(id) }

        let transportStack = NSStackView(views: [editRow, timeline])
        transportStack.orientation = .vertical
        transportStack.spacing = 6
        for v in [editRow, timeline] { v.widthAnchor.constraint(equalTo: transportStack.widthAnchor).isActive = true }
        let transport = FillView(EditorStyle.bg, top: true)
        pin(transportStack, in: transport, insets: NSEdgeInsets(top: 8, left: 10, bottom: 8, right: 10))

        // status line: length · file size · what was edited  …  status, progress, action
        for l in [infoLabel, editLabel, statusLabel] {
            l.font = .systemFont(ofSize: 12)
            l.textColor = EditorStyle.text2
            l.lineBreakMode = .byTruncatingTail
        }
        infoLabel.font = .monospacedDigitSystemFont(ofSize: 12, weight: .regular)
        infoLabel.setContentHuggingPriority(.required, for: .horizontal)
        infoLabel.setContentCompressionResistancePriority(.defaultHigh, for: .horizontal)
        editLabel.setContentHuggingPriority(.defaultLow, for: .horizontal)
        editLabel.setContentCompressionResistancePriority(.init(200), for: .horizontal)
        statusLabel.lineBreakMode = .byTruncatingMiddle
        statusLabel.isSelectable = true
        statusLabel.setContentHuggingPriority(.defaultHigh, for: .horizontal)
        statusLabel.setContentCompressionResistancePriority(.init(250), for: .horizontal)
        progress.style = .bar
        progress.isIndeterminate = false
        progress.minValue = 0
        progress.maxValue = 1
        progress.controlSize = .small
        progress.isHidden = true
        progress.translatesAutoresizingMaskIntoConstraints = false
        progress.widthAnchor.constraint(equalToConstant: 140).isActive = true
        actionButton.onClick = { [weak self] in self?.actionClicked() }
        actionButton.isHidden = true
        let fspace = NSView()
        fspace.setContentHuggingPriority(.init(1), for: .horizontal)
        let footRow = NSStackView(views: [infoLabel, dot(), editLabel, fspace, statusLabel, progress, actionButton])
        footRow.spacing = 10
        let footer = FillView(EditorStyle.bg, top: true)
        pin(footRow, in: footer, insets: NSEdgeInsets(top: 0, left: 12, bottom: 0, right: 12))
        footer.heightAnchor.constraint(equalToConstant: EditorStyle.statusHeight).isActive = true

        let root = NSView()
        for v in [bar, canvas, transport, footer] {
            v.translatesAutoresizingMaskIntoConstraints = false
            root.addSubview(v)
            NSLayoutConstraint.activate([
                v.leadingAnchor.constraint(equalTo: root.leadingAnchor), v.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            ])
        }
        NSLayoutConstraint.activate([
            bar.topAnchor.constraint(equalTo: root.topAnchor),
            canvas.topAnchor.constraint(equalTo: bar.bottomAnchor),
            transport.topAnchor.constraint(equalTo: canvas.bottomAnchor),
            footer.topAnchor.constraint(equalTo: transport.bottomAnchor),
            footer.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            canvas.heightAnchor.constraint(greaterThanOrEqualToConstant: 120),
        ])
        window.backgroundColor = EditorStyle.bg
        window.contentView = root
        updateButtonStates()
    }

    private func pin(_ v: NSView, in parent: NSView, insets e: NSEdgeInsets) {
        v.translatesAutoresizingMaskIntoConstraints = false
        parent.addSubview(v)
        NSLayoutConstraint.activate([
            v.leadingAnchor.constraint(equalTo: parent.leadingAnchor, constant: e.left),
            v.trailingAnchor.constraint(equalTo: parent.trailingAnchor, constant: -e.right),
            v.topAnchor.constraint(equalTo: parent.topAnchor, constant: e.top),
            v.bottomAnchor.constraint(equalTo: parent.bottomAnchor, constant: -e.bottom),
        ])
    }

    /// The status line's separator dot.
    private func dot() -> NSView {
        let d = DotView()
        d.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([d.widthAnchor.constraint(equalToConstant: 3), d.heightAnchor.constraint(equalToConstant: 3)])
        return d
    }

    private func setAspect(_ size: CGSize) {
        aspectConstraint?.isActive = false
        let k = size.height > 0 ? size.width / size.height : 16 / 9
        aspectConstraint = playerView.widthAnchor.constraint(equalTo: playerView.heightAnchor, multiplier: k)
        aspectConstraint?.isActive = true
    }

    /// Like the web editor in a narrow window: labels go, icons stay.
    private func updateCompact() {
        let w = window.frame.width
        let exportButtons = [copyButton, saveButton, uploadButton]
        let editButtons = [cutButton, deleteClipButton, setStartButton, setEndButton, resetButton, animateButton, transitionsButton]
        for b in exportButtons { b.showsLabel = w >= 760 }
        for b in toolButtons.values { b.showsLabel = w >= 1180 }
        for b in editButtons { b.showsLabel = w >= 980 }
        // Thresholds are a first guess; then check the rows really fit (fonts, localisation) and drop labels if not.
        func fits(_ row: NSView?) -> Bool {
            guard let row else { return true }
            row.layoutSubtreeIfNeeded()
            return row.fittingSize.width <= row.bounds.width + 0.5
        }
        guard window.contentView != nil, w > 0 else { return }
        window.contentView?.layoutSubtreeIfNeeded()
        if !fits(barRowView) { for b in toolButtons.values { b.showsLabel = false } }
        if !fits(barRowView) { for b in exportButtons { b.showsLabel = false } }
        if !fits(editRowView) { for b in editButtons { b.showsLabel = false } }
    }

    func windowDidResize(_ notification: Notification) { updateCompact() }

    func show() {
        Task { [weak self] in
            guard let self else { return }
            // size to the video before showing, so the window doesn't jump
            assetDuration = (try? await asset.load(.duration)) ?? CMTime(seconds: doc.duration, preferredTimescale: 600)
            var natural = CGSize(width: 1280, height: 720)
            if let t = try? await asset.loadTracks(withMediaType: .video).first,
               let (size, tf) = try? await t.load(.naturalSize, .preferredTransform) {
                let r = CGRect(origin: .zero, size: size).applying(tf)
                natural = CGSize(width: abs(r.width), height: abs(r.height))
            }
            videoSize = natural
            setAspect(natural)
            drawing.videoSize = natural
            window.setFrame(frame(forVideo: natural), display: false)
            updateCompact()
            timeline.aspect = natural.height > 0 ? natural.width / natural.height : 16 / 9
            edit = EditModel(duration: totalSeconds)
            timeline.setEdit(edit)
            observePlayer()
            loadThumbnails(aspect: timeline.aspect)
            updateEditLabels()
            updateInfo()
            bringForward()
            window.makeFirstResponder(timeline)
            player.play()
        }
    }

    // MARK: Playback

    private func observePlayer() {
        timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 30), queue: .main) { [weak self] t in
            MainActor.assumeIsolated {
                if self?.pendingSeeks == 0 { self?.playheadMoved(t.seconds) }   // not while a seek is in flight: the time is stale
                self?.clipEnded()   // the boundary observer below is exact; this catches what it misses
            }
        }
        rateObserver = player.observe(\.timeControlStatus) { [weak self] _, _ in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.playStateChanged() } }
        }
        observeEnd()
        watchClips()
    }

    /// Reaching the end of the current item (re-registered when the item is swapped).
    private func observeEnd() {
        if let o = endObserver { NotificationCenter.default.removeObserver(o) }
        endObserver = NotificationCenter.default.addObserver(forName: AVPlayerItem.didPlayToEndTimeNotification, object: player.currentItem,
                                                             queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.playStateChanged() }
        }
    }

    /// v3.8: clips play in timeline order, which needn't be the recording's: an exact boundary observer at every clip's
    /// end hands over to the next clip (`playingClip` says which one is playing).
    private func watchClips() {
        if let o = boundaryObserver { player.removeTimeObserver(o); boundaryObserver = nil }
        guard !compMode else { return }   // the composition plays straight through, clips and transitions included
        player.currentItem?.forwardPlaybackEndTime = .invalid
        if !edit.clips.indices.contains(playingClip) { playingClip = 0 }
        let ends = edit.clips.map { NSValue(time: CMTime(seconds: $0.end, preferredTimescale: 600)) }
        guard !ends.isEmpty else { return }
        boundaryObserver = player.addBoundaryTimeObserver(forTimes: ends, queue: .main) { [weak self] in
            MainActor.assumeIsolated { self?.clipEnded() }
        }
    }

    /// The playing clip reached its end: on to the next one in the timeline (no seek when its footage follows on), or
    /// stop after the last.
    private func clipEnded() {
        guard !compMode, isPlaying, pendingSeeks == 0 else { return }   // a seek in flight: the player's time is not the clip's yet
        switch edit.handover(from: playingClip, at: currentSource) {
        case .stay: break
        case .next(let seekTo):
            playingClip += 1
            if let seekTo { seek(seekTo, playing: true, clip: playingClip) }
        case .stop:
            player.pause()
            seek(edit.clips[playingClip].end, playing: false, clip: playingClip)
        }
    }

    /// Seeks started and not yet finished (the player keeps playing meanwhile, so its time and the ticks are stale).
    private var pendingSeeks = 0

    /// The clip playing (timeline index): kept while the time is in it, else the clip holding the time.
    private var playingClip = 0

    /// `t`: the player's time: recording time, or (`compMode`) the edited video's. The annotations show by edited-video time.
    private func playheadMoved(_ t: Double) {
        guard t.isFinite else { return }
        if compMode {
            let s = min(max(0, t), edit.length)
            timeline.playhead = s
            drawing.time = s
            timeLabel.stringValue = "\(RecordingMath.preciseTimer(s)) / \(RecordingMath.preciseTimer(edit.length))"
            return
        }
        let cs = edit.clips
        if !(cs.indices.contains(playingClip) && t >= cs[playingClip].start - 0.02 && t <= cs[playingClip].end + 0.02),
           let k = edit.clipIndex(containingSource: t) { playingClip = k }
        var s = edit.sequence(ofSource: t)
        if cs.indices.contains(playingClip), t >= cs[playingClip].start - 0.02, t <= cs[playingClip].end + 0.02 {
            s = edit.sequenceStart(of: playingClip) + min(cs[playingClip].length, max(0, t - cs[playingClip].start))
        }
        timeline.playhead = s
        drawing.time = s
        timeLabel.stringValue = "\(RecordingMath.preciseTimer(s)) / \(RecordingMath.preciseTimer(edit.length))"
    }

    private var isPlaying: Bool { player.timeControlStatus != .paused }
    /// Recording time at the playhead.
    private var currentSource: Double {
        let t = player.currentTime().seconds
        return compMode ? edit.source(atSequence: t.isFinite ? t : 0) : t
    }

    /// After the edit changed under the playhead: the edited-video time stays (`compMode`), else the recording time does.
    private func refreshPlayhead() {
        playheadMoved(compMode ? min(timeline.playhead, edit.length) : currentSource)
    }
    private var currentSequence: Double { timeline.playhead }

    /// Transitions play while the video plays; paused, everything shows fully so it can be edited.
    private func playStateChanged() {
        let name = isPlaying ? "pause.fill" : "play.fill"
        playButton.image = EditorIcon.symbol(name)
        playButton.setAccessibilityLabel(isPlaying ? "Pause" : "Play")
        let animate = animationsOn && isPlaying
        drawing.animate = animate
        if previewFrames.animate != animate {
            previewFrames.animate = animate
            if previewCompositionOn || (compMode && annotations.contains { $0.kind == .blur }) { refreshFrame() }
        }
    }

    /// Plays the edited video: from the playhead, or from the beginning when it's at the end.
    private func togglePlay() {
        if isPlaying { return player.pause() }
        drawing.endTextEditing(commit: true)
        guard !edit.clips.isEmpty else { return }
        // Always from the playhead (sequence time), in the clip that holds it: a boundary (just after a split or cut)
        // belongs to the clip after it. `playingClip` can be stale or the clip before the seam, so it isn't trusted here.
        let now = currentSource
        let s = currentSequence
        if compMode {
            if s >= edit.length - 0.05 { return seek(0, playing: true) }
            if abs(player.currentTime().seconds - s) < 0.05 { player.play() } else { seek(s, playing: true) }
            return
        }
        if s >= edit.length - 0.05 {
            return seek(edit.clips[0].start, playing: true, clip: 0)
        }
        let k = edit.clipIndex(atSequence: s) ?? 0
        let target = edit.source(atSequence: s)
        playingClip = k
        if abs(now - target) < 0.05 {
            player.play()
        } else {
            seek(target, playing: true, clip: k)
        }
    }

    /// `t`: the player's time (recording time, or `compMode`: the edited video's); `clip`: the timeline clip it's in (else the one holding `t`).
    private func seek(_ t: Double, playing: Bool, clip: Int? = nil) {
        if !playing { player.pause() }
        if let clip { playingClip = clip }
        let time = CMTime(seconds: t, preferredTimescale: 600)
        playheadMoved(t)
        pendingSeeks += 1
        player.seek(to: time, toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] done in
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    self?.pendingSeeks -= 1
                    if done, playing { self?.player.play() }
                }
            }
        }
    }

    private func seekSequence(_ s: Double) {
        if compMode { return seek(s, playing: false) }
        let k = edit.clipIndex(atSequence: s)
        seek(edit.source(atSequence: s), playing: false, clip: k)
    }

    /// Space plays; S splits; Delete removes the selected annotation or clip; I / O set the start / end; arrows step a
    /// frame (Shift: a second); V R A T H B N pick a drawing tool; Esc goes back to Select.
    private func handleKey(_ e: NSEvent) -> Bool {
        guard uploadTask == nil else { return false }
        switch e.keyCode {
        case 49: togglePlay(); return true                                      // Space
        case 51, 117:                                                            // Delete, Forward Delete
            if let a = drawing.selected { drawing.delete(a); return true }
            if timeline.selectedClip != nil { deleteSelectedClip(); return true }
            return false
        case 53:                                                                 // Esc
            if timeline.cutMode { toggleCut(); return true }
            setTool(.select)
            drawing.selected = nil
            timeline.selectedAnnotation = nil
            timeline.select(clip: nil)
            updateProps()
            return true
        case 123, 124:                                                           // ← →
            let dir = e.keyCode == 123 ? -1 : 1
            if e.modifierFlags.contains(.shift) {
                seekSequence(min(edit.length, max(0, currentSequence + Double(dir))))
            } else {
                player.pause()
                player.currentItem?.step(byCount: dir)
            }
            return true
        default: break
        }
        switch e.charactersIgnoringModifiers?.lowercased() {
        case "s": split(); return true
        case "c": toggleCut(); return true
        case "i": setStart(); return true
        case "o": setEnd(); return true
        case "v": setTool(.select); return true
        case "r": setTool(.rect); return true
        case "a": setTool(.arrow); return true
        case "t": setTool(.text); return true
        case "h": setTool(.highlight); return true
        case "b": setTool(.blur); return true
        case "n": setTool(.count); return true
        default: return false
        }
    }

    /// ⌘Z, ⇧⌘Z, ⌘K (Premiere's add edit).
    private func handleCommand(_ c: String, shift: Bool) -> Bool {
        switch c {
        case "z": shift ? redo() : undo(); return true
        case "k": split(); return true
        default: return false
        }
    }

    /// Evenly spaced frames for the timeline's filmstrip; it draws what has arrived so far.
    private func loadThumbnails(aspect: CGFloat) {
        let total = totalSeconds
        guard total > 0 else { return }
        let gen = AVAssetImageGenerator(asset: asset)
        gen.appliesPreferredTrackTransform = true
        gen.maximumSize = CGSize(width: 96 * max(0.2, aspect), height: 96)
        let tol = CMTime(seconds: max(0.1, total / 120), preferredTimescale: 600)
        gen.requestedTimeToleranceBefore = tol
        gen.requestedTimeToleranceAfter = tol
        let n = 60
        let times = (0..<n).map { CMTime(seconds: total * (Double($0) + 0.5) / Double(n), preferredTimescale: 600) }
        timeline.thumbnails = Array(repeating: nil, count: n)
        Task { [weak self] in
            var i = 0
            for await r in gen.images(for: times) {
                guard let self else { return }
                if let img = try? r.image, let k = times.firstIndex(of: r.requestedTime) ?? (i < n ? i : nil) {
                    timeline.thumbnails[k] = img
                }
                i += 1
            }
        }
    }

    /// The video at about its point size (Retina capture: pixels / 2) within 80% of the screen under the pointer, plus the controls.
    private func frame(forVideo n: CGSize) -> NSRect {
        let p = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { NSMouseInRect(p, $0.frame, false) } ?? NSScreen.main
        let vis = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        // bar + editing row and timeline + status line, and the canvas's 16 pt margins
        let panelH: CGFloat = EditorStyle.barHeight + 110 + EditorStyle.statusHeight + 32
        let maxW = vis.width * 0.8 - 32, maxH = vis.height * 0.8 - panelH - 28
        var w = max(1, n.width / 2), h = max(1, n.height / 2)
        let k = min(1, maxW / w, maxH / h)
        w *= k; h *= k
        // wide enough for the bar's labels, like the screenshot editor
        if w < 1180 { w = min(1180, vis.width * 0.9 - 32) }
        let cw = w + 32, ch = min(vis.height * 0.9 - 28, h + panelH)
        return NSRect(x: vis.midX - cw / 2, y: vis.midY - (ch + 28) / 2, width: cw, height: ch + 28)
    }

    func bringForward() {
        NSApp.activate(ignoringOtherApps: true)
        if window.isMiniaturized { window.deminiaturize(nil) }
        window.makeKeyAndOrderFront(nil)
    }

    // MARK: Status

    private func setStatus(_ text: String, action: ActionKind = .none, progress p: Double? = nil, bad: Bool = false) {
        statusLabel.stringValue = text
        statusLabel.textColor = bad ? EditorStyle.danger : EditorStyle.text2
        statusLabel.toolTip = text
        progress.isHidden = p == nil
        if let p { progress.doubleValue = p }
        actionKind = action
        switch action {
        case .none: actionButton.isHidden = true
        case .cancel: actionButton.title = "Cancel"; actionButton.isHidden = false
        case .reveal: actionButton.title = "Show in Finder"; actionButton.isHidden = false
        case .copyLink: actionButton.title = "Copy link"; actionButton.isHidden = false
        }
    }

    private func setProgress(_ p: Double) { progress.doubleValue = p }

    /// Enabled / shown states of the editing buttons (and everything off while uploading).
    private func updateButtonStates() {
        let off = uploadTask != nil
        for b in [saveButton, copyButton, uploadButton, setStartButton, setEndButton] { b.isEnabled = !off }
        for b in toolButtons.values { b.isEnabled = !off }
        deleteClipButton.isEnabled = !off && timeline.selectedClip != nil && edit.clips.count > 1
        undoButton.isEnabled = !off && !undoStack.isEmpty
        redoButton.isEnabled = !off && !redoStack.isEmpty
        resetButton.isEnabled = !off && edit.isModified
        transitionsButton.isEnabled = !off
        transitionsButton.isOn = edit.transitionStyle != .none || edit.hasTransitions
        timeline.isEnabled = !off
        grip.isEnabled = !off
    }

    private func updateButtons() { updateButtonStates() }

    @objc private func actionClicked() {
        switch actionKind {
        case .cancel:
            prepTask?.cancel()
            uploadTask?.cancel()
        case .reveal:
            if let u = savedURL { NSWorkspace.shared.activateFileViewerSelecting([u]) }
        case .copyLink:
            copyLink()
        case .none: break
        }
    }

    private func copyLink() {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(link, forType: .string)
        actionButton.title = "Copied"
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            if self?.actionKind == .copyLink { self?.actionButton.title = "Copy link" }
        }
    }

    // MARK: Names and sizes

    /// The file name (without extension): the title, or the app's file name pattern when the title is the untouched default
    /// and the pattern was customised.
    private func fileBase() -> String {
        let s = CaptureSettings.shared
        if !titleEdited && s.filenamePattern != CaptureSettings.defaultPattern {
            return String(s.fileName(app: doc.target, date: doc.createdAt, ext: "mp4").dropLast(4))
        }
        var t = titleField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        t = t.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: ".")
        while t.hasPrefix(".") { t.removeFirst() }
        if t.isEmpty { t = "Recording" }
        return String(t.prefix(120))
    }

    /// A copy of `base` named after the title (a clone on APFS: instant, no extra space).
    private func namedFile(for base: URL) throws -> URL {
        try FileManager.default.createDirectory(at: workDir.appendingPathComponent("named", isDirectory: true), withIntermediateDirectories: true)
        let url = workDir.appendingPathComponent("named", isDirectory: true).appendingPathComponent(fileBase() + ".mp4")
        if url.standardizedFileURL == base.standardizedFileURL { return url }
        try? FileManager.default.removeItem(at: url)
        try FileManager.default.copyItem(at: base, to: url)
        return url
    }

    private func updateInfo() {
        let kept = edit.isModified ? edit.length : totalSeconds
        var parts = [RecentRecordings.format(duration: max(0, kept))]
        let fm = FileManager.default
        func size(_ u: URL) -> Int64? { (try? fm.attributesOfItem(atPath: u.path)[.size] as? Int64) ?? nil }
        let fmt = ByteCountFormatter()
        fmt.countStyle = .file
        if !isTrimmed, let b = size(sourceURL) {
            parts.append(fmt.string(fromByteCount: b))
        } else if let f = baseFile, baseKey == rangeKey, let b = size(f) {
            parts.append(fmt.string(fromByteCount: b))
        } else if let b = size(sourceURL), assetDuration.seconds > 0 {
            parts.append("about " + fmt.string(fromByteCount: Int64(Double(b) * kept / assetDuration.seconds)))
        }
        if !doc.hasAudio { parts.append("no audio") }
        infoLabel.stringValue = parts.joined(separator: " · ")
    }

    // MARK: Editing

    private var totalSeconds: Double { assetDuration.seconds > 0 ? assetDuration.seconds : doc.duration }
    /// Anything to export (cuts or annotations); otherwise the recording itself is the file.
    private var isTrimmed: Bool { edit.isModified || !annotations.isEmpty }
    private var rangeKey: String {
        guard isTrimmed else { return "full" }
        return edit.key + (annotations.isEmpty ? "" : "+a\(annotationRevision)\(animationsOn ? "" : "s")")
    }

    /// The export for an edit (named by a short hash: many cuts make a long key).
    private func trimFile(_ key: String) -> URL {
        var h: UInt64 = 0xcbf2_9ce4_8422_2325
        for b in key.utf8 { h = (h ^ UInt64(b)) &* 0x100_0000_01b3 }
        return workDir.appendingPathComponent("edit-\(String(h, radix: 36)).mp4")
    }

    private func pushUndo() {
        undoStack.append(Snapshot(edit: edit, annotations: annotations, counter: counter))
        if undoStack.count > 200 { undoStack.removeFirst() }
        redoStack = []
        updateButtonStates()
    }

    private func undo() {
        drawing.endTextEditing(commit: true)
        guard let s = undoStack.popLast() else { return NSSound.beep() }
        redoStack.append(Snapshot(edit: edit, annotations: annotations, counter: counter))
        restore(s)
    }

    private func redo() {
        guard let s = redoStack.popLast() else { return NSSound.beep() }
        undoStack.append(Snapshot(edit: edit, annotations: annotations, counter: counter))
        restore(s)
    }

    private func restore(_ s: Snapshot) {
        edit = s.edit
        annotations = s.annotations
        counter = s.counter
        timeline.setEdit(edit)
        editChanged()
        annotationsChanged()
    }

    /// Splits the clip under the playhead (or `t`, sequence time).
    private func split(atSequence t: Double? = nil) {
        guard totalSeconds > 0 else { return }
        var e = edit
        guard e.split(atSequence: t ?? currentSequence) != nil else {
            setStatus("Move the playhead away from the clip’s edge to split it.")
            return NSSound.beep()
        }
        player.pause()
        pushUndo()
        edit = e
        timeline.setEdit(edit)
        editChanged()
    }

    private func toggleCut() {
        timeline.cutMode.toggle()
        cutButton.isOn = timeline.cutMode
        if timeline.cutMode { player.pause(); toast.show("Cut: click a clip where it should be cut. Esc or C to stop.") }
    }

    private func deleteSelectedClip() {
        guard let i = timeline.selectedClip else { return }
        deleteClip(i)
    }

    /// Removes clip `i`; the rest closes up (the playhead stays where it was in the edited video).
    private func deleteClip(_ i: Int) {
        var e = edit
        guard e.deleteClip(i) else {
            setStatus("The last clip can’t be deleted.")
            return NSSound.beep()
        }
        player.pause()
        let at = edit.sequenceStart(of: i)
        pushUndo()
        edit = e
        timeline.setEdit(edit)
        timeline.select(clip: nil)
        editChanged()
        seekSequence(min(at, edit.length))
        toast.show("Clip removed. Drag the edge with the red notch out to bring it back.")
    }

    private func setStart() {
        guard totalSeconds > 0 else { return }
        var e = edit
        e.deleteBefore(sequence: currentSequence)
        guard e != edit else { return NSSound.beep() }
        pushUndo()
        edit = e
        timeline.setEdit(edit)
        editChanged()
        seekSequence(0)
    }

    private func setEnd() {
        guard totalSeconds > 0 else { return }
        var e = edit
        e.deleteAfter(sequence: currentSequence)
        guard e != edit else { return NSSound.beep() }
        pushUndo()
        edit = e
        timeline.setEdit(edit)
        editChanged()
    }

    private func resetEdit() {
        guard edit.isEdited || edit.clips.count > 1 else { return }
        pushUndo()
        edit.reset()
        timeline.setEdit(edit)
        editChanged()
    }

    /// After any change to the clips.
    private func editChanged() {
        timeline.setAnnotations(annotations)
        watchClips()
        refreshPlayhead()
        updateEditLabels()
        syncPlayback()
        if previewCompositionOn { refreshFrame() }   // blur boxes sit on the edit too
        scheduleExport()
        Log.write("recording: edit \(edit.key) (\(edit.clips.count) clips)")
    }

    // MARK: Transitions

    /// The edit-wide style and speed, from the Transitions button.
    private func showTransitionsMenu() {
        let menu = NSMenu()
        menu.autoenablesItems = false
        for st in CutTransition.Style.allCases {
            let item = ActionItem(st.name) { [weak self] in self?.setTransitions(style: st, speed: nil) }
            item.state = st == edit.transitionStyle ? .on : .off
            menu.addItem(item)
        }
        menu.addItem(.separator())
        for sp in CutTransition.Speed.allCases {
            let item = ActionItem("\(sp.name) (\(sp.seconds.formatted(.number.precision(.fractionLength(1)))) s)") { [weak self] in self?.setTransitions(style: nil, speed: sp) }
            item.state = sp == edit.transitionSpeed ? .on : .off
            item.isEnabled = edit.transitionStyle != .none || edit.hasTransitions
            menu.addItem(item)
        }
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: transitionsButton.bounds.height + 4), in: transitionsButton)
    }

    /// One undo step.
    private func setTransitions(style: CutTransition.Style?, speed: CutTransition.Speed?) {
        var e = edit
        if let style { e.transitionStyle = style }
        if let speed { e.transitionSpeed = speed }
        guard e != edit else { return }
        transitionsChanged(to: e)
        if e.transitionStyle == .crossfade, edit.hasTransitions {
            toast.show("Crossfade overlaps the clips, so the edit is \(RecordingMath.preciseTimer(totalLengthLost)) shorter")
        }
    }

    /// Seam `i` on its own (nil: the edit-wide style again). One undo step.
    private func setSeamStyle(_ i: Int, _ style: CutTransition.Style?) {
        var e = edit
        if let style { e.setSeamStyle(i, style) } else { e.clearSeamStyle(i) }
        guard e != edit else { return }
        transitionsChanged(to: e)
    }

    private var totalLengthLost: Double { edit.clips.reduce(0) { $0 + $1.length } - edit.length }

    private func transitionsChanged(to e: EditModel) {
        player.pause()
        pushUndo()
        edit = e
        timeline.setEdit(edit)
        editChanged()
    }

    /// The preview follows the edit: with transitions the player plays the same composition the export is made from (so
    /// what you see is what is written), else the recording itself, clip by clip. Rebuilt a moment after the last change,
    /// keeping the playhead.
    private func syncPlayback() {
        rebuildWork?.cancel()
        buildGeneration += 1
        guard edit.hasTransitions || compMode else { return }
        let w = DispatchWorkItem { [weak self] in self?.rebuildPlayback() }
        rebuildWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.12, execute: w)
    }

    private func rebuildPlayback() {
        let gen = buildGeneration, snapshot = edit
        if !snapshot.hasTransitions {
            guard compMode else { return }
            let seq = min(timeline.playhead, edit.length), playing = isPlaying
            compMode = false
            swapItem(AVPlayerItem(asset: asset))
            watchClips()
            updatePreviewComposition()
            seek(edit.source(atSequence: seq), playing: playing, clip: edit.clipIndex(atSequence: seq))
            return
        }
        Task { [weak self] in
            guard let self else { return }
            let built: EditComposition
            do { built = try await EditComposition.build(asset: asset, edit: snapshot, frames: previewFrames) } catch {
                if gen == buildGeneration { setStatus("Couldn’t preview the transitions: \(error.localizedDescription)", bad: true) }
                return
            }
            guard gen == buildGeneration else { return }   // the edit changed again meanwhile
            let seq = min(timeline.playhead, snapshot.length), playing = isPlaying
            let item = AVPlayerItem(asset: built.composition)
            item.videoComposition = built.videoComposition
            item.audioMix = built.audioMix
            compMode = true
            previewCompositionOn = false
            previewComposition = nil
            if let o = boundaryObserver { player.removeTimeObserver(o); boundaryObserver = nil }
            swapItem(item)
            seek(seq, playing: playing)
        }
    }

    private func swapItem(_ item: AVPlayerItem) {
        previewCompositionOn = false
        previewComposition = nil
        player.replaceCurrentItem(with: item)
        observeEnd()
    }

    /// After any committed change to the annotations.
    private func annotationsChanged() {
        annotationRevision += 1
        drawing.setAnnotations(annotations)
        timeline.setAnnotations(annotations)
        timeline.selectedAnnotation = drawing.selected
        previewFrames.annotations = annotations
        updatePreviewComposition()
        updateProps()
        updateEditLabels()
        scheduleExport()
    }

    /// Blur boxes in the player go through a Core Image video composition (installed only while there are any).
    private func updatePreviewComposition() {
        guard !compMode else { return refreshFrame() }   // the composition already draws the blur boxes
        let hasBlur = annotations.contains { $0.kind == .blur }
        guard let item = player.currentItem else { return }
        if !hasBlur {
            if previewCompositionOn { item.videoComposition = nil; previewComposition = nil; previewCompositionOn = false }
            return
        }
        if previewCompositionOn {
            // a fresh copy makes the player render the paused frame again (a seek to the same time may be skipped)
            if let vc = previewComposition?.copy() as? AVVideoComposition { item.videoComposition = vc; previewComposition = vc }
            return refreshFrame()
        }
        previewCompositionOn = true
        let frames = previewFrames
        Task { [weak self] in
            guard let vc = try? await AVMutableVideoComposition.videoComposition(with: self?.asset ?? AVURLAsset(url: URL(fileURLWithPath: "/")),
                                                                                 applyingCIFiltersWithHandler: { req in
                let src = req.sourceImage
                let img = frames.apply(to: src.transformed(by: CGAffineTransform(translationX: -src.extent.minX, y: -src.extent.minY)),
                                       at: frames.sequence(ofSource: CMTimeGetSeconds(req.compositionTime)))
                req.finish(with: img.cropped(to: CGRect(origin: .zero, size: src.extent.size)), context: nil)
            }) else { return }
            guard let self, previewCompositionOn else { return }
            player.currentItem?.videoComposition = vc
            previewComposition = vc
            refreshFrame()
        }
    }

    /// Redraws the paused frame (a blur box changed).
    private func refreshFrame() {
        guard !isPlaying else { return }
        if compMode, let item = player.currentItem, let vc = item.videoComposition?.copy() as? AVVideoComposition { item.videoComposition = vc }
        player.seek(to: player.currentTime(), toleranceBefore: .zero, toleranceAfter: .zero)
    }

    private func updateEditLabels() {
        var parts: [String] = []
        if edit.isModified {
            parts.append("Edited: \(RecordingMath.preciseTimer(edit.length)) of \(RecordingMath.preciseTimer(totalSeconds))")
        }
        if edit.clips.count > 1 { parts.append("\(edit.clips.count) clips") }
        if edit.hasTransitions { parts.append("transitions") }
        if !annotations.isEmpty { parts.append("\(annotations.count) annotation\(annotations.count == 1 ? "" : "s")") }
        if parts.isEmpty {
            editLabel.stringValue = "S cuts at the playhead · select a clip and press Delete to remove it · draw with the tools above"
            editLabel.textColor = EditorStyle.text2
        } else {
            editLabel.stringValue = parts.joined(separator: " · ")
            editLabel.textColor = EditorStyle.text
        }
        editLabel.toolTip = editLabel.stringValue
        refreshPlayhead()
        updateButtonStates()
        updateInfo()
    }

    // MARK: Drawing tools

    private func setTool(_ t: AnnotationCanvas.Tool) {
        drawing.tool = t
        for (k, b) in toolButtons { b.isOn = k == t }
        if t != .select {
            player.pause()
            drawing.selected = nil
            timeline.selectedAnnotation = nil
        }
        updateProps()
    }

    /// When a new annotation shows: from the playhead (recording time) for 4 seconds of the edited video, or what's left.
    private func timesForNew(_ k: VideoAnnotation.Kind) -> (start: Double, length: Double) {
        let t = min(max(0, currentSource), max(0, totalSeconds - 0.5))
        return (t, max(0.5, min(edit.length - edit.sequence(ofAnchor: t), 4)))
    }

    /// Selected on the timeline: the picture goes to where it shows, so it can be seen and edited.
    private func selectAnnotation(_ id: Int?) {
        drawing.selected = id
        if let id, let an = annotations.first(where: { $0.id == id })?.resolved(in: edit), !an.visible(at: currentSequence), an.length > 0 {
            seekSequence(an.start + min(0.4, an.length / 2))   // past its transition in
        }
        updateProps()
    }

    /// The floating card: colours and sizes for the current tool or the selected annotation, and Delete.
    private func updateProps() {
        let sel = drawing.selected.flatMap { id in annotations.first { $0.id == id } }
        guard let kind = sel?.kind ?? drawing.tool.kind else { props.isHidden = true; return }
        let style = sel.map { ($0.color, $0.size) } ?? toolStyle[kind] ?? (AnnotationStyle.defaultColor, 1)
        props.stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        var views: [NSView] = []
        if kind != .blur {
            for c in AnnotationStyle.colors {
                let s = SwatchButton(name: c.name, rgb: c.rgb) { [weak self] in self?.applyStyle(color: c.rgb) }
                s.isOn = style.0 == c.rgb
                views.append(s)
            }
        }
        let sizes: [String] = kind == .text ? ["S", "M", "L", "XL"] : [.rect, .arrow, .count].contains(kind) ? ["S", "M", "L"] : []
        if !sizes.isEmpty {
            views.append(props.divider())
            let names = kind == .text ? AnnotationStyle.fontNames : AnnotationStyle.sizeNames
            for (i, n) in sizes.enumerated() {
                let b = GhostButton(n) { [weak self] in self?.applyStyle(size: i) }
                b.toolTip = names[i]
                b.isOn = style.1 == i
                views.append(b)
            }
        }
        if kind == .count {
            views.append(props.divider())
            if let sel {
                let f = NSTextField(string: String(sel.number))
                f.alignment = .center
                f.font = .monospacedDigitSystemFont(ofSize: 12, weight: .semibold)
                f.controlSize = .small
                f.target = self
                f.action = #selector(countNumberEntered(_:))
                f.widthAnchor.constraint(equalToConstant: 44).isActive = true
                f.toolTip = "This badge’s number (1–\(VideoAnnotation.maxCountNumber)); the next badge continues from it"
                f.setAccessibilityLabel("Badge number")
                views.append(f)
            }
            let reset = GhostButton("Reset") { [weak self] in self?.resetCount() }
            reset.toolTip = "Start a new count: the next badge is 1 (existing badges keep their numbers)"
            reset.setAccessibilityLabel("Reset count to 1")
            views.append(reset)
        }
        if kind == .blur {
            let l = NSTextField(labelWithString: sel == nil ? "Drag over what to hide. It blurs for 4 seconds from the playhead; stretch its bar below." : "Blur box")
            l.font = .systemFont(ofSize: 12)
            l.textColor = EditorStyle.text2
            views.append(l)
        }
        // how it comes in (and goes out)
        let tr = sel?.transition ?? toolTransition[kind] ?? .fade
        let trButton = GhostButton(tr.name, image: EditorIcon.symbol("sparkles"))
        trButton.toolTip = animationsOn ? "How it comes in and goes out" : "Transitions are off (Animate, below the video)"
        trButton.isEnabled = animationsOn
        trButton.onClick = { [weak self, weak trButton] in
            guard let self, let trButton else { return }
            let menu = NSMenu()
            for t in VideoAnnotation.Transition.allCases where (kind != .blur || t == .none || t == .fade) && (kind != .count || t != .draw) {
                let item = ActionItem(t.name) { [weak self] in self?.applyStyle(transition: t) }
                item.state = t == tr ? .on : .off
                menu.addItem(item)
            }
            menu.popUp(positioning: nil, at: NSPoint(x: 0, y: -4), in: trButton)
        }
        views += [props.divider(), trButton]
        if animationsOn, tr != .none {
            let speed = sel?.speed ?? toolSpeed[kind] ?? .normal
            let seg = NSSegmentedControl(labels: VideoAnnotation.Speed.allCases.map(\.name), trackingMode: .selectOne,
                                         target: self, action: #selector(speedPicked(_:)))
            seg.segmentStyle = .rounded
            seg.controlSize = .small
            seg.selectedSegment = VideoAnnotation.Speed.allCases.firstIndex(of: speed) ?? 1
            seg.toolTip = "How fast it comes in and goes out"
            seg.setAccessibilityLabel("Transition speed")
            views.append(seg)
        }
        if let sel {
            let when = NSTextField(labelWithString: "\(RecordingMath.preciseTimer(edit.sequence(ofSource: sel.start)))–\(RecordingMath.preciseTimer(edit.sequence(ofSource: sel.end)))")
            when.font = .monospacedDigitSystemFont(ofSize: 11.5, weight: .regular)
            when.textColor = EditorStyle.text2
            when.toolTip = "When it shows; drag its bar on the timeline to change"
            let del = GhostButton("", image: EditorIcon.symbol("trash")) { [weak self] in self?.drawing.delete(sel.id) }
            del.toolTip = "Delete (⌫)"
            del.setAccessibilityLabel("Delete annotation")
            views += [props.divider(), when, del]
        }
        views.forEach { props.stack.addArrangedSubview($0) }
        props.isHidden = false
        props.needsDisplay = true
    }

    @objc private func speedPicked(_ seg: NSSegmentedControl) {
        let all = VideoAnnotation.Speed.allCases
        guard all.indices.contains(seg.selectedSegment) else { return }
        applyStyle(speed: all[seg.selectedSegment])
    }

    @objc private func countNumberEntered(_ f: NSTextField) {
        guard let id = drawing.selected, annotations.first(where: { $0.id == id })?.kind == .count else { return }
        guard let typed = Int(f.stringValue.trimmingCharacters(in: .whitespaces)), typed >= 1 else { return updateProps() }
        setCountNumber(typed, of: id)
    }

    /// Gives a badge a number (one undo step) and continues the count from it.
    private func setCountNumber(_ n: Int, of id: Int) {
        var c = counter
        let number = c.override(n)
        let same = annotations.first(where: { $0.id == id })?.number == number
        if same, c == counter { return updateProps() }
        if same { pushUndo() }   // only the counter moves: still one undo step
        drawing.update(id) { $0.number = number }   // takes its own undo step when the number changes
        counter = c
        updateProps()
    }

    private func resetCount() {
        guard counter != CountCounter() else { return }
        pushUndo()
        counter.reset()
        updateProps()
    }

    private func applyStyle(color: UInt32? = nil, size: Int? = nil, transition: VideoAnnotation.Transition? = nil,
                            speed: VideoAnnotation.Speed? = nil) {
        let sel = drawing.selected.flatMap { id in annotations.first { $0.id == id } }
        guard let kind = sel?.kind ?? drawing.tool.kind else { return }
        var s = toolStyle[kind] ?? (AnnotationStyle.defaultColor, 1)
        if let color { s.color = color }
        if let size { s.size = size }
        toolStyle[kind] = s
        if let transition { toolTransition[kind] = transition }
        if let speed { toolSpeed[kind] = speed }
        if let sel {
            drawing.update(sel.id) { an in
                if let color { an.color = color }
                if let size { an.size = size }
                if let transition { an.transition = transition }
                if let speed { an.speed = speed }
            }
            // show the new transition once
            if transition != nil || speed != nil, transition != VideoAnnotation.Transition.none, animationsOn { previewTransition(of: sel.id) }
        }
        updateProps()
    }

    /// Plays the second around an annotation's start, so a new transition can be seen.
    private func previewTransition(of id: Int) {
        guard let an = annotations.first(where: { $0.id == id })?.resolved(in: edit), an.length > 0 else { return }
        seekSequence(max(0, an.start - 0.3))
        player.play()
        let stopAt = an.start + 1
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) { [weak self] in
            guard let self, isPlaying, currentSequence >= stopAt - 0.2 else { return }
            player.pause()
        }
    }

    private func toggleAnimations() {
        animationsOn.toggle()
        UserDefaults.standard.set(animationsOn, forKey: "recordingAnimations")
        animateButton.isOn = animationsOn
        playStateChanged()
        updateProps()
        if !annotations.isEmpty { scheduleExport() }
        toast.show(animationsOn ? "Transitions on" : "Transitions off: annotations just appear")
    }

    // MARK: Export

    /// Re-exports a moment after the last change, so Save, Copy, Upload and the drag grip are instant (a burst of
    /// changes exports once).
    private func scheduleExport() {
        prepareLater?.cancel()
        if !isTrimmed {
            prepTask?.cancel()
            prepTask = nil
            setStatus("")
            return
        }
        let w = DispatchWorkItem { [weak self] in
            guard let self, isTrimmed, baseKey != rangeKey, prepKey != rangeKey || prepTask == nil else { return }
            startPrepare()
        }
        prepareLater = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5, execute: w)
    }

    /// Exports the edit in the background.
    private func startPrepare() {
        prepTask?.cancel()
        let key = rangeKey, e = edit
        let frames = annotations.isEmpty ? nil : AnnotationFrameRenderer(blurOnly: false, annotations: annotations, edit: edit, animate: animationsOn)
        let out = trimFile(key)
        try? FileManager.default.createDirectory(at: workDir, withIntermediateDirectories: true)
        prepKey = key
        setStatus("Preparing the edited video…", action: .cancel, progress: 0)
        let asset = self.asset
        let t = Task { @MainActor [weak self] () -> URL in
            do {
                let mode = try await RecordingExport.export(asset: asset, edit: e, to: out, frames: frames) { p in
                    Task { @MainActor in self?.setProgress(p) }
                }
                guard let self else { return out }
                if prepKey == key {
                    if let old = baseFile, old != out { try? FileManager.default.removeItem(at: old) }
                    baseFile = out
                    baseKey = key
                    prepTask = nil
                    setStatus("Edited video ready")
                    updateInfo()
                    Log.write("recording: edit exported (\(mode.rawValue))")
                }
                return out
            } catch {
                if let self, prepKey == key {
                    prepTask = nil
                    if error is CancellationError { setStatus("Export cancelled") }
                    else { setStatus("Couldn’t export the edit: \(error.localizedDescription)", bad: true) }
                }
                throw error
            }
        }
        prepTask = t
    }

    /// The file for the current edit: the recording itself, or its export.
    private func ensureFile() async throws -> URL {
        if !isTrimmed { return sourceURL }
        drawing.endTextEditing(commit: true)
        let key = rangeKey
        if let f = baseFile, baseKey == key { return f }
        prepareLater?.cancel()
        if prepTask == nil || prepKey != key { startPrepare() }
        return try await prepTask!.value
    }

    // MARK: Save, copy, upload, drag

    @objc private func saveClicked() { CaptureSettings.shared.askWhere ? saveAs() : save(asking: false) }
    func saveAs() { save(asking: true) }

    /// What the saved file was made from: the edit, the annotations (and animation setting) and the title.
    private var savedKey: String?
    private var currentSaveKey: String { rangeKey + "|" + fileBase() }

    private func save(asking: Bool, then: (() -> Void)? = nil) {
        guard uploadTask == nil else { return }
        // Save again with nothing changed: point at the file already saved instead of writing "name (1).mp4"
        if !asking, let url = savedURL, savedKey == currentSaveKey, FileManager.default.fileExists(atPath: url.path) {
            showSavedToast(url)
            then?()
            return
        }
        Task { [weak self] in
            guard let self else { return }
            do {
                let base = try await ensureFile()
                let folder = CaptureSettings.shared.recordingFolder
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                var dest = Self.unique(folder.appendingPathComponent(fileBase() + ".mp4"))
                if asking {
                    let panel = NSSavePanel()
                    panel.allowedContentTypes = [.mpeg4Movie]
                    panel.nameFieldStringValue = fileBase() + ".mp4"
                    panel.directoryURL = folder
                    let r: NSApplication.ModalResponse = await withCheckedContinuation { c in panel.beginSheetModal(for: self.window) { c.resume(returning: $0) } }
                    guard r == .OK, let url = panel.url else { return }
                    dest = url
                    try? FileManager.default.removeItem(at: url)   // the panel already asked about replacing
                }
                try FileManager.default.copyItem(at: base, to: dest)
                markSaved(dest)
                then?()
            } catch is CancellationError {
            } catch {
                setStatus("Couldn’t save: \(error.localizedDescription)", bad: true)
                Log.write("recording: save failed: \(error.localizedDescription)")
            }
        }
    }

    private func showSavedToast(_ url: URL) {
        toast.show("Saved to \(url.deletingLastPathComponent().lastPathComponent)",
                   action: (title: "Show in Finder", run: { NSWorkspace.shared.activateFileViewerSelecting([url]) }))
    }

    private func markSaved(_ url: URL) {
        saved = true
        savedURL = url
        savedKey = currentSaveKey
        RecentRecordings.shared.update(id: id) { $0.saved = true; $0.path = url.path; $0.title = self.titleField.stringValue }
        setStatus("Saved to \(url.deletingLastPathComponent().lastPathComponent)", action: .reveal)
        showSavedToast(url)
        Log.write("recording: saved \(url.path)")
    }

    @objc private func copyClicked() {
        guard uploadTask == nil else { return }
        Task { [weak self] in
            guard let self else { return }
            do {
                let url = try namedFile(for: try await ensureFile())
                let pb = NSPasteboard.general
                pb.clearContents()
                pb.writeObjects([url as NSURL])
                copied = true
                toast.show("Copied. Paste it into Slack, Mail or Finder.")
                Log.write("recording: copied \(url.lastPathComponent)")
            } catch is CancellationError {
            } catch {
                setStatus("Couldn’t copy: \(error.localizedDescription)", bad: true)
            }
        }
    }

    @objc private func uploadClicked() {
        guard uploadTask == nil else { return }
        guard let config = S3Upload.currentConfig() else {
            setStatus("Upload isn’t set up. Add your storage details in Settings → Screenshots.", bad: true)
            AppSettingsWindow.shared.show()
            return
        }
        link = ""
        uploadTask = Task { [weak self] in
            guard let self else { return }
            defer { uploadTask = nil; updateButtons() }
            updateButtons()
            do {
                let base = try await ensureFile()
                setStatus("Uploading…", action: .cancel, progress: 0)
                let res = try await S3Upload.upload(file: base, name: fileBase(), config: config) { [weak self] p in
                    Task { @MainActor in
                        self?.setProgress(p)
                        self?.statusLabel.stringValue = "Uploading… \(Int(p * 100))%"
                    }
                }
                link = res.link
                uploaded = true
                RecentRecordings.shared.update(id: id) { $0.link = res.link; $0.title = self.titleField.stringValue }
                let pb = NSPasteboard.general
                pb.clearContents()
                pb.setString(res.link, forType: .string)
                setStatus("Link copied: \(res.link)\(res.note.map { " (\($0))" } ?? "")", action: .copyLink)
                Log.write("recording: uploaded \(res.key)")
            } catch is CancellationError {
                setStatus("Upload cancelled")
            } catch {
                setStatus("Upload failed: \(error.localizedDescription)", bad: true)
                Log.write("recording: upload failed: \(error.localizedDescription)")
            }
        }
    }

    /// The file a drag carries. A trimmed recording whose export isn't done yet can't be dragged (a drag needs the file now).
    private func fileForDrag() -> URL? {
        guard uploadTask == nil else { return nil }
        let base: URL
        if !isTrimmed { base = sourceURL }
        else if let f = baseFile, baseKey == rangeKey { base = f }
        else { setStatus("Preparing the trimmed video, then drag again", action: .cancel, progress: progress.doubleValue); return nil }
        guard let url = try? namedFile(for: base) else { return nil }
        copied = true   // it has gone somewhere
        return url
    }

    private func dragIcon() -> NSImage {
        RecentRecordings.shared.thumbnail(for: id) ?? NSImage(systemSymbolName: "film", accessibilityDescription: nil) ?? NSImage()
    }

    /// "name.mp4", then "name (1).mp4", ... like Chrome's uniquify
    private static func unique(_ url: URL) -> URL {
        let fm = FileManager.default
        guard fm.fileExists(atPath: url.path) else { return url }
        let base = url.deletingPathExtension().lastPathComponent, ext = url.pathExtension
        for i in 1... {
            let u = url.deletingLastPathComponent().appendingPathComponent("\(base) (\(i)).\(ext)")
            if !fm.fileExists(atPath: u.path) { return u }
        }
        return url
    }

    // MARK: Title

    func controlTextDidBeginEditing(_ obj: Notification) { titleBox.needsDisplay = true }

    func controlTextDidChange(_ obj: Notification) {
        titleEdited = true
        window.title = titleField.stringValue
    }
    func controlTextDidEndEditing(_ obj: Notification) {
        titleBox.needsDisplay = true
        RecentRecordings.shared.update(id: id) { $0.title = self.titleField.stringValue }
    }

    // MARK: NSWindowDelegate

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if allowClose { return true }
        if uploadTask != nil {
            confirm("Cancel the upload?", "The recording is still uploading. Closing the window cancels it.", ok: "Cancel Upload and Close", destructive: true) { [weak self] in
                self?.uploadTask?.cancel()
                self?.forceClose()
            }
            return false
        }
        if saved || copied || uploaded { return true }
        // neither saved, copied nor uploaded: this window is the only copy that will be kept
        let alert = NSAlert()
        alert.messageText = "Discard recording?"
        alert.informativeText = "“\(titleField.stringValue)” hasn’t been saved, copied or uploaded."
        alert.addButton(withTitle: "Save")
        alert.addButton(withTitle: "Discard")
        alert.addButton(withTitle: "Cancel")
        alert.buttons[1].hasDestructiveAction = true
        alert.beginSheetModal(for: window) { [weak self] r in
            MainActor.assumeIsolated {
                guard let self else { return }
                switch r {
                case .alertFirstButtonReturn: self.save(asking: false) { [weak self] in self?.forceClose() }
                case .alertSecondButtonReturn: self.discarded = true; self.forceClose()
                default: break
                }
            }
        }
        return false
    }

    private func confirm(_ title: String, _ text: String, ok: String, destructive: Bool, _ then: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = text
        alert.addButton(withTitle: ok)
        alert.addButton(withTitle: "Keep Open")
        alert.buttons[0].hasDestructiveAction = destructive
        alert.beginSheetModal(for: window) { r in
            MainActor.assumeIsolated { if r == .alertFirstButtonReturn { then() } }
        }
    }

    private func forceClose() {
        allowClose = true
        window.close()
    }

    func windowWillClose(_ notification: Notification) {
        rebuildWork?.cancel()
        buildGeneration += 1
        player.pause()
        if let o = timeObserver { player.removeTimeObserver(o) }
        if let o = boundaryObserver { player.removeTimeObserver(o) }
        if let o = endObserver { NotificationCenter.default.removeObserver(o) }
        rateObserver = nil
        playerView.player = nil
        prepTask?.cancel()
        uploadTask?.cancel()
        let fm = FileManager.default
        // temp files: the trimmed exports go; the named copies stay when the file was copied or dragged somewhere (a paste may come later)
        try? fm.removeItem(at: trimFile(rangeKey))
        if let f = baseFile { try? fm.removeItem(at: f) }
        if !copied { try? fm.removeItem(at: workDir) }
        let inCache = sourceURL.path.contains("/Caches/")
        if discarded {
            if inCache { try? fm.removeItem(at: sourceURL) }
            RecentRecordings.shared.remove(id: id)
            Log.write("recording: discarded \(id)")
        } else if saved, savedURL != sourceURL, inCache {
            try? fm.removeItem(at: sourceURL)   // the saved copy is the one that lives on
        }
        onClosed?()
    }
}
