import AVFoundation
import XCTest
@testable import StileCore

/// Transitions between clips: the timing model (overlaps, clamps, per-seam overrides), the plan, and the composition built from it.
final class CutTransitionTests: XCTestCase {
    /// 30 s recording in three 10 s clips.
    func threeClips(_ style: CutTransition.Style, _ speed: CutTransition.Speed = .normal) -> EditModel {
        var m = EditModel(duration: 30)
        m.split(atSequence: 10); m.split(atSequence: 20)
        m.transitionStyle = style
        m.transitionSpeed = speed
        return m
    }

    // MARK: timing

    func testNoneChangesNothing() {
        let m = threeClips(.none)
        XCTAssertEqual(m.length, 30)
        XCTAssertFalse(m.hasTransitions)
        XCTAssertFalse(m.isModified)
        XCTAssertEqual(m.key, "full")
        XCTAssertTrue(m.transitionSegments.isEmpty)
        XCTAssertEqual(m.sequenceStart(of: 2), 20)
    }

    func testCrossfadeOverlapsAndShortensTheEdit() {
        let m = threeClips(.crossfade)
        XCTAssertTrue(m.hasTransitions)
        XCTAssertEqual(m.length, 29, accuracy: 1e-9)                 // two seams of 0.5 s
        XCTAssertEqual(m.sequenceStart(of: 1), 9.5, accuracy: 1e-9)
        XCTAssertEqual(m.sequenceStart(of: 2), 19, accuracy: 1e-9)
        XCTAssertEqual(m.sequenceStart(of: 3), 29, accuracy: 1e-9)
        // in the overlap the incoming clip is the one at that time
        XCTAssertEqual(m.clipIndex(atSequence: 9.4), 0)
        XCTAssertEqual(m.clipIndex(atSequence: 9.6), 1)
        XCTAssertEqual(m.clipIndex(atSequence: 29), 2)
        XCTAssertEqual(m.clipIndex(atSequence: 100), 2)
        XCTAssertEqual(m.source(atSequence: 9.75), 10.25, accuracy: 1e-9)
        XCTAssertEqual(m.source(atSequence: 25), 26, accuracy: 1e-9)
        XCTAssertEqual(m.sequence(ofSource: 26), 25, accuracy: 1e-9)
        // an annotation anchored on the seam frame moves with the clip that starts there
        XCTAssertEqual(m.sequence(ofAnchor: 10), 9.5, accuracy: 1e-9)
        let an = VideoAnnotation(id: 1, kind: .rect, a: .zero, b: CGPoint(x: 1, y: 1), color: 0, size: 1, start: 20, length: 100)
        let r = an.resolved(in: m)
        XCTAssertEqual(r.start, 19, accuracy: 1e-9)
        XCTAssertEqual(r.length, 10, accuracy: 1e-9)                 // cut short at the end of the edit
        XCTAssertEqual(m.sequenceRanges(ofSource: 5...25).count, 3)
        XCTAssertEqual(m.sequenceRanges(ofSource: 12...15).first!.lowerBound, 11.5, accuracy: 1e-9)
    }

    func testShortSpeedAndDipsKeepTheLength() {
        XCTAssertEqual(threeClips(.crossfade, .short).length, 29.4, accuracy: 1e-9)
        for s in [CutTransition.Style.dipBlack, .dipWhite] {
            let m = threeClips(s)
            XCTAssertEqual(m.length, 30, accuracy: 1e-9)
            XCTAssertEqual(m.sequenceStart(of: 1), 10, accuracy: 1e-9)
            XCTAssertEqual(m.transitionDuration(ofSeam: 1), 0.5)
            XCTAssertTrue(m.hasTransitions)
            XCTAssertNotEqual(m.key, "full")
        }
    }

