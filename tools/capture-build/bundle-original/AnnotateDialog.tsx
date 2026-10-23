import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import * as RD from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { useMediaQuery } from '../../../lib/theme'
import { Dialog } from '../../../ui/Dialog'
import { Button, IconButton, Spinner } from '../../../ui/primitives'
import { useToast } from '../../../ui/Toast'
import { ExpandButton, useModalCard } from '../../preview/viewerChrome'
import { useViewerExpanded } from '../../preview/viewerWindow'
import p from '../../preview/preview.module.css'
import { AnnotateStage, hintFor } from './AnnotateStage'
import { AnnotateProps, AnnotateTools, HistoryButtons } from './AnnotateToolbar'
import { flattenToFile } from './flatten'
import { measureText } from './measure'
import { FIT_VIEW, type StageView } from './model'
import { useAnnotator } from './useAnnotator'
import s from './annotate.module.css'

export interface AnnotateImage {
  /** same-origin URL the picture loads from (the draft attachment) */
  url: string
  name: string
  mime: string
}

export interface LoadedImage {
  /** the full-resolution picture, for the export */
  source: CanvasImageSource
  width: number
  height: number
  /** a screen-sized copy of a big picture (object URL) that the stage draws instead, so a phone photo stays light */
  previewUrl?: string
}

/** pictures bigger than this on the long side are previewed from a smaller copy */
export const PREVIEW_MAX = 2048

/** loads the picture for the stage and the export (same origin, so the canvas stays readable) */
export function loadImage(url: string): Promise<LoadedImage> {
  return new Promise((resolve, reject) => {
    const im = new Image()
    im.onload = () => {
      const width = im.naturalWidth
      const height = im.naturalHeight
      if (width <= 0) return reject(new Error('The image could not be loaded'))
      const long = Math.max(width, height)
      if (long <= PREVIEW_MAX) return resolve({ source: im, width, height })
      // draw the preview at screen resolution: the full-size picture is only decoded again by the export on Replace
      try {
        const k = PREVIEW_MAX / long
        const c = document.createElement('canvas')
        c.width = Math.round(width * k)
        c.height = Math.round(height * k)
        const ctx = c.getContext('2d')
        if (!ctx) return resolve({ source: im, width, height })
        ctx.drawImage(im, 0, 0, c.width, c.height)
        c.toBlob(
          (b) =>
            resolve({
              source: im,
              width,
              height,
              ...(b ? { previewUrl: URL.createObjectURL(b) } : null),
            }),
          'image/jpeg',
          0.85,
        )
      } catch {
        resolve({ source: im, width, height })
      }
    }
    im.onerror = () => reject(new Error('The image could not be loaded'))
    im.src = url
  })
}

export interface AnnotateDialogProps {
  open: boolean
  image: AnnotateImage
  onClose: () => void
  /** upload the flattened picture and point the image in the draft at it; rejects (with a readable message) on failure */
  onReplace: (file: File) => Promise<void>
  /** where focus goes after the dialog closes (the image's Annotate button) */
  returnFocusTo?: () => HTMLElement | null
  /** the composer's phone flag: a full-screen sheet with a bottom tool bar (never a bare media query) */
  phone?: boolean
  /** test seams */
  load?: typeof loadImage
  flatten?: typeof flattenToFile
}

