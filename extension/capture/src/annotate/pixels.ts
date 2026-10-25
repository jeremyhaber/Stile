/**
 * Reading the picture's pixels for the color picker and the smart measurement: one pixel, or the run of like-colored
 * pixels through a point along its row and its column (what Shottr's ruler shows: the gap between two edges). Only the
 * row / column under the pointer is drawn and read, so a 30 000 px full-page capture costs no more than a small one.
 */
import type { Pt } from './model'

/** the uniform region through a point: x1..x2 along its row, y1..y2 along its column (ends exclusive), image px */
export interface Span {
  x1: number
  x2: number
  y1: number
  y2: number
}

/** what the pointer is over: the point (image px), the pixel's color and, for the measure tool, the span */
export interface Probe {
  pt: Pt
  color: string | null
  span: Span | null
}

export interface Sampler {
  color(p: Pt): string | null
  span(p: Pt): Span | null
}

/** channel difference (0..255) up to which two pixels count as the same color: anti-aliased edges stop the run */
export const EDGE_TOLERANCE = 10

/** the run [lo, hi) of pixels like pixel `i` in an RGBA line of `n` pixels */
export function findRun(
  data: ArrayLike<number>,
  n: number,
  i: number,
  tol = EDGE_TOLERANCE,
): [number, number] {
  const o = i * 4
  const r = data[o]!
  const g = data[o + 1]!
  const b = data[o + 2]!
  const a = data[o + 3]!
  const like = (j: number) => {
    const q = j * 4
    return (
      Math.abs(data[q]! - r) <= tol &&
      Math.abs(data[q + 1]! - g) <= tol &&
      Math.abs(data[q + 2]! - b) <= tol &&
      Math.abs(data[q + 3]! - a) <= tol
    )
  }
  let lo = i
  while (lo > 0 && like(lo - 1)) lo--
  let hi = i + 1
  while (hi < n && like(hi)) hi++
  return [lo, hi]
}

const hex2 = (n: number) => n.toString(16).padStart(2, '0')
export const toHex = (r: number, g: number, b: number) => `#${hex2(r)}${hex2(g)}${hex2(b)}`

/** a sampler over a decoded picture; null where there is no canvas (jsdom) */
export function createSampler(source: CanvasImageSource, w: number, h: number): Sampler | null {
  let rowCtx: CanvasRenderingContext2D | null = null
  let colCtx: CanvasRenderingContext2D | null = null
  try {
    if (typeof document === 'undefined' || /jsdom/i.test(navigator.userAgent)) return null
    const row = document.createElement('canvas')
    row.width = w
    row.height = 1
    const col = document.createElement('canvas')
    col.width = 1
    col.height = h
    rowCtx = row.getContext('2d', { willReadFrequently: true })
    colCtx = col.getContext('2d', { willReadFrequently: true })
  } catch {
    return null
  }
  if (!rowCtx || !colCtx) return null
  const rc = rowCtx
  const cc = colCtx
  // the last row and column read: moving along a line (or holding still) reads nothing new
  let rowAt = -1
  let rowData: Uint8ClampedArray | null = null
  let colAt = -1
  let colData: Uint8ClampedArray | null = null
  const readRow = (y: number) => {
    if (y !== rowAt) {
      rc.clearRect(0, 0, w, 1)
      rc.drawImage(source, 0, y, w, 1, 0, 0, w, 1)
      rowData = rc.getImageData(0, 0, w, 1).data
      rowAt = y
    }
    return rowData!
  }
  const readCol = (x: number) => {
    if (x !== colAt) {
      cc.clearRect(0, 0, 1, h)
      cc.drawImage(source, x, 0, 1, h, 0, 0, 1, h)
      colData = cc.getImageData(0, 0, 1, h).data
      colAt = x
    }
    return colData!
  }
  const cell = (p: Pt) => {
    const x = Math.floor(p.x)
    const y = Math.floor(p.y)
    return x < 0 || y < 0 || x >= w || y >= h ? null : { x, y }
  }
  return {
    color(p) {
      const c = cell(p)
      if (!c) return null
      try {
        const d = readRow(c.y)
        const o = c.x * 4
        return toHex(d[o]!, d[o + 1]!, d[o + 2]!)
      } catch {
        return null // a tainted canvas (never for our own blob URLs)
      }
    },
    span(p) {
      const c = cell(p)
      if (!c) return null
      try {
        const [x1, x2] = findRun(readRow(c.y), w, c.x)
        const [y1, y2] = findRun(readCol(c.x), h, c.y)
        return { x1, x2, y1, y2 }
      } catch {
        return null
      }
    },
  }
}
