import Carbon
import Foundation

/// Global hot key (Control+Option+S) via Carbon.
enum HotKey {
    private static var handlerRef: EventHandlerRef?
    private static var hotKeyRef: EventHotKeyRef?
    private static var action: (() -> Void)?

    static func register(action: @escaping () -> Void) {
        self.action = action
        if handlerRef == nil {
            var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
            let status = InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in
                DispatchQueue.main.async { HotKey.action?() }
                return noErr
            }, 1, &spec, nil, &handlerRef)
            if status != noErr {
                Log.write("hotkey: InstallEventHandler failed \(status)")
                return
            }
        }
        let hotKeyID = EventHotKeyID(signature: OSType(0x5342_4152), id: 1)   // 'SBAR'
        let modifiers = UInt32(controlKey | optionKey)
        let status = RegisterEventHotKey(UInt32(kVK_ANSI_S), modifiers, hotKeyID,
                                         GetApplicationEventTarget(), 0, &hotKeyRef)
        if status != noErr { Log.write("hotkey: RegisterEventHotKey failed \(status)") }
    }
}
