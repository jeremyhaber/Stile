/**
 * State and interaction logic of the annotation editor: tools, selection, pointer drags (create / move / resize / pen /
 * crop), keyboard operation (place, nudge, resize, cycle, delete), inline text editing, undo / redo, the pointer probe
 * (color under the pointer, smart measurement), canvas padding / export scale and the polite status line. The stage and toolbar components only draw and forward events.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import {
  canRedo,
  canUndo,
  initHistory,
  isDirty,
  record,
  redo,
  replace,
  settle,
  undo,
  type History,
} from './history'
import {
  DEFAULT_COLOR,
  EMPTY_DOC,
  FONT_LABELS,
  SELECTION_GAP,
  HIGHLIGHT_COLOR,
  KIND_NAME,
  MAX_PAD,
  MAX_SCALE,
  MIN_SCALE,
  PLACEABLE,
  SIZE_LABELS,
  TOOL_LABEL,
  appendPoint,
  applyHandle,
  badgeRadiusFor,
  boundsOf,
  canvasRect,
  centerOf,
  clampN,
  colorName,
  defaultCrop,
  defaultShape,
  dragCreate,
  dragCropHandle,
  fontIndexOf,
  fontSizeFor,
  freeSpot,
  handleAt,
  handleOutset,
  hitTest,
  keyDelta,
  keyStep,
  magnifyPart,
  measureLabel,
  moveRect,
  moveShape,
  nearestIndex,
  newShapeId,
  badgeCounter,
  clampBadge,
  outputSize,
  padSize,
  rectOf,
  resizeRect,
  resizeShapeBy,
  selectionPad,
  selectionAnnouncement,
  shapeLabel,
  sizeIndexOf,
  strokeFor,
  translateMagnifyPart,
  viewRect,
  MIN_CROP,
  type AnnotDoc,
  type Handle,
  type Pad,
  type Pt,
  type Rect,
  type Shape,
  type ShapeKind,
  type Style,
  type TextMeasure,
  type Tool,
} from './model'
import type { Probe, Sampler } from './pixels'

type Drag =
  /** part: a magnifier's lens or source dragged on its own */
  | {
      mode: 'move'
      id: string
      orig: Shape
      start: Pt
      base: AnnotDoc
      moved: boolean
      part?: 'lens' | 'src'
    }
  /** off: how far the grabbed handle sits outside the shape (see selectionPad), so grabbing it doesn't jump */
  | { mode: 'resize'; id: string; handle: Handle; orig: Shape; base: AnnotDoc; off: Pt }
  | { mode: 'create'; id: string; orig: Shape; start: Pt; base: AnnotDoc; kind: PointerKind }
  | { mode: 'pen'; id: string; base: AnnotDoc; start: Pt; kind: PointerKind }
  | { mode: 'text-tap'; start: Pt; base: AnnotDoc }
  | { mode: 'crop-new'; start: Pt; base: AnnotDoc }
  | { mode: 'crop-move'; orig: Rect; start: Pt; base: AnnotDoc }
  | { mode: 'crop-resize'; handle: Handle; orig: Rect; base: AnnotDoc }

export interface TextEdit {
  id: string
  value: string
  /** the shape is not in the history yet (placed by a click and still being typed) */
  fresh: boolean
  /** the document when editing began */
  base: AnnotDoc
  original: string
}

export type PointerKind = 'mouse' | 'touch' | 'pen'

export interface AnnotatorOptions {
  img: { w: number; h: number }
  /** screen pixels per image pixel (the stage's current fit) */
  scale: number
  measure?: TextMeasure
  /** reads the picture (color picker, smart measurement); without one those tools do nothing */
  sampler?: Sampler | null
  /** image px per measured px (a Retina capture's devicePixelRatio: measurements are in CSS px) */
  unit?: number
  /** the color picker copies a hex color (Tab, or a click) */
  onCopyColor?: (hex: string) => void
}

const withShapes = (d: AnnotDoc, shapes: Shape[]): AnnotDoc => ({ ...d, shapes })
const mapShape = (d: AnnotDoc, id: string, fn: (s: Shape) => Shape): AnnotDoc =>
  withShapes(
    d,
    d.shapes.map((s) => (s.id === id ? fn(s) : s)),
  )

