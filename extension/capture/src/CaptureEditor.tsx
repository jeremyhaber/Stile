import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { AnnotateStage, hintFor, type StageControls } from './annotate/AnnotateStage'
import { AnnotateProps, AnnotateTools } from './annotate/AnnotateToolbar'
import { flattenToFile } from './annotate/flatten'
import { measureText } from './annotate/measure'
import { FIT_VIEW, type StageView } from './annotate/model'
import { useAnnotator } from './annotate/useAnnotator'
import { Button, Dialog, Toasts, type ToastMsg } from './ui'
import { Icon } from './icons'
import { loadImage, type LoadedImage } from './loadImage'
import { sw, ext } from './chromeApi'
import s from './editor.module.css'

export interface CaptureMeta {
  id: string
  time: number
  url: string
  title: string
  mode: 'visible' | 'full' | 'region'
  width: number
  height: number
  dpr: number
  note?: string
  link?: string
  incognito?: boolean
}
export interface EditorProps {
  meta: CaptureMeta
  blob: Blob
  annotate: boolean
  askWhere: boolean
  uploadReady: boolean
  /** called by the shell to close the editor window */
  onClose: () => void
}
const MODE_LABEL = { visible: 'Visible area', full: 'Full page', region: 'Region' } as const

const pad = (n: number) => String(n).padStart(2, '0')
export function screenshotName(d = new Date()) {
  return `Screenshot ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} at ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}.png`
}
const mac = /Mac/i.test(navigator.platform)
const modKey = mac ? '⌘' : 'Ctrl+'

