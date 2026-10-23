/**
 * Image annotation model: shapes in IMAGE PIXEL coordinates (so they scale with the stage and export at the image's
 * natural resolution), plus the pure geometry the editor needs: default placement, hit-testing, move / resize by handle
 * or keyboard, crop math, fit-to-stage and the shared path / arrow geometry that both the SVG stage and the canvas
 * export draw from. No DOM, no React.
 */

export interface Pt {
  x: number
  y: number
}
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export type Tool =
  | 'select'
  | 'pen'
  | 'highlight'
  | 'arrow'
  | 'line'
  | 'rect'
  | 'fillrect'
  | 'ellipse'
  | 'text'
  | 'badge'
  | 'blur'
  | 'crop'
export type ShapeKind = Exclude<Tool, 'select' | 'crop'>

interface Common {
  id: string
  color: string
  /** stroke width in image pixels (highlighter: the base the marker width derives from) */
  width: number
}
export type PenShape = Common & { kind: 'pen'; points: Pt[] }
export type SegmentShape = Common & { kind: 'highlight' | 'arrow' | 'line'; a: Pt; b: Pt }
export type BoxShape = Common & { kind: 'rect' | 'fillrect' | 'ellipse' | 'blur' } & Rect
export type TextShape = Common & {
  kind: 'text'
  x: number
  y: number
  text: string
  fontSize: number
}
export type BadgeShape = Common & { kind: 'badge'; cx: number; cy: number; r: number; n: number }
export type Shape = PenShape | SegmentShape | BoxShape | TextShape | BadgeShape

/** what the history keeps: the shapes (z-order = array order) and the crop rectangle (null = whole image) */
export interface AnnotDoc {
  shapes: Shape[]
  crop: Rect | null
}
export const EMPTY_DOC: AnnotDoc = { shapes: [], crop: null }

export const TOOL_LABEL: Record<Tool, string> = {
  select: 'Select',
  pen: 'Freehand pen',
  highlight: 'Highlighter',
  arrow: 'Arrow',
  line: 'Line',
  rect: 'Rectangle',
  fillrect: 'Filled rectangle',
  ellipse: 'Ellipse',
  text: 'Text',
  badge: 'Number',
  blur: 'Blur',
  crop: 'Crop',
}
/** the tools that put a shape on the stage (Enter / "Add" places one without dragging); the pen is drag-only */
export const PLACEABLE: ReadonlySet<Tool> = new Set([
  'highlight',
  'arrow',
  'line',
  'rect',
  'fillrect',
  'ellipse',
  'text',
  'badge',
  'blur',
])
export const KIND_NAME: Record<ShapeKind, string> = {
  pen: 'Freehand stroke',
  highlight: 'Highlight',
  arrow: 'Arrow',
  line: 'Line',
  rect: 'Rectangle',
  fillrect: 'Filled rectangle',
  ellipse: 'Ellipse',
  text: 'Text',
  badge: 'Number',
  blur: 'Blur',
}

export const COLORS = [
  { name: 'Red', value: '#e5322d' },
  { name: 'Orange', value: '#f28c28' },
  { name: 'Yellow', value: '#ffd60a' },
  { name: 'Green', value: '#1fa34a' },
  { name: 'Blue', value: '#1f6feb' },
  { name: 'Purple', value: '#8a3ba6' },
  { name: 'Black', value: '#111111' },
  { name: 'White', value: '#ffffff' },
] as const
export const DEFAULT_COLOR = COLORS[0].value
export const HIGHLIGHT_COLOR = COLORS[2].value
export const colorName = (value: string) =>
  COLORS.find((c) => c.value.toLowerCase() === value.toLowerCase())?.name ?? value

export const SIZE_LABELS = ['Thin', 'Medium', 'Thick'] as const
export const FONT_LABELS = ['Small', 'Medium', 'Large', 'Extra large'] as const

