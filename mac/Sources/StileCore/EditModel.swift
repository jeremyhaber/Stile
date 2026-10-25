import Foundation

/// v3.7: a recording's edit, Premiere-style. The recording is a row of **clips** (source ranges, never overlapping; v3.8:
/// in any order, dragged around on the timeline). Split cuts a clip in two at the playhead; deleting a clip removes it and the rest closes up (a ripple
/// delete), so the timeline is always the edited video. The footage that was removed isn't gone: dragging the edge of
/// a clip next to it back out brings it back. Times are seconds; "source" is the recording, "sequence" the edited video.
/// Pure, so the timeline's logic is unit-tested.
public struct EditModel: Equatable, Sendable {
    public struct Clip: Equatable, Sendable {
        public var start: Double
        public var end: Double
        /// Identifies the clip through splits, moves and deletes (a per-seam transition belongs to the clip after the seam).
        /// Not part of equality: two clips with the same range are the same footage.
        public internal(set) var id: Int
        public init(start: Double, end: Double) { self.start = start; self.end = end; id = 0 }
        init(start: Double, end: Double, id: Int) { self.start = start; self.end = end; self.id = id }
        public var length: Double { end - start }
        public static func == (a: Clip, b: Clip) -> Bool { a.start == b.start && a.end == b.end }
    }
    public enum Edge: Sendable { case start, end }

    /// Shortest clip a split or a trim leaves.
    public static let minLength = 0.25
    static let epsilon = 0.01

    public private(set) var duration: Double
    public private(set) var clips: [Clip]
    private var nextClipID = 1

    /// v3.9: the edit-wide transition between clips, and its speed.
    public var transitionStyle: CutTransition.Style = .none
    public var transitionSpeed: CutTransition.Speed = .normal
    /// Per-seam styles (None included) that differ from the edit-wide one, by the id of the clip after the seam.
    public private(set) var seamOverrides: [Int: CutTransition.Style] = [:]

    public init(duration: Double) {
        self.duration = max(0, duration)
        clips = duration > 0 ? [Clip(start: 0, end: duration)] : []
    }

    /// The edited video's length (the clips, less what crossfades overlap).
    public var length: Double { sequenceStart(of: clips.count) }

    /// The kept source ranges, clips that follow on in the recording merged (a split with nothing removed is no cut).
    public var pieces: [ClosedRange<Double>] {
        var out: [ClosedRange<Double>] = []
        for c in clips {
            if let last = out.last, abs(last.upperBound - c.start) < Self.epsilon {
                out[out.count - 1] = last.lowerBound...c.end
            } else {
                out.append(c.start...c.end)
            }
        }
        return out
    }

    /// Something was removed (splits alone don't count).
    public var isEdited: Bool {
        let p = pieces
        return !(p.count == 1 && p[0].lowerBound < Self.epsilon && p[0].upperBound > duration - Self.epsilon)
    }

    /// Names the kept pieces, so an export can be reused while nothing changed.
    public var key: String {
        if hasTransitions {
            let seams = (1..<clips.count).map { "\(seamStyle($0).rawValue)@\(String(format: "%.3f", transitionDuration(ofSeam: $0)))" }
            return "t" + clips.map { String(format: "%.3f-%.3f", $0.start, $0.end) }.joined(separator: "_") + "|" + seams.joined(separator: ",")
        }
        return isEdited ? pieces.map { String(format: "%.3f-%.3f", $0.lowerBound, $0.upperBound) }.joined(separator: "_") : "full"
    }

    // MARK: Transitions

    /// The style at seam `i` (between clip `i - 1` and clip `i`): its own, else the edit-wide one.
    public func seamStyle(_ i: Int) -> CutTransition.Style {
        guard i >= 1, i < clips.count else { return .none }
        return seamOverrides[clips[i].id] ?? transitionStyle
    }

    /// Seam `i` has a style of its own.
    public func hasSeamOverride(_ i: Int) -> Bool {
        i >= 1 && i < clips.count && seamOverrides[clips[i].id] != nil
    }

