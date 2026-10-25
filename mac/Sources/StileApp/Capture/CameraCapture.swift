import AppKit
import AVFoundation
import StileCore

/// v3.9: what `RecordingController` drives: the screen recorder (`Recorder`, ScreenCaptureKit) or the camera recorder.
@MainActor
protocol RecordingEngine: AnyObject {
    var state: Recorder.State { get }
    var elapsed: TimeInterval { get }
    /// 0...1, the newest microphone peak (0 without a mic).
    var micLevel: Float { get }
    var onFailure: ((String) -> Void)? { get set }
    func start() async throws
    func pause() async
    func resume() async throws
    func stop() async throws -> RecordingResult
    func discard() async
}

extension Recorder: RecordingEngine {}

/// v3.9: the camera, Loom-style. **Screen + camera**: a round bubble floating over everything; it's one of our windows that
/// captures *show* (`Screenshotter.extraCaptureWindows`), so it's recorded as part of the screen, wherever the user drags
/// it (right-click: size and corner). **Camera only**: the same panel as a larger rounded preview while `CameraRecorder`
/// records the camera itself. The preview is mirrored, like a mirror; the camera-only file isn't.
@MainActor
final class CameraBubble: NSObject {
    enum Size: String, CaseIterable {
        case small, medium, large
        var diameter: CGFloat { self == .small ? 140 : self == .medium ? 200 : 280 }
        var name: String { rawValue.capitalized }
    }
    enum Corner: CaseIterable {
        case bottomLeft, bottomRight, topLeft, topRight
        var name: String {
            switch self {
            case .bottomLeft: return "Bottom Left"
            case .bottomRight: return "Bottom Right"
            case .topLeft: return "Top Left"
            case .topRight: return "Top Right"
            }
        }
    }

    let session = AVCaptureSession()
    let camera: AVCaptureDevice
    /// Camera only: a 16:9 preview instead of the round bubble.
    let previewOnly: Bool
    private let panel: BubblePanel
    private let view = BubbleView()
    private let preview: AVCaptureVideoPreviewLayer
    private(set) var size: Size
    /// Quartz rect the bubble's corners refer to (the recorded area), else the screen.
    var area: CGRect?
    var onSizeChanged: ((Size) -> Void)?

    var windowID: CGWindowID { CGWindowID(max(0, panel.windowNumber)) }
    var frameQuartz: CGRect { ScreenGeometry.quartz(fromAppKit: panel.frame) }

