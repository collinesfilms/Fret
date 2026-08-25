/**
 * The transfers sheet: in from the left on desktop, up from the bottom on
 * mobile, where a grab handle replaces the close button.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { TransferSummary } from '../lib/api'
import { countdown, formatBytes, plural } from '../lib/format'
import { translate, type Locale, type StringKey } from '../lib/i18n'
import { Segmented } from './Controls'

type Filter = 'all' | 'expiring' | 'locked'

/** Past this many pixels of downward drag, the mobile sheet dismisses. */
const DISMISS_AFTER = 70

/**
 * How long a deleted row stays on screen after it has left the list.
 *
 * Must outlast the collapse in the stylesheet; a little over is harmless,
 * under would cut the row off mid-fall.
 */
const DEPART_MS = 340

/** Which row action is currently held open, so its cell can read as pressed. */
export interface EngagedAction {
  id: string
  action: 'edit' | 'delete'
}

interface SheetProps {
  open: boolean
  locale: Locale
  transfers: TransferSummary[]
  storageUsed: number
  publicHost: string
  engaged: EngagedAction | null
  onClose: () => void
  onCopy: (slug: string) => void
  onEdit: (transfer: TransferSummary) => void
  onOpen: (slug: string) => void
  onDelete: (transfer: TransferSummary) => void
}

