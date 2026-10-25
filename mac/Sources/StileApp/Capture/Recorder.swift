import AppKit
import AVFoundation
import CoreMedia
import ScreenCaptureKit
import StileCore

/// What a recording captures. Rects are Quartz global points (top-left origin) like `Selection`; `chromeTab`'s page rect is
/// relative to the top-left of the Chrome window (what `SCStreamConfiguration.sourceRect` means for a window filter).
enum RecordTarget {
    case display(CGDirectDisplayID)
    case window(CGWindowID)
    case area(CGRect, CGDirectDisplayID)
    case chromeTab(window: CGWindowID, page: CGRect)
    /// v3.9: the camera alone (`CameraRecorder`; not this class)
    case camera
}

struct RecordingResult {
    let url: URL
    let duration: Double
    let hasAudio: Bool
}

enum RecorderError: Error, LocalizedError {
    case noTarget, nothingRecorded, mergeFailed(String)
    var errorDescription: String? {
        switch self {
        case .noTarget: return "the display or window to record is gone"
        case .nothingRecorded: return "nothing was recorded"
        case .mergeFailed(let m): return "joining the recording parts failed: \(m)"
        }
    }
}

/// v3.6: the recording engine. One `SCStream` with an `SCRecordingOutput` (macOS 15) writes an H.264 / HEVC MP4 straight
/// to `~/Library/Caches/Stile/recordings/`; the encoder and the AAC audio are SCK's own. This class knows nothing about
/// the UI (bar, pill, borders): `RecordingController` drives it.
///
/// **Pause.** `SCRecordingOutput` has no pause, and a stream that keeps running would keep recording. So pause *ends the
/// current segment* (the stream is stopped and its file finalised) and resume starts a new stream writing the next
/// segment file. On stop the segments are joined with an `AVMutableComposition` and a passthrough `AVAssetExportSession`
/// (no re-encode, takes a moment for long recordings; a single segment is just moved into place). If the passthrough
/// export fails (segments of different sizes, e.g. the window was resized during a pause) it retries with a re-encoding preset.
/// The same segment cut is used to retarget a Chrome tab recording to another window.
///
/// **Audio.** `capturesAudio` is the system audio (our own process's excluded). The microphone is
/// `captureMicrophone` + `microphoneCaptureDeviceID` on the stream; a second stream output on `.microphone` feeds the
/// live level meter only (the recording output does the writing). With a *window* filter (Window, Chrome tab), SCK captures
/// the audio of the window's application, so a Chrome tab recording hears all of Chrome (other tabs too), not other apps.
///
/// **Stile in the picture (v3.6.1).** Display and area recordings keep Stile's panels over Chrome (sidebar, header). A
/// window recording of a Chrome window with panels over it can't use a single-window filter (that has Chrome alone, its
/// tab rail showing where the sidebar is), so it records the window *and* its panels from their display, with `sourceRect`
/// on the window. A 5 Hz check follows the window's frame and the panels shown; moving to another display starts a segment.
@MainActor
final class Recorder {
    struct Options {
        var micID: String?
        var systemAudio: Bool
        var fps: Int
        var hevc: Bool
        var maxLongSide: Double?
        var showCursor: Bool
    }

    enum State { case idle, recording, paused }

    private(set) var state: State = .idle
    private(set) var target: RecordTarget
    let options: Options
    /// The stream died on its own (display unplugged, window closed...): the controller stops and keeps what exists.
    var onFailure: ((String) -> Void)?

    private let id = UUID().uuidString
    private let dir: URL
    private var segments: [URL] = []
    private var segmentIndex = 0
    private var stream: SCStream?
    private var config: SCStreamConfiguration?
    private var delegate: SegmentDelegate?
    private var accumulated: TimeInterval = 0
    private var segmentStart: Date?
    private var fixedSize: (width: Int, height: Int)?   // pixel size of the first segment, kept for tab sourceRect updates
    private var micLive = false
    /// A window recording composited with Stile's panels (see above): what the follow timer compares against.
    private var composite: (window: CGWindowID, display: CGDirectDisplayID, frame: CGRect, panels: Set<CGWindowID>)?
    private var followTimer: Timer?
    private var refiltering = false
    /// v3.9: a tab recording composited from its display (the camera bubble over it): the display, for `updateTabPage`.
    private var tabDisplay: CGDirectDisplayID?