    func testDurationClampsToFortyPercentOfTheShorterClip() {
        var m = EditModel(duration: 10)
        m.split(atSequence: 0.5)                                       // clips 0.5 s and 9.5 s
        m.transitionStyle = .crossfade
        XCTAssertEqual(m.transitionDuration(ofSeam: 1), 0.2, accuracy: 1e-9)
        XCTAssertEqual(m.length, 9.8, accuracy: 1e-9)
        m.split(atSequence: 5)
        // the middle clip has a seam at both ends: 40 % each side never overlaps itself
        XCTAssertLessThanOrEqual(m.overlap(ofSeam: 1) + m.overlap(ofSeam: 2), 0.8 * m.clips[1].length + 1e-9)
        // out-of-range seams have none
        XCTAssertEqual(m.transitionDuration(ofSeam: 0), 0)
        XCTAssertEqual(m.transitionDuration(ofSeam: 9), 0)
    }

    func testPerSeamOverrides() {
        var m = threeClips(.crossfade)
        m.setSeamStyle(1, .none)
        XCTAssertEqual(m.seamStyle(1), .none)
        XCTAssertEqual(m.seamStyle(2), .crossfade)
        XCTAssertTrue(m.hasSeamOverride(1))
        XCTAssertEqual(m.length, 29.5, accuracy: 1e-9)
        m.setSeamStyle(1, .dipWhite)
        XCTAssertEqual(m.length, 29.5, accuracy: 1e-9)                // a dip doesn't overlap
        m.clearSeamStyle(1)
        XCTAssertFalse(m.hasSeamOverride(1))
        XCTAssertEqual(m.length, 29, accuracy: 1e-9)
        // a seam of its own over an otherwise plain edit
        var p = threeClips(.none)
        p.setSeamStyle(2, .dipBlack)
        XCTAssertTrue(p.hasTransitions)
        XCTAssertEqual(p.transitionDuration(ofSeam: 1), 0)
        XCTAssertEqual(p.transitionDuration(ofSeam: 2), 0.5)
    }

    func testOverridesFollowTheirSeamThroughEdits() {
        var m = threeClips(.crossfade)
        m.setSeamStyle(2, .dipBlack)
        m.split(atSequence: 5)                                         // a new seam at 5 s; the old seam is now seam 3
        XCTAssertEqual(m.seamStyle(3), .dipBlack)
        XCTAssertEqual(m.seamStyle(1), .crossfade)
        // deleting a clip merges its two seams into a new one, which starts from the default
        XCTAssertTrue(m.deleteClip(2))
        XCTAssertEqual(m.clips.count, 3)
        XCTAssertFalse((1..<m.clips.count).contains { m.hasSeamOverride($0) })
        // reset forgets them
        var r = threeClips(.crossfade)
        r.setSeamStyle(1, .none)
        r.reset()
        XCTAssertEqual(r.clips.count, 1)
        r.split(atSequence: 10)
        XCTAssertFalse(r.hasSeamOverride(1))
        // model equality sees the style change (it is one undo step)
        XCTAssertNotEqual(threeClips(.crossfade), threeClips(.none))
        XCTAssertNotEqual(threeClips(.crossfade), threeClips(.crossfade, .short))
    }

    func testSeamBetweenContiguousFootageStillCounts() {
        var m = EditModel(duration: 20)
        m.split(atSequence: 10)
        XCTAssertFalse(m.isEdited)
        m.transitionStyle = .crossfade
        XCTAssertTrue(m.hasTransitions)
        XCTAssertTrue(m.isModified)
        XCTAssertEqual(m.length, 19.5, accuracy: 1e-9)
        XCTAssertEqual(m.pieces, [0...20])                             // the merged pieces are for the plain export only
    }

    // MARK: the plan

    func assertContiguous(_ segs: [CutTransition.Segment], length: Double, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(segs.first?.start ?? -1, 0, accuracy: 1e-9, file: file, line: line)
        XCTAssertEqual(segs.last?.end ?? -1, length, accuracy: 1e-9, file: file, line: line)
        for (a, b) in zip(segs, segs.dropFirst()) { XCTAssertEqual(a.end, b.start, accuracy: 1e-9, file: file, line: line) }
    }

