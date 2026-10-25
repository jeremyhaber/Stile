import Foundation

/// Magnetic snap of the Cut tool's hover line onto the playhead. Distances are screen points, so it feels the same at any zoom.
public enum CutSnap {
    public static let distance: Double = 8

    /// True when a pointer at `pointerX` should snap to a playhead drawn at `playheadX`.
    public static func snaps(pointerX: Double, playheadX: Double, disabled: Bool = false, within: Double = distance) -> Bool {
        !disabled && abs(pointerX - playheadX) <= within
    }
}
