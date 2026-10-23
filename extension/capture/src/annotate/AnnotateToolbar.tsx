import {
  useEffect,
  useLayoutEffect,
  useRef,
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
  Plus,
  Redo2,
  RotateCcw,
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
import { COLORS, FONT_LABELS, SIZE_LABELS, TOOL_LABEL, readableOn, type Tool } from './model'
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
  crop: <Crop size={16} aria-hidden />,
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
  'crop',
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

const STROKE_TOOLS = new Set(['pen', 'highlight', 'arrow', 'line', 'rect', 'ellipse', 'badge'])
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
   *  (Sidebar: optional; the capture editor shows its own zoom group in the top bar.) */
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
    annot.tool === 'crop' ? 'Set crop area' : `Add ${TOOL_LABEL[annot.tool].toLowerCase()}`
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
        </Roving>
      )}
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