    func testCrossfadePlan() {
        let m = threeClips(.crossfade)
        let segs = m.transitionSegments
        assertContiguous(segs, length: m.length)
        // solo 0, fade 0>1, solo 1, fade 1>2, solo 2
        XCTAssertEqual(segs.count, 5)
        XCTAssertEqual(segs[0].start, 0); XCTAssertEqual(segs[0].end, 9.5, accuracy: 1e-9)
        XCTAssertEqual(segs[1].layers, [.init(clip: 0, from: 1, to: 1), .init(clip: 1, from: 0, to: 1)])
        XCTAssertEqual(segs[1].start, 9.5, accuracy: 1e-9); XCTAssertEqual(segs[1].end, 10, accuracy: 1e-9)
        XCTAssertEqual(segs[2].layers, [.init(clip: 1, from: 1, to: 1)])
        XCTAssertEqual(segs[2].duration, 9, accuracy: 1e-9)
        XCTAssertEqual(segs[3].layers.last, .init(clip: 2, from: 0, to: 1))
        XCTAssertEqual(segs[4].layers, [.init(clip: 2, from: 1, to: 1)])
    }

    func testDipPlan() {
        let m = threeClips(.dipWhite, .short)
        let segs = m.transitionSegments
        assertContiguous(segs, length: 30)
        // solo 0, out 0, in 1, solo 1, out 1, in 2, solo 2
        XCTAssertEqual(segs.count, 7)
        XCTAssertEqual(segs[1].layers, [.init(clip: 0, from: 1, to: 0)])
        XCTAssertEqual(segs[1].start, 9.85, accuracy: 1e-9); XCTAssertEqual(segs[1].end, 10, accuracy: 1e-9)
        XCTAssertEqual(segs[1].background, .white)
        XCTAssertEqual(segs[2].layers, [.init(clip: 1, from: 0, to: 1)])
        XCTAssertEqual(segs[2].end, 10.15, accuracy: 1e-9)
    }

    func testMixedSeamsPlanStaysContiguous() {
        var m = threeClips(.crossfade)
        m.setSeamStyle(2, .dipBlack)
        assertContiguous(m.transitionSegments, length: m.length)
        m.setSeamStyle(1, .none)
        assertContiguous(m.transitionSegments, length: m.length)
        XCTAssertEqual(m.length, 30, accuracy: 1e-9)
    }

    func testVolumeRamps() {
        let m = threeClips(.crossfade)
        let r = m.volumeRamps
        XCTAssertEqual(r.count, 4)
        XCTAssertEqual(r.filter { $0.clip == 0 }, [.init(clip: 0, start: 9.5, end: 10, from: 1, to: 0)])
        XCTAssertEqual(r.filter { $0.clip == 1 }.map { [$0.from, $0.to] }, [[0, 1], [1, 0]])
        let d = threeClips(.dipBlack, .short).volumeRamps.filter { $0.clip == 1 }
        XCTAssertEqual(d.first!.start, 10, accuracy: 1e-9); XCTAssertEqual(d.first!.end, 10.15, accuracy: 1e-9)
        XCTAssertEqual(d.last!.start, 19.85, accuracy: 1e-9); XCTAssertEqual(d.last!.end, 20, accuracy: 1e-9)
    }

    // MARK: composition and export

    var dir: URL!
    var clip: URL!
    override func setUp() async throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("transition-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        clip = dir.appendingPathComponent("clip.mp4")
        try await RecordingExportTests.makeClip(at: clip, seconds: 3, audio: true)
    }
    override func tearDown() async throws { try? FileManager.default.removeItem(at: dir) }

    func edit3(_ style: CutTransition.Style, speed: CutTransition.Speed = .normal) -> EditModel {
        var m = EditModel(duration: 3)
        m.split(atSequence: 1.5)
        m.transitionStyle = style
        m.transitionSpeed = speed
        return m
    }

