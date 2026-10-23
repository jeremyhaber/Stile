// @vitest-environment jsdom
/** The annotation editor's interaction logic (pointer drags, keyboard, text, crop, undo) without the DOM. */
import { act, renderHook } from '@testing-library/react'
import type { KeyboardEvent } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { useAnnotator } from '../../../extension/capture/src/annotate/useAnnotator'
import type { BoxShape, TextShape } from '../../../extension/capture/src/annotate/model'

const IMG = { w: 1000, h: 600 }
const setup = (scale = 1) => renderHook(() => useAnnotator({ img: IMG, scale })).result
type Api = ReturnType<typeof setup>

const key = (k: string, o: Partial<KeyboardEvent> = {}) =>
  ({
    key: k,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...o,
  }) as unknown as KeyboardEvent

const press = (r: Api, k: string, o: Partial<KeyboardEvent> = {}) => {
  let handled = false
  act(() => {
    handled = r.current.onKey(key(k, o))
  })
  return handled
}
const drag = (
  r: Api,
  from: [number, number],
  to: [number, number],
  kind: 'mouse' | 'touch' = 'mouse',
) => {
  act(() => r.current.pointer.down({ x: from[0], y: from[1] }, kind))
  act(() => r.current.pointer.move({ x: (from[0] + to[0]) / 2, y: (from[1] + to[1]) / 2 }))
  act(() => r.current.pointer.move({ x: to[0], y: to[1] }))
  act(() => r.current.pointer.up({ x: to[0], y: to[1] }))
}
const shapes = (r: Api) => r.current.doc.shapes
const box = (r: Api, i = 0) => shapes(r)[i] as BoxShape

describe('drawing with the pointer', () => {
  it('drags out a rectangle, selects it and returns to the Select tool', () => {
    const r = setup()
    act(() => r.current.setTool('rect'))
    drag(r, [100, 100], [260, 190])
    expect(box(r)).toMatchObject({ kind: 'rect', x: 100, y: 100, w: 160, h: 90 })
    expect(r.current.tool).toBe('select')
    expect(r.current.selectedId).toBe(box(r).id)
    expect(r.current.dirty).toBe(true)
    expect(r.current.status).toMatch(/Rectangle added/)
  })

  it('a click without dragging places a default-size shape there (no drag needed)', () => {
    const r = setup()
    act(() => r.current.setTool('ellipse'))
    act(() => r.current.pointer.down({ x: 500, y: 300 }, 'mouse'))
    act(() => r.current.pointer.up({ x: 500, y: 300 }))
    const e = box(r)
    expect(e.kind).toBe('ellipse')
    expect(e.w).toBeGreaterThan(50)
    expect(e.x + e.w / 2).toBeCloseTo(500)
  })

  it('draws a freehand stroke and stays on the pen', () => {
    const r = setup()
    act(() => r.current.setTool('pen'))
    drag(r, [10, 10], [200, 50])
    const pen = shapes(r)[0]!
    expect(pen.kind === 'pen' && pen.points.length).toBeGreaterThanOrEqual(3)
    expect(r.current.tool).toBe('pen')
  })

  it('numbers badges 1, 2, 3 with each click', () => {
    const r = setup()
    act(() => r.current.setTool('badge'))
    for (const x of [100, 200, 300]) {
      act(() => r.current.pointer.down({ x, y: 100 }, 'mouse'))
      act(() => r.current.pointer.up({ x, y: 100 }))
    }
    expect(shapes(r).map((s) => s.kind === 'badge' && s.n)).toEqual([1, 2, 3])
    expect(r.current.tool).toBe('badge')
  })

  it('cancelling a drag (pointercancel) leaves no shape behind', () => {
    const r = setup()
    act(() => r.current.setTool('line'))
    act(() => r.current.pointer.down({ x: 10, y: 10 }, 'mouse'))
    act(() => r.current.pointer.move({ x: 100, y: 100 }))
    act(() => r.current.pointer.cancel())
    expect(shapes(r)).toHaveLength(0)
    expect(r.current.dirty).toBe(false)
  })
})

