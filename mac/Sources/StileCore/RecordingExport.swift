import AVFoundation
import CoreImage
import Foundation

/// v3.6: exporting a trimmed recording. Passthrough (no re-encode, instant, lossless) when the cut starts on a keyframe, since
/// a passthrough export can only start cleanly there; otherwise a re-encode with a preset that keeps the source's codec and
/// size. Pure AVFoundation (no AppKit) so it is unit-tested against a generated clip.
public enum RecordingExport {
    public enum Mode: String, Sendable { case passthrough, reencoded }

    public struct Failure: LocalizedError {
        public let message: String
        public var errorDescription: String? { message }
    }

    /// Whether a passthrough export starting at `start` would begin on a keyframe (or at the very start).
    public static func startsOnKeyframe(asset: AVAsset, start: CMTime) async -> Bool {
        if CMTimeCompare(start, CMTime(seconds: 0.02, preferredTimescale: 600)) <= 0 { return true }
        guard let track = try? await asset.loadTracks(withMediaType: .video).first,
              let cursor = track.makeSampleCursor(presentationTimeStamp: start) else { return false }
        let off = abs(CMTimeGetSeconds(cursor.presentationTimeStamp) - CMTimeGetSeconds(start))
        return cursor.currentSampleSyncInfo.sampleIsFullSync.boolValue && off < 1.0 / 50
    }

    /// The re-encode preset: the source's codec and size (HEVC stays HEVC) rather than a smaller fixed one.
    static func reencodePreset(asset: AVAsset) async -> String {
        var hevc = false
        if let track = try? await asset.loadTracks(withMediaType: .video).first,
           let desc = try? await track.load(.formatDescriptions).first {
            hevc = CMFormatDescriptionGetMediaSubType(desc) == kCMVideoCodecType_HEVC
        }
        let wanted = hevc ? AVAssetExportPresetHEVCHighestQuality : AVAssetExportPresetHighestQuality
        let ok = await AVAssetExportSession.compatibility(ofExportPreset: wanted, with: asset, outputFileType: nil)
        if ok { return wanted }
        return AVAssetExportPresetHighestQuality
    }

    /// v3.6.2: writes the kept pieces of `asset` back to back (a section cut out of the middle). One piece is `export(range:)`.
    /// Several go through an `AVMutableComposition`: passthrough when every piece starts on a keyframe, else re-encoded.
    /// v3.7: `frames` draws annotations and blur boxes into every frame (always a re-encode); it gets edited-video time.
    @discardableResult
    public static func export(asset: AVAsset, pieces: [CMTimeRange], to url: URL, frames: AnnotationFrameRenderer? = nil,
                              progress: @escaping @Sendable (Double) -> Void = { _ in }) async throws -> Mode {
        guard pieces.count > 1 || frames != nil else {
            var r = pieces.first
            if r == nil { r = CMTimeRange(start: .zero, duration: try await asset.load(.duration)) }
            return try await export(asset: asset, range: r!, to: url, progress: progress)
        }
        let comp = AVMutableComposition()
        let videoTracks = try await asset.loadTracks(withMediaType: .video)
        let audioTracks = try await asset.loadTracks(withMediaType: .audio)
        var pairs: [(AVAssetTrack, AVMutableCompositionTrack)] = []
        for t in videoTracks + audioTracks {
            guard let c = comp.addMutableTrack(withMediaType: t.mediaType, preferredTrackID: kCMPersistentTrackID_Invalid) else { continue }
            if t.mediaType == .video, let tf = try? await t.load(.preferredTransform) { c.preferredTransform = tf }
            pairs.append((t, c))
        }
        var cursor = CMTime.zero
        for r in pieces {
            for (t, c) in pairs { try c.insertTimeRange(r, of: t, at: cursor) }
            cursor = CMTimeAdd(cursor, r.duration)
        }
        var videoComposition: AVVideoComposition?
        if let frames {
            videoComposition = try await AVMutableVideoComposition.videoComposition(with: comp) { req in
                let src = req.sourceImage
                let out = frames.apply(to: src.transformed(by: CGAffineTransform(translationX: -src.extent.minX, y: -src.extent.minY)), at: CMTimeGetSeconds(req.compositionTime))
                req.finish(with: out.cropped(to: CGRect(origin: .zero, size: src.extent.size)), context: nil)
            }
        }
        var aligned = videoComposition == nil
        if aligned { for r in pieces where !(await startsOnKeyframe(asset: asset, start: r.start)) { aligned = false; break } }
        let preset = aligned ? AVAssetExportPresetPassthrough : await reencodePreset(asset: asset)
        try await run(asset: comp, preset: preset, range: nil, videoComposition: videoComposition, to: url, progress: progress)
        return aligned ? .passthrough : .reencoded
    }

