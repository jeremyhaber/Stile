import { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './tokens.css'
import { CaptureEditor, type CaptureMeta } from './CaptureEditor'
import { sw } from './chromeApi'
import { appHost, chromeHost, native } from './host'
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
  // also runs again when the colour changes while the editor is open: start from the plain theme
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t
  else delete document.documentElement.dataset.theme
  document.documentElement.style.removeProperty('--bg')
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
  createRoot(root).render(<ChromeShell meta={got.meta} blob={got.blob} settings={settings} s3={s3} onClose={close} />)
}

/** Settings changed in the side panel or the settings window apply to an open editor right away. */
function ChromeShell(p: { meta: CaptureMeta; blob: Blob; settings: { captureAnnotate: boolean; captureAskWhere: boolean }; s3: unknown; onClose: () => void }) {
  const [settings, setSettings] = useState(p.settings)
  const [s3, setS3] = useState(p.s3)
  useEffect(() => {
    const onSt = (ch: Record<string, unknown>, area: string) => {
      if (area === 'sync' && ('captureAnnotate' in ch || 'captureAskWhere' in ch)) void getCaptureSettings().then(setSettings)
      if (area === 'sync' && 'sidebarColor' in ch) void chrome.storage.sync.get('sidebarColor').then((x: any) => applyTheme(x.sidebarColor)).catch(() => {})
      if (area === 'local' && 'captureS3' in ch) void getS3Config().then(setS3)
    }
    chrome.storage.onChanged.addListener(onSt)
    return () => chrome.storage.onChanged.removeListener(onSt)
  }, [])
  return (
    <CaptureEditor meta={p.meta} blob={p.blob} annotate={settings.captureAnnotate} askWhere={settings.captureAskWhere} uploadReady={s3Configured(s3)} host={chromeHost} onClose={p.onClose} />
  )
}

type AppConfig = { annotate?: boolean; askWhere?: boolean; s3?: unknown; sidebarColor?: { mode?: string; color?: string } }

/** The app pushes the extension's settings again whenever they change (`window.__stileConfig`). */
function AppShell(p: { meta: CaptureMeta; blob: Blob; config: AppConfig; closeRequests: { current: (() => void) | null } }) {
  const [config, setConfig] = useState(p.config)
  useEffect(() => {
    ;(window as any).__stileConfig = (c: AppConfig) => {
      applyTheme(c.sidebarColor)
      setConfig(c)
    }
    return () => void delete (window as any).__stileConfig
  }, [])
  const host = useMemo(() => appHost(config.s3), [config.s3])
  return (
    <CaptureEditor
      meta={p.meta}
      blob={p.blob}
      annotate={config.annotate !== false}
      askWhere={!!config.askWhere}
      uploadReady={s3Configured(config.s3)}
      host={host}
      onClose={() => void native({ op: 'close' })}
      closeRequests={p.closeRequests}
    />
  )
}

/** In a Stile.app window: the app holds the picture (served at /__capture/<id>.png) and the extension's settings. */
async function bootApp() {
  let got: { meta: CaptureMeta; config: AppConfig } | null = null
  let blob: Blob | null = null
  try {
    got = await native({ op: 'load', id })
    if (got) blob = await (await fetch(`/__capture/${encodeURIComponent(id)}.png`)).blob()
  } catch {
    got = null
  }
  if (!got || !blob) {
    root.innerHTML = '<p style="padding:24px;color:var(--text-2)" data-testid="capture-missing">This screenshot is no longer available.</p>'
    return
  }
  const { meta, config } = got
  applyTheme(config.sidebarColor)
  document.title = meta.title || 'Screenshot'
  const closeRequests: { current: (() => void) | null } = { current: null }
  // the window's red button and Command+W ask the page first (unsaved annotations)
  ;(window as any).__stileRequestClose = () => (closeRequests.current ? closeRequests.current() : void native({ op: 'close' }))
  createRoot(root).render(<AppShell meta={meta} blob={blob} config={config} closeRequests={closeRequests} />)
}

if (params.get('host') === 'app') {
  document.documentElement.dataset.host = 'app'
  void bootApp()
} else void boot()
