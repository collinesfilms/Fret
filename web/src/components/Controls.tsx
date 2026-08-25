/** Flat controls: fields, the segmented control, and the settings row layout. */

import type { ReactNode } from 'react'

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
 * Animating grid-template-rows between 0fr and 1fr is what allows the panel to
 * size itself to whatever it contains without a hard-coded height.
 */
export function Grow({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div className={`fret-grow${open ? ' fret-grow--open' : ''}`} aria-hidden={!open}>
      <div className="fret-grow__inner">{children}</div>
    </div>
  )
}
