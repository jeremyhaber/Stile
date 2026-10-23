/** Flatten / export of the annotation editor with a stubbed canvas (jsdom has none). */
import { describe, expect, it, vi } from 'vitest'
import {
  IOS_MAX_PIXELS,
  IOS_MAX_SIDE,
  JPEG_QUALITY,
  exportLimits,
  PNG_LIMIT_BYTES,
  annotatedFilename,
  flattenToFile,
  pixelateImageData,
  type CanvasLike,
} from '../../../extension/capture/src/annotate/flatten'
import type { AnnotDoc, Shape } from '../../../extension/capture/src/annotate/model'

/** a recording 2D context: every call is kept as [name, ...args] */
function stubCanvas(pngBytes: number, jpegBytes = 10) {
  const calls: unknown[][] = []
  const state: Record<string, unknown> = {}
  const ctx = new Proxy(
    {},
    {
      get(_t, name: string) {
        if (name === 'getImageData')
          return (x: number, y: number, w: number, h: number) => {
            calls.push(['getImageData', x, y, w, h])
            const data = new Uint8ClampedArray(w * h * 4)
            for (let i = 0; i < data.length; i += 4) {
              data[i] = i % 255
              data[i + 3] = 255
            }
            return { data, width: w, height: h }
          }
        if (name in state) return state[name]
        return (...args: unknown[]) => void calls.push([name, ...args])
      },
      set(_t, name: string, v) {
        state[name] = v
        calls.push(['set:' + name, v])
        return true
      },
    },
  )
  const types: { type?: string; quality?: number }[] = []
  const canvas: CanvasLike = {
    width: 0,
    height: 0,
    getContext: () => ctx as unknown as CanvasRenderingContext2D,
    toBlob(cb, type, quality) {
      types.push({ type, quality })
      cb(new Blob([new Uint8Array(type === 'image/jpeg' ? jpegBytes : pngBytes)], { type }))
    },
  }
  return { canvas, calls, types }
}

const rectShape: Shape = {
  id: 'r',
  kind: 'rect',
  color: '#e5322d',
  width: 6,
  x: 10,
  y: 10,
  w: 50,
  h: 30,
}
const blurShape: Shape = {
  id: 'b',
  kind: 'blur',
  color: '#000000',
  width: 0,
  x: 20,
  y: 20,
  w: 100,
  h: 40,
}
const doc = (shapes: Shape[], crop: AnnotDoc['crop'] = null): AnnotDoc => ({ shapes, crop })
const base = { source: {} as CanvasImageSource, width: 400, height: 300 }

describe('annotatedFilename', () => {
  it('appends -annotated and the new extension', () => {
    expect(annotatedFilename('shot.png', 'png')).toBe('shot-annotated.png')
    expect(annotatedFilename('Photo.JPG', 'jpg')).toBe('Photo-annotated.jpg')
    expect(annotatedFilename('shot-annotated.png', 'png')).toBe('shot-annotated.png')
    expect(annotatedFilename('', 'png')).toBe('image-annotated.png')
    expect(annotatedFilename('a.b.c.webp', 'png')).toBe('a.b.c-annotated.png')
  })
})

describe('pixelateImageData', () => {
  it('replaces each block by its average color', () => {
    // 4x2 image, blocks of 2: left block black/white pixels, right block uniform
    const px = (r: number) => [r, r, r, 255]
    const data = new Uint8ClampedArray([
      ...px(0),
      ...px(100),
      ...px(7),
      ...px(7),
      ...px(200),
      ...px(0),
      ...px(7),
      ...px(7),
    ])
    pixelateImageData({ data, width: 4, height: 2 }, 2)
    expect([data[0], data[4], data[16], data[20]]).toEqual([75, 75, 75, 75])
    expect([data[8], data[12], data[24], data[28]]).toEqual([7, 7, 7, 7])
    expect(data[3]).toBe(255)
  })
  it('copes with partial blocks at the edge', () => {
    const data = new Uint8ClampedArray(5 * 5 * 4).fill(10)
    pixelateImageData({ data, width: 5, height: 5 }, 4)
    expect(data.every((v) => v === 10)).toBe(true)
  })
})

describe('export limits', () => {
  it('iOS gets the small canvas budget (16.7 Mpx, 4096 px on the long side)', () => {
    expect(exportLimits(true)).toEqual({ maxPixels: IOS_MAX_PIXELS, maxSide: IOS_MAX_SIDE })
    expect(exportLimits(false).maxPixels).toBeGreaterThan(IOS_MAX_PIXELS)
  })
})

