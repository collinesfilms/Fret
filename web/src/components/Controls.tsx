/** Flat controls: fields, the segmented control, and the settings row layout. */

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'

export function SettingsRow({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <div className="fret-row">
      <span className="fret-row__label">{label}</span>
      <div className="fret-row__control">{children}</div>
    </div>
  )
}

/**
 * Attributes that keep a transfer's password out of the operating system's
 * keychain.
 *
 * It is not a credential. Nobody signs in with it — it is a secret you set on
 * a link and then send to somebody, and it lives on the transfer rather than
 * on the account. But it is masked, and `type="password"` is the only honest
 * way to mask a field, so every password manager on the machine assumes it is
 * a login and offers to fill the account password instead. On a phone that
 * assumption is worse than wrong: iOS puts the whole keychain sheet over the
 * keyboard, and both of these fields sit directly under a text input, which
 * is precisely the shape Safari reads as username-then-password.
 *
 * `autocomplete="off"` is specified to be ignored on password fields, so it
 * buys nothing. `new-password` is the documented way to say this one is not
 * an existing credential; the rest are what the common managers watch for.
 * The name matters too — anything containing "password" is a heuristic all of
 * them match on.
 */
export const notACredential = {
  autoComplete: 'new-password',
  name: 'fret-transfer-secret',
  'data-1p-ignore': '',
  'data-lpignore': 'true',
  'data-bwignore': 'true',
  'data-form-type': 'other',
} as const

export function Field({
  error,
  ...rest
}: {
  error?: string
  ref?: React.Ref<HTMLInputElement>
} & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <>
      <input
        className={`fret-field${error ? ' fret-field--error' : ''}`}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        aria-invalid={error ? true : undefined}
        {...rest}
      />
      {error && <div className="fret-field__error">{error}</div>}
    </>
  )
}

export interface Segment<T extends string> {
  value: T
  label: string
}

/**
 * A recessed track with one handle in it.
 *
 * The selection is a single element that travels, not a background that
 * cross-fades from one cell to the next. Every segment is flex:1 from a zero
 * basis, so they are exactly equal in width whatever their labels say — which
 * is what lets the handle be positioned arithmetically rather than measured.
 */
export function Segmented<T extends string>({
  segments,
  value,
  onChange,
  label,
  committed,
}: {
  segments: Segment<T>[]
  value: T
  onChange: (value: T) => void
  label?: string
  /**
   * Set briefly once the server has taken the change. The selection moving is
   * the interface agreeing; this is the server agreeing, and with nothing to
   * press they are not otherwise the same event.
   */
  committed?: boolean
}) {
  const index = segments.findIndex((segment) => segment.value === value)

  return (
    <div
      className={`fret-segmented${committed ? ' fret-segmented--committed' : ''}`}
      role="radiogroup"
      aria-label={label}
    >
      {/* No handle at all for a value that is not one of the segments, rather
          than one parked off the end of the track. */}
      {index >= 0 && (
        <span
          className="fret-segmented__knob"
          aria-hidden="true"
          style={{
            width: `${100 / segments.length}%`,
            transform: `translateX(${index * 100}%)`,
          }}
        />
      )}
      {segments.map((segment) => (
        <button
          key={segment.value}
          type="button"
          role="radio"
          aria-checked={segment.value === value}
          className={`fret-segmented__item${
            segment.value === value ? ' fret-segmented__item--on' : ''
          }`}
          onClick={() => onChange(segment.value)}
        >
          {segment.label}
        </button>
      ))}
    </div>
  )
}

/**
 * The wrapper that lets the device grow into its settings.
 *
 * The obvious way to write this is to interpolate grid-template-rows between
 * 0fr and 1fr, which needs no JavaScript — but that interpolation only works
 * in Chrome 117+ and Safari 17.4+, and it cannot be feature-detected: the
 * declaration parses everywhere, it simply refuses to animate on older
 * engines, so @supports reports it as available and the device snaps open.
 *
 * Measuring the content and animating an explicit height works in every
 * browser, eases correctly, and costs one observer. The observer is what makes
 * it safe: the content changes height on its own — a slug error appears, the
 * file list grows — and a stale measurement would clip it.
 */