describe('touch and pen (a finger is not a mouse)', () => {
  it('a stray tap with a shape tool creates nothing; a mouse click still places a default shape', () => {
    const r = setup()
    act(() => r.current.setTool('rect'))
    act(() => r.current.pointer.down({ x: 300, y: 300 }, 'touch'))
    act(() => r.current.pointer.up({ x: 301, y: 300 }))
    expect(shapes(r)).toHaveLength(0)
    expect(r.current.dirty).toBe(false)
    expect(r.current.tool).toBe('rect')
    act(() => r.current.pointer.down({ x: 300, y: 300 }, 'mouse'))
    act(() => r.current.pointer.up({ x: 300, y: 300 }))
    expect(shapes(r)).toHaveLength(1)
  })

  it('a real finger drag draws, a tiny wiggle is discarded', () => {
    const r = setup()
    act(() => r.current.setTool('rect'))
    drag(r, [100, 100], [102, 101], 'touch')
    expect(shapes(r)).toHaveLength(0)
    drag(r, [100, 100], [200, 160], 'touch')
    expect(box(r)).toMatchObject({ w: 100, h: 60 })
  })

  it('a pen is treated like a finger', () => {
    const r = setup()
    act(() => r.current.setTool('rect'))
    act(() => r.current.pointer.down({ x: 300, y: 300 }, 'pen'))
    act(() => r.current.pointer.up({ x: 300, y: 300 }))
    expect(shapes(r)).toHaveLength(0)
  })

  it('a dot of a freehand stroke by touch is dropped, a stroke is kept', () => {
    const r = setup()
    act(() => r.current.setTool('pen'))
    act(() => r.current.pointer.down({ x: 50, y: 50 }, 'touch'))
    act(() => r.current.pointer.up({ x: 50, y: 50 }))
    expect(shapes(r)).toHaveLength(0)
    drag(r, [50, 50], [150, 90], 'touch')
    expect(shapes(r)).toHaveLength(1)
  })

  it('a tap with the Select tool only selects (or deselects): no zero-size shape', () => {
    const r = setup()
    act(() => r.current.pointer.down({ x: 500, y: 300 }, 'touch'))
    act(() => r.current.pointer.up({ x: 500, y: 300 }))
    expect(shapes(r)).toHaveLength(0)
    act(() => r.current.setTool('rect'))
    drag(r, [100, 100], [300, 200])
    act(() => r.current.select(null))
    act(() => r.current.pointer.down({ x: 100, y: 150 }, 'touch'))
    act(() => r.current.pointer.up({ x: 100, y: 150 }))
    expect(r.current.selectedId).toBe(box(r).id)
  })

  it('a handle is grabbed from 22 screen px away by a finger, not by a mouse', () => {
    const r = setup()
    act(() => r.current.setTool('rect'))
    drag(r, [100, 100], [300, 200]) // se handle at (300, 200)
    drag(r, [318, 200], [360, 230], 'touch')
    expect(box(r)).toMatchObject({ w: 260, h: 130 })
    drag(r, [378, 230], [400, 260], 'mouse') // 18px off: the mouse misses (and moves nothing: empty space)
    expect(box(r)).toMatchObject({ w: 260, h: 130 })
  })

  it('the text box opens when the finger lifts', () => {
    const r = setup()
    act(() => r.current.setTool('text'))
    act(() => r.current.pointer.down({ x: 200, y: 200 }, 'touch'))
    expect(r.current.editing).toBeNull()
    act(() => r.current.pointer.up({ x: 201, y: 200 }))
    expect(r.current.editing).toMatchObject({ fresh: true })
  })
})