export function AnnotateDialog({
  open,
  image,
  onClose,
  onReplace,
  returnFocusTo,
  phone = false,
  load = loadImage,
  flatten = flattenToFile,
}: AnnotateDialogProps) {
  const { toast } = useToast()
  const content = useRef<HTMLDivElement>(null)
  const hintId = useId()
  const card = useModalCard()
  const [expanded] = useViewerExpanded()
  const coarse = useMediaQuery('(pointer: coarse)')
  const [loaded, setLoaded] = useState<LoadedImage | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [fit, setFit] = useState(1)
  const [stageView, setStageView] = useState<StageView>(FIT_VIEW)
  const zoomControls = useRef<{ zoomBy: (factor: number) => void } | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    let preview: string | undefined
    setLoaded(null)
    setLoadError(false)
    load(image.url).then(
      (l) => {
        preview = l.previewUrl
        if (live) setLoaded(l)
        else if (preview) URL.revokeObjectURL(preview)
      },
      () => live && setLoadError(true),
    )
    return () => {
      live = false
      if (preview) URL.revokeObjectURL(preview)
    }
  }, [image.url, load])

  const img = { w: loaded?.width ?? 1, h: loaded?.height ?? 1 }
  const annot = useAnnotator({ img, scale: fit * stageView.zoom, measure: measureText })

  // a different visible area (the crop tool opens / closes) starts at fit again
  useEffect(() => setStageView(FIT_VIEW), [annot.view.w, annot.view.h])

  const focusStage = useCallback(() => {
    content.current?.querySelector<HTMLElement>('[data-testid="annotate-stage"]')?.focus()
  }, [])

  const requestClose = () => {
    if (busy) return
    if (annot.dirty) setConfirming(true)
    else onClose()
  }

  const replace = async () => {
    if (busy || !loaded || !annot.dirty) return
    // a text box still being typed counts
    annot.commitEdit()
    setBusy(true)
    try {
      // let the busy state paint before the (synchronous, heavy) canvas work starts
      await new Promise((r) => setTimeout(r, 30))
      const file = await flatten({
        source: loaded.source,
        width: loaded.width,
        height: loaded.height,
        doc: annot.doc,
        mime: image.mime,
        name: image.name,
      })
      await onReplace(file)
      onClose()
    } catch (e) {
      toast(
        (e as Error).message || 'Couldn’t replace the image. Your annotations are still here.',
        {
          kind: 'error',
        },
      )
      annot.say('The image could not be replaced')
    } finally {
      setBusy(false)
    }
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return
    const t = e.target as HTMLElement
    if (t.closest('textarea, input, select')) return
    const k = e.key.toLowerCase()
    if (k === 'z') {
      e.preventDefault()
      if (e.shiftKey) annot.redo()
      else annot.undo()
    } else if (k === 'y') {
      e.preventDefault()
      annot.redo()
    }
  }

  const zoom = {
    value: stageView.zoom,
    by: (factor: number) => zoomControls.current?.zoomBy(factor),
    fit: () => setStageView(FIT_VIEW),
  }

  const cancelButton = (
    <Button onClick={requestClose} disabled={busy} data-testid="annotate-cancel">
      Cancel
    </Button>
  )
  const replaceButton = (
    <Button
      variant="primary"
      onClick={() => void replace()}
      aria-busy={busy || undefined}
      // aria-disabled keeps focus on the button and lets the reason be read
      aria-disabled={!loaded || !annot.dirty || busy || undefined}
      title={!annot.dirty ? 'Add an annotation or crop first' : undefined}
      data-testid="annotate-replace"
    >
      {busy && <Spinner label="Replacing the image" />}
      {busy ? 'Replacing…' : 'Replace image'}
    </Button>
  )
  const tools = (
    <AnnotateTools annot={annot} phone={phone} className={phone ? s.phoneTools : undefined} />
  )
  const props = <AnnotateProps annot={annot} afterAction={focusStage} zoom={zoom} />

  let body: ReactNode
  if (loadError)
    body = (
      <p className={s.message} role="alert">
        This image can’t be opened for editing.
      </p>
    )
  else if (!loaded)
    body = (
      <p className={s.message} role="status">
        <Spinner label="Loading the image" /> Loading the image…
      </p>
    )
  else
    body = (
      <AnnotateStage
        annot={annot}
        img={img}
        imageUrl={loaded.previewUrl ?? image.url}
        name={image.name}
        hintId={hintId}
        onScale={setFit}
        stageView={stageView}
        onStageView={setStageView}
        coarse={coarse}
        phone={phone}
        controls={zoomControls}
      />
    )

  return (
    <>
      <RD.Root open={open} onOpenChange={(o) => !o && requestClose()}>
        <RD.Portal>
          <RD.Overlay className={p.overlay} style={{ pointerEvents: 'auto' }} />
          <RD.Content
            ref={content}
            className={`${p.dialog} ${s.dialog}`}
            data-testid="annotate-dialog"
            data-phone={phone || undefined}
            data-expanded={expanded || undefined}
            // opened from the modal New message dialog, Radix has put pointer-events: none on <body>; this layer is the
            // top one, and says so itself so taps always reach it
            style={{ pointerEvents: 'auto' }}
            // the error toast of a failed Replace must stay reachable above the dialog (ui/useModalOpen)
            data-toasts-above=""
            onKeyDown={onKeyDown}
            onEscapeKeyDown={(e) => {
              if (confirming) return
              if (busy || annot.escape()) e.preventDefault()
            }}
            onOpenAutoFocus={(e) => {
              e.preventDefault()
              const first = content.current?.querySelector<HTMLElement>(
                '[data-roving][tabindex="0"]',
              )
              ;(first ?? content.current)?.focus()
            }}
            onCloseAutoFocus={(e) => {
              const t = returnFocusTo?.()
              if (t?.isConnected) {
                e.preventDefault()
                t.focus()
              }
            }}
          >
            {phone ? (
              // Cancel | title | Replace image, under the status bar / Dynamic Island
              <header className={s.phoneHeader}>
                {cancelButton}
                {/* the title is spoken, not drawn: the room goes to Undo / Redo */}
                <RD.Title className="sr-only">Annotate image</RD.Title>
                <div className={s.history} role="group" aria-label="History">
                  <HistoryButtons annot={annot} />
                </div>
                {replaceButton}
                <RD.Description className="sr-only">{image.name}</RD.Description>
              </header>
            ) : (
              <header className={p.header}>
                <div className={p.titleWrap}>
                  <RD.Title className={p.title}>Annotate image</RD.Title>
                  <RD.Description className={p.meta}>{image.name}</RD.Description>
                </div>
                <div className={p.tools}>
                  {card && <ExpandButton />}
                  <RD.Close asChild>
                    <IconButton label="Close image editor">
                      <X size={18} aria-hidden />
                    </IconButton>
                  </RD.Close>
                </div>
              </header>
            )}

            {!phone && (
              <div className={s.controls}>
                {tools}
                {props}
              </div>
            )}
            <p id={hintId} className={phone ? 'sr-only' : s.hint}>
              {hintFor(annot.tool)}
            </p>

            <div className={s.body}>{body}</div>

            {phone && (
              // colors / width / font size as a compact row, the tools as a bottom bar of 44px buttons
              <div className={s.phoneControls}>
                {props}
                {tools}
              </div>
            )}

            <div className="sr-only" role="status" aria-live="polite" data-testid="annotate-status">
              {annot.status}
            </div>

            {!phone && (
              <footer className={s.footer}>
                {cancelButton}
                {replaceButton}
              </footer>
            )}
          </RD.Content>
        </RD.Portal>
      </RD.Root>

      <Dialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Discard changes?"
        description="The annotations you made on this image will be lost."
        raise
        width={380}
        // focus goes back to the stage (Keep editing, Escape); on Discard the whole editor closes
        onCloseAutoFocus={(e) => {
          e.preventDefault()
          setTimeout(focusStage, 0)
        }}
        footer={
          <>
            <Button onClick={() => setConfirming(false)} data-testid="annotate-keep">
              Keep editing
            </Button>
            <Button
              variant="danger"
              data-testid="annotate-discard"
              onClick={() => {
                setConfirming(false)
                onClose()
              }}
            >
              Discard
            </Button>
          </>
        }
      >
        {null}
      </Dialog>
    </>
  )
}
