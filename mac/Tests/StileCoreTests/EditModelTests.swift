import XCTest
@testable import StileCore

final class EditModelTests: XCTestCase {
    func testUntouchedIsOneClip() {
        let m = EditModel(duration: 20)
        XCTAssertEqual(m.clips, [.init(start: 0, end: 20)])
        XCTAssertFalse(m.isEdited)
        XCTAssertEqual(m.key, "full")
        XCTAssertEqual(m.length, 20)
    }

    func testSplitAloneIsNoEdit() {
        var m = EditModel(duration: 20)
        XCTAssertEqual(m.split(atSequence: 8), 1)
        XCTAssertEqual(m.clips, [.init(start: 0, end: 8), .init(start: 8, end: 20)])
        XCTAssertFalse(m.isEdited, "two clips that follow on are still the whole recording")
        XCTAssertEqual(m.pieces, [0...20])
        XCTAssertNil(m.split(atSequence: 8.1), "too near an edge")
    }

    func testDeleteClosesUp() {
        var m = EditModel(duration: 30)
        m.split(atSequence: 10)
        m.split(atSequence: 15)          // clips 0-10, 10-15, 15-30
        XCTAssertTrue(m.deleteClip(1))
        XCTAssertEqual(m.pieces, [0...10, 15...30])
        XCTAssertEqual(m.length, 25)
        // sequence time 12 is recording time 17 now
        XCTAssertEqual(m.source(atSequence: 12), 17, accuracy: 0.0001)
        XCTAssertEqual(m.sequence(ofSource: 17), 12, accuracy: 0.0001)
        // removed footage maps to the cut
        XCTAssertEqual(m.sequence(ofSource: 12), 10, accuracy: 0.0001)
        XCTAssertTrue(m.hasHiddenMedia(0, .end))
        XCTAssertTrue(m.hasHiddenMedia(1, .start))
        XCTAssertFalse(m.hasHiddenMedia(1, .end))
        // the last clip can't go
        XCTAssertTrue(m.deleteClip(0))
        XCTAssertFalse(m.deleteClip(0))
    }

    func testDraggingAnEdgeOutRestores() {
        var m = EditModel(duration: 30)
        m.split(atSequence: 10)
        m.split(atSequence: 15)
        m.deleteClip(1)                  // 0-10, 15-30
        m.moveEdge(0, .end, toSource: 12)
        XCTAssertEqual(m.clips[0].end, 12)
        m.moveEdge(0, .end, toSource: 99)   // stops at the next clip's footage
        XCTAssertEqual(m.clips[0].end, 15)
        XCTAssertFalse(m.isEdited, "everything is back")
        // in: leaves the minimum
        m.moveEdge(1, .start, toSource: 40)
        XCTAssertEqual(m.clips[1].start, 30 - EditModel.minLength, accuracy: 0.0001)
        // the first clip's start trims the recording's start
        m.moveEdge(0, .start, toSource: 3)
        XCTAssertEqual(m.pieces.first?.lowerBound, 3)
        m.moveEdge(0, .start, toSource: -5)
        XCTAssertEqual(m.clips[0].start, 0)
    }

    func testSetStartAndEnd() {
        var m = EditModel(duration: 30)
        m.split(atSequence: 10)
        m.deleteBefore(sequence: 12)
        XCTAssertEqual(m.clips, [.init(start: 12, end: 30)])
        m.deleteAfter(sequence: 8)       // recording time 20
        XCTAssertEqual(m.clips, [.init(start: 12, end: 20)])
        m.reset()
        XCTAssertFalse(m.isEdited)
    }

    func testBoundaryBelongsToTheNextClip() {
        var m = EditModel(duration: 30)
        m.split(atSequence: 10)
        m.split(atSequence: 15)
        m.deleteClip(1)
        XCTAssertEqual(m.clipIndex(atSequence: 10), 1, "a boundary belongs to the clip after it")
        XCTAssertEqual(m.clipIndex(atSequence: 25), 1, "the end belongs to the last clip")
    }

