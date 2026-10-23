import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MutableRefObject,
  type PointerEvent,
} from 'react'
import type { Annotator } from './useAnnotator'
import { measureText } from './measure'
import {
  FONT_STACK,
  HIGHLIGHT_ALPHA,
  LINE_HEIGHT,
  arrowParts,
  clampPan,
  clientToImage,
  commandsToD,
  fitScale,
  boundsOf,
  handlesOf,
  highlightWidth,
  MAX_ZOOM,
  pinchView,
  readableOn,
  rectHandles,
  smoothCommands,
  textBounds,
  textLines,
  textOverlay,
  type Pt,
  type Rect,
  type Shape,
  type StageView,
  zoomAround,
} from './model'
import s from './annotate.module.css'

/** the SVG drawing of one shape, in image coordinates (the export draws the same geometry on a canvas) */
export function ShapeView({ shape, hidden }: { shape: Shape; hidden?: boolean }) {
  const common = { color: shape.color, width: shape.width }
  if (hidden) return null
  switch (shape.kind) {
    case 'pen':
      return (
        <path
          d={commandsToD(smoothCommands(shape.points))}
          fill="none"
          stroke={common.color}
          strokeWidth={common.width}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )
    case 'highlight':
      return (
        <line
          x1={shape.a.x}
          y1={shape.a.y}
          x2={shape.b.x}
          y2={shape.b.y}
          stroke={common.color}
          strokeWidth={highlightWidth(common.width)}
          strokeOpacity={HIGHLIGHT_ALPHA}
          strokeLinecap="butt"
        />
      )
    case 'line':
      return (
        <line
          x1={shape.a.x}
          y1={shape.a.y}
          x2={shape.b.x}
          y2={shape.b.y}
          stroke={common.color}
          strokeWidth={common.width}
          strokeLinecap="round"
        />
      )
    case 'arrow': {
      const { shaftEnd, head } = arrowParts(shape.a, shape.b, common.width)
      return (
        <g>
          <line
            x1={shape.a.x}
            y1={shape.a.y}
            x2={shaftEnd.x}
            y2={shaftEnd.y}
            stroke={common.color}
            strokeWidth={common.width}
            strokeLinecap="round"
          />
          <polygon points={head.map((p) => `${p.x},${p.y}`).join(' ')} fill={common.color} />
        </g>
      )
    }
    case 'rect':
      return (
        <rect
          x={shape.x}
          y={shape.y}
          width={shape.w}
          height={shape.h}
          fill="none"
          stroke={common.color}
          strokeWidth={common.width}
        />
      )
    case 'fillrect':
      return <rect x={shape.x} y={shape.y} width={shape.w} height={shape.h} fill={common.color} />
    case 'ellipse':
      return (
        <ellipse
          cx={shape.x + shape.w / 2}
          cy={shape.y + shape.h / 2}
          rx={shape.w / 2}
          ry={shape.h / 2}
          fill="none"
          stroke={common.color}
          strokeWidth={common.width}
        />
      )
    case 'blur':
      // a preview only: the pixelation itself happens when the image is exported
      return (
        <rect
          x={shape.x}
          y={shape.y}
          width={shape.w}
          height={shape.h}
          fill="url(#annot-blur)"
          stroke="#ffffff"
          strokeWidth={2}
          strokeDasharray="6 4"
          vectorEffect="non-scaling-stroke"
        />
      )
    case 'text': {
      const halo = readableOn(shape.color)
      return (
        <text
          fontSize={shape.fontSize}
          fontWeight={600}
          fontFamily={FONT_STACK}
          fill={shape.color}
          stroke={halo}
          strokeWidth={Math.max(2, shape.fontSize * 0.14)}
          strokeLinejoin="round"
          paintOrder="stroke"
          dominantBaseline="text-before-edge"
          style={{ whiteSpace: 'pre' }}
        >
          {textLines(shape.text).map((line, i) => (
            <tspan key={i} x={shape.x} y={shape.y + i * shape.fontSize * LINE_HEIGHT}>
              {line}
            </tspan>
          ))}
        </text>
      )
    }
    case 'badge': {
      const ink = readableOn(shape.color)
      return (
        <g>
          <circle
            cx={shape.cx}
            cy={shape.cy}
            r={shape.r}
            fill={shape.color}
            stroke={ink}
            strokeWidth={Math.max(2, shape.r * 0.12)}
          />
          <text
            x={shape.cx}
            y={shape.cy + shape.r * 0.04}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={Math.round(shape.r * 1.1)}
            fontWeight={700}
            fontFamily={FONT_STACK}
            fill={ink}
          >
            {shape.n}
          </text>
        </g>
      )
    }
  }
}