/** the kinds a picked color goes to */
const COLOR_KINDS = Object.keys(KIND_NAME)

export function useAnnotator({
  img,
  scale,
  measure,
  sampler,
  unit = 1,
  onCopyColor,
}: AnnotatorOptions) {
  const [hist, apply] = useReducer(
    (h: History, fn: (h: History) => History) => fn(h),
    EMPTY_DOC,
    initHistory,
  )
  const doc = hist.present
  const docRef = useRef(doc)
  docRef.current = doc
  const [tool, setToolState] = useState<Tool>('select')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [toolColors, setToolColors] = useState<Partial<Record<string, string>>>({})
  const [sizeIdx, setSizeIdx] = useState(1)
  const [fontIdx, setFontIdx] = useState(1)
  const [editing, setEditing] = useState<TextEdit | null>(null)
  const editingRef = useRef(editing)
  editingRef.current = editing
  const [status, setStatus] = useState('')
  const [probe, setProbe] = useState<Probe | null>(null)
  const probeRef = useRef(probe)
  probeRef.current = probe
  const [measureBox, setMeasureBoxState] = useState(false)
  const drag = useRef<Drag | null>(null)
  const lastClick = useRef<{ id: string; at: number } | null>(null)
  const geo = useRef({ scale, img, measure, sampler, unit, onCopyColor })
  geo.current = { scale, img, measure, sampler, unit, onCopyColor }

  const say = useCallback((msg: string) => {
    // an identical message must still be announced again
    setStatus((cur) => (cur === msg ? `${msg}​` : msg))
  }, [])

  const selected = useMemo(
    () => doc.shapes.find((s) => s.id === selectedId) ?? null,
    [doc.shapes, selectedId],
  )
  // a shape that no longer exists (undo, delete) cannot stay selected
  useEffect(() => {
    if (selectedId && !selected) setSelectedId(null)
  }, [selectedId, selected])

  const colorForTool = (t: Tool) =>
    toolColors[t] ?? (t === 'highlight' ? HIGHLIGHT_COLOR : DEFAULT_COLOR)
  const color = selected ? selected.color : colorForTool(tool)
  const style: Style = {
    color: colorForTool(tool),
    width: strokeFor(sizeIdx, img.w, img.h),
    fontSize: fontSizeFor(fontIdx, img.w, img.h),
    badgeRadius: badgeRadiusFor(sizeIdx, img.w, img.h),
  }
  const styleRef = useRef(style)
  styleRef.current = style

  const view = viewRect(tool, doc.crop, img, padSize(doc))
  /** where shapes may go: the exported canvas (the crop plus any padding) */
  const area = () => canvasRect(docRef.current, geo.current.img)

  // ---------------------------------------------------------------------------------------- selection + tool
  const select = useCallback(
    (id: string | null, announce = false) => {
      setSelectedId(id)
      if (id && announce) say(selectionAnnouncement(docRef.current.shapes, id))
    },
    [say],
  )

  const setTool = useCallback(
    (t: Tool) => {
      if (editingRef.current) return
      setToolState(t)
      if (t !== 'select') setSelectedId(null)
      drag.current = null
      say(`${TOOL_LABEL[t]} tool`)
    },
    [say],
  )

  // ------------------------------------------------------------------------------------------ doc helpers
  const patch = (id: string, fn: (s: Shape) => Shape) =>
    apply((h) => replace(h, mapShape(h.present, id, fn)))
  const recordDoc = (fn: (d: AnnotDoc) => AnnotDoc, co?: string) =>
    apply((h) => record(h, fn(h.present), co ? { key: co, now: Date.now() } : undefined))
  const addShape = (shape: Shape, how: 'record' | 'replace') =>
    apply((h) => {
      let next = withShapes(h.present, [...h.present.shapes, shape])
      // placing a badge uses the counter, which moves on to the number after it
      if (shape.kind === 'badge') next = { ...next, nextBadge: clampBadge(shape.n + 1) }
      return how === 'record' ? record(h, next) : replace(h, next)
    })

  const startEdit = (shape: Shape, fresh: boolean, base: AnnotDoc) => {
    if (shape.kind !== 'text') return
    setSelectedId(shape.id)
    setEditing({ id: shape.id, value: shape.text, fresh, base, original: shape.text })
  }

  const setEditText = (value: string) => {
    const e = editingRef.current
    if (!e) return
    setEditing({ ...e, value })
    patch(e.id, (s) => (s.kind === 'text' ? { ...s, text: value } : s))
  }

  const commitEdit = useCallback(() => {
    const e = editingRef.current
    if (!e) return
    setEditing(null)
    const empty = e.value.trim() === ''
    apply((h) => {
      if (empty) {
        if (e.fresh) return replace(h, e.base)
        const gone = withShapes(
          h.present,
          h.present.shapes.filter((s) => s.id !== e.id),
        )
        return settle(replace(h, gone), e.base)
      }
      if (!e.fresh && e.value === e.original) return replace(h, e.base)
      return settle(h, e.base)
    })
    if (empty) {
      setSelectedId(null)
      say('Empty text removed')
    } else {
      setSelectedId(e.id)
      setToolState('select')
      say(e.fresh ? 'Text added' : 'Text changed')
    }
  }, [say])

  // ---------------------------------------------------------------------------------------------- placing
  const canPlace = tool === 'crop' || tool === 'measure' || tool === 'picker' || PLACEABLE.has(tool)

  // ------------------------------------------------------------------------------------- probe, pick, measure
  const probeAt = (pt: Pt | null, t: Tool = tool) => {
    const smp = geo.current.sampler
    if (!pt) {
      setProbe(null)
      return null
    }
    const next: Probe = {
      pt,
      color: smp?.color(pt) ?? null,
      span: t === 'measure' ? (smp?.span(pt) ?? null) : null,
    }
    setProbe(next)
    return next
  }

  /** the color picker: the pixel's color becomes the drawing color (every tool) and is copied */
  const pickAt = (pt: Pt) => {
    const c = geo.current.sampler?.color(pt)
    if (!c) {
      say('No color here')
      return
    }
    setToolColors(Object.fromEntries(COLOR_KINDS.map((k) => [k, c])))
    geo.current.onCopyColor?.(c)
    say(`${c} picked`)
  }

  const copyProbeColor = () => {
    const c = probeRef.current?.color
    if (!c) return false
    geo.current.onCopyColor?.(c)
    return true
  }

  /** a smart measurement: the like-colored run through `pt` across and down, as up to two dimension lines */
  const measureAt = (pt: Pt) => {
    const sp = geo.current.sampler?.span(pt)
    if (!sp) {
      say('Nothing to measure here')
      return
    }
    const st = styleRef.current
    const u = geo.current.unit
    const x = Math.floor(pt.x) + 0.5
    const y = Math.floor(pt.y) + 0.5
    const base = { color: st.color, width: st.width, box: false, unit: u, kind: 'measure' as const }
    const out: Shape[] = []
    if (sp.x2 - sp.x1 >= 2)
      out.push({ ...base, id: newShapeId(), a: { x: sp.x1, y }, b: { x: sp.x2, y } })
    if (sp.y2 - sp.y1 >= 2)
      out.push({ ...base, id: newShapeId(), a: { x, y: sp.y1 }, b: { x, y: sp.y2 } })
    if (!out.length) {
      say('Nothing to measure here')
      return
    }
    recordDoc((d) => withShapes(d, [...d.shapes, ...out]))
    say(`Measured ${out.map((m) => (m.kind === 'measure' ? measureLabel(m) : '')).join(' by ')}`)
  }

  const setMeasureBox = (box: boolean) => {
    setMeasureBoxState(box)
    if (selected?.kind === 'measure')
      recordDoc((d) => mapShape(d, selected.id, (s) => ({ ...s, box }) as Shape))
    say(box ? 'Measure boxes' : 'Measure lines')
  }

  const place = useCallback(() => {
    const d = docRef.current
    const { img: im, scale: sc } = geo.current
    if (tool === 'measure' || tool === 'picker') {
      const pt = probeRef.current?.pt ?? centerOf(viewRect(tool, d.crop, im))
      if (tool === 'measure') measureAt(pt)
      else pickAt(pt)
      return
    }
    if (tool === 'crop') {
      if (!d.crop) {
        recordDoc((x) => ({ ...x, crop: defaultCrop(im) }))
        say('Crop area set. Arrow keys move it, Alt with arrow keys resizes it, Enter applies it.')
        return
      }
      // Enter with a crop in place applies it: back to the select tool
      setToolState('select')
      say('Crop applied')
      return
    }
    if (!PLACEABLE.has(tool)) return
    const kind = tool as ShapeKind
    const c = freeSpot(d.shapes, kind, centerOf(viewRect(tool, d.crop, im)), 24 / sc)
    const shape = defaultShape(
      kind,
      c,
      styleRef.current,
      newShapeId(),
      im,
      badgeCounter(d),
    )
    const next = withShapes(d, [...d.shapes, shape])
    addShape(shape, 'record')
    setSelectedId(shape.id)
    if (kind === 'text') {
      startEdit(shape, false, next)
      say('Text added. Type to change it, Escape to finish.')
      return
    }
    if (kind !== 'badge') setToolState('select')
    say(`${shapeLabel(shape)} added, ${next.shapes.length} of ${next.shapes.length} selected`)
  }, [tool, say])

  // --------------------------------------------------------------------------------------------- pointer
  const tolerances = (kind: PointerKind) => {
    const sc = geo.current.scale || 1
    // a finger or pen needs a bigger target: handles get a 44px hit area (22px radius), the visible dot stays small
    return { hit: (kind === 'mouse' ? 6 : 12) / sc, handle: (kind === 'mouse' ? 11 : 22) / sc }
  }

  const down = (pt: Pt, kind: PointerKind) => {
    if (editingRef.current) return
    const d = docRef.current
    const { img: im, measure: m } = geo.current
    const tol = tolerances(kind)
    drag.current = null

    if (tool === 'select') {
      if (selected) {
        const pad = selectionPad(selected, SELECTION_GAP / (geo.current.scale || 1))
        const h = handleAt(selected, pt, tol.handle, m, pad)
        if (h) {
          const off = handleOutset(h, pad)
          drag.current = { mode: 'resize', id: selected.id, handle: h, orig: selected, base: d, off }
          return
        }
      }
      const id = hitTest(d.shapes, pt, tol.hit, m)
      const hit = d.shapes.find((s) => s.id === id)
      if (hit) {
        select(hit.id, hit.id !== selectedId)
        // a selected magnifier's lens and source move apart (an unselected one moves as a whole)
        const part =
          hit.kind === 'magnify' && hit.id === selectedId
            ? (magnifyPart(hit, pt, tol.hit) ?? undefined)
            : undefined
        drag.current = { mode: 'move', id: hit.id, orig: hit, start: pt, base: d, moved: false, part }
      } else select(null)
      return
    }

    if (tool === 'crop') {
      const crop = d.crop
      if (crop) {
        const h = handleAt(
          { id: 'crop', kind: 'fillrect', color: '', width: 0, ...crop },
          pt,
          tol.handle,
        )
        if (h) {
          drag.current = { mode: 'crop-resize', handle: h, orig: crop, base: d }
          return
        }
        if (
          pt.x >= crop.x &&
          pt.x <= crop.x + crop.w &&
          pt.y >= crop.y &&
          pt.y <= crop.y + crop.h
        ) {
          drag.current = { mode: 'crop-move', orig: crop, start: pt, base: d }
          return
        }
      }
      drag.current = { mode: 'crop-new', start: pt, base: d }
      return
    }

    if (tool === 'picker') {
      pickAt(pt)
      return
    }
    if (tool === 'canvas') return

    const st = styleRef.current
    const id = newShapeId()
    if (tool === 'measure') {
      setProbe(null)
      const base = defaultShape('measure', pt, st, id, im)
      const orig = { ...base, box: measureBox, unit: geo.current.unit } as Shape
      addShape(dragCreate(orig, pt, pt), 'replace')
      setSelectedId(null)
      drag.current = { mode: 'create', id, orig, start: pt, base: d, kind }
      return
    }
    if (tool === 'pen') {
      addShape({ id, kind: 'pen', color: st.color, width: st.width, points: [pt] }, 'replace')
      setSelectedId(null)
      drag.current = { mode: 'pen', id, base: d, start: pt, kind }
      return
    }
    if (tool === 'text') {
      // the box opens when the finger LIFTS: iOS only opens the keyboard for a focus() made in a tap, not on pointerdown
      drag.current = { mode: 'text-tap', start: pt, base: d }
      return
    }
    if (tool === 'badge') {
      const shape = defaultShape('badge', pt, st, id, im, badgeCounter(d))
      addShape(shape, 'record')
      setSelectedId(id)
      say(`${shapeLabel(shape)} added`)
      return
    }
    if (PLACEABLE.has(tool)) {
      const orig = defaultShape(tool as ShapeKind, pt, st, id, im)
      addShape(dragCreate(orig, pt, pt, area()), 'replace')
      setSelectedId(null)
      drag.current = { mode: 'create', id, orig, start: pt, base: d, kind }
    }
  }

  const move = (pt: Pt) => {
    const g = drag.current
    if (!g) return
    const { img: im, scale: sc } = geo.current
    switch (g.mode) {
      case 'move': {
        const dx = pt.x - g.start.x
        const dy = pt.y - g.start.y
        if (!g.moved && Math.hypot(dx, dy) * sc < 3) return
        g.moved = true
        patch(g.id, () =>
          g.part && g.orig.kind === 'magnify'
            ? translateMagnifyPart(g.orig, g.part, dx, dy)
            : moveShape(g.orig, dx, dy, area()),
        )
        return
      }
      case 'resize':
        patch(g.id, () => applyHandle(g.orig, g.handle, { x: pt.x - g.off.x, y: pt.y - g.off.y }))
        return
      case 'create':
        patch(g.id, () => dragCreate(g.orig, g.start, pt, area()))
        return
      case 'pen':
        patch(g.id, (s) =>
          s.kind === 'pen' ? { ...s, points: appendPoint(s.points, pt, 1.5 / sc) } : s,
        )
        return
      case 'crop-new': {
        const a = { x: clampN(g.start.x, 0, im.w), y: clampN(g.start.y, 0, im.h) }
        const b = { x: clampN(pt.x, 0, im.w), y: clampN(pt.y, 0, im.h) }
        apply((h) => replace(h, { ...h.present, crop: rectOf(a, b) }))
        return
      }
      case 'crop-move':
        apply((h) =>
          replace(h, {
            ...h.present,
            crop: moveRect(g.orig, pt.x - g.start.x, pt.y - g.start.y, im),
          }),
        )
        return
      case 'crop-resize':
        apply((h) => replace(h, { ...h.present, crop: dragCropHandle(g.orig, g.handle, pt, im) }))
        return
    }
  }

  const up = (pt: Pt) => {
    const g = drag.current
    drag.current = null
    if (!g) return
    const { img: im, scale: sc } = geo.current
    switch (g.mode) {
      case 'move':
        if (g.moved) apply((h) => settle(h, g.base))
        else {
          // a second click on a text shape edits it
          const now = Date.now()
          const last = lastClick.current
          if (g.orig.kind === 'text' && last && last.id === g.id && now - last.at < 450) {
            lastClick.current = null
            startEdit(g.orig, false, g.base)
          } else lastClick.current = { id: g.id, at: now }
        }
        return
      case 'resize':
        apply((h) => settle(h, g.base))
        return
      case 'create': {
        const tiny = Math.hypot(pt.x - g.start.x, pt.y - g.start.y) * sc < 5
        if (g.orig.kind === 'measure') {
          // a click (or tap) measures smartly; a drag keeps its line or box. The tool stays, for the next one.
          if (tiny) {
            apply((h) => replace(h, g.base))
            measureAt(g.start)
            return
          }
          apply((h) => settle(h, g.base))
          const m = docRef.current.shapes.find((x) => x.id === g.id)
          say(m ? `${shapeLabel(m)} added` : 'Measurement added')
          return
        }
        if (tiny && g.kind !== 'mouse') {
          // a stray touch or palm: nothing is created (the Add button places a shape without dragging)
          apply((h) => replace(h, g.base))
          return
        }
        // a mouse click without a drag places a default-sized shape at that spot
        const shape = tiny
          ? defaultShape(g.orig.kind as ShapeKind, pt, styleRef.current, g.id, im)
          : null
        if (shape) patch(g.id, () => shape)
        apply((h) => settle(h, g.base))
        setSelectedId(g.id)
        setToolState('select')
        const after = docRef.current.shapes.length
        say(`${shapeLabel(g.orig)} added, ${after} of ${after} selected`)
        return
      }
      case 'pen': {
        const stroke = docRef.current.shapes.find((x) => x.id === g.id)
        const b = stroke ? boundsOf(stroke) : null
        const dotted = !b || Math.max(b.w, b.h) * sc < 3
        if (dotted && g.kind !== 'mouse') {
          apply((h) => replace(h, g.base))
          return
        }
        apply((h) => settle(h, g.base))
        say('Freehand stroke added')
        return
      }
      case 'text-tap': {
        if (Math.hypot(pt.x - g.start.x, pt.y - g.start.y) * sc > 12) return
        const st = styleRef.current
        const shape = defaultShape('text', g.start, st, newShapeId(), im)
        if (shape.kind !== 'text') return
        const fresh: Shape = { ...shape, x: g.start.x, y: g.start.y - st.fontSize * 0.6, text: '' }
        addShape(fresh, 'replace')
        startEdit(fresh, true, g.base)
        return
      }
      case 'crop-new': {
        const c = docRef.current.crop
        if (!c || c.w < MIN_CROP || c.h < MIN_CROP) {
          apply((h) => replace(h, g.base))
          return
        }
        apply((h) => settle(h, g.base))
        setToolState('select')
        say('Crop applied')
        return
      }
      case 'crop-move':
      case 'crop-resize':
        apply((h) => settle(h, g.base))
        return
    }
  }

  const cancel = () => {
    const g = drag.current
    drag.current = null
    if (g) apply((h) => replace(h, g.base))
  }

  /** the pointer moving over the stage with no button down: the color under it, and the span for the measure tool */
  const hover = (pt: Pt) => {
    if (drag.current || editingRef.current) return
    probeAt(pt)
  }
  const leave = () => {
    if (!drag.current) setProbe(null)
  }

  // -------------------------------------------------------------------------------------------- commands
  const deleteSelected = useCallback(() => {
    const s = docRef.current.shapes.find((x) => x.id === selectedId)
    if (!s) return
    recordDoc((d) =>
      withShapes(
        d,
        d.shapes.filter((x) => x.id !== s.id),
      ),
    )
    setSelectedId(null)
    say(`${shapeLabel(s)} deleted`)
  }, [selectedId, say])

  const doUndo = useCallback(() => {
    if (editingRef.current) return
    apply(undo)
    say('Undone')
  }, [say])
  const doRedo = useCallback(() => {
    if (editingRef.current) return
    apply(redo)
    say('Redone')
  }, [say])
  const clearAll = useCallback(() => {
    if (!docRef.current.shapes.length) return
    recordDoc((d) => ({ ...withShapes(d, []), nextBadge: undefined }))
    setSelectedId(null)
    say('All annotations cleared')
  }, [say])
  const resetCrop = useCallback(() => {
    if (!docRef.current.crop) return
    recordDoc((d) => ({ ...d, crop: null }))
    say('Crop removed')
  }, [say])

  // -------------------------------------------------------------------------------------------- properties
  const setColor = (value: string) => {
    if (selected) {
      recordDoc(
        (d) => mapShape(d, selected.id, (s) => ({ ...s, color: value })),
        `color:${selected.id}`,
      )
      setToolColors((c) => ({ ...c, [selected.kind]: value }))
    } else setToolColors((c) => ({ ...c, [tool]: value }))
    say(`${colorName(value)} color`)
  }
  const setSize = (i: number) => {
    setSizeIdx(i)
    if (selected && selected.kind === 'badge')
      recordDoc(
        (d) =>
          mapShape(d, selected.id, (s) => ({ ...s, r: badgeRadiusFor(i, img.w, img.h) }) as Shape),
        `size:${selected.id}`,
      )
    else if (
      selected &&
      selected.kind !== 'text' &&
      selected.kind !== 'blur' &&
      selected.kind !== 'fillrect'
    )
      recordDoc(
        (d) => mapShape(d, selected.id, (s) => ({ ...s, width: strokeFor(i, img.w, img.h) })),
        `size:${selected.id}`,
      )
    say(`${SIZE_LABELS[i]} size`)
  }
  const resetBadgeCounter = () => {
    if (badgeCounter(docRef.current) === 1 && docRef.current.nextBadge === 1) return
    recordDoc((d) => ({ ...d, nextBadge: 1 }))
    say('Next number reset to 1')
  }
  /** override the selected badge's number; the count carries on from it */
  const setBadgeNumber = (value: number) => {
    if (!selected || selected.kind !== 'badge' || !Number.isFinite(value)) return
    const n = clampBadge(value)
    recordDoc(
      (d) => ({
        ...mapShape(d, selected.id, (s) => (s.kind === 'badge' ? { ...s, n } : s)),
        nextBadge: clampBadge(n + 1),
      }),
      `badgen:${selected.id}`,
    )
  }
  const setFont = (i: number) => {
    setFontIdx(i)
    if (selected && selected.kind === 'text')
      recordDoc(
        (d) =>
          mapShape(d, selected.id, (s) =>
            s.kind === 'text' ? { ...s, fontSize: fontSizeFor(i, img.w, img.h) } : s,
          ),
        `font:${selected.id}`,
      )
    say(`${FONT_LABELS[i]} text`)
  }
  // the size / font controls show the selected shape's values
  const shownSize =
    !selected || selected.kind === 'text'
      ? sizeIdx
      : selected.kind === 'badge'
        ? nearestIndex(
            selected.r,
            [0, 1, 2].map((i) => badgeRadiusFor(i, img.w, img.h)),
          )
        : sizeIndexOf(selected.width, img.w, img.h)
  const shownFont =
    selected?.kind === 'text' ? fontIndexOf(selected.fontSize, img.w, img.h) : fontIdx

  // ------------------------------------------------------------------------------------- canvas + scale
  const setScale = (v: number) => {
    if (!Number.isFinite(v) || v <= 0) return
    const k = clampN(v, MIN_SCALE, MAX_SCALE)
    recordDoc((d) => ({ ...d, scale: k }), 'scale')
    const o = outputSize({ ...docRef.current, scale: k }, img)
    say(`Export size ${o.w} by ${o.h} pixels`)
  }
  const setPad = (pad: Pad) => {
    const size = clampN(Math.round(pad.size) || 0, 0, MAX_PAD)
    recordDoc((d) => ({ ...d, pad: { size, color: pad.color } }), 'pad')
    say(size ? `Padding ${size} pixels` : 'No padding')
  }

  // ------------------------------------------------------------------------------------------- keyboard
  /** keys on the stage; returns true when it handled (and prevented) the key */
  const onKey = (e: KeyboardEvent): boolean => {
    if (editingRef.current || e.ctrlKey || e.metaKey) return false
    // typing in a field (e.g. the badge number) is not a shortcut
    if ((e.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable="true"]')) return false
    const d = docRef.current
    const { img: im, scale: sc } = geo.current
    const key = e.key
    const handled = () => {
      e.preventDefault()
      e.stopPropagation()
      return true
    }

    if (key === 'Tab' && tool === 'picker' && !e.shiftKey) {
      // Shottr's "Tab to copy"
      if (!copyProbeColor()) return false
      return handled()
    }

    if (key === 'Tab') {
      if (!d.shapes.length || tool === 'crop') return false
      const i = selectedId ? d.shapes.findIndex((s) => s.id === selectedId) : -1
      if (i < 0 && e.shiftKey) return false
      const next = i + (e.shiftKey ? -1 : 1)
      if (next < 0 || next >= d.shapes.length) {
        // past the ends focus leaves the stage (no keyboard trap)
        setSelectedId(null)
        return false
      }
      if (tool !== 'select') setToolState('select')
      select(d.shapes[next]!.id, true)
      return handled()
    }

    if (key === 'Enter' || key === ' ') {
      if (canPlace) {
        place()
        return handled()
      }
      if (tool === 'select' && selected?.kind === 'text') {
        startEdit(selected, false, d)
        return handled()
      }
      return false
    }

    if (key === 'Delete' || key === 'Backspace') {
      if (tool === 'crop') {
        if (d.crop) resetCrop()
        return handled()
      }
      if (selected) {
        deleteSelected()
        return handled()
      }
      return false
    }

    const step = keyStep(e.shiftKey, 1 / (sc || 1))
    const delta = keyDelta(key, step)
    if (!delta) return false
    if (tool === 'measure' || tool === 'picker') {
      // the keyboard's pointer: arrow keys move the probe, Enter measures / picks there
      const from = probeRef.current?.pt ?? centerOf(viewRect(tool, d.crop, im))
      const p = probeAt({
        x: clampN(from.x + delta.x, 0, im.w - 0.01),
        y: clampN(from.y + delta.y, 0, im.h - 0.01),
      })
      if (tool === 'picker' && p?.color) say(p.color)
      else if (p?.span)
        say(
          `${Math.round((p.span.x2 - p.span.x1) / geo.current.unit)} by ${Math.round((p.span.y2 - p.span.y1) / geo.current.unit)}`,
        )
      return handled()
    }
    if (tool === 'crop') {
      if (!d.crop) return false
      recordDoc(
        (x) => ({
          ...x,
          crop: e.altKey
            ? resizeRect(x.crop!, delta.x, delta.y, im)
            : moveRect(x.crop!, delta.x, delta.y, im),
        }),
        'crop',
      )
      return handled()
    }
    if (!selected) return false
    recordDoc(
      (x) =>
        mapShape(x, selected.id, (s) =>
          e.altKey ? resizeShapeBy(s, delta.x, delta.y) : moveShape(s, delta.x, delta.y, area()),
        ),
      `${e.altKey ? 'resize' : 'nudge'}:${selected.id}`,
    )
    return handled()
  }

  /** Escape on the dialog: finish text, else deselect. True = consumed (the dialog stays open). */
  const escape = useCallback((): boolean => {
    if (editingRef.current) {
      commitEdit()
      return true
    }
    if (selectedId) {
      setSelectedId(null)
      say('Selection cleared')
      return true
    }
    return false
  }, [commitEdit, selectedId, say])

  // the stage's selected shape bounds, for the text editor's position
  const selectedBounds = selected ? boundsOf(selected, measure) : null

  return {
    doc,
    img,
    tool,
    setTool,
    view,
    selected,
    selectedId,
    selectedBounds,
    select,
    color,
    setColor,
    sizeIdx: shownSize,
    setSize,
    fontIdx: shownFont,
    setFont,
    nextBadge: badgeCounter(doc),
    resetBadgeCounter,
    setBadgeNumber,
    editing,
    setEditText,
    commitEdit,
    canUndo: canUndo(hist),
    canRedo: canRedo(hist),
    dirty: isDirty(hist) || !!editing,
    undo: doUndo,
    redo: doRedo,
    clearAll,
    resetCrop,
    deleteSelected,
    canPlace,
    place,
    pointer: { down, move, up, cancel, hover, leave },
    onKey,
    escape,
    status,
    say,
    probe,
    copyProbeColor,
    measureBox: selected?.kind === 'measure' ? selected.box : measureBox,
    setMeasureBox,
    unit,
    setScale,
    setPad,
  }
}

export type Annotator = ReturnType<typeof useAnnotator>