    func testBuilderInstructionsAndRamps() async throws {
        let m = edit3(.crossfade)                                      // 1.5 s clips, 0.5 s overlap: 2.5 s
        let built = try await EditComposition.build(asset: AVURLAsset(url: clip), edit: m)
        XCTAssertEqual(built.duration, 2.5, accuracy: 0.02)
        XCTAssertEqual(built.composition.tracks(withMediaType: .video).count, 2)
        XCTAssertEqual(built.composition.tracks(withMediaType: .audio).count, 2)
        let ins = built.videoComposition.instructions.compactMap { $0 as? EditCompositionInstruction }
        XCTAssertEqual(ins.count, 3)
        // contiguous, from 0 to the end
        XCTAssertEqual(ins[0].timeRange.start, .zero)
        for (a, b) in zip(ins, ins.dropFirst()) { XCTAssertEqual(a.timeRange.end, b.timeRange.start) }
        XCTAssertEqual(ins.last!.timeRange.end, built.composition.duration)
        XCTAssertEqual(ins[1].timeRange.start.seconds, 1.0, accuracy: 0.01)
        XCTAssertEqual(ins[1].timeRange.duration.seconds, 0.5, accuracy: 0.01)
        // the fade shows both clips' tracks, the incoming one ramping 0 to 1 on top
        XCTAssertEqual(ins[1].layers.count, 2)
        XCTAssertNotEqual(ins[1].layers[0].trackID, ins[1].layers[1].trackID)
        XCTAssertEqual(ins[1].layers[0].from, 1); XCTAssertEqual(ins[1].layers[0].to, 1)
        XCTAssertEqual(ins[1].layers[1].from, 0); XCTAssertEqual(ins[1].layers[1].to, 1)
        XCTAssertEqual(ins[0].layers.count, 1)
        XCTAssertEqual(ins[0].layers[0].trackID, ins[1].layers[0].trackID)
        XCTAssertEqual(ins[2].layers[0].trackID, ins[1].layers[1].trackID)
        XCTAssertTrue(ins[1].containsTweening)
        XCTAssertFalse(ins[0].containsTweening)
        XCTAssertEqual(ins[1].requiredSourceTrackIDs?.count, 2)
        // audio: clip 0's track fades out over the overlap, clip 1's fades in
        let mix = try XCTUnwrap(built.audioMix)
        XCTAssertEqual(mix.inputParameters.count, 2)
        struct Ramp { var from: Float; var to: Float; var start: Double; var end: Double }
        func ramps(_ p: AVAudioMixInputParameters) -> [Ramp] {
            var out: [Ramp] = []
            var t = CMTime.zero
            var s: Float = 0, e: Float = 0
            var range = CMTimeRange.zero
            while p.getVolumeRamp(for: t, startVolume: &s, endVolume: &e, timeRange: &range) {
                if s != e { out.append(Ramp(from: s, to: e, start: range.start.seconds, end: range.end.seconds)) }
                t = range.end
                if t.seconds > 10 || range.duration == .zero { break }
            }
            return out
        }
        var all: [Ramp] = []
        for p in mix.inputParameters { all += ramps(p) }
        let fadeOut = all.filter { $0.from == 1 && $0.to == 0 }
        let fadeIn = all.filter { $0.from == 0 && $0.to == 1 }
        XCTAssertEqual(fadeOut.count, 1)
        XCTAssertEqual(fadeIn.count, 1)
        XCTAssertEqual(fadeOut[0].start, 1.0, accuracy: 0.01)
        XCTAssertEqual(fadeOut[0].end, 1.5, accuracy: 0.01)
        XCTAssertEqual(fadeIn[0].start, 1.0, accuracy: 0.01)
        XCTAssertEqual(fadeIn[0].end, 1.5, accuracy: 0.01)
    }

    func testDipInstructionsKeepTheLength() async throws {
        let built = try await EditComposition.build(asset: AVURLAsset(url: clip), edit: edit3(.dipBlack, speed: .short))
        XCTAssertEqual(built.duration, 3, accuracy: 0.02)
        let ins = built.videoComposition.instructions.compactMap { $0 as? EditCompositionInstruction }
        XCTAssertEqual(ins.count, 4)                                   // solo, out, in, solo
        XCTAssertEqual(ins[1].layers.map { [$0.from, $0.to] }, [[1, 0]])
        XCTAssertEqual(ins[2].layers.map { [$0.from, $0.to] }, [[0, 1]])
        XCTAssertEqual(ins[1].timeRange.duration.seconds, 0.15, accuracy: 0.01)
    }

