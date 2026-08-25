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

export function Segmented<T extends string>({
  segments,
  value,
  onChange,
  label,
}: {
  segments: Segment<T>[]
  value: T
  onChange: (value: T) => void
  label?: string
}) {
  return (
    <div className="fret-segmented" role="radiogroup" aria-label={label}>
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
export function Grow({ open, children }: { open: boolean; children: ReactNode }) {
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
      className={`fret-grow${open ? ' fret-grow--open' : ''}`}
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