const STROKE_F = [0.0025, 0.005, 0.009]
const STROKE_MIN = [2, 4, 7]
const FONT_F = [0.018, 0.028, 0.045, 0.07]
const FONT_MIN = [14, 18, 26, 38]
const BADGE_F = [0.009, 0.014, 0.02]
const BADGE_MIN = [9, 12, 16]
const longSide = (w: number, h: number) => Math.max(w, h, 1)

/** stroke width (image px) of size step 0..2: relative to the image so a screenshot and a thumbnail both read well */
export const strokeFor = (i: number, w: number, h: number) =>
  Math.max(STROKE_MIN[i] ?? 4, Math.round(longSide(w, h) * (STROKE_F[i] ?? 0.005)))
export const fontSizeFor = (i: number, w: number, h: number) =>
  Math.max(FONT_MIN[i] ?? 18, Math.round(longSide(w, h) * (FONT_F[i] ?? 0.028)))
export const badgeRadiusFor = (i: number, w: number, h: number) =>
  Math.max(BADGE_MIN[i] ?? 12, Math.round(longSide(w, h) * (BADGE_F[i] ?? 0.014)))

export function nearestIndex(value: number, options: number[]) {
  let best = 0
  for (let i = 1; i < options.length; i++)
    if (Math.abs(options[i]! - value) < Math.abs(options[best]! - value)) best = i
  return best
}
export const sizeIndexOf = (width: number, w: number, h: number) =>
  nearestIndex(
    width,
    [0, 1, 2].map((i) => strokeFor(i, w, h)),
  )
export const fontIndexOf = (fontSize: number, w: number, h: number) =>
  nearestIndex(
    fontSize,
    [0, 1, 2, 3].map((i) => fontSizeFor(i, w, h)),
  )

export const HIGHLIGHT_ALPHA = 0.4
/** the marker is wider than a pen stroke of the same size step */
export const highlightWidth = (width: number) => width * 4
export const LINE_HEIGHT = 1.25
export const FONT_STACK =
  "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
export const MIN_BOX = 6

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
export const clampN = clamp

/** black or white, whichever reads better on this color (badge numbers, halos) */
export function readableOn(hex: string): '#111111' | '#ffffff' {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return '#ffffff'
  const n = parseInt(m[1]!, 16)
  const lin = (c: number) => {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  const l = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255)
  return l > 0.36 ? '#111111' : '#ffffff'
}

// ------------------------------------------------------------------------------------------------------- text

export type TextMeasure = (line: string, fontSize: number) => number
/** used until a real measurer (canvas) is available, and in tests */
export const estimateTextWidth: TextMeasure = (line, fontSize) => line.length * fontSize * 0.56

export const textLines = (text: string) => (text === '' ? [''] : text.split('\n'))

export function textBounds(s: TextShape, measure: TextMeasure = estimateTextWidth): Rect {
  const lines = textLines(s.text)
  const w = Math.max(s.fontSize * 0.6, ...lines.map((l) => measure(l, s.fontSize)))
  return { x: s.x, y: s.y, w, h: lines.length * s.fontSize * LINE_HEIGHT }
}

// ----------------------------------------------------------------------------------------------- geometry

export const rectOf = (a: Pt, b: Pt): Rect => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  w: Math.abs(a.x - b.x),
  h: Math.abs(a.y - b.y),
})

export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0, 1)
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

export function boundsOf(s: Shape, measure?: TextMeasure): Rect {
  switch (s.kind) {
    case 'pen': {
      const xs = s.points.map((p) => p.x)
      const ys = s.points.map((p) => p.y)
      const x = Math.min(...xs)
      const y = Math.min(...ys)
      return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
    }
    case 'highlight':
    case 'arrow':
    case 'line':
      return rectOf(s.a, s.b)
    case 'text':
      return textBounds(s, measure)
    case 'badge':
      return { x: s.cx - s.r, y: s.cy - s.r, w: s.r * 2, h: s.r * 2 }
    default:
      return { x: s.x, y: s.y, w: s.w, h: s.h }
  }
}

export const centerOf = (r: Rect): Pt => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })

