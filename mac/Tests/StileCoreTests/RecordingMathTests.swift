import XCTest
@testable import StileCore

final class RecordingMathTests: XCTestCase {
    func testOutputSizeCapsAndEvens() {
        let a = RecordingMath.outputSize(width: 3024, height: 1964, maxLongSide: 1920)
        XCTAssertEqual(a.width, 1920)
        XCTAssertEqual(a.height % 2, 0)
        XCTAssertEqual(Double(a.height), 1964.0 / 3024.0 * 1920.0, accuracy: 2)
        // never scaled up
        let b = RecordingMath.outputSize(width: 801, height: 601, maxLongSide: 1920)
        XCTAssertEqual(b.width, 800)
        XCTAssertEqual(b.height, 600)
        // native keeps the size; portrait caps the height
        XCTAssertEqual(RecordingMath.outputSize(width: 5120, height: 2880, maxLongSide: nil).width, 5120)
        let c = RecordingMath.outputSize(width: 1000, height: 4000, maxLongSide: 2560)
        XCTAssertEqual(c.height, 2560)
        XCTAssertEqual(c.width, 640)
        XCTAssertEqual(RecordingMath.outputSize(width: 0, height: 0, maxLongSide: nil).width, 2)
    }

    func testMaxLongSideSetting() {
        XCTAssertEqual(RecordingMath.maxLongSide(forSetting: "1080p"), 1920)
        XCTAssertEqual(RecordingMath.maxLongSide(forSetting: "1440p"), 2560)
        XCTAssertNil(RecordingMath.maxLongSide(forSetting: "native"))
        XCTAssertNil(RecordingMath.maxLongSide(forSetting: "bogus"))
    }

    func testTimer() {
        XCTAssertEqual(RecordingMath.timer(0), "0:00")
        XCTAssertEqual(RecordingMath.timer(7.9), "0:07")
        XCTAssertEqual(RecordingMath.timer(723), "12:03")
        XCTAssertEqual(RecordingMath.timer(3723), "1:02:03")
        XCTAssertEqual(RecordingMath.timer(-4), "0:00")
    }

    func testMeterLevel() {
        XCTAssertEqual(RecordingMath.meterLevel(peak: 0), 0)
        XCTAssertEqual(RecordingMath.meterLevel(peak: 1), 1, accuracy: 0.001)
        XCTAssertEqual(RecordingMath.meterLevel(peak: 0.1), 0.6, accuracy: 0.001)   // -20 dB
        XCTAssertEqual(RecordingMath.meterLevel(peak: 0.001), 0, accuracy: 0.001)   // -60 dB: below the floor
    }

    func testRelativeRectAndPage() {
        let win = CGRect(x: 100, y: 50, width: 1000, height: 800)
        let page = CGRect(x: 100, y: 150, width: 1000, height: 700)
        XCTAssertEqual(RecordingMath.relativeRect(page, in: win), CGRect(x: 0, y: 100, width: 1000, height: 700))
        // spilling past the window is clipped
        XCTAssertEqual(RecordingMath.relativeRect(CGRect(x: 90, y: 150, width: 1100, height: 900), in: win),
                       CGRect(x: 0, y: 100, width: 1000, height: 700))
        XCTAssertNil(RecordingMath.relativeRect(CGRect(x: 2000, y: 0, width: 50, height: 50), in: win))
        let side = CGRect(x: 800, y: 150, width: 300, height: 700)
        XCTAssertEqual(RecordingMath.pickPage([side, CGRect(x: 100, y: 150, width: 700, height: 700)]),
                       CGRect(x: 100, y: 150, width: 700, height: 700))
        XCTAssertNil(RecordingMath.pickPage([]))
    }

    func testPreciseTimer() {
        XCTAssertEqual(RecordingMath.preciseTimer(0), "0:00.0")
        XCTAssertEqual(RecordingMath.preciseTimer(7.44), "0:07.4")
        XCTAssertEqual(RecordingMath.preciseTimer(59.96), "1:00.0")
        XCTAssertEqual(RecordingMath.preciseTimer(723.05), "12:03.1")
    }

    func testTrimEdges() {
        // the start can't pass the end (minus the minimum length), nor go below 0
        XCTAssertEqual(RecordingMath.trim(start: 0, end: 10, duration: 20, moving: .start, to: 12).start, 9.5)
        XCTAssertEqual(RecordingMath.trim(start: 3, end: 10, duration: 20, moving: .start, to: -4).start, 0)
        // the end can't pass the start, nor the duration
        XCTAssertEqual(RecordingMath.trim(start: 5, end: 10, duration: 20, moving: .end, to: 2).end, 5.5)
        XCTAssertEqual(RecordingMath.trim(start: 5, end: 10, duration: 20, moving: .end, to: 99).end, 20)
        // a clip shorter than the minimum still works
        let r = RecordingMath.trim(start: 0, end: 0.3, duration: 0.3, moving: .end, to: 0)
        XCTAssertEqual(r.end, 0.3, accuracy: 0.0001)
    }
}
