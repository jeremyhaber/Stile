import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import {
  Check,
  Crop,
  Circle,
  Eraser,
  Grid3x3,
  Hash,
  Highlighter,
  MousePointer2,
  MoveUpRight,
  Pencil,
  Pipette,
  Plus,
  Redo2,
  RotateCcw,
  Ruler,
  Scaling,
  ScanSearch,
  Slash,
  Square,
  Trash2,
  Type,
  Undo2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { Select } from '../ui'
import type { Annotator } from './useAnnotator'
import {
  COLORS,
  FONT_LABELS,
  SIZE_LABELS,
  TOOL_LABEL,
  canvasRect,
  docScale,
  outputSize,
  padSize,
  readableOn,
  type Tool,
} from './model'
import s from './annotate.module.css'

const ICONS: Record<Tool, ReactNode> = {
  select: <MousePointer2 size={16} aria-hidden />,
  pen: <Pencil size={16} aria-hidden />,
  highlight: <Highlighter size={16} aria-hidden />,
  arrow: <MoveUpRight size={16} aria-hidden />,
  line: <Slash size={16} aria-hidden />,
  rect: <Square size={16} aria-hidden />,
  fillrect: <Square size={16} fill="currentColor" aria-hidden />,
  ellipse: <Circle size={16} aria-hidden />,
  text: <Type size={16} aria-hidden />,
  badge: <Hash size={16} aria-hidden />,
  blur: <Grid3x3 size={16} aria-hidden />,
  measure: <Ruler size={16} aria-hidden />,
  magnify: <ScanSearch size={16} aria-hidden />,
  picker: <Pipette size={16} aria-hidden />,
  crop: <Crop size={16} aria-hidden />,
  canvas: <Scaling size={16} aria-hidden />,
}
const TOOL_ORDER: Tool[] = [
  'select',
  'pen',
  'highlight',
  'arrow',
  'line',
  'rect',
  'fillrect',
  'ellipse',
  'text',
  'badge',
  'blur',
  'measure',
  'magnify',
  'picker',
  'crop',
  'canvas',
]

/**
 * Sideways-scrolling rows (the phone's options and tool bar): marks the element with `data-more-start` / `data-more-end`
 * while there is more to scroll to in that direction, so CSS can fade that edge. Static (no animation).
 */
export function useScrollEdges(ref: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => {
      const max = el.scrollWidth - el.clientWidth
      el.toggleAttribute('data-more-start', el.scrollLeft > 2)
      el.toggleAttribute('data-more-end', max > 2 && el.scrollLeft < max - 2)
    }
    update()
    el.addEventListener('scroll', update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(el)
    // controls come and go with the tool: look again after every render of the owner
    return () => {
      el.removeEventListener('scroll', update)
      ro.disconnect()
    }
  }, [ref])
  // content changes (conditional controls) without a resize of the row itself
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const max = el.scrollWidth - el.clientWidth
    el.toggleAttribute('data-more-start', el.scrollLeft > 2)
    el.toggleAttribute('data-more-end', max > 2 && el.scrollLeft < max - 2)
  })
}

/**
 * A group with ONE tab stop (roving tabindex): Left / Right / Home / End move between its `[data-roving]` items, the
 * selected one (aria-pressed / aria-checked) is the stop. `follow` = a radio group, where moving also selects.
 */
function Roving({
  role,
  label,
  className,
  follow,
  children,
}: {
  role: 'toolbar' | 'radiogroup' | 'group'
  label: string
  className?: string
  follow?: boolean
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const active = useRef<HTMLElement | null>(null)
  useScrollEdges(ref)
  const items = () => Array.from(ref.current?.querySelectorAll<HTMLElement>('[data-roving]') ?? [])
  const sync = () => {
    const list = items()
    if (!list.length) return
    if (!active.current || !list.includes(active.current))
      active.current =
        list.find(
          (i) =>
            i.getAttribute('aria-pressed') === 'true' || i.getAttribute('aria-checked') === 'true',
        ) ?? list[0]!
    for (const i of list) i.tabIndex = i === active.current ? 0 : -1
  }
  // after every render: items come and go (conditional controls), exactly one stays tabbable
  useLayoutEffect(sync)
  const onFocus = (e: FocusEvent) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-roving]')
    if (t && t !== active.current) {
      active.current = t
      sync()
    }
  }
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return
    const list = items()
    const i = list.findIndex((el) => el === document.activeElement)
    if (i < 0) return
    let next = -1
    if (e.key === 'ArrowRight' || (role === 'radiogroup' && e.key === 'ArrowDown'))
      next = (i + 1) % list.length
    else if (e.key === 'ArrowLeft' || (role === 'radiogroup' && e.key === 'ArrowUp'))
      next = (i - 1 + list.length) % list.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = list.length - 1
    if (next < 0) return
    e.preventDefault()
    active.current = list[next]!
    sync()
    list[next]!.focus()
    if (follow) list[next]!.click()
  }
  return (
    <div
      ref={ref}
      role={role}
      aria-label={label}
      aria-orientation={role === 'group' ? undefined : 'horizontal'}
      className={className}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>
  )
}