export function translateShape<T extends Shape>(s: T, dx: number, dy: number): T {
  switch (s.kind) {
    case 'pen':
      return { ...s, points: s.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) }
    case 'highlight':
    case 'arrow':
    case 'line':
      return {
        ...s,
        a: { x: s.a.x + dx, y: s.a.y + dy },
        b: { x: s.b.x + dx, y: s.b.y + dy },
      }
    case 'badge':
      return { ...s, cx: s.cx + dx, cy: s.cy + dy }
    default:
      return { ...s, x: (s as BoxShape).x + dx, y: (s as BoxShape).y + dy }
  }
}

/** move by (dx, dy) but keep the shape's center inside the image, so it can always be found again */
export function moveShape(s: Shape, dx: number, dy: number, img: { w: number; h: number }): Shape {
  const c = centerOf(boundsOf(s))
  const nx = clamp(c.x + dx, 0, img.w)
  const ny = clamp(c.y + dy, 0, img.h)
  return translateShape(s, nx - c.x, ny - c.y)
}

export type Handle = 'a' | 'b' | 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
export interface HandlePos {
  id: Handle
  x: number
  y: number
}

export function rectHandles(r: Rect): HandlePos[] {
  const cx = r.x + r.w / 2
  const cy = r.y + r.h / 2
  const x2 = r.x + r.w
  const y2 = r.y + r.h
  return [
    { id: 'nw', x: r.x, y: r.y },
    { id: 'n', x: cx, y: r.y },
    { id: 'ne', x: x2, y: r.y },
    { id: 'e', x: x2, y: cy },
    { id: 'se', x: x2, y: y2 },
    { id: 's', x: cx, y: y2 },
    { id: 'sw', x: r.x, y: y2 },
    { id: 'w', x: r.x, y: cy },
  ]
}

export function handlesOf(s: Shape, measure?: TextMeasure): HandlePos[] {
  switch (s.kind) {
    case 'highlight':
    case 'arrow':
    case 'line':
      return [
        { id: 'a', ...s.a },
        { id: 'b', ...s.b },
      ]
    case 'pen': {
      const b = boundsOf(s)
      return rectHandles(b).filter((h) => h.id.length === 2)
    }
    case 'text': {
      const b = textBounds(s, measure)
      return [{ id: 'se', x: b.x + b.w, y: b.y + b.h }]
    }
    case 'badge':
      return [{ id: 'e', x: s.cx + s.r, y: s.cy }]
    default:
      return rectHandles(s)
  }
}

/** the rectangle a rect handle drags towards `pt` (the opposite side stays; dragging past it flips) */
export function dragRectHandle(r: Rect, handle: Handle, pt: Pt): Rect {
  let x1 = r.x
  let y1 = r.y
  let x2 = r.x + r.w
  let y2 = r.y + r.h
  if (handle.includes('w')) x1 = pt.x
  if (handle.includes('e')) x2 = pt.x
  if (handle.includes('n')) y1 = pt.y
  if (handle.includes('s')) y2 = pt.y
  return rectOf({ x: x1, y: y1 }, { x: x2, y: y2 })
}

function scalePen(s: PenShape, from: Rect, to: Rect): PenShape {
  const sx = from.w > 0 ? to.w / from.w : 1
  const sy = from.h > 0 ? to.h / from.h : 1
  return {
    ...s,
    points: s.points.map((p) => ({
      x: to.x + (from.w > 0 ? (p.x - from.x) * sx : 0),
      y: to.y + (from.h > 0 ? (p.y - from.y) * sy : 0),
    })),
  }
}

