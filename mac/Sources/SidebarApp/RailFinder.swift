import AppKit
import ApplicationServices

/// Chrome's vertical tab rail as found in a window's accessibility tree.
struct RailInfo {
    let railElement: AXUIElement
    let button: AXUIElement?          // Chrome's collapse/expand button
    let splitter: AXUIElement?        // resize splitter at the rail's right edge, if exposed
    var rel: CGRect                   // rail frame relative to the window's top-left (AX points)

    var expanded: Bool { rel.width >= RailFinder.expandedMinWidth }
}

struct RailScan {
    var rail: RailInfo?
    /// Bottom of Chrome's toolbar relative to the window top (top of the page area), if found.
    var contentTopRel: CGFloat?
    /// Human-readable description of what was found, for the log.
    var logLines: [String] = []
}

enum RailFinder {
    static let maxNodes = 400
    static let maxDepth = 14
    static let expandedMinWidth: CGFloat = 120

    private struct Node {
        let el: AXUIElement
        let parent: Int
        let depth: Int
        let role: String
        let frame: CGRect?
    }

    private static func describe(_ n: Node) -> String {
        let desc = AX.string(n.el, AXName.axDescription) ?? ""
        let title = AX.string(n.el, AXName.axTitle) ?? ""
        let f = n.frame.map { "x=\(Int($0.minX)) y=\(Int($0.minY)) w=\(Int($0.width)) h=\(Int($0.height))" } ?? "no frame"
        return "\(String(repeating: "  ", count: min(n.depth, 8)))\(n.role) desc='\(desc)' title='\(title)' \(f)"
    }

    private static func buttonText(_ el: AXUIElement) -> String {
        [AXName.axDescription, AXName.axTitle, AXName.axHelp]
            .compactMap { AX.string(el, $0) }
            .joined(separator: " ")
            .lowercased()
    }

