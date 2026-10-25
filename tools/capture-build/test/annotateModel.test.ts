/** Image annotation editor: the pure model (shapes in image pixels, hit-testing, keyboard move / resize, crop, mapping). */
import { describe, expect, it } from 'vitest'
import {
  COLORS,
  appendPoint,
  applyHandle,
  arrowParts,
  badgeRadiusFor,
  blurRadiusFor,
  boundsOf,
  clientToImage,
  clampPan,
  clampRect,
  commandsToD,
  cropOutput,
  defaultCrop,
  defaultShape,
  dragCreate,
  dragCropHandle,
  fitScale,
  fontSizeFor,
  freeSpot,
  handleAt,
  handlesOf,
  hitShape,
  hitTest,
  keyDelta,
  keyStep,
  moveRect,
  pinchView,
  moveShape,
  nextBadgeNumber,
  readableOn,
  resizeRect,
  resizeShapeBy,
  selectionAnnouncement,
  shapeLabel,
  sizeIndexOf,
  smoothCommands,
  textOverlay,
  strokeFor,
  textBounds,
  viewRect,
  zoomAround,
  MAX_ZOOM,
  MIN_ZOOM,
  type BoxShape,
  type SegmentShape,
  type Shape,
  type Style,
  type TextShape,
} from '../../../extension/capture/src/annotate/model'

const IMG = { w: 1000, h: 600 }
const STYLE: Style = { color: '#e5322d', width: 6, fontSize: 30, badgeRadius: 20 }
const rect = (o: Partial<BoxShape> = {}): BoxShape => ({
  id: 'r',
  kind: 'rect',
  color: '#e5322d',
  width: 6,
  x: 100,
  y: 100,
  w: 200,
  h: 100,
  ...o,
})
const arrow = (o: Partial<SegmentShape> = {}): SegmentShape => ({
  id: 'a',
  kind: 'arrow',
  color: '#e5322d',
  width: 6,
  a: { x: 0, y: 0 },
  b: { x: 100, y: 0 },
  ...o,
})
const text = (o: Partial<TextShape> = {}): TextShape => ({
  id: 't',
  kind: 'text',
  color: '#111111',
  width: 0,
  x: 50,
  y: 50,
  text: 'Hello',
  fontSize: 20,
  ...o,
})

describe('sizes are relative to the image', () => {
  it('scales stroke, font and badge with the image, with minimums', () => {
    expect(strokeFor(1, 1920, 1080)).toBe(10)
    expect(strokeFor(1, 100, 100)).toBe(4)
    expect(strokeFor(0, 1920, 1080)).toBeLessThan(strokeFor(2, 1920, 1080))
    expect(fontSizeFor(1, 1920, 1080)).toBe(54)
    expect(fontSizeFor(0, 50, 50)).toBe(14)
    expect(badgeRadiusFor(2, 1000, 600)).toBe(20)
  })
  it('sizes a tall full-page capture like a screen of the same width, not by its height', () => {
    expect(badgeRadiusFor(1, 3300, 20000)).toBe(badgeRadiusFor(1, 3300, 2000))
    expect(strokeFor(1, 3300, 20000)).toBe(strokeFor(1, 3300, 2000))
    expect(fontSizeFor(1, 1170, 2532)).toBe(33)
    // a panorama is capped by its height
    expect(strokeFor(1, 10000, 1000)).toBe(13)
  })
  it('finds the size step nearest to a width', () => {
    expect(sizeIndexOf(strokeFor(2, 1000, 600), 1000, 600)).toBe(2)
    expect(sizeIndexOf(1, 1000, 600)).toBe(0)
  })
  it('has the preset colors the owner asked for', () => {
    const names = COLORS.map((c) => c.name)
    for (const n of ['Red', 'Yellow', 'Green', 'Blue', 'Black', 'White']) expect(names).toContain(n)
    expect(COLORS.length).toBeGreaterThanOrEqual(8)
  })
  it('picks a readable ink for a color', () => {
    expect(readableOn('#ffffff')).toBe('#111111')
    expect(readableOn('#ffd60a')).toBe('#111111')
    expect(readableOn('#111111')).toBe('#ffffff')
    expect(readableOn('#1f6feb')).toBe('#ffffff')
  })
})