    init(target: RecordTarget, options: Options) {
        self.target = target
        self.options = options
        dir = Self.recordingsDir
    }

    static var recordingsDir: URL {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Caches")
        return base.appendingPathComponent("Stile/recordings", isDirectory: true)
    }

    var elapsed: TimeInterval {
        accumulated + (segmentStart.map { Date().timeIntervalSince($0) } ?? 0)
    }

    /// 0...1, the newest microphone peak (0 without a mic).
    var micLevel: Float { micLive ? (delegate?.level ?? 0) : 0 }

    // MARK: Control

    func start() async throws {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try await startSegment()
        state = .recording
        Log.write("record: started (\(describe(target)), mic \(options.micID != nil ? "on" : "off"), system audio \(options.systemAudio ? "on" : "off"), \(options.fps) fps, \(options.hevc ? "HEVC" : "H.264"))")
    }

    func pause() async {
        guard state == .recording else { return }
        state = .paused
        await stopSegment()
        Log.write("record: paused after \(Int(accumulated)) s")
    }

    func resume() async throws {
        guard state == .paused else { return }
        try await startSegment()
        state = .recording
        Log.write("record: resumed")
    }

    /// Ends the current segment and starts the next on a new target (a Chrome tab moved to another window). Paused: only
    /// remembers the target, so resume uses it.
    func retarget(_ new: RecordTarget) async throws {
        target = new
        fixedSize = nil
        guard state == .recording else { return }
        await stopSegment()
        try await startSegment()
        Log.write("record: retargeted (\(describe(new)))")
    }

    /// A tab recording's page area changed (window resized, bookmarks bar toggled). The output size stays the first
    /// segment's, so a changed aspect ratio is scaled to fit; a retarget starts a segment at the new size.
    func updateTabPage(_ page: CGRect) {
        guard case .chromeTab(let w, _) = target else { return }
        target = .chromeTab(window: w, page: page)
        guard state == .recording, let s = stream, let cfg = config else { return }
        if let did = tabDisplay {
            guard let wf = ScreenGeometry.frame(ofWindow: w), let local = ScreenGeometry.local(page.offsetBy(dx: wf.minX, dy: wf.minY), on: did) else { return }
            cfg.sourceRect = local
        } else {
            cfg.sourceRect = page
        }
        Task { try? await s.updateConfiguration(cfg) }
    }

    /// Stops and joins the segments into the final file.
    func stop() async throws -> RecordingResult {
        let wasRunning = state == .recording
        state = .idle
        if wasRunning { await stopSegment() }
        let duration = accumulated
        let files = segments.filter { FileManager.default.fileExists(atPath: $0.path) }
        segments = []
        guard !files.isEmpty else { throw RecorderError.nothingRecorded }
        let out = dir.appendingPathComponent("\(id).mp4")
        try await Self.join(files, to: out)
        let asset = AVURLAsset(url: out)
        let audio = (try? await asset.loadTracks(withMediaType: .audio))?.isEmpty == false
        // the container's duration is the truth (the stopwatch counts the stream start-up too)
        let real = (try? await asset.load(.duration)).map { CMTimeGetSeconds($0) } ?? duration
        Log.write("record: stopped, \(String(format: "%.1f", real)) s, \(files.count) segment(s), audio \(audio ? "yes" : "no") -> \(out.lastPathComponent)")
        return RecordingResult(url: out, duration: real.isFinite && real > 0 ? real : duration, hasAudio: audio)
    }

    /// Stops and deletes everything (Discard, and Restart before starting again).
    func discard() async {
        let wasRunning = state == .recording
        state = .idle
        if wasRunning { await stopSegment() }
        for u in segments { try? FileManager.default.removeItem(at: u) }
        segments = []
        accumulated = 0
        segmentStart = nil
        Log.write("record: discarded")
    }

