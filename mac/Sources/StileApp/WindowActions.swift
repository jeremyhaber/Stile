import AppKit
import ApplicationServices

/// v3.1: window arrangement used by the header's green button (Fill, Tile, Restore, full screen).
enum WindowActions {
    enum Arrangement { case none, fill, left, right }

    /// Visible frame (menu bar and Dock excluded) of the screen holding most of `frame`, in AX coordinates.
    static func visibleFrame(for frame: CGRect) -> CGRect? {
        guard let s = Geometry.screen(forAXRect: frame) else { return nil }
        return Geometry.flip(s.visibleFrame)
    }

    static func target(_ a: Arrangement, in vf: CGRect) -> CGRect {
        switch a {
        case .left: return CGRect(x: vf.minX, y: vf.minY, width: (vf.width / 2).rounded(.down), height: vf.height)
        case .right:
            let w = (vf.width / 2).rounded(.down)
            return CGRect(x: vf.maxX - w, y: vf.minY, width: w, height: vf.height)
        default: return vf
        }
    }

    /// Which arrangement `frame` currently is (within 4 pt of the screen's fill / left half / right half).
    static func arrangement(of frame: CGRect) -> Arrangement {
        guard let vf = visibleFrame(for: frame) else { return .none }
        func near(_ a: CGRect, _ b: CGRect) -> Bool {
            abs(a.minX - b.minX) <= 4 && abs(a.minY - b.minY) <= 4 && abs(a.width - b.width) <= 4 && abs(a.height - b.height) <= 4
        }
        for a in [Arrangement.fill, .left, .right] where near(frame, target(a, in: vf)) { return a }
        return .none
    }

    /// Size, position, size again (the first size may be limited by the old position).
    static func setFrame(_ el: AXUIElement, _ r: CGRect) {
        AX.setSize(el, r.size)
        AX.setPosition(el, r.origin)
        AX.setSize(el, r.size)
    }

    static func setFullScreen(_ el: AXUIElement, _ on: Bool) {
        if AX.setBool(el, AXName.fullScreen, on) { return }
        if let b = AX.element(el, AXName.fullScreenButton) { AX.perform(b, AXName.actionPress) }
    }
}

/// Target for NSMenuItem actions that run a closure (the menu is popped up synchronously, the caller keeps these alive).
final class MenuBlock: NSObject {
    let block: () -> Void
    init(_ block: @escaping () -> Void) { self.block = block }
    @objc func run() { block() }
}
