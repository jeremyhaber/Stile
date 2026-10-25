import AVFoundation
import XCTest
@testable import StileCore

/// Trims a generated 3 s clip (keyframes every second) both ways.
final class Feed: @unchecked Sendable { var video = 0; var audio = 0 }

final class RecordingExportTests: XCTestCase {
    var dir: URL!
    var clip: URL!

    override func setUp() async throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("export-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        clip = dir.appendingPathComponent("clip.mp4")
        try await Self.makeClip(at: clip, seconds: 3)
    }
    override func tearDown() async throws { try? FileManager.default.removeItem(at: dir) }

    /// 64x64 H.264 at 30 fps, a keyframe every 30 frames, the picture changing every frame.
    static func makeClip(at url: URL, seconds: Int, audio: Bool = false) async throws {
        let w = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 64, AVVideoHeightKey: 64,
            AVVideoCompressionPropertiesKey: [AVVideoMaxKeyFrameIntervalKey: 30, AVVideoAllowFrameReorderingKey: false],
        ])
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String: 64, kCVPixelBufferHeightKey as String: 64,
        ])
        w.add(input)
        let audioInput = AVAssetWriterInput(mediaType: .audio, outputSettings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC, AVNumberOfChannelsKey: 1, AVSampleRateKey: 44100, AVEncoderBitRateKey: 64000,
        ])
        if audio { w.add(audioInput) }
        XCTAssertTrue(w.startWriting())
        w.startSession(atSourceTime: .zero)
        // (the writer wants both inputs fed together, each from its own queue)
        let box = Feed()
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            let group = DispatchGroup()
            group.enter()
            input.requestMediaDataWhenReady(on: DispatchQueue(label: "feed-video")) {
                while input.isReadyForMoreMediaData {
                    if box.video >= seconds * 30 { input.markAsFinished(); group.leave(); return }
                    let f = box.video
                    box.video += 1
                    var pb: CVPixelBuffer?
                    CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &pb)
                    CVPixelBufferLockBaseAddress(pb!, [])
                    let base = CVPixelBufferGetBaseAddress(pb!)!.assumingMemoryBound(to: UInt8.self)
                    for i in 0..<(64 * CVPixelBufferGetBytesPerRow(pb!)) { base[i] = UInt8(truncatingIfNeeded: i &* 31 &+ f &* 17) }
                    CVPixelBufferUnlockBaseAddress(pb!, [])
                    adaptor.append(pb!, withPresentationTime: CMTime(value: CMTimeValue(f), timescale: 30))
                }
            }
            if audio {
                group.enter()
                audioInput.requestMediaDataWhenReady(on: DispatchQueue(label: "feed-audio")) {
                    while audioInput.isReadyForMoreMediaData {
                        if box.audio >= seconds * 30 { audioInput.markAsFinished(); group.leave(); return }
                        let f = box.audio
                        box.audio += 1
                        audioInput.append(try! silence(frames: 1470, at: CMTime(value: CMTimeValue(f * 1470), timescale: 44100)))
                    }
                }
            }
            group.notify(queue: .main) { done.resume() }
        }
        await w.finishWriting()
        XCTAssertEqual(w.status, .completed, "\(String(describing: w.error))")
    }

    static func silence(frames: Int, at pts: CMTime) throws -> CMSampleBuffer {
        var asbd = AudioStreamBasicDescription(mSampleRate: 44100, mFormatID: kAudioFormatLinearPCM, mFormatFlags: kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked,
                                               mBytesPerPacket: 2, mFramesPerPacket: 1, mBytesPerFrame: 2, mChannelsPerFrame: 1, mBitsPerChannel: 16, mReserved: 0)
        var fmt: CMAudioFormatDescription?
        CMAudioFormatDescriptionCreate(allocator: nil, asbd: &asbd, layoutSize: 0, layout: nil, magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &fmt)
        var block: CMBlockBuffer?
        let bytes = frames * 2
        CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: nil, blockLength: bytes, blockAllocator: nil, customBlockSource: nil,
                                           offsetToData: 0, dataLength: bytes, flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block)
        CMBlockBufferFillDataBytes(with: 0, blockBuffer: block!, offsetIntoDestination: 0, dataLength: bytes)
        var sb: CMSampleBuffer?
        CMAudioSampleBufferCreateReadyWithPacketDescriptions(allocator: nil, dataBuffer: block!, formatDescription: fmt!, sampleCount: frames, presentationTimeStamp: pts,
                                                             packetDescriptions: nil, sampleBufferOut: &sb)
        return sb!
    }

    func range(_ a: Double, _ b: Double) -> CMTimeRange {
        CMTimeRange(start: CMTime(seconds: a, preferredTimescale: 600), end: CMTime(seconds: b, preferredTimescale: 600))
    }

    func testKeyframeDetection() async {
        let asset = AVURLAsset(url: clip)
        let atZero = await RecordingExport.startsOnKeyframe(asset: asset, start: .zero)
        let atOne = await RecordingExport.startsOnKeyframe(asset: asset, start: CMTime(seconds: 1, preferredTimescale: 600))
        let mid = await RecordingExport.startsOnKeyframe(asset: asset, start: CMTime(seconds: 1.5, preferredTimescale: 600))
        XCTAssertTrue(atZero)
        XCTAssertTrue(atOne)
        XCTAssertFalse(mid)
    }

    func testPassthroughWhenCutIsOnAKeyframe() async throws {
        let out = dir.appendingPathComponent("a.mp4")
        let mode = try await RecordingExport.export(asset: AVURLAsset(url: clip), range: range(1, 2), to: out)
        XCTAssertEqual(mode, .passthrough)
        let d = try await AVURLAsset(url: out).load(.duration).seconds
        XCTAssertEqual(d, 1, accuracy: 0.1)
    }

    func testReencodeWhenCutIsMidGop() async throws {
        let out = dir.appendingPathComponent("b.mp4")
        let mode = try await RecordingExport.export(asset: AVURLAsset(url: clip), range: range(0.5, 2.5), to: out)
        XCTAssertEqual(mode, .reencoded)
        let d = try await AVURLAsset(url: out).load(.duration).seconds
        XCTAssertEqual(d, 2, accuracy: 0.15)
        let size = try await AVURLAsset(url: out).loadTracks(withMediaType: .video).first!.load(.naturalSize)
        XCTAssertEqual(size.width, 64)
    }

    func testCuttingTheMiddleJoinsThePieces() async throws {
        let out = dir.appendingPathComponent("d.mp4")
        // pieces start on keyframes (0 s, 2 s): passthrough
        let mode = try await RecordingExport.export(asset: AVURLAsset(url: clip), pieces: [range(0, 1), range(2, 3)], to: out)
        XCTAssertEqual(mode, .passthrough)
        let d = try await AVURLAsset(url: out).load(.duration).seconds
        XCTAssertEqual(d, 2, accuracy: 0.1)
        // a piece starting mid-GOP: re-encoded
        let out2 = dir.appendingPathComponent("e.mp4")
        let mode2 = try await RecordingExport.export(asset: AVURLAsset(url: clip), pieces: [range(0, 1), range(1.5, 2.5)], to: out2)
        XCTAssertEqual(mode2, .reencoded)
        let d2 = try await AVURLAsset(url: out2).load(.duration).seconds
        XCTAssertEqual(d2, 2, accuracy: 0.15)
    }

        func testAnnotationsAreDrawnIntoTheExport() async throws {
        let out = dir.appendingPathComponent("f.mp4")
        let box = VideoAnnotation(id: 1, kind: .highlight, a: CGPoint(x: 0, y: 0), b: CGPoint(x: 1, y: 1), color: 0xffffff, size: 1,
                                  start: 0, length: 10)
        let frames = AnnotationFrameRenderer(blurOnly: false, annotations: [box])
        let mode = try await RecordingExport.export(asset: AVURLAsset(url: clip), pieces: [range(0, 1), range(2, 3)], to: out, frames: frames)
        XCTAssertEqual(mode, .reencoded)
        let asset = AVURLAsset(url: out)
        let d = try await asset.load(.duration).seconds
        XCTAssertEqual(d, 2, accuracy: 0.15)
        // the frame is washed with white by the 40 % highlight: brighter on average than the source
        let gen = AVAssetImageGenerator(asset: asset)
        gen.requestedTimeToleranceBefore = .zero
        gen.requestedTimeToleranceAfter = .zero
        let (img, _) = try await gen.image(at: CMTime(seconds: 0.5, preferredTimescale: 600))
        let (src, _) = try await AVAssetImageGenerator(asset: AVURLAsset(url: clip)).image(at: CMTime(seconds: 0.5, preferredTimescale: 600))
        XCTAssertGreaterThan(Self.mean(img), Self.mean(src) + 30)
    }

    static func mean(_ img: CGImage) -> Double {
        let w = img.width, h = img.height
        var p = [UInt8](repeating: 0, count: w * h * 4)
        let ctx = CGContext(data: &p, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
        var sum = 0
        for i in stride(from: 0, to: p.count, by: 4) { sum += Int(p[i]) + Int(p[i + 1]) + Int(p[i + 2]) }
        return Double(sum) / Double(w * h * 3)
    }

        func testCancelledExportLeavesNoFile() async throws {
        let out = dir.appendingPathComponent("c.mp4")
        let asset = AVURLAsset(url: clip)
        let task = Task { try await RecordingExport.export(asset: asset, range: self.range(0.5, 2.5), to: out) }
        task.cancel()
        do { _ = try await task.value } catch { /* cancelled or finished first */ }
        // either it was cancelled (no file) or it finished (a complete file); never a partial one
        if FileManager.default.fileExists(atPath: out.path) {
            let d = try await AVURLAsset(url: out).load(.duration).seconds
            XCTAssertGreaterThan(d, 1)
        }
    }
}