/** drag `handle` of `orig` to `pt` (the original shape is the base, so a long drag never accumulates error) */
export function applyHandle(orig: Shape, handle: Handle, pt: Pt): Shape {
  switch (orig.kind) {
    case 'highlight':
    case 'arrow':
    case 'line':
      return handle === 'a' ? { ...orig, a: { ...pt } } : { ...orig, b: { ...pt } }
    case 'pen': {
      const from = boundsOf(orig)
      return scalePen(orig, from, dragRectHandle(from, handle, pt))
    }
    case 'text': {
      const lines = textLines(orig.text).length
      const fontSize = clamp((pt.y - orig.y) / (lines * LINE_HEIGHT), 8, 2000)
      return { ...orig, fontSize }
    }
    case 'badge':
      return { ...orig, r: Math.max(MIN_BOX, Math.hypot(pt.x - orig.cx, pt.y - orig.cy)) }
    default: {
      const r = dragRectHandle(orig, handle, pt)
      return { ...orig, ...r }
    }
  }
}

/** keyboard resize: grow / shrink by (dw, dh) image pixels (Alt+Arrow); what that means depends on the shape */
export function resizeShapeBy(s: Shape, dw: number, dh: number): Shape {
  switch (s.kind) {
    case 'highlight':
    case 'arrow':
    case 'line':
      return { ...s, b: { x: s.b.x + dw, y: s.b.y + dh } }
    case 'pen': {
      const from = boundsOf(s)
      if (from.w === 0 && from.h === 0) return s
      return scalePen(s, from, {
        x: from.x,
        y: from.y,
        w: Math.max(MIN_BOX, from.w + dw),
        h: Math.max(MIN_BOX, from.h + dh),
      })
    }
    case 'text':
      return { ...s, fontSize: clamp(s.fontSize + (dw !== 0 ? dw : dh), 8, 2000) }
    case 'badge':
      return { ...s, r: Math.max(MIN_BOX, s.r + (dw !== 0 ? dw : dh)) }
    default:
      return { ...s, w: Math.max(MIN_BOX, s.w + dw), h: Math.max(MIN_BOX, s.h + dh) }
  }
}

// ------------------------------------------------------------------------------------------- hit-testing

export function hitShape(s: Shape, p: Pt, tol: number, measure?: TextMeasure): boolean {
  switch (s.kind) {
    case 'line':
    case 'arrow':
      return distToSegment(p, s.a, s.b) <= Math.max(s.width / 2, 0) + tol
    case 'highlight':
      return distToSegment(p, s.a, s.b) <= highlightWidth(s.width) / 2 + tol * 0.5
    case 'pen': {
      const pts = s.points
      if (pts.length === 1) return Math.hypot(p.x - pts[0]!.x, p.y - pts[0]!.y) <= s.width / 2 + tol
      for (let i = 1; i < pts.length; i++)
        if (distToSegment(p, pts[i - 1]!, pts[i]!) <= s.width / 2 + tol) return true
      return false
    }
    case 'rect': {
      const inside = (r: Rect, grow: number) =>
        p.x >= r.x - grow && p.x <= r.x + r.w + grow && p.y >= r.y - grow && p.y <= r.y + r.h + grow
      const edge = s.width / 2 + tol
      if (!inside(s, edge)) return false
      // the interior belongs to whatever lies under the rectangle; only the border selects it
      return !(
        p.x > s.x + edge &&
        p.x < s.x + s.w - edge &&
        p.y > s.y + edge &&
        p.y < s.y + s.h - edge
      )
    }
    case 'fillrect':
    case 'blur':
      return (
        p.x >= s.x - tol && p.x <= s.x + s.w + tol && p.y >= s.y - tol && p.y <= s.y + s.h + tol
      )
    case 'ellipse': {
      const rx = Math.max(s.w / 2, 0.5)
      const ry = Math.max(s.h / 2, 0.5)
      const k = Math.hypot((p.x - (s.x + rx)) / rx, (p.y - (s.y + ry)) / ry)
      return Math.abs(k - 1) * Math.min(rx, ry) <= s.width / 2 + tol
    }
    case 'text': {
      const b = textBounds(s, measure)
      return (
        p.x >= b.x - tol && p.x <= b.x + b.w + tol && p.y >= b.y - tol && p.y <= b.y + b.h + tol
      )
    }
    case 'badge':
      return Math.hypot(p.x - s.cx, p.y - s.cy) <= s.r + tol * 0.5
  }
}

