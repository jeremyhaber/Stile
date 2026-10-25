import AppKit
import ApplicationServices

// Private but long-stable API that maps an AX window to its CGWindowID.
@_silgen_name("_AXUIElementGetWindow")
func _AXUIElementGetWindow(_ element: AXUIElement, _ id: UnsafeMutablePointer<CGWindowID>) -> AXError

/// Attribute / action / notification names as plain strings (identical to the kAX* constants).
enum AXName {
    static let position = "AXPosition"
    static let size = "AXSize"
    static let windows = "AXWindows"
    static let role = "AXRole"
    static let subrole = "AXSubrole"
    static let children = "AXChildren"
    static let minimized = "AXMinimized"
    static let fullScreen = "AXFullScreen"
    static let closeButton = "AXCloseButton"
    static let zoomButton = "AXZoomButton"
    static let main = "AXMain"
    static let focusedWindow = "AXFocusedWindow"
    static let axTitle = "AXTitle"
    static let axDescription = "AXDescription"
    static let axHelp = "AXHelp"

    static let actionRaise = "AXRaise"
    static let actionPress = "AXPress"

    static let windowCreated = "AXWindowCreated"
    static let elementDestroyed = "AXUIElementDestroyed"
    static let moved = "AXMoved"
    static let resized = "AXResized"
    static let focusedWindowChanged = "AXFocusedWindowChanged"
    static let windowMiniaturized = "AXWindowMiniaturized"
    static let windowDeminiaturized = "AXWindowDeminiaturized"
}

enum AX {
    static func copy(_ el: AXUIElement, _ attr: String) -> CFTypeRef? {
        var value: CFTypeRef?
        let err = AXUIElementCopyAttributeValue(el, attr as CFString, &value)
        return err == .success ? value : nil
    }

    static func string(_ el: AXUIElement, _ attr: String) -> String? {
        copy(el, attr) as? String
    }

    static func bool(_ el: AXUIElement, _ attr: String) -> Bool? {
        guard let v = copy(el, attr) else { return nil }
        if CFGetTypeID(v) == CFBooleanGetTypeID() {
            return CFBooleanGetValue(unsafeBitCast(v, to: CFBoolean.self))
        }
        return nil
    }

    static func element(_ el: AXUIElement, _ attr: String) -> AXUIElement? {
        guard let v = copy(el, attr), CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
        return unsafeBitCast(v, to: AXUIElement.self)
    }

    static func children(_ el: AXUIElement, _ attr: String = AXName.children) -> [AXUIElement]? {
        copy(el, attr) as? [AXUIElement]
    }

    static func point(_ el: AXUIElement, _ attr: String) -> CGPoint? {
        guard let v = copy(el, attr), CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
        let av = unsafeBitCast(v, to: AXValue.self)
        var p = CGPoint.zero
        return AXValueGetValue(av, .cgPoint, &p) ? p : nil
    }

    static func size(_ el: AXUIElement, _ attr: String) -> CGSize? {
        guard let v = copy(el, attr), CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
        let av = unsafeBitCast(v, to: AXValue.self)
        var s = CGSize.zero
        return AXValueGetValue(av, .cgSize, &s) ? s : nil
    }

    /// Top-left-origin global frame.
    static func frame(_ el: AXUIElement) -> CGRect? {
        guard let p = point(el, AXName.position), let s = size(el, AXName.size) else { return nil }
        return CGRect(origin: p, size: s)
    }

    @discardableResult
    static func setPosition(_ el: AXUIElement, _ point: CGPoint) -> Bool {
        var p = point
        guard let v = AXValueCreate(.cgPoint, &p) else { return false }
        return AXUIElementSetAttributeValue(el, AXName.position as CFString, v) == .success
    }

    @discardableResult
    static func setSize(_ el: AXUIElement, _ size: CGSize) -> Bool {
        var s = size
        guard let v = AXValueCreate(.cgSize, &s) else { return false }
        return AXUIElementSetAttributeValue(el, AXName.size as CFString, v) == .success
    }

