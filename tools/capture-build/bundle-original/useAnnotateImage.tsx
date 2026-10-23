/**
 * Composer side of "Annotate image": opens the (lazy) editor dialog for an inline image and, on Replace, uploads the
 * flattened picture as a NEW inline attachment and points the image node at it (replace.ts). The dialog chunk is never
 * imported statically (lib/lazy rule).
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Editor } from '@tiptap/core'
import type { AttachmentInfo } from '@tandem/shared'
import { lazyNamed } from '../../../lib/lazy'
import { LazyBoundary, SrLoading } from '../../../ui/LazyBoundary'
import { useToast } from '../../../ui/Toast'
import type { AnnotateImage } from './AnnotateDialog'
import { replaceImageWithFile } from './replace'

const AnnotateDialog = lazyNamed(() => import('./AnnotateDialog'), 'AnnotateDialog')
export const preloadAnnotateDialog = () => AnnotateDialog.preload()

/** what the image node view hands over when its Annotate button is pressed */
export interface AnnotateRequest {
  src: string
  /** the node's position when the button was pressed (a hint: the node is searched again by `src` at save time) */
  pos: number
  trigger: HTMLElement
}

interface Session extends AnnotateRequest {
  key: number
  image: AnnotateImage
}

export function useAnnotateImage(o: {
  editor: Editor | null
  attachments: AttachmentInfo[]
  /** attach the file as an inline image; resolves with its content id (null = the upload failed) */
  uploadInline: (file: File) => Promise<string | null>
  /** the composer's phone flag (full-screen sheet with a bottom tool bar) */
  phone?: boolean
}): { request: (r: AnnotateRequest) => void; dialog: ReactNode } {
  const { toast } = useToast()
  const [session, setSession] = useState<Session | null>(null)
  const [open, setOpen] = useState(false)
  const count = useRef(0)
  const opts = useRef(o)
  opts.current = o
  const current = useRef<Session | null>(null)
  current.current = session

  const request = useCallback(
    (r: AnnotateRequest) => {
      const cid = r.src.replace(/^cid:/i, '')
      const att = opts.current.attachments.find((a) => a.contentId === cid)
      if (!att) {
        toast('This image is still uploading. Try again in a moment.', { kind: 'error' })
        return
      }
      setSession({
        ...r,
        key: ++count.current,
        image: { url: att.url, name: att.filename, mime: att.mime },
      })
      setOpen(true)
    },
    [toast],
  )

  const onReplace = useCallback(
    async (file: File) => {
      const s = current.current
      const { editor, uploadInline } = opts.current
      if (!s || !editor || editor.isDestroyed) throw new Error('The draft is no longer open')
      const next = await replaceImageWithFile({
        editor,
        src: s.src,
        pos: s.pos,
        file,
        upload: uploadInline,
      })
      current.current = { ...s, src: next }
      toast('Image updated')
    },
    [toast],
  )

  // the closed dialog is dropped after its exit (a re-open always starts from a fresh editor)
  useEffect(() => {
    if (open || !session) return
    const t = setTimeout(() => setSession(null), 600)
    return () => clearTimeout(t)
  }, [open, session])

  const dialog = session ? (
    <LazyBoundary
      label="the image editor"
      fallback={<SrLoading label="Loading the image editor" />}
    >
      <AnnotateDialog
        key={session.key}
        open={open}
        phone={opts.current.phone}
        image={session.image}
        onClose={() => setOpen(false)}
        onReplace={onReplace}
        returnFocusTo={() => {
          const t = session.trigger
          return t.isConnected
            ? t
            : ((opts.current.editor?.view.dom as HTMLElement | undefined) ?? null)
        }}
      />
    </LazyBoundary>
  ) : null

  return { request, dialog }
}