export function CaptureEditor({ meta, blob, annotate, askWhere, uploadReady, onClose }: EditorProps) {
  const url = useMemo(() => URL.createObjectURL(blob), [blob])
  useEffect(() => () => URL.revokeObjectURL(url), [url])
  const [loaded, setLoaded] = useState<LoadedImage | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [fit, setFit] = useState(1)
  const [stageView, setStageView] = useState<StageView>(FIT_VIEW)
  const controls = useRef<StageControls | null>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const appRef = useRef<HTMLDivElement>(null)
  const [confirming, setConfirming] = useState(false)
  const [toasts, setToasts] = useState<ToastMsg[]>([])
  const [link, setLink] = useState(meta.link ?? '')
  const [uploading, setUploading] = useState(false)
  const hintId = 'annotate-hint'
  const dpr = meta.dpr || 1

  const toast = useCallback((text: string) => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t, { id, text }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2800)
  }, [])

  useEffect(() => {
    let live = true
    loadImage(url).then(
      (l) => live && setLoaded(l),
      () => live && setLoadError(true),
    )
    return () => {
      live = false
    }
  }, [url])

  const img = { w: loaded?.width ?? meta.width ?? 1, h: loaded?.height ?? meta.height ?? 1 }
  const annot = useAnnotator({ img, scale: fit * stageView.zoom, measure: measureText })
  useEffect(() => setStageView(FIT_VIEW), [annot.view.w, annot.view.h])

  // a tall full-page capture opens at width-fit, top first (Fit shows the whole picture)
  const initialZoom = useRef(false)
  useEffect(() => {
    if (!loaded || initialZoom.current || !annotate) return
    initialZoom.current = true
    if (loaded.height / loaded.width < 2.2) return
    const t = setTimeout(() => controls.current?.fitWidth(), 120)
    return () => clearTimeout(t)
  }, [loaded, annotate])

  const crop = annot.doc.crop
  const outW = Math.round(crop ? crop.w : img.w)
  const outH = Math.round(crop ? crop.h : img.h)

  // ---------------------------------------------------------------- export
  const exportBlob = useCallback(async (): Promise<Blob> => {
    if (!annotate || !annot.dirty || !loaded) return blob
    annot.commitEdit()
    const f = await flattenToFile({
      source: loaded.source,
      width: loaded.width,
      height: loaded.height,
      doc: annot.doc,
      mime: 'image/png',
      name: 'Screenshot',
      // screenshots keep every pixel (full-page captures can be 30 000 px tall)
      maxPixels: 268_000_000,
      maxSide: 32_767,
    })
    return f
  }, [annotate, annot, loaded, blob])
  const exportRef = useRef(exportBlob)
  exportRef.current = exportBlob

  // the drag-out handle needs the file ready synchronously: keep a flattened copy up to date
  const [outUrl, setOutUrl] = useState(url)
  useEffect(() => {
    if (!annotate || !annot.dirty || !loaded) {
      setOutUrl(url)
      return
    }
    let dead = false
    let made: string | null = null
    const t = setTimeout(async () => {
      try {
        const f = await flattenToFile({ source: loaded.source, width: loaded.width, height: loaded.height, doc: annot.doc, mime: 'image/png', name: 'Screenshot', maxPixels: 268_000_000, maxSide: 32_767 })
        if (dead) return
        made = URL.createObjectURL(f)
        setOutUrl(made)
      } catch {
        /* the drag handle falls back to the original */
      }
    }, 400)
    return () => {
      dead = true
      clearTimeout(t)
      if (made) setTimeout(() => URL.revokeObjectURL(made!), 1000)
    }
  }, [annotate, annot.dirty, annot.doc, loaded, url])

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': exportRef.current() })])
      toast('Copied to the clipboard')
      annot.say('Copied to the clipboard')
    } catch (e) {
      toast('Couldn’t copy: ' + ((e as Error).message || 'clipboard unavailable'))
    }
  }, [toast, annot])

  const save = useCallback(async () => {
    try {
      const b = await exportRef.current()
      const u = URL.createObjectURL(b)
      await ext.downloads.download({ url: u, filename: `Screenshots/${screenshotName()}`, saveAs: askWhere, conflictAction: 'uniquify' })
      setTimeout(() => URL.revokeObjectURL(u), 60_000)
      toast('Saved to Downloads')
    } catch (e) {
      const m = (e as Error).message || ''
      if (!/cancel/i.test(m)) toast('Couldn’t save: ' + m)
    }
  }, [askWhere, toast])

  const copyLink = useCallback(
    async (l: string) => {
      try {
        await navigator.clipboard.writeText(l)
        toast('Link copied')
      } catch {
        toast('Couldn’t copy the link')
      }
    },
    [toast],
  )
  const upload = useCallback(async () => {
    if (uploading) return
    setUploading(true)
    try {
      const b = await exportRef.current()
      // the editor page does the upload itself: the (possibly annotated) picture is too big to message around
      const { uploadPng } = await import('../s3.js')
      const { getS3Config } = await import('../common.js')
      const r = await uploadPng(await getS3Config(), b)
      setLink(r.url)
      await sw({ cmd: 'captureSetLink', id: meta.id, link: r.url })
      await copyLink(r.url)
    } catch (e) {
      toast('Upload failed: ' + ((e as Error).message || 'unknown error'))
    } finally {
      setUploading(false)
    }
  }, [uploading, meta.id, toast, copyLink])

  // ---------------------------------------------------------------- closing + keys
  const requestClose = useCallback(() => {
    if (annotate && annot.dirty) setConfirming(true)
    else onClose()
  }, [annotate, annot.dirty, onClose])
  const closeRef = useRef(requestClose)
  closeRef.current = requestClose
  const annotRef = useRef(annot)
  annotRef.current = annot
  const confirmingRef = useRef(confirming)
  confirmingRef.current = confirming

  useEffect(() => {
    // Escape: finish a text box, then deselect, then close (a dirty editor asks first)
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || confirmingRef.current) return
      if (annotate && annotRef.current.escape()) {
        e.preventDefault()
        e.stopPropagation()
        return
      }
      e.preventDefault()
      closeRef.current()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [annotate])

  const onKeyDown = (e: KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey
    if (!mod || e.altKey) return
    const t = e.target as HTMLElement
    const typing = !!t.closest('textarea, input, select')
    const k = e.key.toLowerCase()
    if (k === 's') {
      e.preventDefault()
      void save()
    } else if (k === 'c' && (e.shiftKey || (!typing && !annot.selected && !(window.getSelection()?.toString())))) {
      e.preventDefault()
      void copy()
    } else if (annotate && !typing && k === 'z') {
      e.preventDefault()
      if (e.shiftKey) annot.redo()
      else annot.undo()
    } else if (annotate && !typing && k === 'y') {
      e.preventDefault()
      annot.redo()
    }
  }

  // ---------------------------------------------------------------- zoom
  useEffect(() => {
    const el = canvasRef.current
    if (!el || !annotate) return
    const onWheel = (e: WheelEvent) => {
      const c = controls.current
      if (!c) return
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        c.zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.012 : 0.004)), e.clientX, e.clientY)
      } else if (stageViewRef.current.zoom > 1) {
        e.preventDefault()
        c.panBy(-e.deltaX, -e.deltaY)
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [annotate])
  const stageViewRef = useRef(stageView)
  stageViewRef.current = stageView
  const pct = Math.round(fit * stageView.zoom * dpr * 100)
  const actualSize = () => {
    const target = 1 / dpr
    controls.current?.zoomBy(target / (fit * stageView.zoom))
  }

  // ---------------------------------------------------------------- render
  const showProps = annotate && (annot.tool !== 'select' || !!annot.selected || !!annot.editing)
  const focusStage = useCallback(() => {
    appRef.current?.querySelector<HTMLElement>('[data-testid="annotate-stage"]')?.focus()
  }, [])
  const name = meta.title || 'Screenshot'
  const dragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData('DownloadURL', `image/png:${screenshotName()}:${outUrl}`)
    e.dataTransfer.effectAllowed = 'copy'
  }

  let body
  if (loadError) body = <p className={s.message} role="alert">This screenshot can’t be opened.</p>
  else if (!annotate)
    body = (
      <div className={s.plain} data-testid="capture-plain">
        <img src={url} alt={`Screenshot of ${name}`} />
      </div>
    )
  else if (!loaded) body = <p className={s.message} role="status">Loading…</p>
  else
    body = (
      <AnnotateStage
        annot={annot}
        img={img}
        imageUrl={url}
        name={name}
        hintId={hintId}
        onScale={setFit}
        stageView={stageView}
        onStageView={setStageView}
        coarse={false}
        phone={false}
        controls={controls}
        maxUp={1 / dpr}
      />
    )

  return (
    <div className={s.app} ref={appRef} data-testid="capture-editor" data-mode={meta.mode} data-annotate={annotate} onKeyDown={onKeyDown}>
      <header className={s.bar} role="banner">
        <div className={s.exports} role="group" aria-label="Export">
          <button type="button" className={s.ebtn} data-testid="capture-copy" title={`Copy to the clipboard (${modKey}${mac ? '⇧C' : 'Shift+C'})`} onClick={() => void copy()}>
            <Icon name="copy" />
            <span className={s.lbl}>Copy</span>
          </button>
          <button type="button" className={s.ebtn} data-testid="capture-save" title={`Save to Downloads (${modKey}S)`} onClick={() => void save()}>
            <Icon name="save" />
            <span className={s.lbl}>Save</span>
          </button>
          {uploadReady && (
            <button type="button" className={s.ebtn} data-testid="capture-upload" aria-disabled={uploading || undefined} title="Upload and copy the link" onClick={() => void upload()}>
              <Icon name="upload" />
              <span className={s.lbl}>{uploading ? 'Uploading…' : 'Upload'}</span>
            </button>
          )}
          <span
            className={`${s.ebtn} ${s.grip}`}
            data-testid="capture-drag"
            role="img"
            aria-label="Drag the picture into another app"
            title="Drag the picture into another app"
            draggable
            onDragStart={dragStart}
          >
            <Icon name="grip" />
          </span>
        </div>
        {annotate && <span className={s.vsep} role="separator" />}
        <div className={s.centre}>{annotate && <AnnotateTools annot={annot} />}</div>
        {annotate && (
          <div className={s.zoom} role="group" aria-label="Zoom">
            <button type="button" className={`${s.ebtn} ${s.zbtn}`} data-testid="capture-zoom-out" aria-label="Zoom out" title="Zoom out" aria-disabled={stageView.zoom <= 1 || undefined} onClick={() => controls.current?.zoomBy(1 / 1.5)}>
              <Icon name="minus" />
            </button>
            <button type="button" className={`${s.ebtn} ${s.pct}`} data-testid="capture-fit" aria-label={`Fit to window, ${pct}%`} title="Fit the whole picture in the window" onClick={() => setStageView(FIT_VIEW)}>
              {stageView.zoom === 1 ? 'Fit' : `${pct}%`}
            </button>
            <button type="button" className={`${s.ebtn} ${s.zbtn}`} data-testid="capture-actual" title="Actual size (100%)" onClick={actualSize}>
              1:1
            </button>
            <button type="button" className={`${s.ebtn} ${s.zbtn}`} data-testid="capture-zoom-in" aria-label="Zoom in" title="Zoom in" onClick={() => controls.current?.zoomBy(1.5)}>
              <Icon name="plus" />
            </button>
          </div>
        )}
      </header>

      <div className={s.canvas} ref={canvasRef}>
        {body}
        {showProps && (
          <div className={s.floating} data-testid="capture-props">
            <AnnotateProps annot={annot} afterAction={focusStage} />
          </div>
        )}
      </div>
      <p id={hintId} className="sr-only">{hintFor(annot.tool)}</p>
      <div className="sr-only" role="status" aria-live="polite" data-testid="annotate-status">{annot.status}</div>

      <footer className={s.status} data-testid="capture-status">
        <span data-testid="capture-size">{outW} × {outH} px</span>
        <i className={s.dot} />
        <span data-testid="capture-mode">{MODE_LABEL[meta.mode]}</span>
        {meta.note && (<><i className={s.dot} /><span title={meta.note}>{meta.note}</span></>)}
        {meta.url && (
          <>
            <i className={s.dot} />
            <span className={s.t}>
              <a href={meta.url} target="_blank" rel="noreferrer" data-testid="capture-page-link" title={meta.url}>{meta.title || meta.url}</a>
            </span>
          </>
        )}
        <span className={s.spacer} />
        {link && (
          <span className={s.link} data-testid="capture-link">
            <code title={link}>{link}</code>
            <button type="button" className={s.mini} data-testid="capture-copy-link" onClick={() => void copyLink(link)}>Copy link</button>
          </span>
        )}
      </footer>

      <Toasts items={toasts} />
      <Dialog
        open={confirming}
        title="Discard changes?"
        description="The annotations you made on this screenshot will be lost."
        onClose={() => {
          setConfirming(false)
          setTimeout(focusStage, 0)
        }}
        footer={
          <>
            <Button onClick={() => { setConfirming(false); setTimeout(focusStage, 0) }} data-testid="annotate-keep">Keep editing</Button>
            <Button variant="danger" data-testid="annotate-discard" onClick={() => { setConfirming(false); onClose() }}>Discard</Button>
          </>
        }
      />
    </div>
  )
}
