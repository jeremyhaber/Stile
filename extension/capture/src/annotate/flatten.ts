/**
 * Flatten an annotated image onto a canvas (the crop plus any padding, at the export scale) and encode it.
 * Blur boxes are blurred here exactly like the stage's live preview; magnifiers show the blurred picture too.
 * The canvas is injectable for tests.
 */
import {
  FONT_STACK,
  HIGHLIGHT_ALPHA,
  LINE_HEIGHT,
  arrowParts,
  blurRadiusFor,
  cropOutput,
  docScale,
  highlightWidth,
  lensParts,
  measureParts,
  padRect,
  padSize,
  readableOn,
  smoothCommands,
  textLines,
  type AnnotDoc,
  type MagnifyShape,
  type Rect,
  type Shape,
  badgeFontSize,
} from './model'

/** the part of a canvas this module uses (a real HTMLCanvasElement fits; tests pass a stub) */
export interface CanvasLike {
  width: number
  height: number
  getContext(type: '2d'): CanvasRenderingContext2D | null
  toBlob(cb: (b: Blob | null) => void, type?: string, quality?: number): void
}

/** above this many output pixels the result is scaled down (canvas limits differ per browser) */
export const MAX_PIXELS = 48_000_000
/** iOS Safari refuses canvases above 16 777 216 pixels (and may kill the tab on big ones): 4096 x 4096 at most */
export const IOS_MAX_PIXELS = 16_777_216
export const IOS_MAX_SIDE = 4096
export const MAX_SIDE = 16_384

/** iPhone, iPad (also the desktop-class iPadOS user agent) and iPod: the engines with the small canvas budget */
export function isIosLike(): boolean {
  if (typeof navigator === 'undefined') return false
  return (
    /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  )
}

/** the export canvas limits of this device */
export const exportLimits = (ios = isIosLike()) =>
  ios
    ? { maxPixels: IOS_MAX_PIXELS, maxSide: IOS_MAX_SIDE }
    : { maxPixels: MAX_PIXELS, maxSide: MAX_SIDE }
/** a JPEG source whose PNG export is bigger than this is saved as JPEG instead */
export const PNG_LIMIT_BYTES = 1.5 * 1024 * 1024
export const JPEG_QUALITY = 0.92

export interface PixelData {
  data: Uint8ClampedArray | number[]
  width: number
  height: number
}

/**
 * Gaussian-like blur of the whole buffer in place: three box-blur passes per axis (a box of radius r three times has a
 * standard deviation of about r), edges clamped.
 */
export function blurImageData(img: PixelData, radius: number): void {
  const { data, width, height } = img
  const r = Math.max(1, Math.round(radius))
  const tmp = new Float32Array(data.length)
  for (let pass = 0; pass < 3; pass++) {
    boxBlur(data, tmp, width, height, r, 4, width * 4) // horizontal
    boxBlur(tmp, data, height, width, r, width * 4, 4) // vertical (rows and columns swapped)
  }
}

/** one running-sum box blur along lines of `len` pixels (`step` bytes apart); `lines` lines, `lineStep` bytes apart */
function boxBlur(
  src: ArrayLike<number>,
  dst: { [i: number]: number },
  len: number,
  lines: number,
  r: number,
  step: number,
  lineStep: number,
) {
  const n = 2 * r + 1
  const last = len - 1
  for (let line = 0; line < lines; line++) {
    const o = line * lineStep
    for (let c = 0; c < 4; c++) {
      const at = (x: number) => src[o + Math.min(last, Math.max(0, x)) * step + c]!
      let sum = 0
      for (let x = -r; x <= r; x++) sum += at(x)
      for (let x = 0; x < len; x++) {
        dst[o + x * step + c] = sum / n
        sum += at(x + r + 1) - at(x - r)
      }
    }
  }
}

/** blur the device-pixel rectangle `r` of what is on the canvas now (its surroundings feed the edges, like a lens) */
function blurRegion(
  ctx: CanvasRenderingContext2D,
  r: Rect,
  radius: number,
  canvas: { width: number; height: number },
) {
  const x = Math.max(0, Math.floor(r.x))
  const y = Math.max(0, Math.floor(r.y))
  const w = Math.min(canvas.width, Math.ceil(r.x + r.w)) - x
  const h = Math.min(canvas.height, Math.ceil(r.y + r.h)) - y
  if (w < 1 || h < 1) return
  const pad = Math.ceil(radius * 3)
  const px = Math.max(0, x - pad)
  const py = Math.max(0, y - pad)
  const pw = Math.min(canvas.width, x + w + pad) - px
  const ph = Math.min(canvas.height, y + h + pad) - py
  const img = ctx.getImageData(px, py, pw, ph)
  blurImageData(img, radius)
  // only the box itself is written back
  ctx.putImageData(img, px, py, x - px, y - py, w, h)
}