const STROKE_TOOLS = new Set([
  'pen',
  'highlight',
  'arrow',
  'line',
  'rect',
  'ellipse',
  'badge',
  'measure',
  'magnify',
])
const PAD_COLORS = [
  { name: 'Transparent', value: 'transparent' },
  { name: 'White', value: '#ffffff' },
  { name: 'Light gray', value: '#ececf0' },
  { name: 'Black', value: '#111111' },
] as const
const SCALES = [0.25, 0.5, 0.75, 1, 1.5, 2]
const COLOR_TOOLS = new Set([...STROKE_TOOLS, 'fillrect', 'text'])

/** Undo / Redo: in the tool bar (roving) on desktop, 44px icon buttons in the phone header */
export function HistoryButtons({ annot, roving }: { annot: Annotator; roving?: boolean }) {
  const cls = roving ? s.tool : `${s.tool} ${s.headTool}`
  return (
    <>
      <button
        type="button"
        className={cls}
        {...(roving ? { 'data-roving': '' } : null)}
        data-testid="annotate-undo"
        aria-label="Undo"
        title="Undo (Ctrl/Cmd+Z)"
        aria-disabled={!annot.canUndo || undefined}
        onClick={() => annot.canUndo && annot.undo()}
      >
        <Undo2 size={16} aria-hidden />
      </button>
      <button
        type="button"
        className={cls}
        {...(roving ? { 'data-roving': '' } : null)}
        data-testid="annotate-redo"
        aria-label="Redo"
        title="Redo (Ctrl/Cmd+Shift+Z)"
        aria-disabled={!annot.canRedo || undefined}
        onClick={() => annot.canRedo && annot.redo()}
      >
        <Redo2 size={16} aria-hidden />
      </button>
    </>
  )
}

export function AnnotateTools({
  annot,
  className,
  phone,
}: {
  annot: Annotator
  className?: string
  /** phones: Undo / Redo live in the header, and the active tool is scrolled into view in the sideways row */
  phone?: boolean
}) {
  const bar = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!phone) return
    bar.current
      ?.querySelector<HTMLElement>('[aria-pressed="true"]')
      ?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' })
  }, [phone, annot.tool])
  return (
    <div ref={bar} className={s.toolsWrap}>
      <Roving role="toolbar" label="Annotation tools" className={className ?? s.tools}>
        {TOOL_ORDER.map((t) => (
          <button
            key={t}
            type="button"
            className={s.tool}
            data-roving=""
            data-testid={`annotate-tool-${t}`}
            aria-pressed={annot.tool === t}
            aria-label={TOOL_LABEL[t]}
            title={TOOL_LABEL[t]}
            onClick={() => annot.setTool(t)}
          >
            {ICONS[t]}
          </button>
        ))}
        <span className={s.sep} role="separator" aria-orientation="vertical" />
        {!phone && <HistoryButtons annot={annot} roving />}
        <button
          type="button"
          className={s.tool}
          data-roving=""
          data-testid="annotate-clear"
          aria-label="Clear all"
          title="Clear all annotations"
          aria-disabled={!annot.doc.shapes.length || undefined}
          onClick={() => annot.clearAll()}
        >
          <Eraser size={16} aria-hidden />
        </button>
      </Roving>
    </div>
  )
}

