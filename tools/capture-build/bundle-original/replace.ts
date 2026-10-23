/**
 * The "Replace image" step on the draft document. Kept free of React and of the editor dialog (the dialog is a lazy
 * chunk; this file is imported by the composer itself).
 */
import type { Node as PmNode } from '@tiptap/pm/model'
import type { EditorState, Transaction } from '@tiptap/pm/state'

/** the part of a TipTap editor this step needs */
export interface EditorLike {
  state: EditorState
  view: { dispatch(tr: Transaction): void }
}

/** only `cid:` images are same-origin attachments of the draft, so only they can be read back without tainting a canvas */
export const canAnnotateSrc = (src: unknown): src is string =>
  typeof src === 'string' && /^cid:\S/i.test(src)

export function findImagesBySrc(doc: PmNode, src: string): { pos: number; node: PmNode }[] {
  const found: { pos: number; node: PmNode }[] = []
  doc.descendants((node, pos) => {
    if (node.type.name === 'image' && node.attrs.src === src) found.push({ pos, node })
  })
  return found
}

/**
 * Point the image that carries `oldSrc` at `newSrc` with an ordinary ProseMirror transaction (`setNodeMarkup`), so it
 * travels through the Yjs binding to co-editors and the collaborative undo can bring the old image back. The node is
 * searched again by its `src` NOW (its position may have moved while the dialog was open); with several nodes of the
 * same `src` the one nearest to `hintPos` wins. alt / title are kept. Returns false when the image is gone.
 */
export function replaceImageSrc(
  editor: EditorLike,
  oldSrc: string,
  newSrc: string,
  hintPos?: number,
): boolean {
  const found = findImagesBySrc(editor.state.doc, oldSrc)
  if (!found.length) return false
  const target =
    hintPos === undefined
      ? found[0]!
      : found.reduce((best, f) =>
          Math.abs(f.pos - hintPos) < Math.abs(best.pos - hintPos) ? f : best,
        )
  const tr = editor.state.tr.setNodeMarkup(target.pos, undefined, {
    ...target.node.attrs,
    src: newSrc,
  })
  editor.view.dispatch(tr)
  return true
}

/**
 * The whole Replace step: check the image is still in the draft, upload the flattened file as a NEW inline attachment
 * (`upload` resolves with its content id, null = failed), then swap the node's `src`. Throws a readable Error and leaves
 * the document untouched when anything fails. The old attachment is kept (see docs/arch/drafts.md "Annotate image").
 * Resolves with the new `src`.
 */
export async function replaceImageWithFile(o: {
  editor: EditorLike
  src: string
  pos: number
  file: File
  upload: (file: File) => Promise<string | null>
}): Promise<string> {
  // fail before uploading when a co-editor already deleted the image
  if (!findImagesBySrc(o.editor.state.doc, o.src).length)
    throw new Error('This image was removed from the draft. Nothing was replaced.')
  const contentId = await o.upload(o.file)
  if (!contentId)
    throw new Error('Couldn’t upload the edited image. Your annotations are still here.')
  const next = `cid:${contentId}`
  // the document may have changed while the file was on its way: search by src again, now
  if (!replaceImageSrc(o.editor, o.src, next, o.pos))
    throw new Error(
      'This image was removed from the draft while it uploaded. Nothing was replaced.',
    )
  return next
}