describe('flattenToFile', () => {
  it('scales a panorama down to the side limit even when the pixel count is fine', async () => {
    const { canvas } = stubCanvas(100)
    await flattenToFile({
      ...base,
      width: 8000,
      height: 1000,
      doc: doc([]),
      mime: 'image/png',
      name: 'pano.png',
      maxSide: 4096,
      createCanvas: () => canvas,
    })
    expect(canvas.width).toBe(4096)
    expect(canvas.height).toBe(512)
  })

  it('draws the picture at its natural size and then each shape, as a PNG named <original>-annotated.png', async () => {
    const { canvas, calls } = stubCanvas(1000)
    const file = await flattenToFile({
      ...base,
      doc: doc([rectShape]),
      mime: 'image/png',
      name: 'screen.png',
      createCanvas: () => canvas,
    })
    expect(canvas.width).toBe(400)
    expect(canvas.height).toBe(300)
    expect(file.name).toBe('screen-annotated.png')
    expect(file.type).toBe('image/png')
    const names = calls.map((c) => c[0])
    expect(names.indexOf('drawImage')).toBeLessThan(names.indexOf('strokeRect'))
    expect(calls.find((c) => c[0] === 'drawImage')!.slice(2)).toEqual([0, 0, 400, 300])
    expect(calls.find((c) => c[0] === 'strokeRect')).toEqual(['strokeRect', 10, 10, 50, 30])
  })

  it('crops: the canvas is the crop size and the drawing is shifted by its origin', async () => {
    const { canvas, calls } = stubCanvas(1000)
    await flattenToFile({
      ...base,
      doc: doc([rectShape], { x: 5, y: 8, w: 200, h: 100 }),
      mime: 'image/png',
      name: 'a.png',
      createCanvas: () => canvas,
    })
    expect([canvas.width, canvas.height]).toEqual([200, 100])
    expect(calls.find((c) => c[0] === 'setTransform')).toEqual(['setTransform', 1, 0, 0, 1, -5, -8])
  })

  it('really pixelates blur boxes (getImageData / putImageData) BEFORE annotations are drawn', async () => {
    const { canvas, calls } = stubCanvas(1000)
    await flattenToFile({
      ...base,
      doc: doc([rectShape, blurShape]),
      mime: 'image/png',
      name: 'a.png',
      createCanvas: () => canvas,
    })
    const names = calls.map((c) => c[0])
    expect(names).toContain('getImageData')
    expect(names).toContain('putImageData')
    expect(calls.find((c) => c[0] === 'getImageData')).toEqual(['getImageData', 20, 20, 100, 40])
    expect(names.indexOf('putImageData')).toBeLessThan(names.indexOf('strokeRect'))
    // the stage-only blur preview is never drawn as a shape
    expect(names.filter((n) => n === 'fillRect')).toHaveLength(0)
  })

  it('keeps a PNG when the source was a JPEG but the result is small', async () => {
    const { canvas, types } = stubCanvas(PNG_LIMIT_BYTES - 1)
    const file = await flattenToFile({
      ...base,
      doc: doc([rectShape]),
      mime: 'image/jpeg',
      name: 'p.jpg',
      createCanvas: () => canvas,
    })
    expect(types.map((t) => t.type)).toEqual(['image/png'])
    expect(file.name).toBe('p-annotated.png')
  })

  it('re-encodes as JPEG 0.92 when a JPEG source comes out larger than 1.5 MB as PNG', async () => {
    const { canvas, types } = stubCanvas(PNG_LIMIT_BYTES + 1)
    const file = await flattenToFile({
      ...base,
      doc: doc([rectShape]),
      mime: 'image/jpeg',
      name: 'p.jpeg',
      createCanvas: () => canvas,
    })
    expect(types).toEqual([
      { type: 'image/png', quality: undefined },
      { type: 'image/jpeg', quality: JPEG_QUALITY },
    ])
    expect(file.type).toBe('image/jpeg')
    expect(file.name).toBe('p-annotated.jpg')
  })

  it('a big PNG stays a PNG', async () => {
    const { canvas, types } = stubCanvas(PNG_LIMIT_BYTES * 3)
    const file = await flattenToFile({
      ...base,
      doc: doc([]),
      mime: 'image/png',
      name: 'p.png',
      createCanvas: () => canvas,
    })
    expect(types.map((t) => t.type)).toEqual(['image/png'])
    expect(file.type).toBe('image/png')
  })

  it('scales an image over the pixel cap down', async () => {
    const { canvas, calls } = stubCanvas(100)
    await flattenToFile({
      ...base,
      width: 4000,
      height: 3000,
      doc: doc([]),
      mime: 'image/png',
      name: 'big.png',
      maxPixels: 3_000_000,
      createCanvas: () => canvas,
    })
    expect(canvas.width * canvas.height).toBeLessThanOrEqual(3_000_000 + 4000)
    expect(canvas.width / canvas.height).toBeCloseTo(4 / 3, 1)
    const t = calls.find((c) => c[0] === 'setTransform')!
    expect(t[1]).toBeCloseTo(0.5, 1)
  })

  it('draws text with a halo and a numbered badge', async () => {
    const { canvas, calls } = stubCanvas(100)
    await flattenToFile({
      ...base,
      doc: doc([
        {
          id: 't',
          kind: 'text',
          color: '#ffffff',
          width: 0,
          x: 5,
          y: 5,
          text: 'One\nTwo',
          fontSize: 20,
        },
        { id: 'n', kind: 'badge', color: '#e5322d', width: 0, cx: 50, cy: 50, r: 12, n: 3 },
      ]),
      mime: 'image/png',
      name: 't.png',
      createCanvas: () => canvas,
    })
    const fills = calls.filter((c) => c[0] === 'fillText').map((c) => c[1])
    expect(fills).toEqual(['One', 'Two', '3'])
    expect(calls.filter((c) => c[0] === 'strokeText')).toHaveLength(2)
  })

  it('fails with a readable error when the canvas cannot encode', async () => {
    const { canvas } = stubCanvas(1)
    canvas.toBlob = (cb) => cb(null)
    await expect(
      flattenToFile({
        ...base,
        doc: doc([]),
        mime: 'image/png',
        name: 'x.png',
        createCanvas: () => canvas,
      }),
    ).rejects.toThrow(/could not be exported/)
  })

  it('fails when there is no 2D context', async () => {
    const { canvas } = stubCanvas(1)
    canvas.getContext = vi.fn(() => null)
    await expect(
      flattenToFile({
        ...base,
        doc: doc([]),
        mime: 'image/png',
        name: 'x.png',
        createCanvas: () => canvas,
      }),
    ).rejects.toThrow(/can.t draw/)
  })
})