/** `afterAction` puts focus back on the stage (the button that was pressed may disappear with its action) */
export function AnnotateProps({
  annot,
  afterAction,
  zoom,
}: {
  annot: Annotator
  afterAction: () => void
  /** the stage zoom: pinch is the touch way, these buttons are the single-pointer / keyboard way.
   *  (Stile: optional; the capture editor shows its own zoom group in the top bar.) */
  zoom?: { value: number; by: (factor: number) => void; fit: () => void }
}) {
  const propsRef = useRef<HTMLDivElement>(null)
  useScrollEdges(propsRef)
  const rel: string = annot.selected?.kind ?? annot.tool
  const showColor = COLOR_TOOLS.has(rel)
  const showSize = STROKE_TOOLS.has(rel)
  const showFont = rel === 'text'
  const canAdd = annot.canPlace
  const addLabel =
    annot.tool === 'crop'
      ? 'Set crop area'
      : annot.tool === 'measure'
        ? 'Measure here'
        : annot.tool === 'picker'
          ? 'Pick color'
          : `Add ${TOOL_LABEL[annot.tool].toLowerCase()}`
  // a picked color is not one of the palette's: it gets a swatch of its own, checked
  const custom = COLORS.some((c) => c.value === annot.color.toLowerCase()) ? null : annot.color
  return (
    <div ref={propsRef} className={s.props} role="group" aria-label="Properties">
      {showColor && (
        <Roving role="radiogroup" label="Color" follow className={s.swatches}>
          {COLORS.map((c) => {
            const on = annot.color.toLowerCase() === c.value
            return (
              <button
                key={c.value}
                type="button"
                role="radio"
                className={s.swatch}
                data-roving=""
                data-testid={`annotate-color-${c.name.toLowerCase()}`}
                aria-checked={on}
                aria-label={c.name}
                title={c.name}
                onClick={() => annot.setColor(c.value)}
              >
                {/* the button is the (44px on a phone) target, the dot is what is seen */}
                <span className={s.dot} style={{ background: c.value, color: readableOn(c.value) }}>
                  {on && <Check size={14} strokeWidth={3} aria-hidden />}
                </span>
              </button>
            )
          })}
          {custom && (
            <button
              type="button"
              role="radio"
              className={s.swatch}
              data-roving=""
              data-testid="annotate-color-custom"
              aria-checked
              aria-label={`Picked color ${custom}`}
              title={custom}
              onClick={() => annot.setColor(custom)}
            >
              <span className={s.dot} style={{ background: custom, color: readableOn(custom) }}>
                <Check size={14} strokeWidth={3} aria-hidden />
              </span>
            </button>
          )}
        </Roving>
      )}
      {rel === 'measure' && (
        <Roving role="radiogroup" label="Measure" follow className={s.sizes}>
          {(['Line', 'Box'] as const).map((label) => {
            const on = annot.measureBox === (label === 'Box')
            return (
              <button
                key={label}
                type="button"
                role="radio"
                className={s.size}
                style={{ width: 'auto', padding: '0 8px' }}
                data-roving=""
                data-testid={`annotate-measure-${label.toLowerCase()}`}
                aria-checked={on}
                onClick={() => annot.setMeasureBox(label === 'Box')}
              >
                {label}
              </button>
            )
          })}
        </Roving>
      )}
      {annot.tool === 'canvas' && <CanvasProps annot={annot} />}
      {showSize && (
        <Roving role="radiogroup" label="Stroke width" follow className={s.sizes}>
          {SIZE_LABELS.map((label, i) => (
            <button
              key={label}
              type="button"
              role="radio"
              className={s.size}
              data-roving=""
              data-testid={`annotate-size-${i}`}
              aria-checked={annot.sizeIdx === i}
              aria-label={label}
              title={label}
              onClick={() => annot.setSize(i)}
            >
              <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
                <line
                  x1="3"
                  y1="9"
                  x2="15"
                  y2="9"
                  stroke="currentColor"
                  strokeWidth={[2, 4, 7][i]}
                  strokeLinecap="round"
                />
              </svg>
            </button>
          ))}
        </Roving>
      )}
      {rel === 'badge' && <BadgeProps annot={annot} afterAction={afterAction} />}
      {showFont && (
        <label className={s.fontField}>
          <span>Text size</span>
          <Select
            value={annot.fontIdx}
            onChange={(e) => annot.setFont(Number(e.target.value))}
            data-testid="annotate-font"
          >
            {FONT_LABELS.map((l, i) => (
              <option key={l} value={i}>
                {l}
              </option>
            ))}
          </Select>
        </label>
      )}
      <div className={s.actions}>
        {annot.editing && (
          <button
            type="button"
            className={`${s.action} ${s.actionPrimary}`}
            data-testid="annotate-done"
            onClick={() => annot.commitEdit()}
          >
            <Check size={14} aria-hidden /> Done
          </button>
        )}
        {canAdd && (
          <button
            type="button"
            className={s.action}
            data-testid="annotate-add"
            onClick={() => {
              annot.place()
              afterAction()
            }}
          >
            <Plus size={14} aria-hidden /> {addLabel}
          </button>
        )}
        {annot.tool === 'crop' && annot.doc.crop && (
          <button
            type="button"
            className={s.action}
            onClick={() => {
              annot.resetCrop()
              afterAction()
            }}
          >
            <RotateCcw size={14} aria-hidden /> Reset crop
          </button>
        )}
        {annot.tool === 'canvas' && (docScale(annot.doc) !== 1 || padSize(annot.doc) > 0) && (
          <button
            type="button"
            className={s.action}
            data-testid="annotate-canvas-reset"
            onClick={() => {
              annot.setScale(1)
              annot.setPad({ size: 0, color: annot.doc.pad?.color ?? 'transparent' })
              afterAction()
            }}
          >
            <RotateCcw size={14} aria-hidden /> Reset
          </button>
        )}
        {annot.selected && (
          <button
            type="button"
            className={s.action}
            data-testid="annotate-delete"
            onClick={() => {
              annot.deleteSelected()
              afterAction()
            }}
          >
            <Trash2 size={14} aria-hidden /> Delete
          </button>
        )}
        {zoom && (<>
        <button
          type="button"
          className={s.action}
          data-testid="annotate-zoom-out"
          aria-label="Zoom out"
          title="Zoom out"
          aria-disabled={zoom.value <= 1 || undefined}
          onClick={() => zoom.by(1 / 1.5)}
        >
          <ZoomOut size={16} aria-hidden />
        </button>
        <button
          type="button"
          className={s.action}
          data-testid="annotate-fit"
          aria-label={`Fit to screen, zoom ${Math.round(zoom.value * 100)}%`}
          title="Fit the whole image on screen"
          onClick={zoom.fit}
        >
          Fit
        </button>
        <button
          type="button"
          className={s.action}
          data-testid="annotate-zoom-in"
          aria-label="Zoom in"
          title="Zoom in (or pinch)"
          onClick={() => zoom.by(1.5)}
        >
          <ZoomIn size={16} aria-hidden />
        </button>
        </>)}
      </div>
    </div>
  )
}

