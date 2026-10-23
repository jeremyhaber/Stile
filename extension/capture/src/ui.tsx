// Small local replacements for the Tandem shared UI the annotation code imported (ui/primitives, ui/Dialog, toasts).
import {
  forwardRef,
  useEffect,
  useRef,
  type ButtonHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react'
import s from './editor.module.css'

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, ...rest }, ref) {
    return <select ref={ref} className={`${s.select} ${className ?? ''}`} {...rest} />
  },
)

interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'danger'
}
export const Button = forwardRef<HTMLButtonElement, BtnProps>(function Button(
  { variant = 'default', className, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={`${s.btn} ${variant === 'primary' ? s.primary : ''} ${variant === 'danger' ? s.danger : ''} ${className ?? ''}`}
      {...rest}
    />
  )
})

export function Spinner({ label }: { label: string }) {
  return <span className={s.spinner} role="img" aria-label={label} />
}

/** An in-app confirm dialog (never window.confirm): Escape or the first button keeps editing. */
export function Dialog({
  open,
  title,
  description,
  footer,
  onClose,
}: {
  open: boolean
  title: string
  description: string
  footer: ReactNode
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const prev = document.activeElement as HTMLElement | null
    ref.current?.querySelector<HTMLElement>('button')?.focus()
    return () => prev?.focus?.()
  }, [open])
  if (!open) return null
  return (
    <div className={s.scrim} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        className={s.dialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="dlg-t"
        aria-describedby="dlg-d"
        data-testid="capture-dialog"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            onClose()
          } else if (e.key === 'Tab') {
            const b = Array.from(ref.current?.querySelectorAll<HTMLElement>('button') ?? [])
            if (!b.length) return
            const i = b.indexOf(document.activeElement as HTMLElement)
            const next = e.shiftKey ? (i <= 0 ? b.length - 1 : i - 1) : (i + 1) % b.length
            e.preventDefault()
            b[next]!.focus()
          }
        }}
      >
        <h2 id="dlg-t">{title}</h2>
        <p id="dlg-d">{description}</p>
        <div className={s.dialogFoot}>{footer}</div>
      </div>
    </div>
  )
}

export interface ToastMsg {
  id: number
  text: string
  action?: { label: string; run: () => void }
}
export function Toasts({ items }: { items: ToastMsg[] }) {
  return (
    <div className={s.toasts} role="status" aria-live="polite" data-testid="capture-toasts">
      {items.map((t) => (
        <div key={t.id} className={s.toast} data-testid="capture-toast">
          <span>{t.text}</span>
          {t.action && (
            <button type="button" className={s.toastBtn} onClick={t.action.run}>
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