/** the topmost shape at `p` */
export function hitTest(
  shapes: readonly Shape[],
  p: Pt,
  tol: number,
  measure?: TextMeasure,
): string | null {
  for (let i = shapes.length - 1; i >= 0; i--)
    if (hitShape(shapes[i]!, p, tol, measure)) return shapes[i]!.id
  return null
}

/** the handle of `s` under `p` (within `tol` image pixels), nearest first */
export function handleAt(s: Shape, p: Pt, tol: number, measure?: TextMeasure): Handle | null {
  let best: Handle | null = null
  let bestD = Infinity
  for (const h of handlesOf(s, measure)) {
    const d = Math.hypot(p.x - h.x, p.y - h.y)
    if (d <= tol && d < bestD) {
      best = h.id
      bestD = d
    }
  }
  return best
}

// ---------------------------------------------------------------------------------------------- creation

export interface Style {
  color: string
  width: number
  fontSize: number
  badgeRadius: number
}

export const nextBadgeNumber = (shapes: readonly Shape[]) =>
  shapes.reduce((n, s) => (s.kind === 'badge' ? Math.max(n, s.n) : n), 0) + 1

/** a default-size shape of this kind centered at `c` (kept inside the image) */
export function defaultShape(
  kind: ShapeKind,
  c: Pt,
  style: Style,
  id: string,
  img: { w: number; h: number },
  n = 1,
): Shape {
  const base = { id, color: style.color, width: style.width }
  const boxW = clamp(img.w * 0.3, MIN_BOX, img.w)
  const boxH = clamp(img.h * (kind === 'blur' ? 0.12 : 0.2), MIN_BOX, img.h)
  const x = clamp(c.x - boxW / 2, 0, Math.max(0, img.w - boxW))
  const y = clamp(c.y - boxH / 2, 0, Math.max(0, img.h - boxH))
  switch (kind) {
    case 'rect':
    case 'fillrect':
    case 'ellipse':
    case 'blur':
      return { ...base, kind, x, y, w: boxW, h: boxH }
    case 'arrow':
    case 'line':
      return {
        ...base,
        kind,
        a: { x: clamp(c.x - img.w * 0.12, 0, img.w), y: clamp(c.y + img.h * 0.1, 0, img.h) },
        b: { x: clamp(c.x + img.w * 0.12, 0, img.w), y: clamp(c.y - img.h * 0.1, 0, img.h) },
      }
    case 'highlight':
      return {
        ...base,
        kind,
        a: { x: clamp(c.x - img.w * 0.15, 0, img.w), y: c.y },
        b: { x: clamp(c.x + img.w * 0.15, 0, img.w), y: c.y },
      }
    case 'text':
      return {
        ...base,
        kind,
        x: clamp(c.x - style.fontSize * 1.4, 0, img.w),
        y: clamp(c.y - style.fontSize * 0.6, 0, img.h),
        text: 'Text',
        fontSize: style.fontSize,
      }
    case 'badge':
      return { ...base, kind, cx: c.x, cy: c.y, r: style.badgeRadius, n }
    case 'pen':
      return {
        ...base,
        kind,
        points: [
          { x: c.x - img.w * 0.1, y: c.y },
          { x: c.x, y: c.y - img.h * 0.04 },
          { x: c.x + img.w * 0.1, y: c.y },
        ],
      }
  }
}

/** shift `c` down-right until no shape of this kind already sits exactly there (repeated Enter does not stack) */
export function freeSpot(shapes: readonly Shape[], kind: ShapeKind, c: Pt, step: number): Pt {
  const same = (p: Pt) =>
    shapes.some((s) => {
      if (s.kind !== kind) return false
      const k = centerOf(boundsOf(s))
      return Math.abs(k.x - p.x) < 1 && Math.abs(k.y - p.y) < 1
    })
  let p = c
  for (let i = 0; i < 40 && same(p); i++) p = { x: c.x + step * (i + 1), y: c.y + step * (i + 1) }
  return p
}

