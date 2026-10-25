import XCTest
@testable import StileCore

final class CutSnapTests: XCTestCase {
    func testSnapsWithinDistance() {
        XCTAssertTrue(CutSnap.snaps(pointerX: 108, playheadX: 100))
        XCTAssertTrue(CutSnap.snaps(pointerX: 93, playheadX: 100))
        XCTAssertFalse(CutSnap.snaps(pointerX: 108.5, playheadX: 100))
    }
    func testOptionDisables() {
        XCTAssertFalse(CutSnap.snaps(pointerX: 100, playheadX: 100, disabled: true))
    }
}
