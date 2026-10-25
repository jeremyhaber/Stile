// Thin typed access to the extension APIs the editor uses.
declare const chrome: any
// through globalThis: the editor also runs in a Stile.app window (WebKit), where `chrome` is undefined
export const ext = (globalThis as any).chrome as {
  downloads: { download: (o: Record<string, unknown>) => Promise<number> }
  runtime: any
  windows: any
  storage: any
}
/** a command to the service worker (returns its response object) */
export const sw = (msg: Record<string, unknown>): Promise<any> =>
  new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (r: unknown) => {
        void chrome.runtime.lastError
        resolve(r)
      })
    } catch {
      resolve(undefined)
    }
  })