/**
 * The count tool: the number the next badge gets, a Reset that starts a new count, and (with a badge selected) its
 * number as an editable field. Typing applies as you go (one undo step); an empty or out-of-range value waits.
 */
function BadgeProps({ annot, afterAction }: { annot: Annotator; afterAction: () => void }) {
  const sel = annot.selected?.kind === 'badge' ? annot.selected : null
  const n = sel?.n
  const [text, setText] = useState(n === undefined ? '' : String(n))
  // follows the badge: another selection, undo / redo
  useEffect(() => {
    setText((t) => (n !== undefined && Number(t) !== n ? String(n) : t))
  }, [n, sel?.id])
  return (
    <>
      {sel ? (
        <label className={s.numField}>
          <span>Number</span>
          <input
            key={sel.id}
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={3}
            value={text}
            aria-label="Badge number (1 to 999)"
            title="Badge number (1 to 999); the next badge continues from it"
            data-testid="annotate-badge-number"
            onChange={(e) => {
              const v = e.target.value.replace(/\D/g, '').slice(0, 3)
              setText(v)
              const num = Number(v)
              if (v && num >= 1 && num <= 999) annot.setBadgeNumber(num)
            }}
            onBlur={() => setText(String(sel.n))}
          />
        </label>
      ) : null}
      <span className={s.numField} data-testid="annotate-badge-next">
        Next: {annot.nextBadge}
      </span>
      <button
          type="button"
          className={s.action}
          data-testid="annotate-badge-reset"
          aria-label="Reset count: the next badge is number 1"
          title="Reset count: the next badge is number 1"
          aria-disabled={annot.nextBadge === 1 || undefined}
          onClick={() => {
            annot.resetBadgeCounter()
            afterAction()
          }}
        >
          <RotateCcw size={14} aria-hidden /> Reset
        </button>
    </>
  )
}