    init?(cameraID: String, size: Size, previewOnly: Bool = false) {
        guard let dev = AVCaptureDevice(uniqueID: cameraID) ?? AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: dev) else { return nil }
        camera = dev
        self.size = size
        self.previewOnly = previewOnly
        session.beginConfiguration()
        session.sessionPreset = .high
        guard session.canAddInput(input) else { session.commitConfiguration(); return nil }
        session.addInput(input)
        session.commitConfiguration()
        preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        panel = BubblePanel()
        super.init()
        view.wantsLayer = true
        view.layer?.addSublayer(preview)
        view.onLayout = { [weak self] in self?.layoutPreview() }
        view.menuProvider = { [weak self] in self?.menu() }
        panel.contentView = view
        if let c = preview.connection, c.isVideoMirroringSupported {
            c.automaticallyAdjustsVideoMirroring = false
            c.isVideoMirrored = true
        }
        applySize()
    }

    private func layoutPreview() {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        preview.frame = view.bounds
        let r = previewOnly ? 14 : view.bounds.width / 2
        view.layer?.cornerRadius = r
        view.layer?.masksToBounds = true
        view.layer?.borderWidth = previewOnly ? 0 : 3
        view.layer?.borderColor = NSColor.white.withAlphaComponent(0.9).cgColor
        CATransaction.commit()
        panel.invalidateShadow()
    }

    private func applySize() {
        let s: NSSize = previewOnly ? NSSize(width: 480, height: 270) : NSSize(width: size.diameter, height: size.diameter)
        let old = panel.frame
        panel.setContentSize(s)
        if old.width > 0 { panel.setFrameOrigin(NSPoint(x: old.midX - s.width / 2, y: old.midY - s.height / 2)) }
        clampOnScreen()
    }

    func show(at corner: Corner = .bottomLeft) {
        session.startRunning()
        move(to: corner)
        panel.orderFrontRegardless()
    }

    func close() {
        panel.orderOut(nil)
        nonisolated(unsafe) let s = session
        DispatchQueue.global(qos: .userInitiated).async { s.stopRunning() }
    }

    func setSize(_ s: Size) {
        size = s
        applySize()
        onSizeChanged?(s)
    }

    /// Into a corner of the recorded area (or the screen), 24 pt in.
    func move(to corner: Corner) {
        let a = area.map { ScreenGeometry.appKit(fromQuartz: $0) }
            ?? ScreenGeometry.screen(at: NSEvent.mouseLocation)?.visibleFrame ?? NSScreen.main?.visibleFrame ?? .zero
        let sz = panel.frame.size, m: CGFloat = 24
        let x = corner == .bottomLeft || corner == .topLeft ? a.minX + m : a.maxX - m - sz.width
        let y = corner == .bottomLeft || corner == .bottomRight ? a.minY + m : a.maxY - m - sz.height
        panel.setFrameOrigin(previewOnly ? NSPoint(x: a.midX - sz.width / 2, y: a.minY + 120) : NSPoint(x: x, y: y))
        clampOnScreen()
    }

    private func clampOnScreen() {
        let f = panel.frame
        guard let vis = (NSScreen.screens.first { $0.frame.intersects(f) } ?? NSScreen.main)?.visibleFrame else { return }
        panel.setFrameOrigin(NSPoint(x: min(max(f.minX, vis.minX), vis.maxX - f.width), y: min(max(f.minY, vis.minY), vis.maxY - f.height)))
    }

    private func menu() -> NSMenu? {
        guard !previewOnly else { return nil }
        let m = NSMenu()
        for s in Size.allCases {
            let it = ActionItem(s.name) { [weak self] in self?.setSize(s) }
            it.state = s == size ? .on : .off
            m.addItem(it)
        }
        m.addItem(.separator())
        for c in Corner.allCases { m.addItem(ActionItem(c.name) { [weak self] in self?.move(to: c) }) }
        return m
    }

    // MARK: Devices and permission

    static func cameras() -> [[String: String]] {
        AVCaptureDevice.DiscoverySession(deviceTypes: [.builtInWideAngleCamera, .external, .continuityCamera], mediaType: .video, position: .unspecified)
            .devices.map { ["id": $0.uniqueID, "name": $0.localizedName] }
    }

    static func authorized(prompt: Bool) async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: return true
        case .notDetermined: return prompt ? await AVCaptureDevice.requestAccess(for: .video) : false
        default: return false
        }
    }
}

/// Drag anywhere to move; right-click for size and corners.
private final class BubbleView: NSView {
    var onLayout: (() -> Void)?
    var menuProvider: (() -> NSMenu?)?
    override var mouseDownCanMoveWindow: Bool { true }
    override func layout() { super.layout(); onLayout?() }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .openHand) }
    override func menu(for event: NSEvent) -> NSMenu? { menuProvider?() }
}

/// Above normal windows (so it's over what's recorded), below the recording bar and pill; on every Space.
private final class BubblePanel: NSPanel {
    init() {
        super.init(contentRect: NSRect(x: 0, y: 0, width: 200, height: 200), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        level = NSWindow.Level(rawValue: NSWindow.Level.floating.rawValue + 1)
        isMovableByWindowBackground = true
        hidesOnDeactivate = false
        isReleasedWhenClosed = false
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
    }
    override var canBecomeKey: Bool { false }
}

/// v3.9: Camera only. Records the bubble's capture session (camera + the chosen microphone) with an
/// `AVCaptureMovieFileOutput` (it pauses natively), then rewraps the QuickTime file as MP4 (passthrough, quick) so the editor
/// and sharing get the same kind of file as a screen recording.
@MainActor
final class CameraRecorder: NSObject, RecordingEngine, AVCaptureFileOutputRecordingDelegate {
    private(set) var state: Recorder.State = .idle
    var onFailure: ((String) -> Void)?
    private let session: AVCaptureSession
    private let micID: String?
    private let output = AVCaptureMovieFileOutput()
    private var audioInput: AVCaptureDeviceInput?
    private let movURL: URL
    private let id = UUID().uuidString
    private var finished: CheckedContinuation<Void, Never>?
    private var failure: String?

