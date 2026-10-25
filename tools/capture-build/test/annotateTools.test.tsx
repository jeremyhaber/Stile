// @vitest-environment jsdom
/** The Shottr-style tools: smart measurement, magnifier, color picker, export scale and canvas padding. */
import { act, renderHook } from '@testing-library/react'
import type { KeyboardEvent } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { useAnnotator } from '../../../extension/capture/src/annotate/useAnnotator'
import { findRun, type Sampler } from '../../../extension/capture/src/annotate/pixels'
import { flattenToFile, type CanvasLike } from '../../../extension/capture/src/annotate/flatten'
import {
  applyHandle,
  dragCreate,
  hitShape,
  lensParts,
  measureLabel,
  measureParts,
  outputSize,
  placeLens,
  translateMagnifyPart,
  viewRect,
  type MagnifyShape,
  type MeasureShape,
} from '../../../extension/capture/src/annotate/model'

const IMG = { w: 1000, h: 600 }
const rgba = (px: number[][]) => px.flat()

describe('findRun', () => {
  it('finds the run of like pixels around an index, stopping at edges', () => {
    const W = [255, 255, 255, 255]
    const K = [0, 0, 0, 255]
    const line = rgba([K, W, W, [250, 252, 255, 255], W, K, K])
    expect(findRun(line, 7, 2)).toEqual([1, 5])
    expect(findRun(line, 7, 0)).toEqual([0, 1])
    expect(findRun(line, 7, 6)).toEqual([5, 7])
  })
})

describe('measure geometry', () => {
  const m: MeasureShape = { id: 'm', kind: 'measure', color: '#e5322d', width: 4, a: { x: 100, y: 50.5 }, b: { x: 300, y: 50.5 }, box: false, unit: 2 }
  it('labels in the shape unit (CSS px on a 2x capture)', () => {
    expect(measureLabel(m)).toBe('100')
    expect(measureLabel({ ...m, box: true, b: { x: 300, y: 250.5 } })).toBe('100 × 100')
  })
  it('puts a level line’s label above it and an upright one’s to the right', () => {
    expect(measureParts(m).label.cy).toBeLessThan(50)
    const up = measureParts({ ...m, b: { x: 100, y: 400 } })
    expect(up.label.cx).toBeGreaterThan(100)
  })
  it('snaps a nearly level drag to the axis', () => {
    const d = dragCreate(m, { x: 0, y: 0 }, { x: 200, y: 10 }) as MeasureShape
    expect(d.b).toEqual({ x: 200, y: 0 })
    const free = dragCreate(m, { x: 0, y: 0 }, { x: 200, y: 120 }) as MeasureShape
    expect(free.b).toEqual({ x: 200, y: 120 })
  })
  it('is hit on the line and on its label', () => {
    expect(hitShape(m, { x: 200, y: 51 }, 3)).toBe(true)
    const l = measureParts(m).label
    expect(hitShape(m, { x: l.cx, y: l.cy }, 0)).toBe(true)
    expect(hitShape(m, { x: 200, y: 200 }, 3)).toBe(false)
  })
})

describe('magnifier geometry', () => {
  const src = { x: 100, y: 100, w: 40, h: 40 }
  it('places the lens beside the source, inside the image', () => {
    const l = placeLens(src, IMG)
    expect(l.w).toBe(120)
    expect(l.x).toBeGreaterThan(src.x + src.w)
    const edge = placeLens({ x: 940, y: 100, w: 40, h: 40 }, IMG)
    expect(edge.x + edge.w).toBeLessThanOrEqual(940)
  })
  const g: MagnifyShape = { id: 'g', kind: 'magnify', color: '#000', width: 4, src, ...placeLens(src, IMG) }
  it('maps the source center to the lens center at the lens/source ratio', () => {
    const p = lensParts(g)
    expect(p.k).toBe(3)
    expect(120 * p.k + p.tx).toBeCloseTo(p.cx)
    expect(120 * p.k + p.ty).toBeCloseTo(p.cy)
    expect(p.connector).not.toBeNull()
  })
  it('keeps the lens round when resized, and moves its parts apart', () => {
    const r = applyHandle(g, 'se', { x: g.x + 200, y: g.y + 50 }) as MagnifyShape
    expect(r.w).toBe(200)
    expect(r.h).toBe(200)
    const s = applyHandle(g, 'src', { x: 160, y: 170 }) as MagnifyShape
    expect(s.src.w).toBe(70)
    expect(translateMagnifyPart(g, 'lens', 10, 0).src).toEqual(src)
  })
})