    func testTransitionsForceAReencode() async throws {
        let asset = AVURLAsset(url: clip)
        // seams on keyframes (1 s): passthrough without transitions...
        var cut = EditModel(duration: 3)
        cut.split(atSequence: 1); cut.split(atSequence: 2); cut.deleteClip(1)   // 0-1, 2-3
        let a = try await RecordingExport.export(asset: asset, edit: cut, to: dir.appendingPathComponent("a.mp4"))
        XCTAssertEqual(a, .passthrough)
        // ...and re-encoded with them
        cut.transitionStyle = .crossfade
        cut.transitionSpeed = .short
        let b = try await RecordingExport.export(asset: asset, edit: cut, to: dir.appendingPathComponent("b.mp4"))
        XCTAssertEqual(b, .reencoded)
        let d = try await AVURLAsset(url: dir.appendingPathComponent("b.mp4")).load(.duration).seconds
        XCTAssertEqual(d, 2 - 0.3, accuracy: 0.15)
    }

    func testDipFramesGoToBlackAndWhite() async throws {
        for (style, dark) in [(CutTransition.Style.dipBlack, true), (.dipWhite, false)] {
            let out = dir.appendingPathComponent("dip-\(style.rawValue).mp4")
            let mode = try await RecordingExport.export(asset: AVURLAsset(url: clip), edit: edit3(style, speed: .normal), to: out)
            XCTAssertEqual(mode, .reencoded)
            let asset = AVURLAsset(url: out)
            let dur = try await asset.load(.duration).seconds
            let audioTracks = try await asset.loadTracks(withMediaType: .audio).count
            XCTAssertEqual(dur, 3, accuracy: 0.15)
            XCTAssertEqual(audioTracks, 1)
            let gen = AVAssetImageGenerator(asset: asset)
            gen.requestedTimeToleranceBefore = .zero
            gen.requestedTimeToleranceAfter = .zero
            let (mid, _) = try await gen.image(at: CMTime(seconds: 1.5, preferredTimescale: 600))
            let (away, _) = try await gen.image(at: CMTime(seconds: 0.5, preferredTimescale: 600))
            let m = RecordingExportTests.mean(mid), f = RecordingExportTests.mean(away)
            if dark { XCTAssertLessThan(m, 12, "the seam is black"); XCTAssertGreaterThan(f, 40) }
            else { XCTAssertGreaterThan(m, 243, "the seam is white") ; XCTAssertLessThan(f, 215) }
        }
    }

    func testAnnotationsStillDrawOverTransitions() async throws {
        let out = dir.appendingPathComponent("ann.mp4")
        let box = VideoAnnotation(id: 1, kind: .highlight, a: .zero, b: CGPoint(x: 1, y: 1), color: 0xffffff, size: 1, start: 0, length: 10)
        let m = edit3(.crossfade, speed: .short)
        let frames = AnnotationFrameRenderer(blurOnly: false, annotations: [box], edit: m)
        _ = try await RecordingExport.export(asset: AVURLAsset(url: clip), edit: m, to: out, frames: frames)
        let asset = AVURLAsset(url: out)
        let gen = AVAssetImageGenerator(asset: asset)
        gen.requestedTimeToleranceBefore = .zero
        gen.requestedTimeToleranceAfter = .zero
        let (img, _) = try await gen.image(at: CMTime(seconds: 0.5, preferredTimescale: 600))
        let (src, _) = try await AVAssetImageGenerator(asset: AVURLAsset(url: clip)).image(at: CMTime(seconds: 0.5, preferredTimescale: 600))
        XCTAssertGreaterThan(RecordingExportTests.mean(img), RecordingExportTests.mean(src) + 30)
    }
}