describe('placement without dragging (2.5.7)', () => {
  it.each([
    'rect',
    'fillrect',
    'ellipse',
    'blur',
    'arrow',
    'line',
    'highlight',
    'text',
    'badge',
  ] as const)('puts a default %s in the middle of the image', (kind) => {
    const s = defaultShape(kind, { x: 500, y: 300 }, STYLE, 'x', IMG)
    expect(s.kind).toBe(kind)
    const b = boundsOf(s)
    const c = { x: b.x + b.w / 2, y: b.y + b.h / 2 }
    expect(Math.abs(c.x - 500)).toBeLessThan(60)
    expect(Math.abs(c.y - 300)).toBeLessThan(60)
    expect(b.x).toBeGreaterThanOrEqual(0)
    expect(b.x + b.w).toBeLessThanOrEqual(IMG.w + 1)
  })
  it('keeps a default shape inside the image when the center is near an edge', () => {
    const s = defaultShape('rect', { x: 2, y: 2 }, STYLE, 'x', IMG)
    expect(s.kind === 'rect' && s.x).toBe(0)
  })
  it('numbers badges 1, 2, 3 and continues after the highest', () => {
    expect(nextBadgeNumber([])).toBe(1)
    const b = (n: number): Shape => ({
      id: `b${n}`,
      kind: 'badge',
      color: '#e5322d',
      width: 0,
      cx: 0,
      cy: 0,
      r: 10,
      n,
    })
    expect(nextBadgeNumber([b(1), b(2)])).toBe(3)
    expect(nextBadgeNumber([b(1), b(3)])).toBe(4)
  })
  it('does not stack a second shape exactly on the first', () => {
    const first = defaultShape('rect', { x: 500, y: 300 }, STYLE, 'a', IMG)
    const spot = freeSpot([first], 'rect', { x: 500, y: 300 }, 24)
    expect(spot).not.toEqual({ x: 500, y: 300 })
    expect(freeSpot([first], 'arrow', { x: 500, y: 300 }, 24)).toEqual({ x: 500, y: 300 })
  })
})

describe('hit-testing', () => {
  it('selects an outline rectangle by its border only, a filled one anywhere', () => {
    const r = rect()
    expect(hitShape(r, { x: 100, y: 150 }, 4)).toBe(true) // left edge
    expect(hitShape(r, { x: 200, y: 150 }, 4)).toBe(false) // inside: belongs to what is below
    expect(hitShape(r, { x: 50, y: 150 }, 4)).toBe(false)
    expect(hitShape({ ...r, kind: 'fillrect' }, { x: 200, y: 150 }, 4)).toBe(true)
    expect(hitShape({ ...r, kind: 'blur' }, { x: 200, y: 150 }, 4)).toBe(true)
  })
  it('hits a line within its width plus the tolerance', () => {
    const a = arrow()
    expect(hitShape(a, { x: 50, y: 5 }, 4)).toBe(true)
    expect(hitShape(a, { x: 50, y: 30 }, 4)).toBe(false)
    expect(hitShape(a, { x: 150, y: 0 }, 4)).toBe(false)
  })
  it('hits an ellipse on its outline, not in the middle or far away', () => {
    const e = rect({ kind: 'ellipse' })
    expect(hitShape(e, { x: 100, y: 150 }, 4)).toBe(true)
    expect(hitShape(e, { x: 200, y: 150 }, 4)).toBe(false)
    expect(hitShape(e, { x: 500, y: 500 }, 4)).toBe(false)
  })
  it('hits text inside its box and a badge inside its circle', () => {
    const t = text()
    const b = textBounds(t)
    expect(hitShape(t, { x: b.x + 2, y: b.y + 2 }, 2)).toBe(true)
    expect(hitShape(t, { x: b.x + b.w + 40, y: b.y }, 2)).toBe(false)
    const badge: Shape = {
      id: 'b',
      kind: 'badge',
      color: '#000',
      width: 0,
      cx: 100,
      cy: 100,
      r: 20,
      n: 1,
    }
    expect(hitShape(badge, { x: 110, y: 110 }, 2)).toBe(true)
    expect(hitShape(badge, { x: 140, y: 100 }, 2)).toBe(false)
  })
  it('hits a freehand stroke along its segments', () => {
    const pen: Shape = {
      id: 'p',
      kind: 'pen',
      color: '#000',
      width: 6,
      points: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
      ],
    }
    expect(hitShape(pen, { x: 50, y: 2 }, 3)).toBe(true)
    expect(hitShape(pen, { x: 100, y: 60 }, 3)).toBe(true)
    expect(hitShape(pen, { x: 50, y: 50 }, 3)).toBe(false)
  })
  it('returns the topmost shape', () => {
    const under = rect({ id: 'under', kind: 'fillrect' })
    const over = rect({ id: 'over', kind: 'fillrect' })
    expect(hitTest([under, over], { x: 150, y: 150 }, 3)).toBe('over')
    expect(hitTest([under, over], { x: 900, y: 500 }, 3)).toBeNull()
  })
})