const HINTS: Record<string, string> = {
  select:
    'Select a shape by clicking it or with Tab. Drag it or use the arrow keys (Shift for bigger steps) to move it, Alt with the arrow keys to resize it, Delete to remove it.',
  pen: 'Drag on the image to draw freehand.',
  highlight: 'Drag to highlight, or press Enter to place a highlight in the center.',
  arrow: 'Drag to draw an arrow, or press Enter to place one in the center.',
  line: 'Drag to draw a line, or press Enter to place one in the center.',
  rect: 'Drag to draw a rectangle, or press Enter to place one in the center.',
  fillrect: 'Drag to draw a filled rectangle, or press Enter to place one in the center.',
  ellipse: 'Drag to draw an ellipse, or press Enter to place one in the center.',
  text: 'Click where the text goes, or press Enter to place a text box in the center.',
  badge: 'Click to place a numbered badge, or press Enter to place the next number in the center.',
  blur: 'Drag over what to hide, or press Enter to place a blur box in the center. It is pixelated when you replace the image.',
  crop: 'Drag to choose the part to keep, or press Enter for a default crop. Arrow keys move it, Alt with the arrow keys resizes it.',
}
export const hintFor = (tool: string) => HINTS[tool] ?? ''

interface StageProps {
  annot: Annotator
  img: { w: number; h: number }
  /** what the stage draws: the picture itself, or a screen-sized copy of a big one */
  imageUrl: string
  name: string
  hintId: string
  /** the fitted display scale (screen px per image px, before zoom): the dialog multiplies it by the zoom for the editor */
  onScale: (scale: number) => void
  /** the zoom and pan of the stage (pinch / buttons); the stage reports changes of its own gestures */
  stageView: StageView
  onStageView: (v: StageView) => void
  coarse: boolean
  phone: boolean
  /** filled by the stage: the zoom buttons of the dialog call these */
  controls?: MutableRefObject<StageControls | null>
  /** Sidebar: the largest fit scale (screen px per image px). Default 4; the capture editor passes 1 / devicePixelRatio. */
  maxUp?: number
}

export interface StageControls {
  zoomBy: (factor: number) => void
  /** Sidebar: zoom about a client point (wheel / pinch on a trackpad) */
  zoomAt: (factor: number, clientX: number, clientY: number) => void
  /** Sidebar: scroll the zoomed stage (wheel) */
  panBy: (dx: number, dy: number) => void
  /** Sidebar: zoom so the picture's width fills the box, top edge first (tall full-page captures) */
  fitWidth: () => void
}

