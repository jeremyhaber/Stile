import { describe, expect, it } from 'vitest'
import {
  COALESCE_MS,
  HISTORY_LIMIT,
  canRedo,
  canUndo,
  initHistory,
  isDirty,
  record,
  redo,
  replace,
  settle,
  undo,
} from '../../../extension/capture/src/annotate/history'
import { EMPTY_DOC, type AnnotDoc, type Shape } from '../../../extension/capture/src/annotate/model'

const shape = (id: string): Shape => ({
  id,
  kind: 'line',
  color: '#000',
  width: 2,
  a: { x: 0, y: 0 },
  b: { x: 1, y: 1 },
})
const doc = (...ids: string[]): AnnotDoc => ({ shapes: ids.map(shape), crop: null })

describe('annotation history', () => {
  it('undoes and redoes discrete edits', () => {
    let h = initHistory(EMPTY_DOC)
    expect(isDirty(h)).toBe(false)
    h = record(h, doc('a'))
    h = record(h, doc('a', 'b'))
    expect(isDirty(h)).toBe(true)
    expect(canUndo(h)).toBe(true)
    h = undo(h)
    expect(h.present.shapes.map((s) => s.id)).toEqual(['a'])
    expect(canRedo(h)).toBe(true)
    h = undo(h)
    expect(h.present).toBe(EMPTY_DOC)
    expect(isDirty(h)).toBe(false) // back at the start = nothing to lose
    h = redo(h)
    h = redo(h)
    expect(h.present.shapes).toHaveLength(2)
    expect(canRedo(h)).toBe(false)
  })
  it('a new edit clears the redo stack', () => {
    let h = record(initHistory(EMPTY_DOC), doc('a'))
    h = undo(h)
    h = record(h, doc('z'))
    expect(canRedo(h)).toBe(false)
  })
  it('a drag is ONE undo step: frames replace, settle commits', () => {
    const base = doc('a')
    let h = record(initHistory(EMPTY_DOC), base)
    const before = h.past.length
    for (let i = 0; i < 20; i++)
      h = replace(h, { shapes: [{ ...shape('a'), width: i }], crop: null })
    expect(h.past.length).toBe(before)
    h = settle(h, base)
    expect(h.past.length).toBe(before + 1)
    h = undo(h)
    expect(h.present).toBe(base)
  })
  it('settling an unchanged drag records nothing', () => {
    const h = initHistory(EMPTY_DOC)
    expect(settle(h, h.present)).toBe(h)
  })
  it('keyboard nudges within the window share one step; another key or a pause starts a new one', () => {
    let h = initHistory(EMPTY_DOC)
    h = record(h, doc('a'), { key: 'nudge:a', now: 1000 })
    h = record(h, doc('a', 'b'), { key: 'nudge:a', now: 1000 + COALESCE_MS - 10 })
    h = record(h, doc('a', 'b', 'c'), { key: 'nudge:a', now: 1000 + 2 * COALESCE_MS + 100 })
    expect(h.past).toHaveLength(2)
    h = record(h, doc('x'), { key: 'resize:a', now: 1000 + 2 * COALESCE_MS + 150 })
    expect(h.past).toHaveLength(3)
  })
  it('caps the stack', () => {
    let h = initHistory(EMPTY_DOC)
    for (let i = 0; i < HISTORY_LIMIT + 30; i++) h = record(h, doc(`s${i}`))
    expect(h.past.length).toBe(HISTORY_LIMIT)
  })
  it('undo / redo at the ends are no-ops', () => {
    const h = initHistory(EMPTY_DOC)
    expect(undo(h)).toBe(h)
    expect(redo(h)).toBe(h)
    expect(record(h, h.present)).toBe(h)
  })
})