    @discardableResult
    static func setBool(_ el: AXUIElement, _ attr: String, _ value: Bool) -> Bool {
        let v: CFBoolean = value ? kCFBooleanTrue : kCFBooleanFalse
        return AXUIElementSetAttributeValue(el, attr as CFString, v) == .success
    }

    @discardableResult
    static func perform(_ el: AXUIElement, _ action: String) -> Bool {
        AXUIElementPerformAction(el, action as CFString) == .success
    }

    static func cgWindowID(_ el: AXUIElement) -> CGWindowID {
        var id = CGWindowID(0)
        if _AXUIElementGetWindow(el, &id) == .success { return id }
        return 0
    }

    /// Stable identity for a window element: its CGWindowID when available, else a negative hash.
    static func windowKey(_ el: AXUIElement) -> Int {
        let id = cgWindowID(el)
        if id != 0 { return Int(id) }
        let h = Int(truncatingIfNeeded: CFHash(el)) & 0x3fffffff
        return -(h + 1)
    }

    static func pid(_ el: AXUIElement) -> pid_t {
        var p: pid_t = 0
        _ = AXUIElementGetPid(el, &p)
        return p
    }

    /// Breadth-first search for the first AXToolbar below the window; returns its top (AX coords).
    static func toolbarTop(in window: AXUIElement, maxDepth: Int = 6, maxNodes: Int = 500) -> CGFloat? {
        var queue: [(AXUIElement, Int)] = [(window, 0)]
        var index = 0
        while index < queue.count && index < maxNodes {
            let (el, depth) = queue[index]
            index += 1
            if depth > 0, string(el, AXName.role) == "AXToolbar", let f = frame(el) {
                return f.minY
            }
            if depth < maxDepth, let kids = children(el) {
                for k in kids { queue.append((k, depth + 1)) }
            }
        }
        return nil
    }
}

enum CGInfo {
    /// Window IDs currently on screen (current Space), any owner.
    static func onScreenWindowInfo() -> [[String: Any]] {
        let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        guard let arr = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else { return [] }
        return arr
    }

    /// Live window-server bounds (top-left origin, same space as AX) for the given windows.
    /// One window uses `.optionIncludingWindow`; several use a single on-screen list call.
    static func boundsMap(ids: [CGWindowID]) -> [CGWindowID: CGRect] {
        var out: [CGWindowID: CGRect] = [:]
        if ids.isEmpty { return out }
        let arr: [[String: Any]]
        if ids.count == 1 {
            arr = (CGWindowListCopyWindowInfo([.optionIncludingWindow], ids[0]) as? [[String: Any]]) ?? []
        } else {
            arr = (CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]]) ?? []
        }
        let wanted = Set(ids)
        for info in arr {
            guard let n = info["kCGWindowNumber"] as? NSNumber else { continue }
            let id = CGWindowID(n.uint32Value)
            guard wanted.contains(id),
                  let boundsDict = info["kCGWindowBounds"] as? NSDictionary,
                  let b = CGRect(dictionaryRepresentation: boundsDict as CFDictionary) else { continue }
            out[id] = b
        }
        return out
    }

    /// Fallback CGWindowID by owner pid + bounds.
    static func match(pid: pid_t, frame: CGRect, in infos: [[String: Any]]) -> CGWindowID {
        for info in infos {
            guard let owner = info["kCGWindowOwnerPID"] as? NSNumber, owner.int32Value == pid,
                  let layer = info["kCGWindowLayer"] as? NSNumber, layer.intValue == 0,
                  let number = info["kCGWindowNumber"] as? NSNumber,
                  let boundsDict = info["kCGWindowBounds"] as? NSDictionary,
                  let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary) else { continue }
            if abs(bounds.minX - frame.minX) <= 2, abs(bounds.minY - frame.minY) <= 2,
               abs(bounds.width - frame.width) <= 2, abs(bounds.height - frame.height) <= 2 {
                return CGWindowID(number.uint32Value)
            }
        }
        return 0
    }
}
