// Where the editor runs: a Chrome popup (the extension) or a Stile.app window (WKWebView, `?host=app`).
// The editor only talks to its host through this interface.
import { ext, sw } from './chromeApi'
// @ts-ignore plain JS modules shared with the service worker
import { uploadPng } from '../s3.js'
// @ts-ignore
import { getS3Config } from '../common.js'

export interface EditorHost {
  app: boolean
  /** the picture may still be rendering: Chrome needs the ClipboardItem created inside the click */
  copyImage(b: Promise<Blob>): Promise<void>
  copyText(t: string): Promise<void>
  /** resolves the toast text, or null when the person cancelled */
  save(b: Blob, name: string, askWhere: boolean): Promise<string | null>
  /** uploads to the configured bucket; resolves the link */
  upload(b: Blob): Promise<string>
  setLink(id: string, link: string): Promise<void>
  /** app only: start a native drag of the picture (as a PNG file) into another app */
  dragOut?: (b: Blob, name: string) => void
}

export const chromeHost: EditorHost = {
  app: false,
  copyImage: (b) => navigator.clipboard.write([new ClipboardItem({ 'image/png': b })]),
  copyText: (t) => navigator.clipboard.writeText(t),
  async save(b, name, askWhere) {
    const u = URL.createObjectURL(b)
    try {
      await ext.downloads.download({ url: u, filename: `Screenshots/${name}`, saveAs: askWhere, conflictAction: 'uniquify' })
    } catch (e) {
      if (/cancel/i.test((e as Error).message || '')) return null
      throw e
    } finally {
      setTimeout(() => URL.revokeObjectURL(u), 60_000)
    }
    return 'Saved to Downloads'
  },
  // the editor page does the upload itself: the (possibly annotated) picture is too big to message around
  upload: async (b) => (await uploadPng(await getS3Config(), b)).url,
  setLink: async (id, link) => void (await sw({ cmd: 'captureSetLink', id, link })),
}

// ------------------------------------------------------------------ Stile.app
/** a request to the app (WKScriptMessageHandlerWithReply: resolves the app's reply, rejects with its error) */
export const native = (msg: Record<string, unknown>): Promise<any> =>
  (window as any).webkit.messageHandlers.stileCapture.postMessage(msg)

export function blobToBase64(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(b)
  })
}

/** fetch through the app (URLSession): an S3 bucket's CORS rules would refuse the page's own origin */
async function appFetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: Uint8Array | string }) {
  const body =
    init.body == null ? undefined : await blobToBase64(new Blob([init.body as BlobPart]))
  const r = await native({ op: 'fetch', url, method: init.method || 'GET', headers: init.headers || {}, body })
  return {
    ok: r.status >= 200 && r.status < 300,
    status: r.status as number,
    statusText: (r.statusText as string) || '',
    text: async () => (r.body as string) || '',
  }
}

export function appHost(s3: unknown): EditorHost {
  return {
    app: true,
    copyImage: async (b) => void (await native({ op: 'copyImage', data: await blobToBase64(await b) })),
    copyText: async (text) => void (await native({ op: 'copyText', text })),
    async save(b, name, askWhere) {
      const r = await native({ op: 'save', data: await blobToBase64(b), name, askWhere })
      return r && r.path ? `Saved to ${r.folder}` : null
    },
    upload: async (b) => (await uploadPng(s3, b, { fetch: appFetch as unknown as typeof fetch })).url,
    setLink: async (id, link) => void (await native({ op: 'setLink', id, link })),
    dragOut: (b, name) => {
      void blobToBase64(b).then((data) => native({ op: 'dragOut', data, name }))
    },
  }
}
