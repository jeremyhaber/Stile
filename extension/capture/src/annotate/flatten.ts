/**
 * Flatten an annotated image onto a canvas at its natural resolution (after the crop) and encode it.
 * Blur boxes are really pixelated here (the stage only previews them). The canvas is injectable for tests.
 */
import {
  FONT_STACK,
  HIGHLIGHT_ALPHA,
  LINE_HEIGHT,
  arrowParts,
  blockSizeFor,
  cropOutput,
  highlightWidth,
  readableOn,
  smoothCommands,
  textLines,
  type AnnotDoc,
  type Rect,
  type Shape,
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

/** replace every `block` x `block` cell by its average color (in place) */
export function pixelateImageData(img: PixelData, block: number): void {
  const { data, width, height } = img
  const b = Math.max(1, Math.round(block))
  for (let by = 0; by < height; by += b) {
    for (let bx = 0; bx < width; bx += b) {
      const x2 = Math.min(width, bx + b)
      const y2 = Math.min(height, by + b)
      let r = 0
      let g = 0
      let bl = 0
      let a = 0
      let n = 0
      for (let y = by; y < y2; y++)
        for (let x = bx; x < x2; x++) {
          const i = (y * width + x) * 4
          r += data[i]!
          g += data[i + 1]!
          bl += data[i + 2]!
          a += data[i + 3]!
          n++
        }
      if (!n) continue
      const ar = Math.round(r / n)
      const ag = Math.round(g / n)
      const ab = Math.round(bl / n)
      const aa = Math.round(a / n)
      for (let y = by; y < y2; y++)
        for (let x = bx; x < x2; x++) {
          const i = (y * width + x) * 4
          data[i] = ar
          data[i + 1] = ag
          data[i + 2] = ab
          data[i + 3] = aa
        }
    }
  }
}

/** pixelate the device-pixel rectangle `r` of what is on the canvas now */
function pixelateRegion(
  ctx: CanvasRenderingContext2D,
  r: Rect,
  canvas: { width: number; height: number },
) {
  const x = Math.max(0, Math.floor(r.x))
  const y = Math.max(0, Math.floor(r.y))
  const w = Math.min(canvas.width, Math.ceil(r.x + r.w)) - x
  const h = Math.min(canvas.height, Math.ceil(r.y + r.h)) - y
  if (w < 1 || h < 1) return
  const img = ctx.getImageData(x, y, w, h)
  pixelateImageData(img, blockSizeFor(w, h))
  ctx.putImageData(img, x, y)
}

/** draw one (non-blur) shape; the context is already in image coordinates */
export function drawShape(ctx: CanvasRenderingContext2D, s: Shape): void {
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
      ctx.font = `700 ${Math.round(s.r * 1.1)}px ${FONT_STACK}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(String(s.n), s.cx, s.cy + s.r * 0.04)
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

/**
 * Crop, pixelate the blur boxes, draw the shapes in order, encode. PNG, or JPEG 0.92 when the source was a JPEG and the
 * PNG came out bigger than 1.5 MB.
 */
export async function flattenToFile(i: FlattenInput): Promise<File> {
  const img = { w: i.width, h: i.height }
  const region = cropOutput(i.doc.crop, img) ?? { x: 0, y: 0, w: img.w, h: img.h }
  const limits = exportLimits()
  const maxPixels = i.maxPixels ?? limits.maxPixels
  const maxSide = i.maxSide ?? limits.maxSide
  const k = Math.min(
    1,
    Math.sqrt(maxPixels / (region.w * region.h)),
    maxSide / Math.max(region.w, region.h),
  )
  const outW = Math.max(1, Math.round(region.w * k))
  const outH = Math.max(1, Math.round(region.h * k))
  const canvas = (i.createCanvas ?? defaultCanvas)(outW, outH)
  canvas.width = outW
  canvas.height = outH
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('This browser can’t draw the edited image')
  ctx.imageSmoothingQuality = 'high'
  ctx.setTransform(k, 0, 0, k, -region.x * k, -region.y * k)
  ctx.drawImage(i.source, 0, 0, img.w, img.h)

  // blur boxes pixelate the PICTURE (before any annotation is drawn), so arrows and text on top stay crisp
  for (const s of i.doc.shapes) {
    if (s.kind !== 'blur') continue
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    pixelateRegion(
      ctx,
      { x: (s.x - region.x) * k, y: (s.y - region.y) * k, w: s.w * k, h: s.h * k },
      canvas,
    )
    ctx.restore()
  }
  for (const s of i.doc.shapes) if (s.kind !== 'blur') drawShape(ctx, s)

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
