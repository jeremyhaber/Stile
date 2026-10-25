import AVFoundation
import CoreImage
import Foundation

/// v3.9: an edit with transitions as an `AVMutableComposition`, one build shared by the editor's preview and the export
/// (so what you see is what is written). Clips alternate between two video tracks (A / B) and two audio tracks, so
/// neighbouring clips can overlap; `EditCompositionInstruction`s say which layers show with which opacity in each stretch
/// (from `EditModel.transitionSegments`), `EditCompositor` blends them and draws the annotations on top, and an
/// `AVMutableAudioMix` ramps the sound. Times are the edited video's (sequence) time.
public struct EditComposition {
    public let composition: AVMutableComposition
    public let videoComposition: AVMutableVideoComposition
    public let audioMix: AVMutableAudioMix?

    public var duration: Double { composition.duration.seconds }

    /// `frames` (optional) draws annotations or the editor's blur preview onto every frame, given the edited video's time.
    public static func build(asset: AVAsset, edit: EditModel, frames: AnnotationFrameRenderer? = nil) async throws -> EditComposition {
        guard let video = try await asset.loadTracks(withMediaType: .video).first else {
            throw RecordingExport.Failure(message: "This recording has no video")
        }
        let audio = try await asset.loadTracks(withMediaType: .audio).first
        let comp = AVMutableComposition()
        func tracks(_ source: AVAssetTrack?) -> [AVMutableCompositionTrack] {
            guard let source else { return [] }
            return (0..<2).compactMap { _ in comp.addMutableTrack(withMediaType: source.mediaType, preferredTrackID: kCMPersistentTrackID_Invalid) }
        }
        let vTracks = tracks(video), aTracks = tracks(audio)
        guard vTracks.count == 2 else { throw RecordingExport.Failure(message: "This recording can’t be exported") }
        func time(_ s: Double) -> CMTime { CMTime(seconds: s, preferredTimescale: 600) }

        for (i, c) in edit.clips.enumerated() {
            let range = CMTimeRange(start: time(c.start), end: time(c.end))
            let at = time(edit.sequenceStart(of: i))
            try vTracks[i % 2].insertTimeRange(range, of: video, at: at)
            if let audio, aTracks.count == 2 { try aTracks[i % 2].insertTimeRange(range, of: audio, at: at) }
        }

        // instructions: contiguous, rounded once so they meet exactly, the last one ending with the composition
        let segments = edit.transitionSegments
        var instructions: [AVVideoCompositionInstructionProtocol] = []
        var bounds = segments.map { time($0.start) }
        bounds.append(comp.duration)
        for (k, seg) in segments.enumerated() {
            let r = CMTimeRange(start: k == 0 ? .zero : bounds[k], end: bounds[k + 1])
            guard r.duration > .zero else { continue }
            instructions.append(EditCompositionInstruction(
                timeRange: r, layers: seg.layers.map { .init(trackID: vTracks[$0.clip % 2].trackID, from: $0.from, to: $0.to) },
                background: seg.background, frames: frames))
        }
        if instructions.isEmpty {   // no transitions: one pass-through-the-compositor instruction (annotations only)
            instructions = [EditCompositionInstruction(timeRange: CMTimeRange(start: .zero, duration: comp.duration), layers: [.init(trackID: vTracks[0].trackID, from: 1, to: 1)],
                                                       background: .black, frames: frames)]
        }

        let size = (try? await video.load(.naturalSize)) ?? CGSize(width: 1280, height: 720)
        let fps = (try? await video.load(.nominalFrameRate)) ?? 0
        let vc = AVMutableVideoComposition()
        vc.customVideoCompositorClass = EditCompositor.self
        vc.renderSize = size
        vc.frameDuration = CMTime(value: 1, timescale: Int32(fps > 1 ? min(120, fps.rounded()) : 30))
        vc.instructions = instructions

        var mix: AVMutableAudioMix?
        if aTracks.count == 2 {
            let m = AVMutableAudioMix()
            let params: [AVMutableAudioMixInputParameters] = aTracks.map { AVMutableAudioMixInputParameters(track: $0) }
            let ramps = edit.volumeRamps
            for (i, _) in edit.clips.enumerated() {
                let p = params[i % 2]
                let mine = ramps.filter { $0.clip == i }
                if !mine.contains(where: { $0.from == 0 && $0.to == 1 }) { p.setVolume(1, at: time(edit.sequenceStart(of: i))) }
                for r in mine {
                    p.setVolumeRamp(fromStartVolume: Float(r.from), toEndVolume: Float(r.to), timeRange: CMTimeRange(start: time(r.start), end: time(r.end)))
                }
            }
            m.inputParameters = params
            mix = m
        }
        return EditComposition(composition: comp, videoComposition: vc, audioMix: mix)
    }
}