describe('canvas padding and export scale', () => {
  it('pads the view and sizes the output', () => {
    const doc = { shapes: [], crop: { x: 100, y: 100, w: 200, h: 100 }, pad: { size: 20, color: '#fff' }, scale: 0.5 }
    expect(viewRect('select', doc.crop, IMG, 20)).toEqual({ x: 80, y: 80, w: 240, h: 140 })
    expect(viewRect('crop', doc.crop, IMG, 20)).toEqual({ x: 0, y: 0, w: 1000, h: 600 })
    expect(outputSize(doc, IMG)).toEqual({ w: 120, h: 70 })
  })
  it('exports padded and scaled, filling the padding and clipping the picture to the crop', async () => {
    const calls: unknown[][] = []
    const ctx = new Proxy({}, { get: (_t, n: string) => (...a: unknown[]) => void calls.push([n, ...a]), set: (_t, n: string, v) => (calls.push(['set:' + n, v]), true) })
    let made: CanvasLike | null = null
    const create = (): CanvasLike => (made = { width: 0, height: 0, getContext: () => ctx as unknown as CanvasRenderingContext2D, toBlob: (cb) => cb(new Blob([new Uint8Array(4)])) })
    await flattenToFile({
      source: {} as CanvasImageSource,
      width: 400,
      height: 300,
      doc: { shapes: [], crop: null, pad: { size: 50, color: '#ffffff' }, scale: 2 },
      mime: 'image/png',
      name: 'x',
      createCanvas: create,
    })
    expect([made!.width, made!.height]).toEqual([1000, 800])
    expect(calls).toContainEqual(['fillRect', 0, 0, 1000, 800])
    expect(calls).toContainEqual(['setTransform', 2, 0, 0, 2, -(-50) * 2, -(-50) * 2])
    expect(calls).toContainEqual(['clip'])
  })
})

// ------------------------------------------------------------------------------------------- the annotator
const sampler: Sampler = {
  color: (p) => (p.x < 500 ? '#123456' : '#abcdef'),
  span: (p) => ({ x1: 100, x2: 300, y1: Math.floor(p.y) - 10, y2: Math.floor(p.y) + 30 }),
}
const setup = (onCopyColor = vi.fn()) =>
  renderHook(() => useAnnotator({ img: IMG, scale: 1, sampler, unit: 2, onCopyColor })).result
const key = (k: string, o: Partial<KeyboardEvent> = {}) =>
  ({ key: k, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...o }) as unknown as KeyboardEvent