/** the picture (with its blur boxes applied) around a magnifier's source, 1:1 in image px from (x, y) */
export interface LensSource {
  canvas: CanvasImageSource
  x: number
  y: number
}

/**
 * draw one (non-blur) shape; the context is already in image coordinates. A magnifier's lens shows `lens` (without one
 * only its outlines are drawn).
 */
export function drawShape(ctx: CanvasRenderingContext2D, s: Shape, lens?: LensSource): void {
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  switch (s.kind) {
    case 'pen': {
      ctx.strokeStyle = s.color
      ctx.lineWidth = s.width
      ctx.beginPath()
      for (const c of smoothCommands(s.points)) {
        if (c.c === 'M') ctx.moveTo(c.x, c.y)
        else if (c.c === 'L') ctx.lineTo(c.x, c.y)
        else ctx.quadraticCurveTo(c.cx, c.cy, c.x, c.y)
      }
      ctx.stroke()
      break
    }
    case 'highlight':
      ctx.globalAlpha = HIGHLIGHT_ALPHA
      ctx.strokeStyle = s.color
      ctx.lineWidth = highlightWidth(s.width)
      ctx.lineCap = 'butt'
      ctx.beginPath()
      ctx.moveTo(s.a.x, s.a.y)
      ctx.lineTo(s.b.x, s.b.y)
      ctx.stroke()
      break
    case 'line':
      ctx.strokeStyle = s.color
      ctx.lineWidth = s.width
      ctx.beginPath()
      ctx.moveTo(s.a.x, s.a.y)
      ctx.lineTo(s.b.x, s.b.y)
      ctx.stroke()
      break
    case 'arrow': {
      const { shaftEnd, head } = arrowParts(s.a, s.b, s.width)
      ctx.strokeStyle = s.color
      ctx.fillStyle = s.color
      ctx.lineWidth = s.width
      ctx.beginPath()
      ctx.moveTo(s.a.x, s.a.y)
      ctx.lineTo(shaftEnd.x, shaftEnd.y)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(head[0].x, head[0].y)
      ctx.lineTo(head[1].x, head[1].y)
      ctx.lineTo(head[2].x, head[2].y)
      ctx.closePath()
      ctx.fill()
      break
    }
    case 'rect':
      ctx.strokeStyle = s.color
      ctx.lineWidth = s.width
      ctx.lineJoin = 'miter'
      ctx.strokeRect(s.x, s.y, s.w, s.h)
      break
    case 'fillrect':
      ctx.fillStyle = s.color
      ctx.fillRect(s.x, s.y, s.w, s.h)
      break
    case 'ellipse':
      ctx.strokeStyle = s.color
      ctx.lineWidth = s.width
      ctx.beginPath()
      ctx.ellipse(s.x + s.w / 2, s.y + s.h / 2, s.w / 2, s.h / 2, 0, 0, Math.PI * 2)
      ctx.stroke()
      break
    case 'text': {
      ctx.font = `600 ${s.fontSize}px ${FONT_STACK}`
      ctx.textBaseline = 'top'
      ctx.textAlign = 'left'
      ctx.lineWidth = Math.max(2, s.fontSize * 0.14)
      // the halo keeps the text readable on any picture: dark halo for light text, light halo for dark text
      ctx.strokeStyle = readableOn(s.color)
      ctx.fillStyle = s.color
      textLines(s.text).forEach((line, i) => {
        const y = s.y + i * s.fontSize * LINE_HEIGHT
        ctx.strokeText(line, s.x, y)
        ctx.fillText(line, s.x, y)
      })
      break
    }
    case 'badge': {
      ctx.beginPath()
      ctx.arc(s.cx, s.cy, s.r, 0, Math.PI * 2)
      ctx.fillStyle = s.color
      ctx.fill()
      ctx.lineWidth = Math.max(2, s.r * 0.12)
      ctx.strokeStyle = readableOn(s.color)
      ctx.stroke()
      ctx.fillStyle = readableOn(s.color)
      ctx.font = `700 ${badgeFontSize(s.r, s.n)}px ${FONT_STACK}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(String(s.n), s.cx, s.cy + s.r * 0.04)
      break
    }
    case 'measure': {
      const m = measureParts(s)
      ctx.strokeStyle = s.color
      ctx.lineWidth = m.line
      ctx.lineCap = 'butt'
      if (m.box) {
        ctx.setLineDash([m.line * 4, m.line * 3])
        ctx.strokeRect(m.box.x, m.box.y, m.box.w, m.box.h)
        ctx.setLineDash([])
      } else {
        ctx.beginPath()
        ctx.moveTo(s.a.x, s.a.y)
        ctx.lineTo(s.b.x, s.b.y)
        for (const [p, q] of m.ticks) {
          ctx.moveTo(p.x, p.y)
          ctx.lineTo(q.x, q.y)
        }
        ctx.stroke()
      }
      const l = m.label
      ctx.fillStyle = s.color
      ctx.beginPath()
      ctx.roundRect(l.x, l.y, l.w, l.h, l.h * 0.3)
      ctx.fill()
      ctx.fillStyle = readableOn(s.color)
      ctx.font = `600 ${l.fontSize}px ${FONT_STACK}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(l.text, l.cx, l.cy + l.fontSize * 0.04)
      break
    }
    case 'magnify': {
      const g = lensParts(s)
      ctx.strokeStyle = s.color
      ctx.lineWidth = Math.max(1, s.width * 0.6)
      ctx.lineJoin = 'miter'
      ctx.strokeRect(s.src.x, s.src.y, s.src.w, s.src.h)
      if (g.connector) {
        ctx.beginPath()
        ctx.moveTo(g.connector[0].x, g.connector[0].y)
        ctx.lineTo(g.connector[1].x, g.connector[1].y)
        ctx.stroke()
      }
      ctx.save()
      ctx.beginPath()
      ctx.arc(g.cx, g.cy, g.r, 0, Math.PI * 2)
      ctx.clip()
      ctx.fillStyle = '#ffffff'
      ctx.fill()
      if (lens) {
        ctx.transform(g.k, 0, 0, g.k, g.tx, g.ty)
        ctx.drawImage(lens.canvas, lens.x, lens.y)
      }
      ctx.restore()
      ctx.lineWidth = s.width
      ctx.beginPath()
      ctx.arc(g.cx, g.cy, g.r, 0, Math.PI * 2)
      ctx.stroke()
      break
    }
    case 'blur':
      break
  }
  ctx.restore()
}