export function AnnotateStage({
  annot,
  img,
  imageUrl,
  name,
  hintId,
  onScale,
  stageView,
  onStageView,
  coarse,
  phone,
  controls,
  maxUp = 4,
}: StageProps) {
  const boxRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  const capturing = useRef<number | null>(null)
  // fingers on the stage: a second one turns the gesture into pinch zoom + pan and cancels any drawing
  const touches = useRef(new Map<number, Pt>())
  const gesture = useRef<{ start: Parameters<typeof pinchView>[0] } | null>(null)
  const settling = useRef(false)

  useLayoutEffect(() => {
    const el = boxRef.current
    if (!el) return
    const read = () => {
      const cs = getComputedStyle(el)
      const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)
      const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
      setBox({
        w: Math.max(0, el.clientWidth - (padX || 0)),
        h: Math.max(0, el.clientHeight - (padY || 0)),
      })
    }
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const view = annot.view
  // jsdom (and the first frame) have no layout: assume a roomy box
  const avail = box.w > 0 && box.h > 0 ? box : { w: 800, h: 500 }
  const fit = fitScale(view, avail, maxUp)
  const dispW = Math.max(1, Math.round(view.w * fit))
  const dispH = Math.max(1, Math.round(view.h * fit))
  const { zoom, pan } = stageView
  const scale = fit * zoom // screen px per image px, as the person sees it
  useEffect(() => onScale(fit), [fit, onScale])

  const toImage = (e: PointerEvent) => {
    const r = svgRef.current!.getBoundingClientRect()
    return clientToImage({ x: e.clientX, y: e.clientY }, r, view)
  }
  const kind = (e: PointerEvent) =>
    e.pointerType === 'touch' ? 'touch' : e.pointerType === 'pen' ? 'pen' : 'mouse'

  /** where the unzoomed stage sits (client px) and inside the box, and the box size */
  const geometry = () => {
    const r = stageRef.current!.getBoundingClientRect()
    const br = boxRef.current!.getBoundingClientRect()
    const origin = { x: r.left - pan.x, y: r.top - pan.y }
    return {
      origin,
      base: { x: origin.x - br.left, y: origin.y - br.top },
      box: { w: br.width, h: br.height },
    }
  }
  /** keep a zoomed stage on screen (no layout, e.g. jsdom: no clamp) */
  const clamped = (v: StageView): StageView => {
    if (!stageRef.current || !boxRef.current) return v
    const g = geometry()
    if (!g.box.w || !g.box.h) return v
    return { zoom: v.zoom, pan: clampPan(v.pan, v.zoom, g.base, { w: dispW, h: dispH }, g.box) }
  }
  useEffect(() => {
    if (!controls) return
    controls.current = {
      zoomBy: (factor) =>
        onStageView(clamped(zoomAround(stageView, factor, { x: dispW / 2, y: dispH / 2 }))),
      zoomAt: (factor, cx, cy) => {
        const o = geometry().origin
        onStageView(clamped(zoomAround(stageView, factor, { x: cx - o.x, y: cy - o.y })))
      },
      panBy: (dx, dy) =>
        onStageView(clamped({ zoom: stageView.zoom, pan: { x: pan.x + dx, y: pan.y + dy } })),
      fitWidth: () => {
        const g = geometry()
        if (!g.box.w) return
        const z = Math.min(MAX_ZOOM, Math.max(1, avail.w / view.w / fit))
        const base = g.base
        onStageView(
          clamped({ zoom: z, pan: { x: (g.box.w - dispW * z) / 2 - base.x, y: 0 } }),
        )
      },
    }
  })

  const startGesture = () => {
    // drawing stops: nothing half-drawn is kept
    if (capturing.current !== null) {
      capturing.current = null
      annot.pointer.cancel()
    }
    const [a, b] = [...touches.current.values()]
    gesture.current = {
      start: {
        zoom: stageView.zoom,
        pan: stageView.pan,
        mid: { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 },
        dist: Math.hypot(a!.x - b!.x, a!.y - b!.y),
        origin: geometry().origin,
      },
    }
  }
  const moveGesture = () => {
    const g = gesture.current
    if (!g || touches.current.size < 2) return
    const [a, b] = [...touches.current.values()]
    onStageView(
      clamped(
        pinchView(g.start, {
          mid: { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 },
          dist: Math.hypot(a!.x - b!.x, a!.y - b!.y),
        }),
      ),
    )
  }

  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    if (e.pointerType === 'touch') {
      touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (touches.current.size === 2) {
        startGesture()
        return
      }
      if (touches.current.size > 2) return
    }
    // a second finger never draws; neither does the finger left over after a pinch
    if (capturing.current !== null || gesture.current || settling.current) return
    if (annot.editing) {
      annot.commitEdit()
      return
    }
    capturing.current = e.pointerId
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
    stageRef.current?.focus({ preventScroll: true })
    annot.pointer.down(toImage(e), kind(e))
  }
  const onPointerMove = (e: PointerEvent) => {
    if (touches.current.has(e.pointerId))
      touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (gesture.current) {
      moveGesture()
      return
    }
    if (capturing.current !== e.pointerId) return
    annot.pointer.move(toImage(e))
  }
  const end = (e: PointerEvent, cancelled: boolean) => {
    touches.current.delete(e.pointerId)
    if (gesture.current) {
      // the pinch is over; a finger still down must lift before anything draws again
      gesture.current = null
      settling.current = touches.current.size > 0
      return
    }
    if (touches.current.size === 0) settling.current = false
    if (capturing.current !== e.pointerId) return
    capturing.current = null
    if (cancelled) annot.pointer.cancel()
    else annot.pointer.up(toImage(e))
  }

  const onKeyDown = (e: KeyboardEvent) => {
    annot.onKey(e)
  }

  // the text box takes focus (all text selected) when editing starts; the stage gets it back when editing ends
  const editingId = annot.editing?.id ?? null
  const wasEditing = useRef(false)
  useEffect(() => {
    if (editingId) {
      wasEditing.current = true
      textRef.current?.focus()
      textRef.current?.select()
    } else if (wasEditing.current) {
      wasEditing.current = false
      if (!document.activeElement || document.activeElement === document.body)
        stageRef.current?.focus({ preventScroll: true })
    }
  }, [editingId])

  const sel = annot.selected
  const editShape = annot.doc.shapes.find((x) => x.id === editingId)
  // 44px hit areas on a finger, the visible dot stays small
  const hr = (coarse ? 9 : 6) / scale
  const sw = 2
  const crop = annot.doc.crop
  const cropOpen = annot.tool === 'crop'

  // the text box sits OUTSIDE the zoomed stage so it is never scaled below iOS's 16px zoom threshold
  const svgRect = editShape ? svgRef.current?.getBoundingClientRect() : undefined
  const boxRect = editShape ? boxRef.current?.getBoundingClientRect() : undefined

  const editing = annot.editing
  const overlayBox =
    editShape?.kind === 'text' && editing
      ? (() => {
          const b = textBounds({ ...editShape, text: editing.value }, measureText)
          const o = textOverlay({
            left:
              (svgRect && boxRect ? svgRect.left - boxRect.left : 0) +
              (editShape.x - view.x) * scale,
            top:
              (svgRect && boxRect ? svgRect.top - boxRect.top : 0) + (editShape.y - view.y) * scale,
            textW: b.w * scale,
            lines: textLines(editing.value).length,
            real: editShape.fontSize * scale,
            // 16px at least on a phone: a smaller font makes iOS zoom the page when the box takes focus
            floor: phone || coarse ? 16 : 0,
            box: { w: boxRect?.width || avail.w, h: boxRect?.height || avail.h },
          })
          return {
            left: o.left,
            top: o.top,
            width: o.width,
            fontSize: o.fontSize,
            ...(o.scale !== 1 ? { transform: `scale(${o.scale})`, transformOrigin: '0 0' } : null),
          }
        })()
      : null
  const overlay = overlayBox ?? {}

  return (
    <div className={s.stageBox} ref={boxRef} data-testid="annotate-stagebox">
      <div
        ref={stageRef}
        className={s.stage}
        data-testid="annotate-stage"
        data-tool={annot.tool}
        data-zoom={zoom !== 1 ? zoom.toFixed(2) : undefined}
        role="application"
        tabIndex={0}
        aria-label={`Annotation canvas for ${name}`}
        aria-describedby={hintId}
        style={{
          width: dispW,
          height: dispH,
          ...(zoom !== 1 || pan.x !== 0 || pan.y !== 0
            ? {
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                transformOrigin: '0 0',
              }
            : null),
        }}
        onKeyDown={onKeyDown}
        // a MOUSE press must not move focus away from a freshly opened text box or off the stage (compatibility mouse
        // events only: pointer and touch events are never cancelled)
        onMouseDown={(e) => e.preventDefault()}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => end(e, false)}
        onPointerCancel={(e) => end(e, true)}
      >
        <svg
          ref={svgRef}
          className={s.svg}
          viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
          width={dispW}
          height={dispH}
          aria-hidden="true"
          focusable="false"
        >
          <defs>
            <pattern
              id="annot-blur"
              width={12 / scale}
              height={12 / scale}
              patternUnits="userSpaceOnUse"
            >
              <rect width={12 / scale} height={12 / scale} fill="#ffffff" fillOpacity={0.55} />
              <rect width={6 / scale} height={6 / scale} fill="#000000" fillOpacity={0.45} />
              <rect
                x={6 / scale}
                y={6 / scale}
                width={6 / scale}
                height={6 / scale}
                fill="#000000"
                fillOpacity={0.45}
              />
            </pattern>
          </defs>
          <image href={imageUrl} x={0} y={0} width={img.w} height={img.h} />
          {annot.doc.shapes.map((sh) => (
            <ShapeView key={sh.id} shape={sh} hidden={sh.id === editingId} />
          ))}
          {sel && !editingId && !cropOpen && <Selection shape={sel} hr={hr} sw={sw} />}
          {cropOpen && <CropOverlay crop={crop} img={img} hr={hr} />}
        </svg>
      </div>
      {editShape?.kind === 'text' && annot.editing && (
        <textarea
          ref={textRef}
          className={s.textEdit}
          data-testid="annotate-text-input"
          aria-label="Text annotation"
          value={annot.editing.value}
          rows={Math.max(1, textLines(annot.editing.value).length)}
          spellCheck={false}
          enterKeyHint="enter"
          autoCapitalize="sentences"
          style={{
            ...overlay,
            lineHeight: LINE_HEIGHT,
            color: editShape.color,
            fontFamily: FONT_STACK,
            textShadow: `0 0 3px ${readableOn(editShape.color)}, 0 0 3px ${readableOn(editShape.color)}`,
          }}
          onChange={(e) => annot.setEditText(e.target.value)}
          onBlur={() => annot.commitEdit()}
          onKeyDown={(e) => {
            // typing must not reach the stage's shortcuts; Ctrl / Cmd+Enter (and Escape, via the dialog) finish
            e.stopPropagation()
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              annot.commitEdit()
            }
          }}
        />
      )}
    </div>
  )
}