    /// Gives seam `i` its own style (None included).
    public mutating func setSeamStyle(_ i: Int, _ style: CutTransition.Style) {
        guard i >= 1, i < clips.count else { return }
        seamOverrides[clips[i].id] = style
    }

    /// Seam `i` follows the edit-wide style again.
    public mutating func clearSeamStyle(_ i: Int) {
        guard i >= 1, i < clips.count else { return }
        seamOverrides[clips[i].id] = nil
    }

    /// Seconds seam `i`'s transition lasts: the speed's, clamped to 40 % of the shorter neighbour; 0 for None.
    public func transitionDuration(ofSeam i: Int) -> Double {
        guard i >= 1, i < clips.count, seamStyle(i) != .none else { return 0 }
        let cap = CutTransition.maxClipFraction * min(clips[i - 1].length, clips[i].length)
        let d = min(transitionSpeed.seconds, cap)
        return d < CutTransition.minDuration ? 0 : d
    }

    /// How much the two clips at seam `i` overlap (crossfade only).
    public func overlap(ofSeam i: Int) -> Double { seamStyle(i).overlaps ? transitionDuration(ofSeam: i) : 0 }

    /// Some seam has a transition (the edit then plays and exports through `EditComposition`).
    public var hasTransitions: Bool { clips.count > 1 && (1..<clips.count).contains { transitionDuration(ofSeam: $0) > 0 } }

    /// Cuts, reordering or transitions: the edited video differs from the recording.
    public var isModified: Bool { isEdited || hasTransitions }

    /// Drops overrides of seams that no longer exist.
    private mutating func pruneOverrides() {
        let ids = Set(clips.map(\.id))
        seamOverrides = seamOverrides.filter { ids.contains($0.key) }
    }

    /// The picture, as stretches of sequence time with the clips (and their opacity) showing in each. Empty without
    /// transitions. See `CutTransition` for the timing model.
    public var transitionSegments: [CutTransition.Segment] {
        guard hasTransitions else { return [] }
        var out: [CutTransition.Segment] = []
        func add(_ a: Double, _ b: Double, _ layers: [CutTransition.Layer], _ bg: CutTransition.Background = .black) {
            if b - a > 1e-6 { out.append(.init(start: a, end: b, layers: layers, background: bg)) }
        }
        func background(_ s: CutTransition.Style) -> CutTransition.Background { s == .dipWhite ? .white : .black }
        for i in clips.indices {
            let s = sequenceStart(of: i), e = s + clips[i].length
            let inD = transitionDuration(ofSeam: i), inS = seamStyle(i)
            let outD = transitionDuration(ofSeam: i + 1), outS = seamStyle(i + 1)
            var head = 0.0, tail = 0.0
            if inS.overlaps { head = inD; add(s, s + inD, [.init(clip: i - 1, from: 1, to: 1), .init(clip: i, from: 0, to: 1)]) }
            else if inD > 0 { head = inD / 2; add(s, s + head, [.init(clip: i, from: 0, to: 1)], background(inS)) }
            if outS.overlaps { tail = outD } else if outD > 0 { tail = outD / 2 }
            add(s + head, e - tail, [.init(clip: i, from: 1, to: 1)])
            if outD > 0, !outS.overlaps { add(e - tail, e, [.init(clip: i, from: 1, to: 0)], background(outS)) }
        }
        return out
    }

    /// The sound's ramps at each transition (every clip is at full level between them).
    public var volumeRamps: [CutTransition.VolumeRamp] {
        guard hasTransitions else { return [] }
        var out: [CutTransition.VolumeRamp] = []
        for i in clips.indices {
            let s = sequenceStart(of: i), e = s + clips[i].length
            let inD = transitionDuration(ofSeam: i), outD = transitionDuration(ofSeam: i + 1)
            if inD > 0 {
                let d = seamStyle(i).overlaps ? inD : inD / 2
                out.append(.init(clip: i, start: s, end: s + d, from: 0, to: 1))
            }
            if outD > 0 {
                let d = seamStyle(i + 1).overlaps ? outD : outD / 2
                out.append(.init(clip: i, start: e - d, end: e, from: 1, to: 0))
            }
        }
        return out
    }

