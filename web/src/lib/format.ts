/**
 * Formatting for every machine-generated value in the interface.
 *
 * The typographic rule the design rests on: if a value is countable or
 * machine-generated it is set in mono, and it comes from this file. If a human
 * wrote it, it does not.
 *
 * Machine-generated is not the same as language-free. `expires in 3d` is built
 * here and it is still a sentence, and `1.25 GB` is a convention rather than a
 * fact — French counts octets and puts a comma where English puts a point. So
 * everything here takes a locale and gets its words from the catalog; the
 * arithmetic is the part that belongs to this file, not the wording.
 */

import { translate, type Locale, type StringKey } from './i18n'

/** Renders a number with the locale's decimal separator. */
function decimal(locale: Locale, value: number, digits: number): string {
  const fixed = value.toFixed(digits)
  const separator = translate(locale, 'bytes.decimal')
  return separator === '.' ? fixed : fixed.replace('.', separator)
}

/** Formats a byte count the way a file manager does. */
export function formatBytes(locale: Locale, bytes: number): string {
  const unit = (key: StringKey) => translate(locale, key)
  if (bytes >= 1_073_741_824) return `${decimal(locale, bytes / 1_073_741_824, 2)} ${unit('bytes.gb')}`
  if (bytes >= 1_048_576) return `${decimal(locale, bytes / 1_048_576, 1)} ${unit('bytes.mb')}`
  if (bytes >= 1024) return `${decimal(locale, bytes / 1024, 0)} ${unit('bytes.kb')}`
  return `${bytes} ${unit('bytes.b')}`
}

/**
 * Splits a byte count into figure and unit, for the large screen readout.
 *
 * The unit is lowercased: the readout draws it small beside the figure rather
 * than as the abbreviation a sentence would use.
 */
export function splitBytes(locale: Locale, bytes: number): [string, string] {
  const unit = (key: StringKey) => translate(locale, key).toLowerCase()
  if (bytes >= 1_073_741_824) return [decimal(locale, bytes / 1_073_741_824, 2), unit('bytes.gb')]
  if (bytes >= 1_048_576) return [decimal(locale, bytes / 1_048_576, 1), unit('bytes.mb')]
  return [decimal(locale, bytes / 1024, 0), unit('bytes.kb')]
}

/** Pads a count to two digits, as the active-transfers pill shows it. */
export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

export interface Countdown {
  /** Short form for the sheet's rows, e.g. "expires in 21h". */
  label: string
  /** True within a day of expiry, which is what turns the label red. */
  soon: boolean
  expired: boolean
}

/**
 * Describes how long a transfer has left. A transfer with no expiry never
 * becomes urgent, so it is never marked soon.
 */
export function countdown(locale: Locale, expiresAt: number | null, now = Date.now()): Countdown {
  const t = (key: StringKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars)

  if (expiresAt == null) return { label: t('expiry.none'), soon: false, expired: false }

  const seconds = expiresAt - Math.floor(now / 1000)
  if (seconds <= 0) return { label: t('expiry.expired'), soon: true, expired: true }

  const hours = seconds / 3600
  if (hours < 1) {
    const minutes = Math.max(1, Math.round(seconds / 60))
    return { label: t('expiry.minutes', { n: minutes }), soon: true, expired: false }
  }
  if (hours < 24) {
    return { label: t('expiry.hours', { n: Math.round(hours) }), soon: true, expired: false }
  }
  const days = Math.round(hours / 24)
  return { label: t('expiry.days', { n: days }), soon: false, expired: false }
}

/** Renders the "N s remaining" readout during an upload. */
export function remaining(locale: Locale, seconds: number | null): string {
  const t = (key: StringKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars)

  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return t('upload.estimating')
  if (seconds < 60) return t('upload.secondsLeft', { s: Math.ceil(seconds) })
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return t('upload.minutesLeft', { m: minutes })
  const hours = Math.floor(minutes / 60)
  return t('upload.hoursLeft', { h: hours, m: minutes % 60 })
}

/** Renders a transfer rate for the upload readout. */
export function rate(locale: Locale, bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return ''
  return `${formatBytes(locale, bytesPerSecond)}/s`
}

/**
 * Filters slug input as it is typed, matching the server's own rule so a
 * value that looks accepted in the field is accepted on save.
 */
export function filterSlug(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9_-]/g, '')
}