describe('handles and resizing', () => {
  it('offers 8 handles on a rectangle, 2 on an arrow, 1 on text and on a badge', () => {
    expect(handlesOf(rect())).toHaveLength(8)
    expect(handlesOf(arrow()).map((h) => h.id)).toEqual(['a', 'b'])
    expect(handlesOf(text())).toHaveLength(1)
    expect(
      handlesOf({ id: 'b', kind: 'badge', color: '#000', width: 0, cx: 0, cy: 0, r: 5, n: 1 }),
    ).toHaveLength(1)
  })
  it('finds the handle under a point', () => {
    expect(handleAt(rect(), { x: 302, y: 201 }, 10)).toBe('se')
    expect(handleAt(rect(), { x: 200, y: 99 }, 10)).toBe('n')
    expect(handleAt(rect(), { x: 200, y: 150 }, 10)).toBeNull()
  })
  it('drags a corner while the opposite one stays, and flips when dragged past it', () => {
    const r = applyHandle(rect(), 'se', { x: 400, y: 300 }) as BoxShape
    expect(r).toMatchObject({ x: 100, y: 100, w: 300, h: 200 })
    const flipped = applyHandle(rect(), 'nw', { x: 400, y: 300 }) as BoxShape
    expect(flipped).toMatchObject({ x: 300, y: 200, w: 100, h: 100 })
    const side = applyHandle(rect(), 'e', { x: 500, y: 999 }) as BoxShape
    expect(side).toMatchObject({ x: 100, y: 100, w: 400, h: 100 })
  })
  it('moves one arrow end', () => {
    const a = applyHandle(arrow(), 'b', { x: 80, y: 40 }) as SegmentShape
    expect(a.a).toEqual({ x: 0, y: 0 })
    expect(a.b).toEqual({ x: 80, y: 40 })
  })
  it('scales a freehand stroke with its corner handle', () => {
    const pen: Shape = {
      id: 'p',
      kind: 'pen',
      color: '#000',
      width: 4,
      points: [
        { x: 0, y: 0 },
        { x: 100, y: 50 },
      ],
    }
    const s = applyHandle(pen, 'se', { x: 200, y: 100 })
    expect(boundsOf(s)).toMatchObject({ x: 0, y: 0, w: 200, h: 100 })
  })
  it('resizes text by font size and a badge by radius', () => {
    const t = applyHandle(text(), 'se', { x: 0, y: 50 + 20 * 1.25 * 2 }) as TextShape
    expect(t.fontSize).toBeCloseTo(40)
    const b = applyHandle(
      { id: 'b', kind: 'badge', color: '#000', width: 0, cx: 100, cy: 100, r: 10, n: 1 },
      'e',
      { x: 130, y: 100 },
    )
    expect(b.kind === 'badge' && b.r).toBe(30)
  })
})