/** the shape while dragging out from `start` to `to` (rects, ellipses, blur, arrows, lines, highlights) */
export function dragCreate(orig: Shape, start: Pt, to: Pt): Shape {
  switch (orig.kind) {
    case 'highlight':
    case 'arrow':
    case 'line':
      return { ...orig, a: { ...start }, b: { ...to } }
    case 'rect':
    case 'fillrect':
    case 'ellipse':
    case 'blur':
      return { ...orig, ...rectOf(start, to) }
    default:
      return orig
  }
}

// ------------------------------------------------------------------------------------------------ labels

export function shapeLabel(s: Shape): string {
  if (s.kind === 'text') return s.text.trim() ? `Text “${s.text.trim().slice(0, 24)}”` : 'Text'
  if (s.kind === 'badge') return `Number ${s.n}`
  return KIND_NAME[s.kind]
}

/** "Arrow 2 of 4 selected" */
export function selectionAnnouncement(shapes: readonly Shape[], id: string): string {
  const i = shapes.findIndex((s) => s.id === id)
  if (i < 0) return ''
  return `${shapeLabel(shapes[i]!)}, ${i + 1} of ${shapes.length} selected`
}

// -------------------------------------------------------------------------------------------- key handling

export function keyDelta(key: string, step: number): Pt | null {
  switch (key) {
    case 'ArrowLeft':
      return { x: -step, y: 0 }
    case 'ArrowRight':
      return { x: step, y: 0 }
    case 'ArrowUp':
      return { x: 0, y: -step }
    case 'ArrowDown':
      return { x: 0, y: step }
    default:
      return null
  }
}

/** one arrow-key press = `unit` image pixels (1 screen pixel), Shift = 10 of them */
export const keyStep = (shift: boolean, unit: number) => (shift ? 10 : 1) * unit

// --------------------------------------------------------------------------------------------------- crop

export const MIN_CROP = 16

export function defaultCrop(img: { w: number; h: number }): Rect {
  const mx = img.w * 0.1
  const my = img.h * 0.1
  return { x: mx, y: my, w: img.w - 2 * mx, h: img.h - 2 * my }
}

/** a rectangle kept inside the image and at least `min` big */
export function clampRect(r: Rect, img: { w: number; h: number }, min = MIN_CROP): Rect {
  const m = Math.min(min, img.w, img.h)
  const w = clamp(r.w, m, img.w)
  const h = clamp(r.h, m, img.h)
  return { x: clamp(r.x, 0, img.w - w), y: clamp(r.y, 0, img.h - h), w, h }
}
export const moveRect = (r: Rect, dx: number, dy: number, img: { w: number; h: number }): Rect =>
  clampRect({ ...r, x: r.x + dx, y: r.y + dy }, img)
export const resizeRect = (r: Rect, dw: number, dh: number, img: { w: number; h: number }): Rect =>
  clampRect({ ...r, w: r.w + dw, h: r.h + dh }, img)
export function dragCropHandle(
  r: Rect,
  handle: Handle,
  pt: Pt,
  img: { w: number; h: number },
): Rect {
  return clampRect(
    dragRectHandle(r, handle, { x: clamp(pt.x, 0, img.w), y: clamp(pt.y, 0, img.h) }),
    img,
  )
}
/** the crop that is really exported: whole pixels inside the image; null when it covers everything */
export function cropOutput(crop: Rect | null, img: { w: number; h: number }): Rect | null {
  if (!crop) return null
  const x = clamp(Math.round(crop.x), 0, img.w - 1)
  const y = clamp(Math.round(crop.y), 0, img.h - 1)
  const w = clamp(Math.round(crop.w), 1, img.w - x)
  const h = clamp(Math.round(crop.h), 1, img.h - y)
  return x === 0 && y === 0 && w === img.w && h === img.h ? null : { x, y, w, h }
}
/** what the stage shows: the whole image while the crop tool is open, else the crop (or everything) */
export const viewRect = (tool: Tool, crop: Rect | null, img: { w: number; h: number }): Rect =>
  tool !== 'crop' && crop ? crop : { x: 0, y: 0, w: img.w, h: img.h }