    // MARK: Source <-> sequence

    /// Where clip `i` starts in the edited video (`clips.count`: the end).
    public func sequenceStart(of i: Int) -> Double {
        let n = max(0, min(i, clips.count))
        var s = 0.0
        for j in 0..<n {
            s += clips[j].length
            if j + 1 < clips.count { s -= overlap(ofSeam: j + 1) }
        }
        return s
    }

    /// The clip at sequence time `t` (a boundary belongs to the clip after it, so inside a crossfade it's the incoming
    /// clip; the very end belongs to the last clip).
    public func clipIndex(atSequence t: Double) -> Int? {
        guard !clips.isEmpty else { return nil }
        for i in 1..<max(1, clips.count) where t < sequenceStart(of: i) { return i - 1 }
        return clips.count - 1
    }

    /// The recording's time at sequence time `t` (clamped to the edit).
    public func source(atSequence t: Double) -> Double {
        guard let i = clipIndex(atSequence: max(0, t)) else { return 0 }
        let c = clips[i]
        return min(c.end, c.start + max(0, t - sequenceStart(of: i)))
    }

    /// The clip holding recording time `s` (nil: removed).
    public func clipIndex(containingSource s: Double) -> Int? {
        clips.firstIndex { s >= $0.start - Self.epsilon && s <= $0.end + Self.epsilon }
    }

    /// Sequence time of recording time `s`; removed footage maps to the start of the clip holding the footage that
    /// follows it in the recording (the end when there is none).
    public func sequence(ofSource s: Double) -> Double {
        if let i = clips.firstIndex(where: { s >= $0.start && s <= $0.end }) { return sequenceStart(of: i) + (s - clips[i].start) }
        if let i = clips.indices.filter({ clips[$0].start > s }).min(by: { clips[$0].start < clips[$1].start }) { return sequenceStart(of: i) }
        return length
    }

    /// Like `sequence(ofSource:)`, but a frame on the seam between two clips belongs to the one that starts there (an
    /// annotation anchored to it moves with that clip); cut-away footage snaps as `sequence(ofSource:)` does.
    public func sequence(ofAnchor s: Double) -> Double {
        if let i = clips.firstIndex(where: { s >= $0.start - 1e-6 && s < $0.end - 1e-6 }) { return sequenceStart(of: i) + max(0, s - clips[i].start) }
        return sequence(ofSource: s)
    }

    /// Where recording range `r` shows in the edited video: one sequence range per clip it overlaps, in sequence order.
    public func sequenceRanges(ofSource r: ClosedRange<Double>) -> [ClosedRange<Double>] {
        var out: [ClosedRange<Double>] = []
        for (i, c) in clips.enumerated() {
            let a = sequenceStart(of: i)
            let lo = max(r.lowerBound, c.start), hi = min(r.upperBound, c.end)
            if hi - lo > Self.epsilon { out.append((a + lo - c.start)...(a + hi - c.start)) }
        }
        return out
    }

    /// Removed footage right at this edge of clip `i`, which dragging the edge out brings back.
    public func hasHiddenMedia(_ i: Int, _ edge: Edge) -> Bool {
        guard clips.indices.contains(i) else { return false }
        let r = limits(i, edge)
        return edge == .start ? clips[i].start - r.lowerBound > Self.epsilon : r.upperBound - clips[i].end > Self.epsilon
    }

    /// How far an edge of clip `i` can go (recording time): out to the footage another clip uses (or the recording's
    /// ends), whatever the order on the timeline; in to leave `minLength`.
    public func limits(_ i: Int, _ edge: Edge) -> ClosedRange<Double> {
        let c = clips[i]
        let others = clips.indices.filter { $0 != i }.map { clips[$0] }
        switch edge {
        case .start:
            let lo = others.filter { $0.end <= c.start + Self.epsilon }.map(\.end).max() ?? 0
            return lo...max(lo, c.end - Self.minLength)
        case .end:
            let hi = others.filter { $0.start >= c.end - Self.epsilon }.map(\.start).min() ?? duration
            return min(hi, c.start + Self.minLength)...hi
        }
    }

