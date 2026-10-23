import { FONT_STACK, estimateTextWidth, type TextMeasure } from './model'

let ctx: CanvasRenderingContext2D | null | undefined

/** text width through a canvas (the same font the export draws with); an estimate where canvas is unavailable (jsdom) */
export const measureText: TextMeasure = (line, fontSize) => {
  if (ctx === undefined) {
    try {
      // jsdom has no canvas (and logs "not implemented" when asked)
      ctx = /jsdom/i.test(navigator.userAgent)
        ? null
        : document.createElement('canvas').getContext('2d')
    } catch {
      ctx = null
    }
  }
  if (!ctx) return estimateTextWidth(line, fontSize)
  ctx.font = `600 ${fontSize}px ${FONT_STACK}`
  return ctx.measureText(line).width
}
