/**
 * The device primitives: panel, screen, vent, key, lamp, caret.
 *
 * These are the entire visual vocabulary of the interface. The screen and the
 * keys are the only elements permitted real depth.
 */

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'

import { translate, type Locale, type StringKey } from '../lib/i18n'

export function Panel({
  children,
  recipient,
  ...rest
}: {
  children: ReactNode
  recipient?: boolean
} & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`fret-panel${recipient ? ' fret-panel--recipient' : ''}`} {...rest}>
      {children}
    </div>
  )
}

export function Vent() {
  // Decorative: it stands in for a speaker grille and carries no information.
  return <div className="fret-vent" aria-hidden="true" />
}

export function Lamp({
  color,
  size = 7,
  pulse,
  breathe,
}: {
  color: string
  size?: number
  pulse?: boolean
  breathe?: boolean
}) {
  const className = ['fret-lamp', pulse && 'fret-lamp--pulse', breathe && 'fret-lamp--breathe']
    .filter(Boolean)
    .join(' ')
  return (
    <span
      className={className}
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        background: color,
        boxShadow: `0 0 6px ${color}, inset 0 1px 1px rgba(255,255,255,.5)`,
      }}
    />
  )
}

/** The blinking block cursor that follows a status line. */
export function Caret({ width = 9, height = 20 }: { width?: number; height?: number }) {
  return <span className="fret-caret" aria-hidden="true" style={{ width, height }} />
}

export function Screen({
  children,
  dragging,
  onClick,
  onDragOver,
  onDragLeave,
  onDrop,
  fill,
  draining,
  sheen,
  style,
  label,
}: {
  children: ReactNode
  dragging?: boolean
  onClick?: () => void
  onDragOver?: (e: React.DragEvent) => void
  onDragLeave?: (e: React.DragEvent) => void
  onDrop?: (e: React.DragEvent) => void
  /** Height of the rising material, 0-100. */
  fill?: number
  draining?: boolean
  sheen?: boolean
  style?: CSSProperties
  label?: string
}) {
  const droppable = Boolean(onDrop)
  const className = [
    'fret-screen',
    droppable && 'fret-screen--drop',
    dragging && 'fret-screen--dragging',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      className={className}
      style={style}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onClick={onClick}
      onKeyDown={
        droppable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onClick?.()
              }
            }
          : undefined
      }
      role={droppable ? 'button' : undefined}
      tabIndex={droppable ? 0 : undefined}
      aria-label={label}
    >
      {fill !== undefined && fill > 0 && (
        <div
          className={`fret-fill${draining ? ' fret-fill--draining' : ''}`}
          style={{ height: `${fill}%`, opacity: draining ? 0 : 1 }}
        />
      )}
      {sheen && <div className="fret-sheen" aria-hidden="true" />}
      <div className="fret-screen__inner">{children}</div>
    </div>
  )
}

/** The status strip along the top of the screen: lamp, label, right-hand note. */
export function Strip({
  color,
  label,
  right,
  pulse,
}: {
  color: string
  label: string
  right?: ReactNode
  pulse?: boolean
}) {
  return (
    <div className="fret-screen__strip">
      <Lamp color={color} size={6} pulse={pulse} />
      <span className="fret-screen__stripLabel">{label}</span>
      {right && <span className="fret-screen__stripRight">{right}</span>}
    </div>
  )
}

export function Key({
  children,
  variant = 'primary',
  inert,
  lamp,
  className = '',
  ...rest
}: {
  children: ReactNode
  variant?: 'primary' | 'alt'
  inert?: boolean
  /** Colour of the state lamp carried on the key itself, if any. */
  lamp?: { color: string; pulse?: boolean }
  className?: string
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const classes = [
    'fret-key',
    variant === 'alt' && 'fret-key--alt',
    inert && 'fret-key--inert',
    className,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button type="button" className={classes} disabled={inert || rest.disabled} {...rest}>
      {lamp && <Lamp color={lamp.color} size={7} pulse={lamp.pulse} />}
      <span className="fret-key__label">{children}</span>
    </button>
  )
}

/**
 * The restore tag.
 *
 * Renaming a live transfer is deliberate — you do it precisely when a link
 * went to the wrong person — so the old name stops working, as it should. But
 * the name itself should not be lost, and it stays reserved to this transfer
 * server-side, so restoring it always succeeds.
 *
 * It is drawn as a paper tag tucked into the base of the device rather than a
 * warning banner: nothing is broken, a previous name is simply on file. It
 * exists in the DOM only while there is one to offer.
 */
export function RestoreTag({
  slug,
  current,
  locale,
  onRestore,
}: {
  /** The name the link was handed out under, or '' if it never was. */
  slug: string
  current: string
  locale: Locale
  onRestore: () => void
}) {
  const showing = slug !== '' && slug !== current
  // Held after `showing` goes false so the tag can slide back under the device
  // instead of vanishing mid-transition.
  const [remembered, setRemembered] = useState(slug)
  useEffect(() => {
    if (showing) setRemembered(slug)
  }, [showing, slug])

  if (remembered === '') return null
  const t = (key: StringKey) => translate(locale, key)

  return (
    <div className={`fret-tag${showing ? ' fret-tag--out' : ''}`} aria-hidden={!showing}>
      <div className="fret-tag__inner">
        <span className="fret-tag__label">{t('tag.sharedAs')}</span>
        <span className="fret-tag__slug">{remembered}</span>
        <span className="fret-tag__note">{t('tag.note')}</span>
        <button
          type="button"
          className="fret-tag__restore"
          onClick={onRestore}
          tabIndex={showing ? 0 : -1}
        >
          {t('tag.restore')}
        </button>
      </div>
    </div>
  )
}
