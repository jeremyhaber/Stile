import AppKit

/// Matches AX windows to (profile bridge, Chrome windowId) by asking each bridge for its windows
/// and comparing bounds (±3 px). Once mapped, a window keeps its mapping while Chrome still lists its id.
@MainActor
final class WindowMapper {
    struct Mapping {
        let bridge: ProfileBridge
        let windowId: Int
    }

    private(set) var map: [Int: Mapping] = [:]
    var onChange: (() -> Void)?
    var windowsProvider: (() -> [ChromeWindow])?
    var bridgesProvider: (() -> [ProfileBridge])?

    private let debounce = OneShot()
    private var generation = 0
    private let tolerance: Double = 3

    func schedule() {
        debounce.schedule(after: 0.15) { [weak self] in
            self?.debounce.clear()
            self?.run()
        }
    }

    private func run() {
        generation += 1
        let gen = generation
        let wins = windowsProvider?() ?? []
        let bridges = bridgesProvider?() ?? []
        Task {
            var lists: [(ProfileBridge, [[String: Any]])] = []
            for b in bridges {
                do {
                    let res = try await b.call("windows.getAll", [["windowTypes": ["normal", "popup"]]])
                    if let arr = res as? [[String: Any]] { lists.append((b, arr)) }
                } catch {
                    Log.write("mapper: windows.getAll failed for \(b.profileDir): \(error.localizedDescription)")
                }
            }
            self.finish(generation: gen, windows: wins, lists: lists)
        }
    }

    private func near(_ dict: [String: Any], _ f: CGRect) -> Bool {
        guard let l = JSONUtil.double(dict["left"]), let t = JSONUtil.double(dict["top"]),
              let w = JSONUtil.double(dict["width"]), let h = JSONUtil.double(dict["height"]) else { return false }
        return abs(l - Double(f.minX)) <= tolerance && abs(t - Double(f.minY)) <= tolerance
            && abs(w - Double(f.width)) <= tolerance && abs(h - Double(f.height)) <= tolerance
    }

    private func finish(generation gen: Int, windows wins: [ChromeWindow],
                        lists: [(ProfileBridge, [[String: Any]])]) {
        guard gen == generation else { return }
        var newMap: [Int: Mapping] = [:]
        var used = Set<String>()
        func tag(_ b: ProfileBridge, _ id: Int) -> String { "\(b.id.uuidString)#\(id)" }

        // 1. Keep existing mappings that are still valid.
        for w in wins {
            guard let old = map[w.key], !old.bridge.closed else { continue }
            if let entry = lists.first(where: { $0.0 === old.bridge }) {
                if entry.1.contains(where: { JSONUtil.int($0["id"]) == old.windowId }) {
                    newMap[w.key] = old
                    used.insert(tag(old.bridge, old.windowId))
                }
            } else {
                // The bridge did not answer this round; keep the mapping rather than flapping.
                newMap[w.key] = old
                used.insert(tag(old.bridge, old.windowId))
            }
        }

        // 2. Match the rest by bounds.
        for w in wins.sorted(by: { $0.key < $1.key }) where newMap[w.key] == nil && !w.minimized && !w.fullscreen {
            var found: Mapping?
            outer: for (bridge, arr) in lists {
                for d in arr {
                    guard let wid = JSONUtil.int(d["id"]), !used.contains(tag(bridge, wid)) else { continue }
                    if near(d, w.frame) {
                        found = Mapping(bridge: bridge, windowId: wid)
                        break outer
                    }
                }
            }
            if let f = found {
                newMap[w.key] = f
                used.insert(tag(f.bridge, f.windowId))
            }
        }

        var changed = newMap.count != map.count
        if !changed {
            for (k, v) in newMap {
                if let o = map[k], o.bridge === v.bridge, o.windowId == v.windowId { continue }
                changed = true
                break
            }
        }
        map = newMap
        if changed { onChange?() }
    }
}