describe('measure tool', () => {
  it('a click measures smartly: across and down, in one undo step, and the tool stays', () => {
    const r = setup()
    act(() => r.current.setTool('measure'))
    act(() => r.current.pointer.down({ x: 200, y: 50 }, 'mouse'))
    act(() => r.current.pointer.up({ x: 200, y: 50 }))
    const ms = r.current.doc.shapes as MeasureShape[]
    expect(ms).toHaveLength(2)
    expect(ms[0]).toMatchObject({ a: { x: 100, y: 50.5 }, b: { x: 300, y: 50.5 }, unit: 2 })
    expect(measureLabel(ms[0]!)).toBe('100')
    expect(measureLabel(ms[1]!)).toBe('20')
    expect(r.current.tool).toBe('measure')
    act(() => r.current.undo())
    expect(r.current.doc.shapes).toHaveLength(0)
  })
  it('a drag measures a line, or a box in Box mode', () => {
    const r = setup()
    act(() => r.current.setTool('measure'))
    act(() => r.current.pointer.down({ x: 10, y: 10 }, 'mouse'))
    act(() => r.current.pointer.move({ x: 110, y: 12 }))
    act(() => r.current.pointer.up({ x: 110, y: 12 }))
    expect(r.current.doc.shapes[0]).toMatchObject({ kind: 'measure', box: false, b: { x: 110, y: 10 } })
    act(() => r.current.setMeasureBox(true))
    act(() => r.current.pointer.down({ x: 10, y: 10 }, 'mouse'))
    act(() => r.current.pointer.move({ x: 110, y: 90 }))
    act(() => r.current.pointer.up({ x: 110, y: 90 }))
    expect(r.current.doc.shapes[1]).toMatchObject({ kind: 'measure', box: true })
  })
  it('hovering shows the span; arrow keys move the probe', () => {
    const r = setup()
    act(() => r.current.setTool('measure'))
    act(() => r.current.pointer.hover({ x: 200, y: 50 }))
    expect(r.current.probe?.span).toEqual({ x1: 100, x2: 300, y1: 40, y2: 80 })
    act(() => void r.current.onKey(key('ArrowRight', { shiftKey: true })))
    expect(r.current.probe?.pt.x).toBe(210)
  })
})

describe('color picker', () => {
  it('a click copies the color and makes it the drawing color for every tool', () => {
    const copy = vi.fn()
    const r = setup(copy)
    act(() => r.current.setTool('picker'))
    act(() => r.current.pointer.down({ x: 700, y: 50 }, 'mouse'))
    expect(copy).toHaveBeenCalledWith('#abcdef')
    act(() => r.current.setTool('rect'))
    expect(r.current.color).toBe('#abcdef')
    act(() => r.current.setTool('highlight'))
    expect(r.current.color).toBe('#abcdef')
  })
  it('Tab copies the color under the pointer', () => {
    const copy = vi.fn()
    const r = setup(copy)
    act(() => r.current.setTool('picker'))
    act(() => r.current.pointer.hover({ x: 10, y: 10 }))
    let handled = false
    act(() => void (handled = r.current.onKey(key('Tab'))))
    expect(handled).toBe(true)
    expect(copy).toHaveBeenCalledWith('#123456')
  })
})

describe('magnifier tool', () => {
  it('drags out a square source with a lens beside it; a selected lens moves on its own', () => {
    const r = setup()
    act(() => r.current.setTool('magnify'))
    act(() => r.current.pointer.down({ x: 100, y: 100 }, 'mouse'))
    act(() => r.current.pointer.move({ x: 160, y: 130 }))
    act(() => r.current.pointer.up({ x: 160, y: 130 }))
    const g = r.current.doc.shapes[0] as MagnifyShape
    expect(g.src).toEqual({ x: 100, y: 85, w: 60, h: 60 })
    expect(g.w).toBe(180)
    expect(r.current.selectedId).toBe(g.id)
    const c = { x: g.x + g.w / 2, y: g.y + g.h / 2 }
    act(() => r.current.pointer.down(c, 'mouse'))
    act(() => r.current.pointer.move({ x: c.x + 40, y: c.y }))
    act(() => r.current.pointer.up({ x: c.x + 40, y: c.y }))
    const moved = r.current.doc.shapes[0] as MagnifyShape
    expect(moved.x).toBe(g.x + 40)
    expect(moved.src).toEqual(g.src)
  })
})

describe('resize and padding', () => {
  it('records scale and padding (undoable) and pads the view', () => {
    const r = setup()
    act(() => r.current.setScale(0.5))
    act(() => r.current.setPad({ size: 30, color: '#ffffff' }))
    expect(r.current.view).toEqual({ x: -30, y: -30, w: 1060, h: 660 })
    expect(outputSize(r.current.doc, IMG)).toEqual({ w: 530, h: 330 })
    act(() => r.current.undo())
    expect(r.current.doc.pad ?? null).toBeNull()
    expect(r.current.doc.scale).toBe(0.5)
  })
})
