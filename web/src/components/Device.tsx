/**
 * The device primitives: panel, screen, vent, key, lamp, caret.
 *
 * These are the entire visual vocabulary of the interface. The screen and the
 * keys are the only elements permitted real depth.
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'

export function Panel({
  children,
  recipient,
  settled,
  ...rest
}: {
  children: ReactNode
  recipient?: boolean
  /** Plays the completion settle once. */
  settled?: boolean
} & React.HTMLAttributes<HTMLDivElement>) {
  const classes = [
    'fret-panel',
    recipient && 'fret-panel--recipient',
    settled && 'fret-panel--settled',
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <div className={classes} {...rest}>
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
  bloom,
}: {
  color: string
  size?: number
  pulse?: boolean
  breathe?: boolean
  /** Blooms once, for a lamp that has just come good. */
  bloom?: boolean
}) {
  const className = [
    'fret-lamp',
    pulse && 'fret-lamp--pulse',
    breathe && 'fret-lamp--breathe',
    bloom && 'fret-lamp--bloom',
  ]
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

/**
 * The blinking block cursor that follows a line of type.
 *
 * Sized in em, so it is measured against the type it actually sits beside
 * rather than a number passed in beside it. That distinction is the whole
 * fix: the recipient title is clamp(21px, 3.2vw, 27px), so a caret told it
 * was 20px was drawn a third too small at most window widths, and no amount
 * of tuning the number would have held across the clamp.
 *
 * It sits on the baseline rather than centred in the line box. Centring is
 * what made it look high: a line box carries descender space the letters do
 * not use, so its middle sits below the middle of the visible text. An empty
 * inline-block aligns its bottom edge to the baseline, which is exactly where
 * a block cursor belongs.
 */
export function Caret() {
  return <span className="fret-caret" aria-hidden="true" />
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
  pressed,
  lamp,
  className = '',
  ...rest
}: {
  children: ReactNode
  variant?: 'primary' | 'alt'
  inert?: boolean
  /** Held down for as long as whatever it opened stays open. */
  pressed?: boolean
  /** Colour of the state lamp carried on the key itself, if any. */
  lamp?: { color: string; pulse?: boolean; bloom?: boolean }
  className?: string
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const classes = [
    'fret-key',
    variant === 'alt' && 'fret-key--alt',
    inert && 'fret-key--inert',
    pressed && 'fret-key--pressed',
    className,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button type="button" className={classes} disabled={inert || rest.disabled} {...rest}>
      {lamp && <Lamp color={lamp.color} size={7} pulse={lamp.pulse} bloom={lamp.bloom} />}
      <span className="fret-key__label">{children}</span>
    </button>
  )
}

/**
 * The link a transfer will be reachable at, shown on the status strip.
 *
 * The host is there from the moment the screen is, so nothing appears out of
 * nowhere: when an upload starts, only the slug is typed onto the end of an
 * address that was already sitting there. A later rename flashes rather than
 * retyping — retyping would read as a second link being minted, when what
 * happened is that one link changed its name.
 */
export function LinkReadout({
  host,
  slug,
  onOpen,
}: {
  host: string
  slug: string
  /** Makes the readout the way to preview, once there is something to open. */
  onOpen?: () => void
}) {
  const [typed, setTyped] = useState(slug)
  const [flash, setFlash] = useState(false)
  const previous = useRef(slug)

  useEffect(() => {
    const before = previous.current
    previous.current = slug
    if (slug === before) return

    if (slug === '') {
      setTyped('')
      return
    }

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    // Only the first appearance is typed; a rename is a change of name, not
    // an arrival.
    if (before !== '' || reduced) {
      setTyped(slug)
      setFlash(true)
      const done = window.setTimeout(() => setFlash(false), 620)
      return () => window.clearTimeout(done)
    }

    let shown = 0
    setTyped('')
    const tick = window.setInterval(() => {
      shown += 1
      setTyped(slug.slice(0, shown))
      if (shown >= slug.length) window.clearInterval(tick)
    }, 26)
    return () => window.clearInterval(tick)
  }, [slug])

  const body = (
    <>
      <span className="fret-link__host">{host}</span>
      {typed !== '' && (
        <span className={`fret-link__slug${flash ? ' fret-link__slug--flash' : ''}`}>
          /{typed}
        </span>
      )}
    </>
  )

  // The device carries three keys and no more, so previewing lives on the link
  // itself: the address is already on screen, and a link is a thing you click.
  if (onOpen && slug !== '' && typed === slug) {
    return (
      <button type="button" className="fret-link fret-link--open" onClick={onOpen}>
        {body}
      </button>
    )
  }
  return <span className="fret-link">{body}</span>
}