describe('keyboard move and resize', () => {
  it('maps arrow keys to deltas and Shift to 10-pixel steps', () => {
    expect(keyDelta('ArrowLeft', 1)).toEqual({ x: -1, y: 0 })
    expect(keyDelta('ArrowDown', 10)).toEqual({ x: 0, y: 10 })
    expect(keyDelta('a', 1)).toBeNull()
    expect(keyStep(false, 1)).toBe(1)
    expect(keyStep(true, 1)).toBe(10)
    expect(keyStep(true, 2.5)).toBe(25)
  })
  it('moves every kind of shape by the delta', () => {
    const moved = moveShape(rect(), 10, -20, IMG) as BoxShape
    expect(moved).toMatchObject({ x: 110, y: 80 })
    const a = moveShape(
      arrow({ a: { x: 100, y: 100 }, b: { x: 200, y: 100 } }),
      5,
      5,
      IMG,
    ) as SegmentShape
    expect(a.a).toEqual({ x: 105, y: 105 })
    expect(a.b).toEqual({ x: 205, y: 105 })
  })
  it('never moves a shape out of the image entirely', () => {
    const moved = moveShape(rect(), 5000, 5000, IMG) as BoxShape
    const c = { x: moved.x + moved.w / 2, y: moved.y + moved.h / 2 }
    expect(c.x).toBe(IMG.w)
    expect(c.y).toBe(IMG.h)
  })
  it('resizes with Alt+Arrow: size, arrow tip, font size, radius', () => {
    expect(resizeShapeBy(rect(), 10, 0)).toMatchObject({ w: 210, h: 100 })
    expect(resizeShapeBy(rect(), -500, 0)).toMatchObject({ w: 6 }) // never below the minimum
    expect((resizeShapeBy(arrow(), 10, 5) as SegmentShape).b).toEqual({ x: 110, y: 5 })
    expect((resizeShapeBy(text(), 4, 0) as TextShape).fontSize).toBe(24)
    expect((resizeShapeBy(text(), 0, -4) as TextShape).fontSize).toBe(16)
    const badge = resizeShapeBy(
      { id: 'b', kind: 'badge', color: '#000', width: 0, cx: 0, cy: 0, r: 10, n: 1 },
      5,
      0,
    )
    expect(badge.kind === 'badge' && badge.r).toBe(15)
  })
  it('creates by dragging from a start point (either direction)', () => {
    const orig = defaultShape('rect', { x: 0, y: 0 }, STYLE, 'x', IMG)
    expect(dragCreate(orig, { x: 300, y: 200 }, { x: 100, y: 50 })).toMatchObject({
      x: 100,
      y: 50,
      w: 200,
      h: 150,
    })
    const line = dragCreate(
      defaultShape('arrow', { x: 0, y: 0 }, STYLE, 'x', IMG),
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ) as SegmentShape
    expect(line.a).toEqual({ x: 1, y: 2 })
    expect(line.b).toEqual({ x: 3, y: 4 })
  })
})

describe('announcements', () => {
  it('says which shape is selected and where it is in the order', () => {
    const shapes: Shape[] = [
      rect({ id: '1' }),
      arrow({ id: '2' }),
      text({ id: '3', text: 'Look here' }),
    ]
    expect(selectionAnnouncement(shapes, '2')).toBe('Arrow, 2 of 3 selected')
    expect(selectionAnnouncement(shapes, '3')).toBe('Text “Look here”, 3 of 3 selected')
    expect(selectionAnnouncement(shapes, 'nope')).toBe('')
    expect(
      shapeLabel({ id: 'b', kind: 'badge', color: '#000', width: 0, cx: 0, cy: 0, r: 5, n: 4 }),
    ).toBe('Number 4')
  })
})