describe('select, move, resize', () => {
  const withRect = () => {
    const r = setup()
    act(() => r.current.setTool('rect'))
    drag(r, [100, 100], [300, 200])
    return r
  }

  it('clicking a shape selects it; a drag moves it as ONE undo step', () => {
    const r = withRect()
    act(() => r.current.select(null))
    drag(r, [100, 150], [140, 190]) // grab the left border
    expect(r.current.selectedId).toBe(box(r).id)
    expect(box(r)).toMatchObject({ x: 140, y: 140 })
    act(() => r.current.undo())
    expect(box(r)).toMatchObject({ x: 100, y: 100 })
    act(() => r.current.undo())
    expect(shapes(r)).toHaveLength(0)
    act(() => r.current.redo())
    expect(shapes(r)).toHaveLength(1)
  })

  it('a handle drag resizes; the tolerance grows on touch', () => {
    const r = withRect()
    drag(r, [300, 200], [400, 260]) // the se handle of the selected rectangle
    expect(box(r)).toMatchObject({ x: 100, y: 100, w: 300, h: 160 })
    // 15 image px away from the nw corner: a touch grabs the handle, a mouse would not
    drag(r, [112, 112], [90, 90], 'touch')
    expect(box(r)).toMatchObject({ x: 90, y: 90 })
  })

  it('clicking empty space deselects', () => {
    const r = withRect()
    act(() => r.current.pointer.down({ x: 800, y: 500 }, 'mouse'))
    act(() => r.current.pointer.up({ x: 800, y: 500 }))
    expect(r.current.selectedId).toBeNull()
  })
})

describe('keyboard: no dragging needed (2.5.7)', () => {
  it("Enter places the active shape tool's default shape in the center, then arrows move and Alt+arrows resize it", () => {
    const r = setup()
    act(() => r.current.setTool('rect'))
    expect(press(r, 'Enter')).toBe(true)
    const placed = box(r)
    expect(placed.x + placed.w / 2).toBeCloseTo(500)
    expect(placed.y + placed.h / 2).toBeCloseTo(300)
    expect(r.current.tool).toBe('select')
    expect(r.current.selectedId).toBe(placed.id)

    press(r, 'ArrowRight')
    expect(box(r).x).toBe(placed.x + 1)
    press(r, 'ArrowDown', { shiftKey: true })
    expect(box(r).y).toBe(placed.y + 10)
    press(r, 'ArrowRight', { altKey: true, shiftKey: true })
    expect(box(r).w).toBe(placed.w + 10)
    press(r, 'ArrowUp', { altKey: true })
    expect(box(r).h).toBe(placed.h - 1)
  })

  it('steps are one SCREEN pixel: a zoomed-out stage moves further in the image', () => {
    const r = setup(0.5)
    act(() => r.current.setTool('rect'))
    press(r, ' ')
    const x0 = box(r).x
    press(r, 'ArrowRight')
    expect(box(r).x - x0).toBe(2)
  })

  it('coalesces a run of arrow presses into one undo step', () => {
    const r = setup()
    act(() => r.current.setTool('rect'))
    press(r, 'Enter')
    const x0 = box(r).x
    for (let i = 0; i < 5; i++) press(r, 'ArrowRight')
    expect(box(r).x).toBe(x0 + 5)
    act(() => r.current.undo())
    expect(box(r).x).toBe(x0)
  })

  it('Tab walks through the shapes (announced) and leaves the stage at the ends', () => {
    const r = setup()
    for (const t of ['rect', 'ellipse', 'arrow'] as const) {
      act(() => r.current.setTool(t))
      press(r, 'Enter')
    }
    act(() => r.current.select(null))
    expect(press(r, 'Tab')).toBe(true)
    expect(r.current.status).toBe('Rectangle, 1 of 3 selected')
    press(r, 'Tab')
    expect(r.current.status).toBe('Ellipse, 2 of 3 selected')
    press(r, 'Tab')
    expect(r.current.status).toBe('Arrow, 3 of 3 selected')
    expect(press(r, 'Tab')).toBe(false) // past the last: focus moves on, nothing is trapped
    expect(r.current.selectedId).toBeNull()
    expect(press(r, 'Tab', { shiftKey: true })).toBe(false) // nothing selected: Shift+Tab leaves
    act(() => r.current.select(shapes(r)[1]!.id))
    press(r, 'Tab', { shiftKey: true })
    expect(r.current.status).toBe('Rectangle, 1 of 3 selected')
  })

  it('Delete removes the selected shape and Escape deselects', () => {
    const r = setup()
    act(() => r.current.setTool('arrow'))
    press(r, 'Enter')
    expect(press(r, 'Delete')).toBe(true)
    expect(shapes(r)).toHaveLength(0)
    expect(r.current.status).toBe('Arrow deleted')
    act(() => r.current.undo())
    expect(shapes(r)).toHaveLength(1)
    act(() => r.current.select(shapes(r)[0]!.id))
    let consumed = false
    act(() => {
      consumed = r.current.escape()
    })
    expect(consumed).toBe(true)
    expect(r.current.selectedId).toBeNull()
    act(() => {
      consumed = r.current.escape()
    })
    expect(consumed).toBe(false) // nothing left to dismiss: the dialog may close
  })

  it('ignores keys with Ctrl / Cmd (undo and the browser keep them)', () => {
    const r = setup()
    act(() => r.current.setTool('rect'))
    expect(press(r, 'Enter', { ctrlKey: true })).toBe(false)
    expect(shapes(r)).toHaveLength(0)
  })

  it('does not place anything with the pen or Select tool', () => {
    const r = setup()
    expect(press(r, 'Enter')).toBe(false)
    act(() => r.current.setTool('pen'))
    expect(press(r, 'Enter')).toBe(false)
    expect(shapes(r)).toHaveLength(0)
  })

  it('does not stack repeated placements exactly on top of each other', () => {
    const r = setup()
    act(() => r.current.setTool('badge'))
    press(r, 'Enter')
    press(r, 'Enter')
    const [a, b] = shapes(r) as unknown as { cx: number; cy: number; n: number }[]
    expect([a!.n, b!.n]).toEqual([1, 2])
    expect(a!.cx === b!.cx && a!.cy === b!.cy).toBe(false)
  })
})