// ------------------------------------------------------------------------------------------ stage mapping

/** display scale (screen px per image px) that fits `view` into the box; small images may grow up to `maxUp` */
export function fitScale(
  view: { w: number; h: number },
  box: { w: number; h: number },
  maxUp = 4,
): number {
  if (view.w <= 0 || view.h <= 0 || box.w <= 0 || box.h <= 0) return 1
  return Math.min(box.w / view.w, box.h / view.h, maxUp)
}

/** a pointer position on the displayed stage -> image coordinates */
export function clientToImage(
  client: Pt,
  box: { left: number; top: number; width: number; height: number },
  view: Rect,
): Pt {
  const w = box.width || 1
  const h = box.height || 1
  return {
    x: view.x + ((client.x - box.left) * view.w) / w,
    y: view.y + ((client.y - box.top) * view.h) / h,
  }
}

// ----------------------------------------------------------------------------------- shared draw geometry

export type PathCmd =
  | { c: 'M'; x: number; y: number }
  | { c: 'L'; x: number; y: number }
  | { c: 'Q'; cx: number; cy: number; x: number; y: number }

/** freehand points -> a smooth path (quadratic curves through the midpoints), the same for SVG and canvas */
export function smoothCommands(points: readonly Pt[]): PathCmd[] {
  if (points.length === 0) return []
  const first = points[0]!
  if (points.length === 1)
    return [
      { c: 'M', ...first },
      { c: 'L', x: first.x, y: first.y },
    ]
  if (points.length === 2)
    return [
      { c: 'M', ...first },
      { c: 'L', x: points[1]!.x, y: points[1]!.y },
    ]
  const out: PathCmd[] = [{ c: 'M', ...first }]
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i]!
    const n = points[i + 1]!
    out.push({ c: 'Q', cx: p.x, cy: p.y, x: (p.x + n.x) / 2, y: (p.y + n.y) / 2 })
  }
  const last = points[points.length - 1]!
  out.push({ c: 'L', x: last.x, y: last.y })
  return out
}
const r2 = (n: number) => Math.round(n * 100) / 100
export const commandsToD = (cmds: readonly PathCmd[]) =>
  cmds
    .map((c) =>
      c.c === 'Q'
        ? `Q${r2(c.cx)} ${r2(c.cy)} ${r2(c.x)} ${r2(c.y)}`
        : `${c.c}${r2(c.x)} ${r2(c.y)}`,
    )
    .join(' ')

/** a stroke needs at least this many image px between two kept points */
export function appendPoint(points: Pt[], p: Pt, minDist: number): Pt[] {
  const last = points[points.length - 1]
  if (last && Math.hypot(p.x - last.x, p.y - last.y) < minDist) return points
  return [...points, p]
}

/** shaft end (the head's base) and the three head corners of an arrow from a to b */
export function arrowParts(a: Pt, b: Pt, width: number): { shaftEnd: Pt; head: [Pt, Pt, Pt] } {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy)
  if (len === 0) return { shaftEnd: { ...b }, head: [{ ...b }, { ...b }, { ...b }] }
  const ux = dx / len
  const uy = dy / len
  const headLen = Math.min(len, Math.max(width * 4.5, 12))
  const half = headLen * 0.42
  const base = { x: b.x - ux * headLen, y: b.y - uy * headLen }
  return {
    shaftEnd: { x: b.x - ux * headLen * 0.8, y: b.y - uy * headLen * 0.8 },
    head: [
      { x: b.x, y: b.y },
      { x: base.x - uy * half, y: base.y + ux * half },
      { x: base.x + uy * half, y: base.y - ux * half },
    ],
  }
}

/** pixelation block size for a blur box (large enough that text inside stays unreadable) */
export const blockSizeFor = (w: number, h: number) => clamp(Math.round(Math.min(w, h) / 5), 8, 48)

let seq = 0
export const newShapeId = () => `s${Date.now().toString(36)}${(seq++).toString(36)}`