describe('crop math', () => {
  it('starts from a centered default and keeps every crop inside the image', () => {
    const c = defaultCrop(IMG)
    expect(c).toEqual({ x: 100, y: 60, w: 800, h: 480 })
    expect(moveRect(c, -500, 900, IMG)).toMatchObject({ x: 0, y: 120 })
    expect(resizeRect(c, 5000, 5000, IMG)).toMatchObject({ w: 1000, h: 600, x: 0, y: 0 })
    expect(clampRect({ x: 10, y: 10, w: 1, h: 1 }, IMG)).toMatchObject({ w: 16, h: 16 })
  })
  it('drags a crop handle and clamps to the image', () => {
    const c = dragCropHandle(defaultCrop(IMG), 'se', { x: 5000, y: 5000 }, IMG)
    expect(c).toMatchObject({ x: 100, y: 60, w: 900, h: 540 })
    const nw = dragCropHandle(defaultCrop(IMG), 'nw', { x: -50, y: -50 }, IMG)
    expect(nw).toMatchObject({ x: 0, y: 0 })
  })
  it('exports whole pixels, and nothing for a crop that covers everything', () => {
    expect(cropOutput({ x: 10.4, y: 20.6, w: 100.5, h: 50.2 }, IMG)).toEqual({
      x: 10,
      y: 21,
      w: 101,
      h: 50,
    })
    expect(cropOutput({ x: 0, y: 0, w: 1000, h: 600 }, IMG)).toBeNull()
    expect(cropOutput(null, IMG)).toBeNull()
    expect(cropOutput({ x: 900, y: 0, w: 500, h: 100 }, IMG)).toEqual({
      x: 900,
      y: 0,
      w: 100,
      h: 100,
    })
  })
  it('shows the whole image while the crop tool is open, the crop otherwise', () => {
    const crop = { x: 10, y: 10, w: 100, h: 50 }
    expect(viewRect('crop', crop, IMG)).toEqual({ x: 0, y: 0, w: 1000, h: 600 })
    expect(viewRect('select', crop, IMG)).toEqual(crop)
    expect(viewRect('select', null, IMG)).toEqual({ x: 0, y: 0, w: 1000, h: 600 })
  })
})

describe('stage mapping', () => {
  it('fits the view into the box, growing small images up to 4x', () => {
    expect(fitScale({ w: 2000, h: 1000 }, { w: 1000, h: 800 })).toBe(0.5)
    expect(fitScale({ w: 100, h: 100 }, { w: 1000, h: 1000 })).toBe(4)
    expect(fitScale({ w: 0, h: 0 }, { w: 10, h: 10 })).toBe(1)
  })
  it('maps a pointer position to image pixels, also for a cropped view', () => {
    const box = { left: 100, top: 50, width: 500, height: 300 }
    expect(clientToImage({ x: 350, y: 200 }, box, { x: 0, y: 0, w: 1000, h: 600 })).toEqual({
      x: 500,
      y: 300,
    })
    expect(clientToImage({ x: 100, y: 50 }, box, { x: 200, y: 100, w: 500, h: 300 })).toEqual({
      x: 200,
      y: 100,
    })
  })
})

describe('shared drawing geometry', () => {
  it('smooths freehand points into a path the SVG and the canvas both draw', () => {
    expect(smoothCommands([])).toEqual([])
    expect(commandsToD(smoothCommands([{ x: 1, y: 2 }]))).toBe('M1 2 L1 2')
    const d = commandsToD(
      smoothCommands([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 20, y: 10 },
      ]),
    )
    expect(d.startsWith('M0 0 Q10 0 10 5')).toBe(true)
    expect(d.endsWith('L20 10')).toBe(true)
  })
  it('drops points that are too close', () => {
    const p = appendPoint([{ x: 0, y: 0 }], { x: 0.5, y: 0 }, 2)
    expect(p).toHaveLength(1)
    expect(appendPoint(p, { x: 5, y: 0 }, 2)).toHaveLength(2)
  })
  it('builds an arrow head at the tip and a shaft that stops inside it', () => {
    const { shaftEnd, head } = arrowParts({ x: 0, y: 0 }, { x: 100, y: 0 }, 6)
    expect(head[0]).toEqual({ x: 100, y: 0 })
    expect(shaftEnd.x).toBeLessThan(100)
    expect(shaftEnd.x).toBeGreaterThan(70)
    expect(head[1]!.y).toBeCloseTo(-head[2]!.y)
    expect(arrowParts({ x: 5, y: 5 }, { x: 5, y: 5 }, 6).shaftEnd).toEqual({ x: 5, y: 5 })
  })
  it('blurs strongly enough to hide text', () => {
    expect(blurRadiusFor(300, 40)).toBe(10)
    expect(blurRadiusFor(100, 20)).toBe(8)
    expect(blurRadiusFor(1000, 500)).toBe(40)
  })
})