    // MARK: Segments

    private func startSegment() async throws {
        let content = try await Screenshotter.shareableContent(onScreenOnly: false)
        let (filter, cfg) = try build(content)
        if fixedSize == nil { fixedSize = (cfg.width, cfg.height) }
        let url = dir.appendingPathComponent("\(id)-part\(segmentIndex).mp4")
        segmentIndex += 1
        try? FileManager.default.removeItem(at: url)

        let d = SegmentDelegate()
        d.onStop = { [weak self] error in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.streamDied(error) } }
        }
        let s = SCStream(filter: filter, configuration: cfg, delegate: d)
        micLive = options.micID != nil
        if micLive { try s.addStreamOutput(d, type: .microphone, sampleHandlerQueue: d.queue) }
        let rc = SCRecordingOutputConfiguration()
        rc.outputURL = url
        rc.videoCodecType = options.hevc ? .hevc : .h264
        rc.outputFileType = .mp4
        let ro = SCRecordingOutput(configuration: rc, delegate: d)
        try s.addRecordingOutput(ro)
        try await s.startCapture()
        stream = s
        config = cfg
        delegate = d
        segments.append(url)
        segmentStart = Date()
        if composite != nil { startFollowing() }
    }

    /// Stops the stream and waits (a few seconds at most) until SCK has finalised the segment file.
    private func stopSegment() async {
        if let st = segmentStart { accumulated += Date().timeIntervalSince(st) }
        segmentStart = nil
        followTimer?.invalidate()
        followTimer = nil
        guard let s = stream, let d = delegate else { return }
        stream = nil
        config = nil
        delegate = nil
        try? await s.stopCapture()
        await d.waitForFinish(timeout: 6)
    }

    private func streamDied(_ error: Error) {
        guard state == .recording else { return }
        Log.write("record: stream stopped by the system: \(error.localizedDescription)")
        onFailure?(error.localizedDescription)
    }

    // MARK: Filter and configuration

    private func build(_ content: SCShareableContent) throws -> (SCContentFilter, SCStreamConfiguration) {
        let cfg = SCStreamConfiguration()
        let filter: SCContentFilter
        var pointSize: CGSize
        composite = nil
        tabDisplay = nil
        switch target {
        case .camera:
            throw RecorderError.noTarget
        case .display(let did):
            guard let d = Screenshotter.display(did, in: content) else { throw RecorderError.noTarget }
            filter = Screenshotter.displayFilter(d, content: content)
            pointSize = filter.contentRect.size
        case .area(let rect, let did):
            guard let d = Screenshotter.display(did, in: content) else { throw RecorderError.noTarget }
            filter = Screenshotter.displayFilter(d, content: content)
            guard let local = ScreenGeometry.local(rect, on: did) else { throw RecorderError.noTarget }
            cfg.sourceRect = local
            pointSize = local.size
        case .window(let wid):
            guard let w = content.windows.first(where: { $0.windowID == wid }) else { throw RecorderError.noTarget }
            if let c = Screenshotter.windowWithOverlay(w, content: content), let wf = ScreenGeometry.frame(ofWindow: wid) {
                filter = c.filter
                cfg.sourceRect = c.rect
                pointSize = c.rect.size
                composite = (wid, c.displayID, wf, Screenshotter.shownIDs(over: wid))
            } else {
                filter = SCContentFilter(desktopIndependentWindow: w)
                pointSize = filter.contentRect.size
            }
        case .chromeTab(let wid, let page):
            guard let w = content.windows.first(where: { $0.windowID == wid }) else { throw RecorderError.noTarget }
            let extras = content.windows.filter { Set(Screenshotter.extraCaptureWindows()).contains($0.windowID) }
            if !extras.isEmpty, let wf = ScreenGeometry.frame(ofWindow: wid), let did = ScreenGeometry.displayID(containing: wf),
               let d = Screenshotter.display(did, in: content), let local = ScreenGeometry.local(page.offsetBy(dx: wf.minX, dy: wf.minY), on: did) {
                // the camera bubble over the page: the page area of the display, with just Chrome and the bubble in it
                filter = SCContentFilter(display: d, including: [w] + extras)
                cfg.sourceRect = local
                tabDisplay = did
            } else {
                filter = SCContentFilter(desktopIndependentWindow: w)
                cfg.sourceRect = page
            }
            pointSize = page.size
        }
        let scale = CGFloat(filter.pointPixelScale)
        let size = fixedSize ?? RecordingMath.outputSize(width: pointSize.width * scale, height: pointSize.height * scale,
                                                         maxLongSide: options.maxLongSide)
        cfg.width = size.width
        cfg.height = size.height
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(options.fps))
        cfg.showsCursor = options.showCursor
        cfg.queueDepth = 6
        cfg.capturesAudio = options.systemAudio
        cfg.excludesCurrentProcessAudio = true
        if let mic = options.micID {
            cfg.captureMicrophone = true
            cfg.microphoneCaptureDeviceID = mic
        }
        return (filter, cfg)
    }

    // MARK: Following a composited window

    private func startFollowing() {
        followTimer?.invalidate()
        followTimer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.followTick() }
        }
    }

    /// The window moved or resized: move `sourceRect` (the output keeps its size; SCK scales into it). Another display:
    /// a new segment there. The panels shown changed (the sidebar was hidden, the header appeared): a new filter.
    private func followTick() {
        guard state == .recording, let c = composite, let s = stream, let cfg = config, !refiltering else { return }
        guard let wf = ScreenGeometry.frame(ofWindow: c.window) else { return }   // minimised: nothing to follow
        if let did = ScreenGeometry.displayID(containing: wf), did != c.display {
            refiltering = true
            Task {
                await stopSegment()
                do { try await startSegment() } catch {
                    Log.write("record: couldn't follow the window to another display: \(error.localizedDescription)")
                    onFailure?("the window moved to a display that can't be recorded")
                }
                refiltering = false
                Log.write("record: window moved to display \(did), new segment")
            }
            return
        }
        if wf != c.frame, let local = ScreenGeometry.local(wf, on: c.display) {
            composite?.frame = wf
            cfg.sourceRect = local
            Task { try? await s.updateConfiguration(cfg) }
        }
        let panels = Screenshotter.shownIDs(over: c.window)
        guard panels != c.panels else { return }
        refiltering = true
        Task {
            defer { refiltering = false }
            guard let content = try? await Screenshotter.shareableContent(onScreenOnly: false),
                  let w = content.windows.first(where: { $0.windowID == c.window }), let d = Screenshotter.display(c.display, in: content),
                  stream === s else { return }
            let found = Screenshotter.overlayWindows(in: content, over: c.window)
            try? await s.updateContentFilter(SCContentFilter(display: d, including: [w] + found))
            composite?.panels = panels   // what was asked for, so a panel SCK doesn't list yet isn't retried every tick
        }
    }

    private func describe(_ t: RecordTarget) -> String {
        switch t {
        case .display(let d): return "display \(d)"
        case .window(let w): return "window \(w)"
        case .area(let r, _): return "area \(Int(r.width))x\(Int(r.height))"
        case .chromeTab(let w, let p): return "chrome tab in window \(w), page \(Int(p.width))x\(Int(p.height))"
        case .camera: return "camera"
        }
    }

    // MARK: Joining segments

    nonisolated static func join(_ files: [URL], to out: URL) async throws {
        try? FileManager.default.removeItem(at: out)
        if files.count == 1 {
            try FileManager.default.moveItem(at: files[0], to: out)
            return
        }
        let comp = AVMutableComposition()
        var video: AVMutableCompositionTrack?
        var audio: [AVMutableCompositionTrack] = []
        var cursor = CMTime.zero
        for f in files {
            let asset = AVURLAsset(url: f)
            let dur = try await asset.load(.duration)
            if let t = try await asset.loadTracks(withMediaType: .video).first {
                if video == nil { video = comp.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) }
                try video?.insertTimeRange(CMTimeRange(start: .zero, duration: dur), of: t, at: cursor)
            }
            // mic and system audio are separate tracks: keep each on its own composition track
            for (i, t) in try await asset.loadTracks(withMediaType: .audio).enumerated() {
                while audio.count <= i {
                    guard let n = comp.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else { break }
                    audio.append(n)
                }
                guard i < audio.count else { break }
                try audio[i].insertTimeRange(CMTimeRange(start: .zero, duration: dur), of: t, at: cursor)
            }
            cursor = CMTimeAdd(cursor, dur)
        }
        func export(_ preset: String) async throws {
            try? FileManager.default.removeItem(at: out)
            guard let session = AVAssetExportSession(asset: comp, presetName: preset) else {
                throw RecorderError.mergeFailed("no export session for \(preset)")
            }
            try await session.export(to: out, as: .mp4)
        }
        do {
            try await export(AVAssetExportPresetPassthrough)
        } catch {
            Log.write("record: passthrough join failed (\(error.localizedDescription)); re-encoding")
            do { try await export(AVAssetExportPresetHighestQuality) } catch { throw RecorderError.mergeFailed(error.localizedDescription) }
        }
        for f in files { try? FileManager.default.removeItem(at: f) }
    }
}

