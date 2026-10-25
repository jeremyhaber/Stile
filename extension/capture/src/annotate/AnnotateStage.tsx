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
import type { Span } from './pixels'
import {
  FONT_STACK,
  HIGHLIGHT_ALPHA,
  LINE_HEIGHT,
  arrowParts,
  blurRadiusFor,
  clampPan,
  clientToImage,
  commandsToD,
  fitScale,
  boundsOf,
  handlesOf,
  padRect,
  selectionPad,
  SELECTION_GAP,
  highlightWidth,
  lensParts,
  MAX_ZOOM,
  measureParts,
  padSize,
  pinchView,
  readableOn,
  rectHandles,
  smoothCommands,
  textBounds,
  textLines,
  textOverlay,
  type MagnifyShape,
  type MeasureShape,
  type Pt,
  type Rect,
  type Shape,
  type StageView,
  zoomAround,
  badgeFontSize,
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
      // drawn by BlurView, under every other shape (the export blurs the picture before drawing annotations)
      return null
    case 'measure':
      return <MeasureView shape={shape} />
    case 'magnify':
      return <MagnifyView shape={shape} />
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
            fontSize={badgeFontSize(shape.r, shape.n)}
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

/** id of the picture-plus-blur layer a magnifier's lens shows (one stage per page) */
export const BASE_LAYER_ID = 'annot-base'

function MeasureView({ shape }: { shape: MeasureShape }) {
  const m = measureParts(shape)
  const l = m.label
  return (
    <g data-measure={shape.id}>
      {m.box ? (
        <rect
          x={m.box.x}
          y={m.box.y}
          width={m.box.w}
          height={m.box.h}
          fill="none"
          stroke={shape.color}
          strokeWidth={m.line}
          strokeDasharray={`${m.line * 4} ${m.line * 3}`}
        />
      ) : (
        <path
          d={[`M${shape.a.x} ${shape.a.y}L${shape.b.x} ${shape.b.y}`, ...m.ticks.map(([p, q]) => `M${p.x} ${p.y}L${q.x} ${q.y}`)].join('')}
          fill="none"
          stroke={shape.color}
          strokeWidth={m.line}
        />
      )}
      <rect x={l.x} y={l.y} width={l.w} height={l.h} rx={l.h * 0.3} fill={shape.color} />
      <text
        x={l.cx}
        y={l.cy + l.fontSize * 0.04}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={l.fontSize}
        fontWeight={600}
        fontFamily={FONT_STACK}
        fill={readableOn(shape.color)}
      >
        {l.text}
      </text>
    </g>
  )
}

/** a magnifier: the source square, a connector and the lens showing the picture (with its blurs) enlarged */
function MagnifyView({ shape }: { shape: MagnifyShape }) {
  const g = lensParts(shape)
  const clip = `annot-lens-${shape.id}`
  const thin = Math.max(1, shape.width * 0.6)
  return (
    <g data-magnify={shape.id}>
      <defs>
        <clipPath id={clip}>
          <circle cx={g.cx} cy={g.cy} r={g.r} />
        </clipPath>
      </defs>
      <rect x={shape.src.x} y={shape.src.y} width={shape.src.w} height={shape.src.h} fill="none" stroke={shape.color} strokeWidth={thin} />
      {g.connector && (
        <line x1={g.connector[0].x} y1={g.connector[0].y} x2={g.connector[1].x} y2={g.connector[1].y} stroke={shape.color} strokeWidth={thin} />
      )}
      <g clipPath={`url(#${clip})`}>
        <circle cx={g.cx} cy={g.cy} r={g.r} fill="#ffffff" />
        <use href={`#${BASE_LAYER_ID}`} transform={`translate(${g.tx} ${g.ty}) scale(${g.k})`} />
      </g>
      <circle cx={g.cx} cy={g.cy} r={g.r} fill="none" stroke={shape.color} strokeWidth={shape.width} />
    </g>
  )
}

/** a blur box: the picture under it, Gaussian-blurred with the same radius the export uses */
export function BlurView({ shape, imageUrl, img }: { shape: Rect & { id: string }; imageUrl: string; img: { w: number; h: number } }) {
  const sd = blurRadiusFor(shape.w, shape.h)
  const pad = sd * 3
  const id = `annot-blur-${shape.id}`
  return (
    <g data-blur={shape.id}>
      <defs>
        <clipPath id={`${id}-clip`}>
          <rect x={shape.x} y={shape.y} width={shape.w} height={shape.h} />
        </clipPath>
        <filter
          id={id}
          filterUnits="userSpaceOnUse"
          x={shape.x - pad}
          y={shape.y - pad}
          width={shape.w + 2 * pad}
          height={shape.h + 2 * pad}
        >
          <feGaussianBlur stdDeviation={sd} edgeMode="duplicate" />
        </filter>
      </defs>
      <g clipPath={`url(#${id}-clip)`}>
        <image href={imageUrl} x={0} y={0} width={img.w} height={img.h} filter={`url(#${id})`} />
      </g>
    </g>
  )
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
  blur: 'Drag over what to hide, or press Enter to place a blur box in the center. It is blurred in the saved image too.',
  measure:
    'Point at something to see the distance between the edges around it; click to keep that measurement. Drag to measure any distance (or a box). Arrow keys move the pointer, Enter measures there.',
  magnify: 'Drag over the part to enlarge, or press Enter to place a magnifier in the center. Drag the lens to move it.',
  picker:
    'Point at a color: Tab copies its hex code, a click also makes it the drawing color. Arrow keys move the pointer, Enter picks there.',
  canvas: 'Set the size the picture is exported at, and add padding around it.',
  crop: 'Drag to choose the part to keep, or press Enter for a default crop. Arrow keys move it, Alt with the arrow keys resizes it, Enter applies it.',
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
  /** Stile: the largest fit scale (screen px per image px). Default 4; the capture editor passes 1 / devicePixelRatio. */
  maxUp?: number
}

export interface StageControls {
  zoomBy: (factor: number) => void
  /** Stile: zoom about a client point (wheel / pinch on a trackpad) */
  zoomAt: (factor: number, clientX: number, clientY: number) => void
  /** Stile: scroll the zoomed stage (wheel) */
  panBy: (dx: number, dy: number) => void
  /** Stile: zoom so the picture's width fills the box, top edge first (tall full-page captures) */
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
    if (capturing.current !== e.pointerId) {
      // no button down: the probe (color readout, smart measurement) follows a mouse or pen
      if (capturing.current === null && e.pointerType !== 'touch' && !gesture.current)
        annot.pointer.hover(toImage(e))
      return
    }
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
  const pad = cropOpen ? 0 : padSize(annot.doc)
  const padColor = annot.doc.pad?.color ?? 'transparent'
  const shown = crop ?? { x: 0, y: 0, w: img.w, h: img.h }

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
        onPointerLeave={() => annot.pointer.leave()}
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
          {pad > 0 && (
            <>
              <defs>
                <pattern id="annot-checker" width={16 / scale} height={16 / scale} patternUnits="userSpaceOnUse">
                  <rect width={16 / scale} height={16 / scale} fill="#ffffff" />
                  <rect width={8 / scale} height={8 / scale} fill="#e4e4ea" />
                  <rect x={8 / scale} y={8 / scale} width={8 / scale} height={8 / scale} fill="#e4e4ea" />
                </pattern>
                <clipPath id="annot-shown">
                  <rect x={shown.x} y={shown.y} width={shown.w} height={shown.h} />
                </clipPath>
              </defs>
              <rect
                data-testid="annotate-pad"
                x={view.x}
                y={view.y}
                width={view.w}
                height={view.h}
                fill={padColor === 'transparent' ? 'url(#annot-checker)' : padColor}
              />
            </>
          )}
          <g clipPath={pad > 0 ? 'url(#annot-shown)' : undefined}>
            <g id={BASE_LAYER_ID}>
              <image href={imageUrl} x={0} y={0} width={img.w} height={img.h} />
              {annot.doc.shapes.map((sh) =>
                sh.kind === 'blur' ? <BlurView key={sh.id} shape={sh} imageUrl={imageUrl} img={img} /> : null,
              )}
            </g>
          </g>
          {annot.doc.shapes.map((sh) => (
            <ShapeView key={sh.id} shape={sh} hidden={sh.id === editingId} />
          ))}
          {sel && !editingId && !cropOpen && <Selection shape={sel} hr={hr} sw={sw} u={1 / scale} />}
          {cropOpen && <CropOverlay crop={crop} img={img} hr={hr} u={1 / scale} />}
          {annot.probe && annot.tool === 'measure' && annot.probe.span && (
            <MeasureProbe pt={annot.probe.pt} span={annot.probe.span} unit={annot.unit} u={1 / scale} />
          )}
          {annot.probe && annot.tool === 'picker' && <PickerProbe pt={annot.probe.pt} u={1 / scale} />}
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

/**
 * Dashed outline + handles of the selected shape (two-tone, so they show on any picture). Stroke widths are in image px
 * (`u` = image px per screen px), not vector-effect="non-scaling-stroke": WebKit ignores the stage's CSS zoom there,
 * so a zoomed-in selection got 8x thicker strokes.
 */
function Selection({ shape, hr, sw, u }: { shape: Shape; hr: number; sw: number; u: number }) {
  // pushed clear of the shape's own stroke, so the outline never covers what it selects
  const pad = selectionPad(shape, SELECTION_GAP * u)
  const handles = handlesOf(shape, measureText, pad)
  // a magnifier outlines its source and its lens separately (one box around both would cover the picture between)
  const boxes =
    shape.kind === 'magnify'
      ? [shape.src, { x: shape.x, y: shape.y, w: shape.w, h: shape.h }]
      : [padRect(boundsOf(shape, measureText), pad)]
  return (
    <g pointerEvents="none" data-testid="annotate-selection">
      {boxes.map((b, i) => (
        <g key={i}>
          <rect
            x={b.x}
            y={b.y}
            width={b.w}
            height={b.h}
            fill="none"
            stroke="#ffffff"
            strokeWidth={(sw + 2) * u}
          />
          <rect
            x={b.x}
            y={b.y}
            width={b.w}
            height={b.h}
            fill="none"
            stroke="#18181b"
            strokeWidth={sw * u}
            strokeDasharray={`${5 * u} ${4 * u}`}
          />
        </g>
      ))}
      {handles.map((h) => (
        <circle
          key={h.id}
          cx={h.x}
          cy={h.y}
          r={hr}
          fill="#ffffff"
          stroke="#18181b"
          strokeWidth={sw * u}
        />
      ))}
    </g>
  )
}

/** the measure tool's live readout: the edges around the pointer, across and down, with their lengths */
function MeasureProbe({ pt, span, unit, u }: { pt: Pt; span: Span; unit: number; u: number }) {
  const y = Math.floor(pt.y) + 0.5
  const x = Math.floor(pt.x) + 0.5
  const w = Math.round((span.x2 - span.x1) / unit)
  const h = Math.round((span.y2 - span.y1) / unit)
  const t = 5 * u
  const tag = (cx: number, cy: number, text: string) => {
    const fw = (text.length * 6.6 + 10) * u
    return (
      <g>
        <rect x={cx - fw / 2} y={cy - 9 * u} width={fw} height={18 * u} rx={4 * u} fill="#18181b" />
        <text x={cx} y={cy + 0.5 * u} textAnchor="middle" dominantBaseline="central" fontSize={11 * u} fontWeight={600} fontFamily={FONT_STACK} fill="#ffffff">
          {text}
        </text>
      </g>
    )
  }
  const d = `M${span.x1} ${y}H${span.x2}M${span.x1} ${y - t}V${y + t}M${span.x2} ${y - t}V${y + t}M${x} ${span.y1}V${span.y2}M${x - t} ${span.y1}H${x + t}M${x - t} ${span.y2}H${x + t}`
  return (
    <g pointerEvents="none" data-testid="annotate-measure-probe">
      <path d={d} fill="none" stroke="#ffffff" strokeWidth={3 * u} />
      <path d={d} fill="none" stroke="#e5322d" strokeWidth={1.25 * u} />
      {tag(pt.x + 16 * u + ((`${w} × ${h}`.length * 6.6 + 10) * u) / 2, pt.y + 18 * u, `${w} × ${h}`)}
    </g>
  )
}

/** the color picker's target: the pixel under the pointer, outlined */
function PickerProbe({ pt, u }: { pt: Pt; u: number }) {
  const x = Math.floor(pt.x)
  const y = Math.floor(pt.y)
  const s = Math.max(1, 6 * u)
  return (
    <g pointerEvents="none" data-testid="annotate-picker-probe">
      <rect x={x + 0.5 - s} y={y + 0.5 - s} width={s * 2} height={s * 2} fill="none" stroke="#ffffff" strokeWidth={3 * u} />
      <rect x={x + 0.5 - s} y={y + 0.5 - s} width={s * 2} height={s * 2} fill="none" stroke="#18181b" strokeWidth={1.25 * u} />
    </g>
  )
}

function CropOverlay({
  crop,
  img,
  hr,
  u,
}: {
  crop: Rect | null
  img: { w: number; h: number }
  hr: number
  /** image px per screen px (see Selection) */
  u: number
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
        strokeWidth={4 * u}
      />
      <rect
        x={crop.x}
        y={crop.y}
        width={crop.w}
        height={crop.h}
        fill="none"
        stroke="#18181b"
        strokeWidth={2 * u}
        strokeDasharray={`${6 * u} ${4 * u}`}
      />
      {rectHandles(crop).map((h) => (
        <circle
          key={h.id}
          cx={h.x}
          cy={h.y}
          r={hr}
          fill="#ffffff"
          stroke="#18181b"
          strokeWidth={2 * u}
        />
      ))}
    </g>
  )
}