describe('text', () => {
  it('a click starts an inline text box; typing and committing keeps the shape (one undo step)', () => {
    const r = setup()
    act(() => r.current.setTool('text'))
    act(() => r.current.pointer.down({ x: 200, y: 200 }, 'mouse'))
    act(() => r.current.pointer.up({ x: 200, y: 200 }))
    expect(r.current.editing).toMatchObject({ fresh: true, value: '' })
    act(() => r.current.setEditText('Look here'))
    act(() => r.current.commitEdit())
    const t = shapes(r)[0] as TextShape
    expect(t).toMatchObject({ kind: 'text', text: 'Look here' })
    expect(r.current.editing).toBeNull()
    expect(r.current.tool).toBe('select')
    act(() => r.current.undo())
    expect(shapes(r)).toHaveLength(0)
  })

  it('empty text is dropped', () => {
    const r = setup()
    act(() => r.current.setTool('text'))
    act(() => r.current.pointer.down({ x: 200, y: 200 }, 'mouse'))
    act(() => r.current.pointer.up({ x: 200, y: 200 }))
    act(() => r.current.commitEdit())
    expect(shapes(r)).toHaveLength(0)
    expect(r.current.dirty).toBe(false)
  })

  it('Enter places a text box and edits it; Enter on a selected text edits it again', () => {
    const r = setup()
    act(() => r.current.setTool('text'))
    press(r, 'Enter')
    expect(r.current.editing?.value).toBe('Text')
    act(() => r.current.setEditText('Hello'))
    act(() => r.current.commitEdit())
    expect((shapes(r)[0] as TextShape).text).toBe('Hello')
    expect(press(r, 'Enter')).toBe(true)
    expect(r.current.editing).toMatchObject({ fresh: false, value: 'Hello' })
    act(() => r.current.setEditText(''))
    act(() => r.current.commitEdit())
    expect(shapes(r)).toHaveLength(0)
    act(() => r.current.undo())
    expect((shapes(r)[0] as TextShape).text).toBe('Hello')
  })

  it('Escape while typing finishes the text instead of closing', () => {
    const r = setup()
    act(() => r.current.setTool('text'))
    press(r, 'Enter')
    let consumed = false
    act(() => {
      consumed = r.current.escape()
    })
    expect(consumed).toBe(true)
    expect(r.current.editing).toBeNull()
    expect(shapes(r)).toHaveLength(1)
  })
})