    /// Breadth-first scan (400 nodes max) of one Chrome window.
    /// The rail is the AXTabGroup that is tall and narrow, widened to its largest same-x ancestor that
    /// is at most 420 wide, no taller than the window and does not contain the toolbar.
    static func scan(window: AXUIElement, windowFrame: CGRect, wantLog: Bool) -> RailScan {
        var nodes: [Node] = [Node(el: window, parent: -1, depth: 0, role: "AXWindow", frame: windowFrame)]
        var i = 0
        while i < nodes.count && nodes.count < maxNodes {
            let n = nodes[i]
            let parentIndex = i
            i += 1
            if n.depth >= maxDepth { continue }
            guard let kids = AX.children(n.el) else { continue }
            for k in kids {
                if nodes.count >= maxNodes { break }
                nodes.append(Node(el: k, parent: parentIndex, depth: n.depth + 1,
                                  role: AX.string(k, AXName.role) ?? "", frame: AX.frame(k)))
            }
        }

        var result = RailScan()

        // Toolbars: needed to keep them out of the rail, and for the top of the page area.
        var toolbarAncestors = Set<Int>()
        var toolbarBottom: CGFloat?
        for n in nodes where n.role == "AXToolbar" {
            var p = n.parent
            while p >= 0 {
                toolbarAncestors.insert(p)
                p = nodes[p].parent
            }
            if let f = n.frame, f.width > windowFrame.width * 0.4 {
                toolbarBottom = max(toolbarBottom ?? f.maxY, f.maxY)
            }
        }
        if let b = toolbarBottom {
            let rel = b - windowFrame.minY
            if rel > 20 && rel < 220 { result.contentTopRel = rel }
        }

        // The tab strip: tall and narrow AXTabGroup inside the window.
        var tabGroupIndex: Int?
        for (idx, n) in nodes.enumerated() where idx > 0 && n.role == "AXTabGroup" {
            guard let f = n.frame, f.width > 16, f.height > 3 * f.width,
                  f.intersects(windowFrame) else { continue }
            tabGroupIndex = idx
            break
        }

        guard let tg = tabGroupIndex, let tgFrame = nodes[tg].frame else {
            if wantLog {
                let groups = nodes.filter { $0.role == "AXTabGroup" }.map { describe($0) }
                result.logLines.append("rail: not found (\(nodes.count) nodes scanned, window w=\(Int(windowFrame.width)) h=\(Int(windowFrame.height)))")
                result.logLines.append(groups.isEmpty ? "  no AXTabGroup nodes" : "  AXTabGroup nodes (none tall and narrow enough):")
                result.logLines.append(contentsOf: groups)
                result.logLines.append("  first levels of the tree:")
                for n in nodes.prefix(60) where n.depth <= 4 { result.logLines.append("  " + describe(n)) }
            }
            return result
        }

        var best = tg
        var cur = nodes[tg].parent
        while cur > 0 {
            guard let f = nodes[cur].frame else { break }
            if abs(f.minX - tgFrame.minX) > 1.5 || f.width > 420 || f.height > windowFrame.height + 1 { break }
            if toolbarAncestors.contains(cur) { break }
            best = cur
            cur = nodes[cur].parent
        }
        guard let railFrame = nodes[best].frame, railFrame.width >= 24, railFrame.width <= 420 else {
            if wantLog { result.logLines.append("rail: AXTabGroup found but its container has an odd width") }
            return result
        }

        // Collapse/expand button: inside the rail first, anywhere in the window otherwise.
        var inside: Int?
        var anywhere: Int?
        for (idx, n) in nodes.enumerated() where n.role == "AXButton" {
            let text = buttonText(n.el)
            guard text.contains("tab"), text.contains("collapse") || text.contains("expand") else { continue }
            if anywhere == nil { anywhere = idx }
            if inside == nil, let f = n.frame, railFrame.insetBy(dx: -2, dy: -2).contains(CGPoint(x: f.midX, y: f.midY)) {
                inside = idx
            }
        }
        let buttonIndex = inside ?? anywhere

        var splitterIndex: Int?
        for (idx, n) in nodes.enumerated() where n.role == "AXSplitter" {
            if let f = n.frame, f.height > 100, f.width < 20, abs(f.midX - railFrame.maxX) < 16 {
                splitterIndex = idx
                break
            }
        }

        let rel = CGRect(x: railFrame.minX - windowFrame.minX, y: railFrame.minY - windowFrame.minY,
                         width: railFrame.width, height: railFrame.height)
        result.rail = RailInfo(railElement: nodes[best].el,
                               button: buttonIndex.map { nodes[$0].el },
                               splitter: splitterIndex.map { nodes[$0].el },
                               rel: rel)

        if wantLog {
            result.logLines.append("rail: found, width \(Int(railFrame.width)) (\(railFrame.width < expandedMinWidth ? "collapsed" : "expanded")), \(nodes.count) nodes scanned")
            var chain: [Int] = []
            var c = tg
            while c >= 0 { chain.append(c); c = nodes[c].parent }
            result.logLines.append("  path to tab strip (window -> AXTabGroup):")
            for idx in chain.reversed() where nodes[idx].depth <= 8 {
                result.logLines.append("  " + describe(nodes[idx]) + (idx == best ? "   <== rail" : ""))
            }
            if best != tg { result.logLines.append("  rail container: " + describe(nodes[best]).trimmingCharacters(in: .whitespaces)) }
            if let b = buttonIndex {
                result.logLines.append("  collapse/expand button: " + describe(nodes[b]).trimmingCharacters(in: .whitespaces))
            } else {
                result.logLines.append("  collapse/expand button: NOT FOUND (pinning will float over the page)")
                let buttons = nodes.filter { $0.role == "AXButton" }.prefix(30).map { describe($0).trimmingCharacters(in: .whitespaces) }
                result.logLines.append("  buttons seen: " + buttons.joined(separator: " | "))
            }
            if let s = splitterIndex {
                result.logLines.append("  splitter: " + describe(nodes[s]).trimmingCharacters(in: .whitespaces))
            }
            if let top = result.contentTopRel { result.logLines.append("  toolbar bottom at +\(Int(top))") }
        }
        return result
    }
}