    func testReorderingClips() {
        var m = EditModel(duration: 30)
        m.split(atSequence: 10)
        m.split(atSequence: 20)              // A 0-10, B 10-20, C 20-30
        XCTAssertEqual(m.moveClip(2, toGap: 0), 0)
        XCTAssertEqual(m.clips.map(\.start), [20, 0, 10])   // C A B
        XCTAssertTrue(m.isEdited, "a new order is an edit")
        XCTAssertEqual(m.pieces, [20...30, 0...20], "A and B still follow on, so they export as one piece")
        XCTAssertNil(m.moveClip(1, toGap: 1), "no move")
        XCTAssertNil(m.moveClip(1, toGap: 2), "no move")
        XCTAssertEqual(m.moveClip(0, toGap: 3), 2)          // C to the end again
        XCTAssertFalse(m.isEdited)
        // sequence <-> recording time with the new order
        m.moveClip(2, toGap: 0)                              // C A B
        XCTAssertEqual(m.sequence(ofSource: 25), 5, accuracy: 0.0001)
        XCTAssertEqual(m.sequence(ofSource: 5), 15, accuracy: 0.0001)
        XCTAssertEqual(m.source(atSequence: 12), 2, accuracy: 0.0001)
    }

    func testEdgesOfReorderedClipsReachUnusedFootageOnly() {
        var m = EditModel(duration: 30)
        m.split(atSequence: 10)
        m.split(atSequence: 20)              // A 0-10, B 10-20, C 20-30
        m.deleteClip(1)                      // A C; 10-20 unused
        m.moveClip(1, toGap: 0)              // C A
        XCTAssertTrue(m.hasHiddenMedia(1, .end), "A can grow into 10-20 though C is now before it")
        XCTAssertTrue(m.hasHiddenMedia(0, .start), "so can C, backwards")
        m.moveEdge(1, .end, toSource: 25)
        XCTAssertEqual(m.clips[1].end, 20, "stops at C's footage")
        XCTAssertFalse(m.hasHiddenMedia(0, .start))
    }

    func testSequenceRangesSplitAcrossClips() {
        var m = EditModel(duration: 30)
        m.split(atSequence: 10)
        m.split(atSequence: 20)
        m.moveClip(2, toGap: 0)              // C(20-30) A(0-10) B(10-20)
        // recording 5...25 shows in A (5-10 -> 15-20), B (10-20 -> 20-30) and C (20-25 -> 0-5)
        XCTAssertEqual(m.sequenceRanges(ofSource: 5...25), [0...5, 15...20, 20...30])
        XCTAssertEqual(m.sequence(ofSource: 25), 5, accuracy: 0.0001)
    }
}

final class VideoAnnotationTests: XCTestCase {
    func render(_ list: [VideoAnnotation], at t: Double, base: CIImage? = nil) -> CGImage {
        let size = CGSize(width: 200, height: 100)
        let frame = base ?? CIImage(color: CIColor(red: 0, green: 0, blue: 1)).cropped(to: CGRect(origin: .zero, size: size))
        let out = AnnotationFrameRenderer(blurOnly: false, annotations: list).apply(to: frame, at: t)
        return CIContext().createCGImage(out, from: CGRect(origin: .zero, size: size))!
    }

