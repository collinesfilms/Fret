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

interface SheetProps {
  open: boolean
  locale: Locale
  transfers: TransferSummary[]
  storageUsed: number
  publicHost: string
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
              {visible.map((transfer) => (
                <Row
                  key={transfer.id}
                  transfer={transfer}
                  locale={locale}
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
  open,
  interactive,
  onToggle,
  onCopy,
  onEdit,
  onOpen,
  onDelete,
}: {
  transfer: TransferSummary
  locale: Locale
  open: boolean
  interactive: boolean
  onToggle: () => void
  onCopy: () => void
  onEdit: () => void
  onOpen: () => void
  onDelete: () => void
}) {
  const t = (key: StringKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars)
  const expiry = countdown(transfer.expiresAt)
  const tab = interactive ? 0 : -1

  return (
    <div className="fret-list__row">
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
          <Action label={t('action.edit')} onClick={onEdit} tabIndex={open ? tab : -1} />
          <Action label={t('action.open')} onClick={onOpen} tabIndex={open ? tab : -1} />
          <Action label={t('action.delete')} onClick={onDelete} danger tabIndex={open ? tab : -1} />
        </div>
      </div>
    </div>
  )
}

function Action({
  label,
  onClick,
  danger,
  tabIndex,
}: {
  label: string
  onClick: () => void
  danger?: boolean
  tabIndex?: number
}) {
  return (
    <button
      type="button"
      className={`fret-rowaction${danger ? ' fret-rowaction--danger' : ''}`}
      onClick={onClick}
      tabIndex={tabIndex}
    >
      {label}
    </button>
  )
}