export function TransfersSheet({
  open,
  locale,
  transfers,
  storageUsed,
  engaged,
  onClose,
  onCopy,
  onEdit,
  onOpen,
  onDelete,
}: SheetProps) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [openRow, setOpenRow] = useState<string | null>(null)
  const [grabY, setGrabY] = useState(0)
  const dragging = useRef(false)
  const dragStart = useRef(0)
  const t = (key: StringKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars)

  // Reopening should feel fresh rather than resuming a stale search.
  useEffect(() => {
    if (!open) {
      setOpenRow(null)
      setGrabY(0)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const now = Date.now()
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return transfers.filter((transfer) => {
      if (needle && !transfer.slug.toLowerCase().includes(needle)) return false
      if (filter === 'locked') return transfer.hasPassword
      if (filter === 'expiring') return countdown(transfer.expiresAt, now).soon
      return true
    })
  }, [transfers, query, filter, now])

  /*
   * Rows that have left the list but not yet the screen.
   *
   * A deleted transfer is gone from the server before the list reloads, so by
   * the time this renders again there is nothing left to animate: the row
   * simply ceases to exist and everything below it jumps up. Holding on to it
   * for the length of its collapse is the only way to show it going, and the
   * position is held with it — a row that fell out of the middle of the list
   * must fall from the middle, not from the end.
   *
   * Only a row that left the *data* falls. Searching and filtering remove
   * rows too, and those are the list answering a question rather than losing
   * anything; making them collapse one by one would be a lie about what
   * happened, and a slow one.
   */
  const [departing, setDeparting] = useState<{ transfer: TransferSummary; index: number }[]>([])
  const lastVisible = useRef(visible)
  const lastIds = useRef(new Set(transfers.map((transfer) => transfer.id)))
  const departTimers = useRef<number[]>([])

  useEffect(() => () => departTimers.current.forEach(window.clearTimeout), [])

  /*
   * Deliberately not keyed on `visible`: the countdown is recomputed against
   * the clock on every render, so that array is a new object every time and
   * an effect watching it would run on every render — cancelling its own
   * removal timer before it ever fired, and leaving the collapsed row on
   * screen for good. These three are what actually change who is in the list.
   */
  useEffect(() => {
    const present = new Set(transfers.map((transfer) => transfer.id))
    const deleted = new Set([...lastIds.current].filter((id) => !present.has(id)))
    const before = lastVisible.current
    lastVisible.current = visible
    lastIds.current = present
    if (deleted.size === 0) return

    const gone = before
      .map((transfer, index) => ({ transfer, index }))
      .filter((row) => deleted.has(row.transfer.id))
    if (gone.length === 0) return

    setDeparting((current) => [...current, ...gone])
    const goneIds = new Set(gone.map((row) => row.transfer.id))
    departTimers.current.push(
      window.setTimeout(
        () => setDeparting((current) => current.filter((row) => !goneIds.has(row.transfer.id))),
        DEPART_MS,
      ),
    )
    // No cleanup: this timer belongs to the rows it was scheduled for, not to
    // the render that happened to schedule it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transfers, query, filter])

  const rows = useMemo(() => {
    const out = visible.map((transfer) => ({ transfer, leaving: false }))
    for (const row of departing) {
      out.splice(Math.min(row.index, out.length), 0, { transfer: row.transfer, leaving: true })
    }
    return out
  }, [visible, departing])

  const expiringCount = useMemo(
    () => transfers.filter((transfer) => countdown(transfer.expiresAt, now).soon).length,
    [transfers, now],
  )

  const filtered = query.trim() !== '' || filter !== 'all'

  const onGrabDown = (event: React.PointerEvent) => {
    dragging.current = true
    dragStart.current = event.clientY
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onGrabMove = (event: React.PointerEvent) => {
    if (!dragging.current) return
    const delta = Math.max(0, event.clientY - dragStart.current)
    if (delta > 2) setGrabY(delta)
  }
  const onGrabUp = () => {
    if (!dragging.current) return
    dragging.current = false
    const far = grabY > DISMISS_AFTER
    setGrabY(0)
    // A tap on the handle closes too, which is what a thumb expects.
    if (far || grabY === 0) onClose()
  }

  return (
    <>
      <div
        className={`fret-scrim${open ? ' fret-scrim--on' : ''}`}
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        className={`fret-sheet${open ? ' fret-sheet--open' : ''}`}
        style={
          grabY > 0
            ? { transform: `translateY(${grabY}px)`, transition: 'none' }
            : undefined
        }
        aria-hidden={!open}
        aria-label={t('sheet.title')}
      >
        <div
          className="fret-sheet__grab"
          onPointerDown={onGrabDown}
          onPointerMove={onGrabMove}
          onPointerUp={onGrabUp}
          onPointerCancel={onGrabUp}
          role="button"
          tabIndex={open ? 0 : -1}
          aria-label={t('sheet.title')}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') onClose()
          }}
        />

        <div className="fret-sheet__body">
          <div className="fret-sheet__head">
            <div>
              <div className="fret-sheet__title">{t('sheet.title')}</div>
              <div className="fret-sheet__subtitle">
                {t('sheet.subtitle', {
                  links: plural(transfers.length, 'link', 'links'),
                  size: formatBytes(storageUsed),
                })}
              </div>
            </div>
            <button
              type="button"
              className="fret-close"
              onClick={onClose}
              aria-label="Close"
              tabIndex={open ? 0 : -1}
            >
              ×
            </button>
          </div>

          <input
            className="fret-field"
            placeholder={t('sheet.search')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ borderRadius: 11, fontSize: 9.5 }}
            tabIndex={open ? 0 : -1}
          />

          <Segmented<Filter>
            value={filter}
            onChange={setFilter}
            label={t('sheet.title')}
            segments={[
              { value: 'all', label: t('sheet.all') },
              { value: 'expiring', label: t('sheet.expiring') },
              { value: 'locked', label: t('sheet.password') },
            ]}
          />

          <div className="fret-stats">
            <Stat value={String(transfers.length)} label={t('sheet.statActive')} />
            <Stat value={formatBytes(storageUsed)} label={t('sheet.statStorage')} />
            <Stat value={String(expiringCount)} label={t('sheet.statExpiring')} />
          </div>

          <div className="fret-listhead">
            {filtered
              ? t('sheet.results', { count: visible.length })
              : t('sheet.newestFirst', { links: plural(transfers.length, 'link', 'links') })}
          </div>

          {visible.length === 0 ? (
            <div className="fret-empty">
              {transfers.length === 0 ? t('sheet.empty') : t('sheet.noResults')}
            </div>
          ) : (
            /*
             * One flat chronological list. The red countdown already carries
             * urgency, so an "expiring soon" section would only break the
             * history reading that makes the list scannable.
             */
            <div className="fret-list">
              {rows.map(({ transfer, leaving }) => (
                <Row
                  key={transfer.id}
                  transfer={transfer}
                  locale={locale}
                  leaving={leaving}
                  engaged={engaged?.id === transfer.id ? engaged.action : null}
                  open={openRow === transfer.id}
                  interactive={open}
                  onToggle={() => setOpenRow(openRow === transfer.id ? null : transfer.id)}
                  onCopy={() => onCopy(transfer.slug)}
                  onEdit={() => onEdit(transfer)}
                  onOpen={() => onOpen(transfer.slug)}
                  onDelete={() => onDelete(transfer)}
                />
              ))}
            </div>
          )}
        </div>
      </aside>
    </>
  )
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="fret-stat">
      <div className="fret-stat__value">{value}</div>
      <div className="fret-stat__label">{label}</div>
    </div>
  )
}