/**
 * The canvas tool: the export size (width / height in px, aspect kept, or a percentage) and the padding around the
 * picture (px and color). Typed numbers apply on Enter or when the field loses focus.
 */
function CanvasProps({ annot }: { annot: Annotator }) {
  const img = annot.img
  const c = canvasRect(annot.doc, img)
  const out = outputSize(annot.doc, img)
  const k = docScale(annot.doc)
  const pad = padSize(annot.doc)
  const padColor = annot.doc.pad?.color ?? 'transparent'
  const commit = (fn: (v: number) => void) => (e: FocusEvent<HTMLInputElement> | KeyboardEvent<HTMLInputElement>) => {
    if ('key' in e && e.key !== 'Enter') return
    const v = Number((e.currentTarget as HTMLInputElement).value)
    if (Number.isFinite(v)) fn(v)
  }
  const pct = Math.round(k * 100)
  return (
    <>
      <label className={s.numField}>
        <span>Size</span>
        <input
          key={`w${out.w}`}
          type="number"
          min={1}
          defaultValue={out.w}
          aria-label="Export width in pixels"
          data-testid="annotate-out-width"
          onBlur={commit((v) => v > 0 && annot.setScale(v / c.w))}
          onKeyDown={commit((v) => v > 0 && annot.setScale(v / c.w))}
        />
        <span className={s.times}>×</span>
        <input
          key={`h${out.h}`}
          type="number"
          min={1}
          defaultValue={out.h}
          aria-label="Export height in pixels"
          data-testid="annotate-out-height"
          onBlur={commit((v) => v > 0 && annot.setScale(v / c.h))}
          onKeyDown={commit((v) => v > 0 && annot.setScale(v / c.h))}
        />
      </label>
      <label className={s.fontField}>
        <span className="sr-only">Scale</span>
        <Select
          value={SCALES.includes(k) ? String(k) : 'custom'}
          onChange={(e) => e.target.value !== 'custom' && annot.setScale(Number(e.target.value))}
          data-testid="annotate-scale"
          aria-label="Export scale"
        >
          {!SCALES.includes(k) && <option value="custom">{pct}%</option>}
          {SCALES.map((v) => (
            <option key={v} value={String(v)}>
              {Math.round(v * 100)}%{annot.unit > 1 && Math.abs(v - 1 / annot.unit) < 1e-6 ? ' (1×)' : ''}
            </option>
          ))}
        </Select>
      </label>
      <label className={s.numField}>
        <span>Padding</span>
        <input
          key={`p${pad}`}
          type="number"
          min={0}
          defaultValue={pad}
          aria-label="Padding in pixels"
          data-testid="annotate-pad-size"
          onBlur={commit((v) => annot.setPad({ size: v, color: padColor }))}
          onKeyDown={commit((v) => annot.setPad({ size: v, color: padColor }))}
        />
      </label>
      <Roving role="radiogroup" label="Padding color" follow className={s.swatches}>
        {PAD_COLORS.map((p) => {
          const on = padColor === p.value
          return (
            <button
              key={p.value}
              type="button"
              role="radio"
              className={s.swatch}
              data-roving=""
              data-testid={`annotate-pad-${p.name.toLowerCase().replace(' ', '-')}`}
              aria-checked={on}
              aria-label={`${p.name} padding`}
              title={`${p.name} padding`}
              onClick={() => annot.setPad({ size: pad || 40, color: p.value })}
            >
              <span
                className={`${s.dot} ${p.value === 'transparent' ? s.checker : ''}`}
                style={p.value === 'transparent' ? { color: '#111111' } : { background: p.value, color: readableOn(p.value) }}
              >
                {on && <Check size={14} strokeWidth={3} aria-hidden />}
              </span>
            </button>
          )
        })}
      </Roving>
    </>
  )
}