export function Grow({
  open,
  className = '',
  children,
}: {
  open: boolean
  className?: string
  children: ReactNode
}) {
  const inner = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(0)

  useLayoutEffect(() => {
    const element = inner.current
    if (!element) return
    const measure = () => setHeight(element.scrollHeight)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return (
    <div
      className={`fret-grow${open ? ' fret-grow--open' : ''}${className ? ` ${className}` : ''}`}
      style={{ height: open ? height : 0 }}
      // Keeps the collapsed settings out of the tab order rather than leaving
      // invisible fields focusable behind the closed panel.
      inert={!open}
      aria-hidden={!open}
    >
      <div className="fret-grow__inner" ref={inner}>
        {children}
      </div>
    </div>
  )
}

/**
 * A field that reports its own state.
 *
 * With no save button, a field has to say for itself that a change took. It
 * shows a tick and a green border for a moment after committing, an error
 * beneath when the server refuses, and — where one applies — an action beside
 * it that does the thing you would otherwise have to know: that emptying the
 * password box is what removes the protection, or that a link you did not
 * choose can be drawn again.
 */
export function LiveField({
  committed,
  action,
  error,
  below,
  ...rest
}: {
  /** Set briefly after a successful commit. */
  committed?: boolean
  /**
   * A button beside the field, at the field's own height. It stays in place
   * when it has nothing to do, greyed rather than absent: a control that
   * appears and disappears teaches nothing, and the row would reflow every
   * time the value emptied.
   */
  action?: { label: string; onClick: () => void; disabled?: boolean; title?: string }
  error?: string
  /** Anything that belongs directly beneath the field, e.g. a consequence. */
  below?: ReactNode
  ref?: React.Ref<HTMLInputElement>
} & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <>
      <span className="fret-field__wrap">
        <span className="fret-field__box">
          <input
            className={`fret-field${error ? ' fret-field--error' : ''}${
              committed ? ' fret-field--committed' : ''
            }`}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            aria-invalid={error ? true : undefined}
            {...rest}
          />
          <span
            className={`fret-field__tick${committed ? ' fret-field__tick--on' : ''}`}
            aria-hidden="true"
          />
        </span>
        {action && (
          <button
            type="button"
            className="fret-field__action"
            onClick={action.onClick}
            // Keeps the field from blurring under the press. Without this the
            // blur lands first and commits whatever is half-typed, and the
            // button can change identity between the press and the release —
            // Shuffle becoming Reset because the commit it just caused made
            // the name a custom one. Suppressing the focus change costs
            // nothing: the button is still reachable by Tab.
            onMouseDown={(event) => event.preventDefault()}
            disabled={action.disabled}
            title={action.title}
          >
            {action.label}
          </button>
        )}
      </span>
      {error && <div className="fret-field__error">{error}</div>}
      {below}
    </>
  )
}

/**
 * A consequence shown at the moment it applies.
 *
 * It occupies no space until it does, so a field that has nothing to warn
 * about is not laid out around a warning that never appears.
 */
export function Consequence({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div className={`fret-warn${open ? ' fret-warn--on' : ''}`} aria-hidden={!open}>
      <div className="fret-warn__inner">
        <div className="fret-warn__text">
          <span className="fret-warn__dot" />
          {children}
        </div>
      </div>
    </div>
  )
}

/**
 * The options drawer, pulled out of the base of the device.
 *
 * Rendered as a sibling of the panel rather than inside it, so it can travel
 * out from behind: a negative z-index child paints above its own parent's
 * background and would slide over the device instead of from under it.
 *
 * It reports its own height, because the deck above has to make room for it:
 * the drawer is positioned out of flow, so without that the panel stays put
 * and the whole object drifts off-centre as the drawer extends below it.
 */
export function Tray({
  open,
  label,
  onHeight,
  children,
}: {
  open: boolean
  /** Engraved along the drawer's bottom edge, the way a case is marked. */
  label?: string
  onHeight?: (height: number) => void
  children: ReactNode
}) {
  const inner = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const element = inner.current
    if (!element || !onHeight) return
    const measure = () => onHeight(element.offsetHeight)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [onHeight])

  return (
    <div className={`fret-tray${open ? ' fret-tray--open' : ''}`} inert={!open} aria-hidden={!open}>
      <div className="fret-tray__inner" ref={inner}>
        <div className="fret-tray__pull" aria-hidden="true" />
        {children}
        {label && (
          <div className="fret-tray__mark" aria-hidden="true">
            {label}
          </div>
        )}
      </div>
    </div>
  )
}