describe('pinch zoom and pan of the stage', () => {
  const start = {
    zoom: 1,
    pan: { x: 0, y: 0 },
    mid: { x: 300, y: 200 },
    dist: 100,
    origin: { x: 100, y: 50 },
  }

  it('doubles the zoom when the fingers spread to twice the distance, keeping the picture under the middle', () => {
    const v = pinchView(start, { mid: { x: 300, y: 200 }, dist: 200 })
    expect(v.zoom).toBe(2)
    // the stage-local point (200,150) under the middle is still under it: origin + pan + zoom * local = mid
    expect(100 + v.pan.x + 2 * 200).toBe(300)
    expect(50 + v.pan.y + 2 * 150).toBe(200)
  })

  it('panning with two fingers moves the picture with the middle', () => {
    const v = pinchView(start, { mid: { x: 340, y: 230 }, dist: 100 })
    expect(v.zoom).toBe(1)
    expect(v.pan).toEqual({ x: 40, y: 30 })
  })

  it('clamps the zoom between fit and 8x', () => {
    expect(pinchView(start, { mid: start.mid, dist: 10 }).zoom).toBe(MIN_ZOOM)
    expect(pinchView(start, { mid: start.mid, dist: 5000 }).zoom).toBe(MAX_ZOOM)
  })

  it('buttons zoom around a point', () => {
    const v = zoomAround({ zoom: 1, pan: { x: 0, y: 0 } }, 2, { x: 100, y: 100 })
    expect(v).toEqual({ zoom: 2, pan: { x: -100, y: -100 } })
    expect(zoomAround(v, 0.5, { x: 100, y: 100 })).toEqual({ zoom: 1, pan: { x: 0, y: 0 } })
  })

  it('keeps a zoomed stage on screen and a fitted one in place', () => {
    const base = { x: 20, y: 10 }
    const size = { w: 300, h: 200 }
    const box = { w: 340, h: 220 }
    expect(clampPan({ x: 500, y: 500 }, 1, base, size, box)).toEqual({ x: 20, y: 10 })
    expect(clampPan({ x: -500, y: -500 }, 1, base, size, box)).toEqual({ x: -20, y: -10 })
    // zoomed 3x: at least 48px stay inside
    const far = clampPan({ x: 5000, y: 5000 }, 3, base, size, box)
    expect(base.x + far.x).toBe(box.w - 48)
    const near = clampPan({ x: -5000, y: -5000 }, 3, base, size, box)
    expect(base.x + near.x + 900).toBe(48)
  })
})

describe('text edit overlay', () => {
  const box = { w: 374, h: 234 }
  it('on a phone keeps the CSS font at the 16px floor and scales the box to the real size', () => {
    const o = textOverlay({ left: 40, top: 40, textW: 60, lines: 1, real: 9.6, floor: 16, box })
    expect(o.fontSize).toBe(16)
    expect(o.scale).toBeCloseTo(0.6)
    // what is SEEN is the real size, within a tolerance
    expect(o.fontSize * o.scale).toBeCloseTo(9.6, 1)
    expect(o.width * o.scale).toBeCloseTo(Math.max(64, 60 + 28), 1)
  })
  it('does not scale when the real size is already above the floor, nor on desktop', () => {
    expect(
      textOverlay({ left: 0, top: 0, textW: 80, lines: 1, real: 24, floor: 16, box }).scale,
    ).toBe(1)
    const d = textOverlay({ left: 5, top: 5, textW: 10, lines: 1, real: 12, floor: 0, box })
    expect(d).toMatchObject({ fontSize: 12, scale: 1, width: 120, left: 5 })
  })
  it('keeps the box inside the stage on a phone', () => {
    const o = textOverlay({
      left: 360,
      top: 400,
      textW: 200,
      lines: 2,
      real: 20,
      floor: 16,
      box: { w: 320, h: 200 },
    })
    expect(o.left + o.width * o.scale).toBeLessThanOrEqual(320)
    expect(o.left).toBeGreaterThanOrEqual(0)
    expect(o.top).toBeLessThan(200)
  })
})