    /// RGBA of pixel (x, y), top-left origin.
    func pixel(_ img: CGImage, _ x: Int, _ y: Int) -> [UInt8] {
        var p = [UInt8](repeating: 0, count: 4)
        let ctx = CGContext(data: &p, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.draw(img, in: CGRect(x: -x, y: -(img.height - 1 - y), width: img.width, height: img.height))
        return p
    }

    func testRectIsDrawnWhereItShowsAndOnlyThen() {
        // a red box from (0.1, 0.2) to (0.6, 0.8): its left edge at x = 20 px, y 20...80
        let r = VideoAnnotation(id: 1, kind: .rect, a: CGPoint(x: 0.1, y: 0.2), b: CGPoint(x: 0.6, y: 0.8), color: 0xe5322d, size: 1, start: 2, length: 2)
        let on = pixel(render([r], at: 3), 20, 50)
        XCTAssertGreaterThan(on[0], 200)
        XCTAssertLessThan(on[2], 80)
        let inside = pixel(render([r], at: 3), 60, 50)
        XCTAssertGreaterThan(inside[2], 200, "a rectangle is only its outline")
        let off = pixel(render([r], at: 5), 20, 50)
        XCTAssertGreaterThan(off[2], 200, "not showing after its end")
    }

    func testBlurChangesOnlyItsBox() {
        // left half black, right half white; a blur box over the middle mixes them
        let size = CGRect(x: 0, y: 0, width: 200, height: 100)
        let black = CIImage(color: CIColor(red: 0, green: 0, blue: 0)).cropped(to: CGRect(x: 0, y: 0, width: 100, height: 100))
        let white = CIImage(color: CIColor(red: 1, green: 1, blue: 1)).cropped(to: CGRect(x: 100, y: 0, width: 100, height: 100))
        let base = black.composited(over: white).cropped(to: size)
        let b = VideoAnnotation(id: 2, kind: .blur, a: CGPoint(x: 0.3, y: 0.1), b: CGPoint(x: 0.7, y: 0.9), color: 0, size: 0, start: 0, length: 10)
        let img = render([b], at: 1, base: base)
        let mid = pixel(img, 98, 50)[0]
        XCTAssertGreaterThan(mid, 30)
        XCTAssertLessThan(mid, 225)
        XCTAssertLessThan(pixel(img, 5, 50)[0], 10, "outside the box: untouched")
    }

    func testArrowHeadAndReadableHalo() {
        let p = AnnotationRenderer.arrowParts(.zero, CGPoint(x: 100, y: 0), width: 4)
        XCTAssertEqual(p.head[0], CGPoint(x: 100, y: 0))
        XCTAssertEqual(p.shaftEnd.x, 100 - 18 * 0.8, accuracy: 0.001)
        XCTAssertEqual(AnnotationStyle.readable(on: 0xffd60a), 0x111111)
        XCTAssertEqual(AnnotationStyle.readable(on: 0xe5322d), 0xffffff)
    }

    func testTransitionProgress() {
        var a = VideoAnnotation(id: 4, kind: .rect, a: .zero, b: CGPoint(x: 1, y: 1), color: 0, size: 0, start: 2, length: 4)
        XCTAssertEqual(a.progress(at: 2), 0, accuracy: 0.0001)
        XCTAssertEqual(a.progress(at: 2.275), 0.5, accuracy: 0.0001)
        XCTAssertEqual(a.progress(at: 4), 1)
        XCTAssertEqual(a.progress(at: 6 - 0.275), 0.5, accuracy: 0.0001, "mirrored on the way out")
        a.length = 0.2   // shorter than two transitions: half each way
        XCTAssertEqual(a.progress(at: 2.1), 1, accuracy: 0.0001)
        a.transition = .none
        XCTAssertEqual(a.progress(at: 2), 1)
    }

    func testTransitionSpeeds() {
        XCTAssertEqual(VideoAnnotation.Transition.fade.duration(at: .fast), 0.3)
        XCTAssertEqual(VideoAnnotation.Transition.fade.duration(at: .normal), 0.55)
        XCTAssertEqual(VideoAnnotation.Transition.pop.duration(at: .slow), 1.0)
        XCTAssertEqual(VideoAnnotation.Transition.draw.duration(at: .fast), 0.3)
        XCTAssertEqual(VideoAnnotation.Transition.draw.duration(at: .normal), 0.7)
        XCTAssertEqual(VideoAnnotation.Transition.draw.duration(at: .slow), 1.2)
        var a = VideoAnnotation(id: 4, kind: .rect, a: .zero, b: CGPoint(x: 1, y: 1), color: 0, size: 0, start: 2, length: 4)
        XCTAssertEqual(a.speed, .normal)
        a.speed = .fast
        XCTAssertEqual(a.progress(at: 2.15), 0.5, accuracy: 0.0001)
        XCTAssertEqual(a.progress(at: 6 - 0.15), 0.5, accuracy: 0.0001)
        a.speed = .slow
        XCTAssertEqual(a.progress(at: 2.5), 0.5, accuracy: 0.0001)
        a.length = 1   // slow wants 1 s each way: clamped to half the 1 s on screen
        XCTAssertEqual(a.progress(at: 2.25), 0.5, accuracy: 0.0001)
        XCTAssertEqual(a.progress(at: 2.5), 1, accuracy: 0.0001)
        a.transition = .none
        XCTAssertEqual(a.progress(at: 2), 1)
    }

    func testFadingInIsHalfwayAndCanBeTurnedOff() {
        // a white highlight over blue, half faded in: between the two
        let size = CGSize(width: 200, height: 100)
        let h = VideoAnnotation(id: 5, kind: .highlight, a: .zero, b: CGPoint(x: 1, y: 1), color: 0xffffff, size: 0, start: 0, length: 10)
        let frame = CIImage(color: CIColor(red: 0, green: 0, blue: 1)).cropped(to: CGRect(origin: .zero, size: size))
        func red(_ animate: Bool, _ t: Double) -> UInt8 {
            let out = AnnotationFrameRenderer(blurOnly: false, annotations: [h], animate: animate).apply(to: frame, at: t)
            return pixel(CIContext().createCGImage(out, from: CGRect(origin: .zero, size: size))!, 100, 50)[0]
        }
        let full = red(true, 5), half = red(true, 0.1), off = red(false, 0.1)
        XCTAssertGreaterThan(full, 60)
        XCTAssertGreaterThan(half, 5)
        XCTAssertLessThan(half, full)
        XCTAssertEqual(off, full, "transitions off: fully in from the start")
    }

        func testMovedStaysOnTheVideo() {
        let r = VideoAnnotation(id: 3, kind: .rect, a: CGPoint(x: 0.7, y: 0.1), b: CGPoint(x: 0.9, y: 0.3), color: 0, size: 0, start: 0, length: 1)
        let m = r.moved(by: CGVector(dx: 0.5, dy: -0.5))
        XCTAssertEqual(m.box.maxX, 1, accuracy: 0.0001)
        XCTAssertEqual(m.box.minY, 0, accuracy: 0.0001)
        XCTAssertEqual(m.box.width, 0.2, accuracy: 0.0001)
    }

    func testHandoverOnlyAtTheClipsOwnEnd() {
        var m = EditModel(duration: 14.5)
        m.split(atSequence: 5.1); m.split(atSequence: 8)       // 0-5.1, 5.1-8, 8-14.5
        XCTAssertEqual(m.handover(from: 1, at: 6), .stay)
        XCTAssertEqual(m.handover(from: 1, at: 7.97), .next(seekTo: nil), "the footage follows on: no seek")
        XCTAssertEqual(m.handover(from: 2, at: 14.47), .stop)
        XCTAssertEqual(m.handover(from: 5, at: 1), .stay, "no such clip")
    }

    func testHandoverIgnoresATimeBeforeTheClip() {
        // reordered: 5.1-8, 0-5.1, 8-14.5. Jumping from the second clip to the last one leaves the player's time at
        // the old place for a moment; that must not stop the playback at the last clip.
        var m = EditModel(duration: 14.5)
        m.split(atSequence: 5.1); m.split(atSequence: 8)
        XCTAssertNotNil(m.moveClip(1, toGap: 0))
        XCTAssertEqual(m.clips.map(\.start), [5.1, 0, 8])
        XCTAssertEqual(m.handover(from: 1, at: 5.1), .next(seekTo: 8))
        XCTAssertEqual(m.handover(from: 2, at: 5.1), .stay, "still at the old place")
        XCTAssertEqual(m.handover(from: 0, at: 8), .next(seekTo: 0))
    }
}