// ------------------------------------------------------------------------------------------- zoom and pan

export const MIN_ZOOM = 1
export const MAX_ZOOM = 8
export interface StageView {
  zoom: number
  /** screen px the zoomed stage is shifted from its fitted position */
  pan: Pt
}
export const FIT_VIEW: StageView = { zoom: 1, pan: { x: 0, y: 0 } }

/**
 * Keep a zoomed stage on screen: at least `keep` px of it must stay inside the box (a smaller-than-box stage is
 * centered, i.e. pan 0). `base` is the stage's fitted offset inside the box, `size` its fitted size.
 */
export function clampPan(
  pan: Pt,
  zoom: number,
  base: Pt,
  size: { w: number; h: number },
  box: { w: number; h: number },
  keep = 48,
): Pt {
  const axis = (p: number, b: number, s: number, bx: number) => {
    const scaled = s * zoom
    if (scaled <= bx) return clamp(p, -b, bx - b - scaled) // stays fully inside (or centered at zoom 1)
    const k = Math.min(keep, bx)
    return clamp(p, k - b - scaled, bx - k - b)
  }
  return { x: axis(pan.x, base.x, size.w, box.w), y: axis(pan.y, base.y, size.h, box.h) }
}

/**
 * Two fingers: the zoom follows the distance between them, and the picture point that was under the middle between them
 * at the start stays under it. All points are client pixels; `origin` is where the unzoomed stage's top-left corner is.
 */
export function pinchView(
  start: { zoom: number; pan: Pt; mid: Pt; dist: number; origin: Pt },
  now: { mid: Pt; dist: number },
): StageView {
  const zoom = clamp(start.zoom * (start.dist > 0 ? now.dist / start.dist : 1), MIN_ZOOM, MAX_ZOOM)
  // the stage-local point under the starting middle
  const px = (start.mid.x - start.origin.x - start.pan.x) / start.zoom
  const py = (start.mid.y - start.origin.y - start.pan.y) / start.zoom
  return {
    zoom,
    pan: { x: now.mid.x - start.origin.x - zoom * px, y: now.mid.y - start.origin.y - zoom * py },
  }
}

/** zoom by a factor around a point of the box (buttons: the middle), keeping that point fixed */
export function zoomAround(view: StageView, factor: number, about: Pt): StageView {
  const zoom = clamp(view.zoom * factor, MIN_ZOOM, MAX_ZOOM)
  const k = zoom / view.zoom
  return {
    zoom,
    pan: { x: about.x - (about.x - view.pan.x) * k, y: about.y - (about.y - view.pan.y) * k },
  }
}

// ------------------------------------------------------------------------------------- text edit overlay

/**
 * Where and how big the text box is while typing. `real` is the text's on-screen font size (image font size x display
 * scale). On a phone the box's CSS font-size must be at least `floor` (16px: a smaller one makes iOS zoom the page), so a
 * smaller real size is reached with a CSS scale (`k`, origin top left): the box then LOOKS exactly like the committed text.
 * With a floor the box is also kept inside the stage (`box`, same px as left / top).
 */
export function textOverlay(o: {
  left: number
  top: number
  /** the text's real on-screen width (widest line) and the line count */
  textW: number
  lines: number
  real: number
  floor: number
  box: { w: number; h: number }
}): { left: number; top: number; width: number; fontSize: number; scale: number } {
  const fontSize = Math.max(o.floor, o.real)
  const k = o.real / fontSize
  let widthReal = Math.max(o.floor ? 64 : 120, o.textW + 28)
  let { left, top } = o
  if (o.floor) {
    const heightReal = o.lines * o.real * LINE_HEIGHT + 4
    widthReal = Math.min(widthReal, Math.max(48, o.box.w - 8))
    left = clamp(left, 4, Math.max(4, o.box.w - widthReal - 4))
    top = clamp(top, 0, Math.max(0, o.box.h - heightReal))
  }
  return { left, top, width: widthReal / k, fontSize, scale: k }
}
