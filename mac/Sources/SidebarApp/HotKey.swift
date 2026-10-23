import Carbon
import Foundation

/// Global hot keys via Carbon: Control+Option+S (pin) and Control+Option+Shift+S (overlay on/off).
enum HotKey {
    static let pinID: UInt32 = 1
    static let toggleOverlayID: UInt32 = 2

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

    /// Control+Option+Shift+S.
    static func registerToggleOverlay(action: @escaping () -> Void) {
        register(id: toggleOverlayID, keyCode: kVK_ANSI_S, modifiers: controlKey | optionKey | shiftKey, action: action)
    }
}