/// One stretch of the edited video: which tracks show (bottom to top) with what opacity ramp, over what.
final class EditCompositionInstruction: NSObject, AVVideoCompositionInstructionProtocol {
    struct Layer: Equatable { var trackID: CMPersistentTrackID; var from: Double; var to: Double }

    let timeRange: CMTimeRange
    let layers: [Layer]
    let background: CutTransition.Background
    let frames: AnnotationFrameRenderer?

    var enablePostProcessing: Bool { false }
    var containsTweening: Bool { layers.contains { $0.from != $0.to } }
    var requiredSourceTrackIDs: [NSValue]? { layers.map { NSNumber(value: $0.trackID) } }
    var passthroughTrackID: CMPersistentTrackID { kCMPersistentTrackID_Invalid }

    init(timeRange: CMTimeRange, layers: [Layer], background: CutTransition.Background, frames: AnnotationFrameRenderer?) {
        self.timeRange = timeRange; self.layers = layers; self.background = background; self.frames = frames
    }

    /// 0...1 across the instruction at composition time `t`.
    func progress(at t: Double) -> Double {
        let d = timeRange.duration.seconds
        return d > 0 ? min(1, max(0, (t - timeRange.start.seconds) / d)) : 1
    }
}

/// Blends an instruction's layers (opacity ramps over black or white) and draws the annotations on top.
final class EditCompositor: NSObject, AVVideoCompositing, @unchecked Sendable {
    private static let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
    private static let ciContext = CIContext(options: [.workingColorSpace: NSNull(), .outputColorSpace: NSNull()])
    private let queue = DispatchQueue(label: "stile.edit-compositor", qos: .userInitiated)

    var sourcePixelBufferAttributes: [String: any Sendable]? { [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA] }
    var requiredPixelBufferAttributesForRenderContext: [String: any Sendable] { [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA] }

    func renderContextChanged(_ newRenderContext: AVVideoCompositionRenderContext) {}
    func cancelAllPendingVideoCompositionRequests() {}

    func startRequest(_ request: AVAsynchronousVideoCompositionRequest) {
        queue.async {
            guard let inst = request.videoCompositionInstruction as? EditCompositionInstruction,
                  let out = request.renderContext.newPixelBuffer() else {
                return request.finish(with: RecordingExport.Failure(message: "Couldn’t compose a frame"))
            }
            let size = request.renderContext.size
            let rect = CGRect(origin: .zero, size: size)
            let t = request.compositionTime.seconds
            let p = inst.progress(at: t)
            var image = CIImage(color: inst.background == .white ? .white : .black).cropped(to: rect)
            for layer in inst.layers {
                guard let pb = request.sourceFrame(byTrackID: layer.trackID) else { continue }
                var img = CIImage(cvPixelBuffer: pb, options: [.colorSpace: Self.colorSpace])
                let a = layer.from + (layer.to - layer.from) * p
                if a < 0.999 {
                    img = img.applyingFilter("CIColorMatrix", parameters: ["inputAVector": CIVector(x: 0, y: 0, z: 0, w: CGFloat(max(0, a)))])
                }
                image = img.composited(over: image)
            }
            if let frames = inst.frames { image = frames.apply(to: image.cropped(to: rect), at: t).cropped(to: rect) }
            Self.ciContext.render(image, to: out, bounds: rect, colorSpace: Self.colorSpace)
            request.finish(withComposedVideoFrame: out)
        }
    }
}
