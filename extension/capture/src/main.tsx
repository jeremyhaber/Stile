import { createRoot } from 'react-dom/client'
import './tokens.css'
import { CaptureEditor, type CaptureMeta } from './CaptureEditor'
import { sw } from './chromeApi'
// @ts-ignore plain JS modules shared with the service worker
import { getMeta, getBlob, getCaptureSettings, getS3Config } from '../common.js'
// @ts-ignore
import { s3Configured } from '../s3.js'

declare const chrome: any
const params = new URLSearchParams(location.search)
const id = params.get('id') || ''
const root = document.getElementById('root')!

function applyTheme(custom: { mode?: string; color?: string } | undefined) {
  const t = params.get('theme')
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t
  // a custom sidebar colour tints the editor chrome, like the side panel
  if (custom && custom.mode === 'custom' && /^#[0-9a-f]{6}$/i.test(custom.color || '')) {
    const c = custom.color!
    const n = parseInt(c.slice(1), 16)
    const lum = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255
    const st = document.documentElement.style
    st.setProperty('--bg', c)
    if (lum < 0.5 && params.get('theme') !== 'light') document.documentElement.dataset.theme = 'dark'
    else if (lum >= 0.5 && params.get('theme') !== 'dark') document.documentElement.dataset.theme = 'light'
  }
}

function dataUrlToBlob(u: string): Blob {
  const [head, b64] = u.split(',')
  const bin = atob(b64!)
  const a = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i)
  return new Blob([a], { type: /data:([^;]+)/.exec(head!)?.[1] || 'image/png' })
}

async function load(): Promise<{ meta: CaptureMeta; blob: Blob } | null> {
  try {
    const meta = await getMeta(id)
    const blob = meta && (await getBlob(id))
    if (meta && blob) return { meta, blob }
  } catch {
    /* private captures live in the service worker */
  }
  const m = await sw({ cmd: 'captureMeta', id })
  const i = m && m.ok ? await sw({ cmd: 'captureImage', id }) : null
  if (m && m.ok && i && i.ok) return { meta: m.meta, blob: dataUrlToBlob(i.dataUrl) }
  return null
}

/** Size the popup to the picture (max 85% of the screen) and centre it. */
async function fitWindow(meta: CaptureMeta) {
  try {
    const win = await chrome.windows.getCurrent()
    const dpr = meta.dpr || 1
    const sw0 = (screen as any).availWidth, sh0 = (screen as any).availHeight
    const left0 = (screen as any).availLeft ?? 0, top0 = (screen as any).availTop ?? 0
    const chromeW = window.outerWidth - window.innerWidth, chromeH = window.outerHeight - window.innerHeight
    const wantW = Math.round(meta.width / dpr) + 48
    const wantH = Math.round(meta.height / dpr) + 48 + 46 + 28
    const innerW = Math.min(Math.round(sw0 * 0.85) - chromeW, Math.max(780, wantW))
    const innerH = Math.min(Math.round(sh0 * 0.85) - chromeH, Math.max(460, wantH))
    const w = innerW + chromeW, h = innerH + chromeH
    await chrome.windows.update(win.id, { width: w, height: h, left: Math.round(left0 + (sw0 - w) / 2), top: Math.round(top0 + (sh0 - h) / 2) })
  } catch {
    /* a tab, not a popup (tests): leave it */
  }
}

async function boot() {
  const [settings, s3, sync] = await Promise.all([
    getCaptureSettings(),
    getS3Config(),
    chrome.storage.sync.get('sidebarColor').catch(() => ({})),
  ])
  applyTheme(sync && sync.sidebarColor)
  const got = await load()
  if (!got) {
    root.innerHTML = '<p style="padding:24px;color:var(--text-2)" data-testid="capture-missing">This screenshot is no longer available.</p>'
    return
  }
  document.title = `Screenshot${got.meta.title ? ' – ' + got.meta.title : ''}`
  void sw({ cmd: 'captureEditorOpened', id })
  void fitWindow(got.meta)
  const close = async () => {
    try {
      const w = await chrome.windows.getCurrent()
      if (w && w.type === 'popup') await chrome.windows.remove(w.id)
      else window.close()
    } catch {
      window.close()
    }
  }
  if (got.meta.incognito) addEventListener('pagehide', () => void sw({ cmd: 'captureDiscard', id }))
  createRoot(root).render(
    <CaptureEditor meta={got.meta} blob={got.blob} annotate={settings.captureAnnotate} askWhere={settings.captureAskWhere} uploadReady={s3Configured(s3)} onClose={close} />,
  )
}
void boot()
