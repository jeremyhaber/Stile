/**
 * Undo / redo for the annotation editor: a plain snapshot stack (documents are small and immutable).
 * `replace` is for the frames of a drag (nothing recorded); `settle` commits a finished drag as ONE undo step;
 * `record` is a discrete edit. Repeated keyboard nudges of the same shape coalesce into one step.
 */
import type { AnnotDoc } from './model'

export const HISTORY_LIMIT = 100
export const COALESCE_MS = 700

export interface History {
  past: AnnotDoc[]
  present: AnnotDoc
  future: AnnotDoc[]
  /** the last coalescable edit (e.g. "nudge:<shape id>") and when it happened */
  last: { key: string; at: number } | null
}

export const initHistory = (doc: AnnotDoc): History => ({
  past: [],
  present: doc,
  future: [],
  last: null,
})

const push = (past: AnnotDoc[], doc: AnnotDoc) => [...past, doc].slice(-HISTORY_LIMIT)

/** a frame of a drag: the present changes, the stacks do not */
export const replace = (h: History, doc: AnnotDoc): History => ({ ...h, present: doc, last: null })

/** a finished drag started from `base`: one undo step back to it */
export function settle(h: History, base: AnnotDoc): History {
  if (base === h.present) return h
  return { past: push(h.past, base), present: h.present, future: [], last: null }
}

/** a discrete edit; edits with the same `key` less than COALESCE_MS apart share one undo step */
export function record(
  h: History,
  doc: AnnotDoc,
  coalesce?: { key: string; now: number },
): History {
  if (doc === h.present) return h
  if (coalesce && h.last && h.last.key === coalesce.key && coalesce.now - h.last.at < COALESCE_MS)
    return { ...h, present: doc, last: { key: coalesce.key, at: coalesce.now } }
  return {
    past: push(h.past, h.present),
    present: doc,
    future: [],
    last: coalesce ? { key: coalesce.key, at: coalesce.now } : null,
  }
}

export function undo(h: History): History {
  const prev = h.past[h.past.length - 1]
  if (!prev) return h
  return {
    past: h.past.slice(0, -1),
    present: prev,
    future: [h.present, ...h.future],
    last: null,
  }
}

export function redo(h: History): History {
  const next = h.future[0]
  if (!next) return h
  return { past: push(h.past, h.present), present: next, future: h.future.slice(1), last: null }
}

export const canUndo = (h: History) => h.past.length > 0
export const canRedo = (h: History) => h.future.length > 0
/** are there changes to lose? (undoing back to the start counts as no edits) */
export const isDirty = (h: History) => h.past.length > 0
