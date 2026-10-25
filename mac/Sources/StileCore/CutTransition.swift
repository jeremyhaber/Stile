import Foundation

/// v3.9: transitions between the clips of an edit (not the per-annotation `VideoAnnotation.Transition`).
///
/// Timing model:
/// - **Crossfade** overlaps the two clips by the transition's duration: the outgoing clip's last `d` seconds dissolve into the
///   incoming clip's first `d`, so each crossfade makes the edit `d` seconds shorter. Every clip still plays all of its footage.
/// - **Fade through black / white** is centred on the seam and doesn't overlap: the outgoing clip fades out over its last
///   `d / 2` and the incoming one fades in over its first `d / 2`. The edit's length doesn't change.
/// - `d` is 0.3 s (Short) or 0.5 s (Normal), clamped to 40 % of the shorter of the two clips (so the transitions at both
///   ends of a clip use at most 80 % of it); under 0.04 s there is no transition.
/// - Audio follows the picture: a crossfade crossfades the sound over the overlap, a dip fades the outgoing clip out and
///   the incoming one in around the seam.
///
/// Sequence time is the edited video's time with the overlaps taken out, so `EditModel.sequenceStart(of:)`, `length`,
/// `clipIndex(atSequence:)` and everything built on them (annotations, playhead, ruler) already account for it.
public enum CutTransition {
    public enum Style: String, Sendable, CaseIterable {
        case none, crossfade, dipBlack, dipWhite
        public var name: String {
            switch self {
            case .none: return "None"
            case .crossfade: return "Crossfade"
            case .dipBlack: return "Fade through black"
            case .dipWhite: return "Fade through white"
            }
        }
        /// Crossfade: the clips overlap.
        public var overlaps: Bool { self == .crossfade }
    }

    public enum Speed: String, Sendable, CaseIterable {
        case short, normal
        public var name: String { self == .short ? "Short" : "Normal" }
        public var seconds: Double { self == .short ? 0.3 : 0.5 }
    }

    /// The most of a clip a transition may take at one of its ends.
    public static let maxClipFraction = 0.4
    /// Shorter than this is no transition.
    public static let minDuration = 0.04

    /// What shows behind a fading clip.
    public enum Background: Equatable, Sendable { case black, white }

    /// A clip's opacity ramping from `from` to `to` over a segment (layers are listed bottom to top).
    public struct Layer: Equatable, Sendable {
        public var clip: Int
        public var from: Double
        public var to: Double
    }

    /// A stretch of the edited video (sequence seconds) where the picture is made of the same layers throughout.
    public struct Segment: Equatable, Sendable {
        public var start: Double
        public var end: Double
        public var layers: [Layer]
        public var background: Background
        public var duration: Double { end - start }
    }

    /// A clip's sound level ramping from `from` to `to` over `start...end` (sequence seconds).
    public struct VolumeRamp: Equatable, Sendable {
        public var clip: Int
        public var start: Double
        public var end: Double
        public var from: Double
        public var to: Double
    }
}