describe('properties', () => {
  it('a color change recolors the selected shape and is remembered for the tool', () => {
    const r = setup()
    act(() => r.current.setTool('rect'))
    press(r, 'Enter')
    act(() => r.current.setColor('#1f6feb'))
    expect(box(r).color).toBe('#1f6feb')
    expect(r.current.color).toBe('#1f6feb')
    act(() => r.current.setTool('rect'))
    press(r, 'Enter')
    expect(box(r, 1).color).toBe('#1f6feb')
  })

  it('the highlighter starts yellow', () => {
    const r = setup()
    act(() => r.current.setTool('highlight'))
    press(r, 'Enter')
    expect(shapes(r)[0]!.color).toBe('#ffd60a')
  })

  it('size and font controls restyle the selected shape', () => {
    const r = setup()
    act(() => r.current.setTool('arrow'))
    press(r, 'Enter')
    const w0 = shapes(r)[0]!.width
    act(() => r.current.setSize(2))
    expect(shapes(r)[0]!.width).toBeGreaterThan(w0)
    expect(r.current.sizeIdx).toBe(2)
    act(() => r.current.setTool('text'))
    press(r, 'Enter')
    act(() => r.current.commitEdit())
    const f0 = (shapes(r)[1] as TextShape).fontSize
    act(() => r.current.setFont(3))
    expect((shapes(r)[1] as TextShape).fontSize).toBeGreaterThan(f0)
    expect(r.current.fontIdx).toBe(3)
  })

  it('Clear all removes the shapes (undoable) but keeps the crop', () => {
    const r = setup()
    act(() => r.current.setTool('rect'))
    press(r, 'Enter')
    act(() => r.current.setTool('crop'))
    press(r, 'Enter')
    act(() => r.current.clearAll())
    expect(shapes(r)).toHaveLength(0)
    expect(r.current.doc.crop).not.toBeNull()
    act(() => r.current.undo())
    expect(shapes(r)).toHaveLength(1)
  })
})

describe('crop', () => {
  it('Enter sets a default crop, arrows move it, Alt+arrows resize it, Delete resets it', () => {
    const r = setup()
    act(() => r.current.setTool('crop'))
    press(r, 'Enter')
    const c0 = r.current.doc.crop!
    expect(c0).toEqual({ x: 100, y: 60, w: 800, h: 480 })
    press(r, 'ArrowLeft', { shiftKey: true })
    expect(r.current.doc.crop!.x).toBe(90)
    press(r, 'ArrowRight', { altKey: true })
    expect(r.current.doc.crop!.w).toBe(801)
    press(r, 'Delete')
    expect(r.current.doc.crop).toBeNull()
  })

  it('shows the cropped area once the crop tool is closed', () => {
    const r = setup()
    act(() => r.current.setTool('crop'))
    expect(r.current.view).toEqual({ x: 0, y: 0, w: 1000, h: 600 })
    drag(r, [200, 100], [600, 400])
    expect(r.current.doc.crop).toEqual({ x: 200, y: 100, w: 400, h: 300 })
    act(() => r.current.setTool('select'))
    expect(r.current.view).toEqual({ x: 200, y: 100, w: 400, h: 300 })
  })

  it('ignores a crop dragged out too small', () => {
    const r = setup()
    act(() => r.current.setTool('crop'))
    drag(r, [200, 100], [204, 103])
    expect(r.current.doc.crop).toBeNull()
  })

  it('moves and resizes an existing crop by dragging', () => {
    const r = setup()
    act(() => r.current.setTool('crop'))
    press(r, 'Enter') // 100,60 800x480
    drag(r, [500, 300], [550, 330]) // inside: move
    expect(r.current.doc.crop).toMatchObject({ x: 150, y: 90 })
    drag(r, [950, 570], [980, 590]) // se corner
    expect(r.current.doc.crop).toMatchObject({ w: 830, h: 500 })
  })
})

describe('undo / redo / dirty', () => {
  it('is not dirty until something changes and not again after undoing everything', () => {
    const r = setup()
    expect(r.current.dirty).toBe(false)
    act(() => r.current.setTool('line'))
    press(r, 'Enter')
    expect(r.current.dirty).toBe(true)
    expect(r.current.canUndo).toBe(true)
    act(() => r.current.undo())
    expect(r.current.dirty).toBe(false)
    expect(r.current.canRedo).toBe(true)
    expect(r.current.selectedId).toBeNull()
  })
})