// MARK: - Stream / recording-output delegate (background queue)

/// One per segment. Receives the stream's stop, the recording output's lifecycle and the microphone buffers (level only).
private final class SegmentDelegate: NSObject, SCStreamDelegate, SCStreamOutput, SCRecordingOutputDelegate, @unchecked Sendable {
    let queue = DispatchQueue(label: "stile.recorder.mic", qos: .userInitiated)
    var onStop: ((Error) -> Void)?

    private let lock = NSLock()
    private var peak: Float = 0
    private var finished = false
    private var waiter: CheckedContinuation<Void, Never>?

    /// Smoothed meter level 0...1 (decays between buffers).
    var level: Float {
        lock.lock(); defer { lock.unlock() }
        let l = RecordingMath.meterLevel(peak: peak)
        peak *= 0.6
        return l
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) { onStop?(error) }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .microphone, sampleBuffer.isValid else { return }
        var p: Float = 0
        let isFloat = (sampleBuffer.formatDescription?.audioStreamBasicDescription?.mFormatFlags ?? 0) & kAudioFormatFlagIsFloat != 0
        try? sampleBuffer.withAudioBufferList { list, _ in
            for buf in list {
                guard let data = buf.mData else { continue }
                if isFloat {
                    let n = Int(buf.mDataByteSize) / MemoryLayout<Float>.size
                    let f = data.bindMemory(to: Float.self, capacity: n)
                    for i in 0..<n { p = max(p, abs(f[i])) }
                } else {
                    let n = Int(buf.mDataByteSize) / MemoryLayout<Int16>.size
                    let s = data.bindMemory(to: Int16.self, capacity: n)
                    for i in 0..<n { p = max(p, abs(Float(s[i])) / 32768) }
                }
            }
        }
        lock.lock(); peak = max(peak * 0.5, p); lock.unlock()
    }

    // SCRecordingOutputDelegate
    func recordingOutputDidFinishRecording(_ recordingOutput: SCRecordingOutput) { signalFinished() }
    func recordingOutput(_ recordingOutput: SCRecordingOutput, didFailWithError error: Error) {
        Log.write("record: recording output failed: \(error.localizedDescription)")
        signalFinished()
    }

    private func signalFinished() {
        lock.lock()
        finished = true
        let w = waiter
        waiter = nil
        lock.unlock()
        w?.resume()
    }

    func waitForFinish(timeout: TimeInterval) async {
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            lock.lock()
            if finished { lock.unlock(); c.resume(); return }
            waiter = c
            lock.unlock()
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { [weak self] in
                if self?.finished == false { Log.write("record: segment finalise timed out") }
                self?.signalFinished()
            }
        }
    }
}