function Row({
  transfer,
  locale,
  engaged,
  open,
  interactive,
  onToggle,
  onCopy,
  onEdit,
  onOpen,
  onDelete,
  leaving,
}: {
  transfer: TransferSummary
  locale: Locale
  engaged: 'edit' | 'delete' | null
  open: boolean
  interactive: boolean
  /** Already gone from the list, still on screen long enough to leave it. */
  leaving?: boolean
  onToggle: () => void
  onCopy: () => void
  onEdit: () => void
  onOpen: () => void
  onDelete: () => void
}) {
  const t = (key: StringKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars)
  const expiry = countdown(transfer.expiresAt)
  const tab = leaving ? -1 : interactive ? 0 : -1

  return (
    <div
      className={`fret-list__row${leaving ? ' fret-list__row--leaving' : ''}`}
      inert={leaving || undefined}
    >
      {/* The shell collapses; everything the row actually is lives in here,
          so the two jobs do not fight over the same box. */}
      <div className="fret-list__rowInner">
      <button type="button" className="fret-row__main" onClick={onToggle} tabIndex={tab}>
        <span className="fret-tile">
          <span className="fret-tile__count">{transfer.fileCount}</span>
          <span className="fret-tile__unit">{t('sheet.files')}</span>
          {/* Neutral grey, never red: a password is a feature, not a problem. */}
          {transfer.hasPassword && (
            <span className="fret-tile__lock" aria-label={t('sheet.password')}>
              <span className="fret-lock" />
            </span>
          )}
        </span>

        <span className="fret-row__text">
          <span className="fret-row__slug">{transfer.slug}</span>
          <span className="fret-row__meta">
            {formatBytes(transfer.totalBytes)} ·{' '}
            {transfer.downloads === 0
              ? t('sheet.noDownloads')
              : t('sheet.downloads', { count: transfer.downloads })}
          </span>
        </span>

        <span className="fret-row__right">
          <span
            className={`fret-row__countdown${expiry.soon ? ' fret-row__countdown--soon' : ''}`}
          >
            {expiry.label}
          </span>
          <span className={`fret-chevron${open ? ' fret-chevron--open' : ''}`} aria-hidden="true">
            ›
          </span>
        </span>
      </button>

      {/*
        A drawer in the same material as the row rather than a card of tiles
        sitting on top of it: hairline-divided cells and mono labels, which is
        the vocabulary the rest of the sheet already speaks.
      */}
      <div className={`fret-rowactions${open ? ' fret-rowactions--open' : ''}`}>
        <div className="fret-rowactions__strip">
          <Action label={t('action.copy')} onClick={onCopy} tabIndex={open ? tab : -1} />
          <Action
            label={t('action.edit')}
            onClick={onEdit}
            engaged={engaged === 'edit'}
            tabIndex={open ? tab : -1}
          />
          <Action label={t('action.open')} onClick={onOpen} tabIndex={open ? tab : -1} />
          <Action
            label={t('action.delete')}
            onClick={onDelete}
            engaged={engaged === 'delete'}
            danger
            tabIndex={open ? tab : -1}
          />
        </div>
      </div>
      </div>
    </div>
  )
}

function Action({
  label,
  onClick,
  danger,
  engaged,
  tabIndex,
}: {
  label: string
  onClick: () => void
  danger?: boolean
  /** True while the surface this opens is still open. */
  engaged?: boolean
  tabIndex?: number
}) {
  const classes = [
    'fret-rowaction',
    danger && 'fret-rowaction--danger',
    engaged && 'fret-rowaction--engaged',
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <button
      type="button"
      className={classes}
      onClick={onClick}
      aria-expanded={engaged === undefined ? undefined : engaged}
      tabIndex={tabIndex}
    >
      {label}
    </button>
  )
}