    init(session: AVCaptureSession, micID: String?) {
        self.session = session
        self.micID = micID
        movURL = Recorder.recordingsDir.appendingPathComponent("\(id).mov")
        super.init()
    }

    var elapsed: TimeInterval { output.recordedDuration.seconds.isFinite ? output.recordedDuration.seconds : 0 }

    var micLevel: Float {
        guard micID != nil, let c = output.connection(with: .audio), let ch = c.audioChannels.first else { return 0 }
        return RecordingMath.meterLevel(peak: pow(10, ch.peakHoldLevel / 20))
    }

    func start() async throws {
        try FileManager.default.createDirectory(at: Recorder.recordingsDir, withIntermediateDirectories: true)
        try? FileManager.default.removeItem(at: movURL)
        session.beginConfiguration()
        if audioInput == nil, let micID, let dev = AVCaptureDevice(uniqueID: micID), let input = try? AVCaptureDeviceInput(device: dev),
           session.canAddInput(input) {
            session.addInput(input)
            audioInput = input
        }
        if !session.outputs.contains(output), session.canAddOutput(output) { session.addOutput(output) }
        session.commitConfiguration()
        if !session.isRunning { session.startRunning() }
        output.startRecording(to: movURL, recordingDelegate: self)
        state = .recording
        Log.write("record: camera started (mic \(micID != nil ? "on" : "off"))")
    }

    func pause() async {
        guard state == .recording else { return }
        output.pauseRecording()
        state = .paused
    }

    func resume() async throws {
        guard state == .paused else { return }
        output.resumeRecording()
        state = .recording
    }

    func stop() async throws -> RecordingResult {
        guard state != .idle else { throw RecorderError.nothingRecorded }
        state = .idle
        await finish()
        if let f = failure { throw RecorderError.mergeFailed(f) }
        let out = Recorder.recordingsDir.appendingPathComponent("\(id).mp4")
        try? FileManager.default.removeItem(at: out)
        let asset = AVURLAsset(url: movURL)
        guard let s = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetPassthrough) else { throw RecorderError.nothingRecorded }
        try await s.export(to: out, as: .mp4)
        try? FileManager.default.removeItem(at: movURL)
        let result = AVURLAsset(url: out)
        let dur = (try? await result.load(.duration)).map { CMTimeGetSeconds($0) } ?? 0
        let audio = (try? await result.loadTracks(withMediaType: .audio))?.isEmpty == false
        Log.write("record: camera stopped, \(String(format: "%.1f", dur)) s")
        return RecordingResult(url: out, duration: dur, hasAudio: audio)
    }

    func discard() async {
        if state != .idle {
            state = .idle
            await finish()
        }
        try? FileManager.default.removeItem(at: movURL)
        Log.write("record: camera discarded")
    }

    /// Stops the file output and waits for it to finish writing (a few seconds at most).
    private func finish() async {
        guard output.isRecording else { return }
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            finished = c
            output.stopRecording()
            DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak self] in
                guard let self, let c = self.finished else { return }
                self.finished = nil
                c.resume()
            }
        }
        if let a = audioInput { session.removeInput(a); audioInput = nil }
    }

    nonisolated func fileOutput(_ output: AVCaptureFileOutput, didFinishRecordingTo outputFileURL: URL, from connections: [AVCaptureConnection], error: Error?) {
        // "finished successfully" errors still carry a usable file
        let ok = (error as NSError?)?.userInfo[AVErrorRecordingSuccessfullyFinishedKey] as? Bool ?? (error == nil)
        let message = ok ? nil : error?.localizedDescription
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                if let message { self.failure = message }
                if let c = self.finished { self.finished = nil; c.resume() }
                else if let message, self.state != .idle { self.onFailure?(message) }
            }
        }
    }
}
