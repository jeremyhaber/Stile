import Carbon
import Foundation

/// Global hot keys via Carbon: Control+Option+S (pin), Control+Option+Shift+S (overlay on/off), Control+Option+N (little window)
/// and the screenshots: Control+Option+3 / 4 / 5 / 6 (screen, area, window, full Chrome page; like macOS's Shift+Command+3/4/5).
enum HotKey {
    static let pinID: UInt32 = 1
    static let toggleOverlayID: UInt32 = 2
    static let littleID: UInt32 = 3
    static let captureScreenID: UInt32 = 4
    static let captureAreaID: UInt32 = 5
    static let captureWindowID: UInt32 = 6
    static let captureChromePageID: UInt32 = 7
    static let captureActiveWindowID: UInt32 = 8
    static let captureRepeatAreaID: UInt32 = 9
    static let captureScrollingID: UInt32 = 10
    static let recordID: UInt32 = 20

    private static var handlerRef: EventHandlerRef?
    private static var hotKeyRefs: [UInt32: EventHotKeyRef] = [:]
    private static var actions: [UInt32: () -> Void] = [:]

    /// Registers (or replaces) the hot key with the given id. The shared event handler is installed once.
    static func register(id: UInt32, keyCode: Int, modifiers: Int, action: @escaping () -> Void) {
        actions[id] = action
        if handlerRef == nil {
            var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
            let status = InstallEventHandler(GetApplicationEventTarget(), { _, event, _ in
                var hotKeyID = EventHotKeyID()
                let got = GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                                            nil, MemoryLayout<EventHotKeyID>.size, nil, &hotKeyID)
                if got == noErr {
                    let id = hotKeyID.id
                    DispatchQueue.main.async { HotKey.actions[id]?() }
                }
                return noErr
            }, 1, &spec, nil, &handlerRef)
            if status != noErr {
                Log.write("hotkey: InstallEventHandler failed \(status)")
                return
            }
        }
        if let old = hotKeyRefs.removeValue(forKey: id) { UnregisterEventHotKey(old) }
        let hotKeyID = EventHotKeyID(signature: OSType(0x5342_4152), id: id)   // 'SBAR'
        var ref: EventHotKeyRef?
        let status = RegisterEventHotKey(UInt32(keyCode), UInt32(modifiers), hotKeyID,
                                         GetApplicationEventTarget(), 0, &ref)
        if status == noErr, let ref = ref {
            hotKeyRefs[id] = ref
        } else {
            Log.write("hotkey: RegisterEventHotKey(\(id)) failed \(status)")
        }
    }

    /// Control+Option+S.
    static func registerPin(action: @escaping () -> Void) {
        register(id: pinID, keyCode: kVK_ANSI_S, modifiers: controlKey | optionKey, action: action)
    }

    /// Control+Option+N (v2.8: new little window).
    static func registerLittle(action: @escaping () -> Void) {
        register(id: littleID, keyCode: kVK_ANSI_N, modifiers: controlKey | optionKey, action: action)
    }

    /// Control+Option+3 (screen), 4 (area), 5 (window), 6 (full Chrome page);
    /// 7 (scrolling capture); with Shift: 5 (active window), 4 (repeat the last area).
    static func registerCaptures(screen: @escaping () -> Void, area: @escaping () -> Void,
                                 window: @escaping () -> Void, chromePage: @escaping () -> Void,
                                 activeWindow: @escaping () -> Void, repeatArea: @escaping () -> Void,
                                 scrolling: @escaping () -> Void) {
        let mods = controlKey | optionKey
        register(id: captureActiveWindowID, keyCode: kVK_ANSI_5, modifiers: mods | shiftKey, action: activeWindow)
        register(id: captureRepeatAreaID, keyCode: kVK_ANSI_4, modifiers: mods | shiftKey, action: repeatArea)
        register(id: captureScreenID, keyCode: kVK_ANSI_3, modifiers: mods, action: screen)
        register(id: captureAreaID, keyCode: kVK_ANSI_4, modifiers: mods, action: area)
        register(id: captureWindowID, keyCode: kVK_ANSI_5, modifiers: mods, action: window)
        register(id: captureChromePageID, keyCode: kVK_ANSI_6, modifiers: mods, action: chromePage)
        register(id: captureScrollingID, keyCode: kVK_ANSI_7, modifiers: mods, action: scrolling)
    }

    /// Control+Option+8 (v3.6): stop a recording, else open the recorder for the last-used target.
    static func registerRecord(action: @escaping () -> Void) {
        register(id: recordID, keyCode: kVK_ANSI_8, modifiers: controlKey | optionKey, action: action)
    }

    /// Control+Option+Shift+S.
    static func registerToggleOverlay(action: @escaping () -> Void) {
        register(id: toggleOverlayID, keyCode: kVK_ANSI_S, modifiers: controlKey | optionKey | shiftKey, action: action)
    }
}