export function annotatedFilename(original: string, ext: 'png' | 'jpg'): string {
  const stem = original
    .replace(/\.[a-z0-9]{1,5}$/i, '')
    .replace(/-annotated$/i, '')
    .trim()
  return `${stem || 'image'}-annotated.${ext}`
}

const isJpeg = (mime: string) => /^image\/jpe?g$/i.test(mime)

const toBlob = (c: CanvasLike, type: string, quality?: number) =>
  new Promise<Blob>((resolve, reject) =>
    c.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('The image could not be exported'))),
      type,
      quality,
    ),
  )

export interface FlattenInput {
  /** the loaded picture (an <img>, ImageBitmap or canvas) and its natural size */
  source: CanvasImageSource
  width: number
  height: number
  doc: AnnotDoc
  /** the source's mime type and file name (decide the output format and name) */
  mime: string
  name: string
  createCanvas?: (w: number, h: number) => CanvasLike
  /** override the device's export limits (tests) */
  maxPixels?: number
  maxSide?: number
}

const defaultCanvas = (w: number, h: number): CanvasLike => {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

const intersect = (a: Rect, b: Rect): Rect => {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  return {
    x,
    y,
    w: Math.max(0, Math.min(a.x + a.w, b.x + b.w) - x),
    h: Math.max(0, Math.min(a.y + a.h, b.y + b.h) - y),
  }
}

/**
 * The picture around a magnifier's source at 1:1, with the blur boxes that reach it blurred (and enough margin that the
 * blur's edges are fed like on the main canvas), so a magnified blur box stays unreadable.
 */
function lensSource(
  i: FlattenInput,
  s: MagnifyShape,
  make: (w: number, h: number) => CanvasLike,
): LensSource | undefined {
  const margin = Math.ceil(blurRadiusFor(1e9, 1e9) * 3) + 2
  const x = Math.max(0, Math.floor(s.src.x - margin))
  const y = Math.max(0, Math.floor(s.src.y - margin))
  const w = Math.min(i.width, Math.ceil(s.src.x + s.src.w + margin)) - x
  const h = Math.min(i.height, Math.ceil(s.src.y + s.src.h + margin)) - y
  if (w < 1 || h < 1) return undefined
  const c = make(w, h)
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')
  if (!ctx) return undefined
  ctx.drawImage(i.source, x, y, w, h, 0, 0, w, h)
  for (const b of i.doc.shapes) {
    if (b.kind !== 'blur') continue
    const r = intersect(b, { x, y, w, h })
    if (r.w <= 0 || r.h <= 0) continue
    blurRegion(ctx, { x: b.x - x, y: b.y - y, w: b.w, h: b.h }, blurRadiusFor(b.w, b.h), c)
  }
  return { canvas: c as unknown as CanvasImageSource, x, y }
}

/**
 * Crop, pad, scale, blur the blur boxes, draw the shapes in order, encode. PNG, or JPEG 0.92 when the source was a JPEG
 * and the PNG came out bigger than 1.5 MB.
 */
export async function flattenToFile(i: FlattenInput): Promise<File> {
  const img = { w: i.width, h: i.height }
  const region = cropOutput(i.doc.crop, img) ?? { x: 0, y: 0, w: img.w, h: img.h }
  const pad = padSize(i.doc)
  const outer = pad ? padRect(region, pad) : region
  const limits = exportLimits()
  const maxPixels = i.maxPixels ?? limits.maxPixels
  const maxSide = i.maxSide ?? limits.maxSide
  const k = Math.min(
    docScale(i.doc),
    Math.sqrt(maxPixels / (outer.w * outer.h)),
    maxSide / Math.max(outer.w, outer.h),
  )
  const outW = Math.max(1, Math.round(outer.w * k))
  const outH = Math.max(1, Math.round(outer.h * k))
  const make = i.createCanvas ?? defaultCanvas
  const canvas = make(outW, outH)
  canvas.width = outW
  canvas.height = outH
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('This browser can’t draw the edited image')
  ctx.imageSmoothingQuality = 'high'
  const padColor = i.doc.pad?.color
  if (pad && padColor && padColor !== 'transparent') {
    ctx.fillStyle = padColor
    ctx.fillRect(0, 0, outW, outH)
  }
  ctx.setTransform(k, 0, 0, k, -outer.x * k, -outer.y * k)
  if (pad) {
    // the padding shows its color, not the picture cropped away under it
    ctx.save()
    ctx.beginPath()
    ctx.rect(region.x, region.y, region.w, region.h)
    ctx.clip()
  }
  ctx.drawImage(i.source, 0, 0, img.w, img.h)
  if (pad) ctx.restore()

  // blur boxes blur the PICTURE (before any annotation is drawn), so arrows and text on top stay crisp
  const shown = { x: (region.x - outer.x) * k, y: (region.y - outer.y) * k, w: region.w * k, h: region.h * k }
  for (const s of i.doc.shapes) {
    if (s.kind !== 'blur') continue
    const box = { x: (s.x - outer.x) * k, y: (s.y - outer.y) * k, w: s.w * k, h: s.h * k }
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    blurRegion(ctx, pad ? intersect(box, shown) : box, blurRadiusFor(s.w, s.h) * k, canvas)
    ctx.restore()
  }
  for (const s of i.doc.shapes) {
    if (s.kind === 'blur') continue
    drawShape(ctx, s, s.kind === 'magnify' ? lensSource(i, s, make) : undefined)
  }

  let blob = await toBlob(canvas, 'image/png')
  let ext: 'png' | 'jpg' = 'png'
  if (isJpeg(i.mime) && blob.size > PNG_LIMIT_BYTES) {
    blob = await toBlob(canvas, 'image/jpeg', JPEG_QUALITY)
    ext = 'jpg'
  }
  return new File([blob], annotatedFilename(i.name, ext), {
    type: ext === 'jpg' ? 'image/jpeg' : 'image/png',
  })
}