/** dashed outline + handles of the selected shape (two-tone, so they show on any picture) */
function Selection({ shape, hr, sw }: { shape: Shape; hr: number; sw: number }) {
  const handles = handlesOf(shape, measureText)
  const b = boundsOf(shape, measureText)
  return (
    <g pointerEvents="none" data-testid="annotate-selection">
      <rect
        x={b.x}
        y={b.y}
        width={b.w}
        height={b.h}
        fill="none"
        stroke="#ffffff"
        strokeWidth={sw + 2}
        vectorEffect="non-scaling-stroke"
      />
      <rect
        x={b.x}
        y={b.y}
        width={b.w}
        height={b.h}
        fill="none"
        stroke="#18181b"
        strokeWidth={sw}
        strokeDasharray="5 4"
        vectorEffect="non-scaling-stroke"
      />
      {handles.map((h) => (
        <circle
          key={h.id}
          cx={h.x}
          cy={h.y}
          r={hr}
          fill="#ffffff"
          stroke="#18181b"
          strokeWidth={sw}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </g>
  )
}

function CropOverlay({
  crop,
  img,
  hr,
}: {
  crop: Rect | null
  img: { w: number; h: number }
  hr: number
}) {
  if (!crop) return null
  const d = `M0 0H${img.w}V${img.h}H0Z M${crop.x} ${crop.y}V${crop.y + crop.h}H${crop.x + crop.w}V${crop.y}Z`
  return (
    <g pointerEvents="none" data-testid="annotate-crop">
      <path d={d} fillRule="evenodd" fill="#000000" fillOpacity={0.55} />
      <rect
        x={crop.x}
        y={crop.y}
        width={crop.w}
        height={crop.h}
        fill="none"
        stroke="#ffffff"
        strokeWidth={4}
        vectorEffect="non-scaling-stroke"
      />
      <rect
        x={crop.x}
        y={crop.y}
        width={crop.w}
        height={crop.h}
        fill="none"
        stroke="#18181b"
        strokeWidth={2}
        strokeDasharray="6 4"
        vectorEffect="non-scaling-stroke"
      />
      {rectHandles(crop).map((h) => (
        <circle
          key={h.id}
          cx={h.x}
          cy={h.y}
          r={hr}
          fill="#ffffff"
          stroke="#18181b"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </g>
  )
}