    // MARK: Edits

    /// Splits the clip under sequence time `t` in two. Returns the index of the second half; nil too near an edge.
    @discardableResult
    public mutating func split(atSequence t: Double) -> Int? {
        guard let i = clipIndex(atSequence: t) else { return nil }
        let s = source(atSequence: t), c = clips[i]
        guard s - c.start >= Self.minLength, c.end - s >= Self.minLength else { return nil }
        clips[i].end = s
        clips.insert(Clip(start: s, end: c.end, id: nextClipID), at: i + 1)
        nextClipID += 1
        return i + 1
    }

    /// Removes clip `i`; the rest closes up. The last clip can't go (false).
    @discardableResult
    public mutating func deleteClip(_ i: Int) -> Bool {
        guard clips.indices.contains(i), clips.count > 1 else { return false }
        // the seams on either side become one new seam
        if i + 1 < clips.count { seamOverrides[clips[i + 1].id] = nil }
        clips.remove(at: i)
        pruneOverrides()
        return true
    }

    /// Drags an edge of clip `i` to recording time `s`, within `limits`: out restores removed footage, in removes some.
    public mutating func moveEdge(_ i: Int, _ edge: Edge, toSource s: Double) {
        guard clips.indices.contains(i) else { return }
        let r = limits(i, edge)
        let v = min(max(s, r.lowerBound), r.upperBound)
        switch edge {
        case .start: clips[i].start = v
        case .end: clips[i].end = v
        }
    }

    /// v3.8: moves clip `i` to the gap before clip `k` (`k == clips.count`: the end). Returns its new index; nil when it
    /// wouldn't move.
    @discardableResult
    public mutating func moveClip(_ i: Int, toGap k: Int) -> Int? {
        guard clips.indices.contains(i), (0...clips.count).contains(k), k != i, k != i + 1 else { return nil }
        // the seams around its old and new places are different seams now
        seamOverrides[clips[i].id] = nil
        if i + 1 < clips.count { seamOverrides[clips[i + 1].id] = nil }
        if k < clips.count { seamOverrides[clips[k].id] = nil }
        let c = clips.remove(at: i)
        let j = k > i ? k - 1 : k
        clips.insert(c, at: j)
        return j
    }

    /// Removes everything before sequence time `t` (Set Start).
    public mutating func deleteBefore(sequence t: Double) {
        guard let i = clipIndex(atSequence: t) else { return }
        let s = source(atSequence: t)
        if clips[i].end - s < Self.minLength { return }
        clips.removeFirst(i)
        clips[0].start = s
        pruneOverrides()
    }

    /// Removes everything after sequence time `t` (Set End).
    public mutating func deleteAfter(sequence t: Double) {
        guard let i = clipIndex(atSequence: t) else { return }
        let s = source(atSequence: t)
        if s - clips[i].start < Self.minLength { return }
        clips.removeLast(clips.count - i - 1)
        clips[i].end = s
        pruneOverrides()
    }

    public mutating func reset() {
        seamOverrides = [:]
        clips = duration > 0 ? [Clip(start: 0, end: duration)] : []
    }

    // MARK: Playback

    /// What playback does when the clip at timeline index `playing` is at recording time `now`.
    public enum Handover: Equatable, Sendable {
        /// Keep playing: the clip hasn't reached its end.
        case stay
        /// Go on with the next clip; `seekTo` is where its footage starts, nil when it follows on from this one.
        case next(seekTo: Double?)
        /// That was the last clip.
        case stop
    }

    /// Only the clip's own end hands over: a time before the clip (a seek still in flight) never does, so a jump
    /// to a clip that doesn't follow on can't end the playback or skip a clip.
    public func handover(from playing: Int, at now: Double) -> Handover {
        guard clips.indices.contains(playing), now >= clips[playing].end - 0.04 else { return .stay }
        guard playing + 1 < clips.count else { return .stop }
        let next = clips[playing + 1]
        return .next(seekTo: abs(next.start - clips[playing].end) > 0.01 ? next.start : nil)
    }
}