    /// v3.9: exports an edit. Without transitions that is the pieces export above (passthrough where it can); with any
    /// transition it is always re-encoded, through `EditComposition` (the same build the editor previews).
    /// `frames` draws annotations and blur boxes on top, given edited-video time.
    @discardableResult
    public static func export(asset: AVAsset, edit: EditModel, to url: URL, frames: AnnotationFrameRenderer? = nil,
                              progress: @escaping @Sendable (Double) -> Void = { _ in }) async throws -> Mode {
        guard edit.hasTransitions else {
            let pieces = edit.pieces.map { CMTimeRange(start: CMTime(seconds: $0.lowerBound, preferredTimescale: 600), end: CMTime(seconds: $0.upperBound, preferredTimescale: 600)) }
            return try await export(asset: asset, pieces: pieces, to: url, frames: frames, progress: progress)
        }
        let built = try await EditComposition.build(asset: asset, edit: edit, frames: frames)
        try await run(asset: built.composition, preset: await reencodePreset(asset: asset), range: nil, videoComposition: built.videoComposition,
                      audioMix: built.audioMix, to: url, progress: progress)
        return .reencoded
    }

    /// Writes `range` of `asset` to `url` (an .mp4; replaced if present). `progress` gets 0...1. Cancelling the calling task
    /// cancels the export and removes the partial file.
    @discardableResult
    public static func export(asset: AVAsset, range: CMTimeRange, to url: URL, forcePreset: String? = nil,
                              progress: @escaping @Sendable (Double) -> Void = { _ in }) async throws -> Mode {
        try? FileManager.default.removeItem(at: url)
        let aligned = forcePreset == nil ? await startsOnKeyframe(asset: asset, start: range.start) : false
        var preset = forcePreset ?? AVAssetExportPresetPassthrough
        if forcePreset == nil && !aligned { preset = await reencodePreset(asset: asset) }
        try await run(asset: asset, preset: preset, range: range, to: url, progress: progress)
        return preset == AVAssetExportPresetPassthrough ? .passthrough : .reencoded
    }

    private static func run(asset: AVAsset, preset: String, range: CMTimeRange?, videoComposition: AVVideoComposition? = nil, audioMix: AVAudioMix? = nil, to url: URL,
                            progress: @escaping @Sendable (Double) -> Void) async throws {
        try? FileManager.default.removeItem(at: url)
        guard let session = AVAssetExportSession(asset: asset, presetName: preset) else {
            throw Failure(message: "This recording can’t be exported")
        }
        if let range { session.timeRange = range }
        if let videoComposition { session.videoComposition = videoComposition }
        if let audioMix { session.audioMix = audioMix }
        let watcher = Task {
            for await state in session.states(updateInterval: 0.1) {
                if case .exporting(let p) = state { progress(p.fractionCompleted) }
            }
        }
        defer { watcher.cancel() }
        do {
            try await session.export(to: url, as: .mp4)
        } catch {
            try? FileManager.default.removeItem(at: url)
            if Task.isCancelled || error is CancellationError { throw CancellationError() }
            throw error
        }
        progress(1)
    }
}
