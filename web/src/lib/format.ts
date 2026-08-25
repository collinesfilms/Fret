/**
 * Formatting for every machine-generated value in the interface.
 *
 * The typographic rule the design rests on: if a value is countable or
 * machine-generated it is set in mono, and it comes from this file. If a human
 * wrote it, it does not.
 */

/** Formats a byte count the way a file manager does. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(2)} GB`
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

/** Splits a byte count into figure and unit, for the large screen readout. */
export function splitBytes(bytes: number): [string, string] {
  if (bytes >= 1_073_741_824) return [(bytes / 1_073_741_824).toFixed(2), 'gb']
  if (bytes >= 1_048_576) return [(bytes / 1_048_576).toFixed(1), 'mb']
  return [(bytes / 1024).toFixed(0), 'kb']
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
export function countdown(expiresAt: number | null, now = Date.now()): Countdown {
  if (expiresAt == null) return { label: 'no expiry', soon: false, expired: false }

  const seconds = expiresAt - Math.floor(now / 1000)
  if (seconds <= 0) return { label: 'expired', soon: true, expired: true }

  const hours = seconds / 3600
  if (hours < 1) {
    const minutes = Math.max(1, Math.round(seconds / 60))
    return { label: `expires in ${minutes}m`, soon: true, expired: false }
  }
  if (hours < 24) {
    return { label: `expires in ${Math.round(hours)}h`, soon: true, expired: false }
  }
  const days = Math.round(hours / 24)
  return { label: `expires in ${days}d`, soon: false, expired: false }
}

/** Renders the "N s remaining" readout during an upload. */
export function remaining(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return 'estimating'
  if (seconds < 60) return `${Math.ceil(seconds)} s remaining`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min remaining`
  const hours = Math.floor(minutes / 60)
  return `${hours} h ${minutes % 60} min remaining`
}

/** Renders a transfer rate for the upload readout. */
export function rate(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return ''
  return `${formatBytes(bytesPerSecond)}/s`
}

/** Pluralises a count with its noun, e.g. "1 file" / "4 files". */
export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

/**
 * Filters slug input as it is typed, matching the server's own rule so a
 * value that looks accepted in the field is accepted on save.
 */
export function filterSlug(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9_-]/g, '')
}
