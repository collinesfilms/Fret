/**
 * The transfers sheet: in from the left on desktop, up from the bottom on
 * mobile, where a grab handle replaces the close button.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type TransferFile, type TransferSummary } from '../lib/api'
import { countdown, formatBytes } from '../lib/format'
import { counted, translate, type Locale, type StringKey } from '../lib/i18n'
import { Grow, Segmented, useGrabToDismiss } from './Controls'
import { FileList, Morph } from './Device'

type Filter = 'all' | 'expiring' | 'locked'

/**
 * How long a deleted row stays on screen after it has left the list.
 *
 * Must outlast the collapse in the stylesheet; a little over is harmless,
 * under would cut the row off mid-fall.
 */
const DEPART_MS = 340

/** How long a row action holds its confirmation before reverting. */
const CONFIRM_MS = 1600

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
  const { grabHandlers, grabStyle } = useGrabToDismiss(open, onClose)
  const t = (key: StringKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars)

  // Reopening should feel fresh rather than resuming a stale search.
  useEffect(() => {
    if (!open) setOpenRow(null)
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
      /*
       * Matched against both the name and the link, because the row now shows
       * one and is reached by the other. Searching only the slug would mean
       * typing the exact thing on screen and being told there are no results.
       */
      if (
        needle &&
        !transfer.slug.toLowerCase().includes(needle) &&
        !transfer.firstFile.toLowerCase().includes(needle)
      ) {
        return false
      }
      if (filter === 'locked') return transfer.hasPassword
      if (filter === 'expiring') return countdown(locale, transfer.expiresAt, now).soon
      return true
    })
  }, [transfers, query, filter, now, locale])

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
    () => transfers.filter((transfer) => countdown(locale, transfer.expiresAt, now).soon).length,
    [transfers, now, locale],
  )

  const filtered = query.trim() !== '' || filter !== 'all'

  return (
    <>
      <div
        className={`fret-scrim${open ? ' fret-scrim--on' : ''}`}
        onClick={onClose}
        aria-hidden="true"
      />
      {/* The gesture is on the whole surface, not on the bar: a thumb pushing
          a sheet back down does not aim at anything. */}
      <aside
        className={`fret-sheet${open ? ' fret-sheet--open' : ''}`}
        style={grabStyle}
        {...grabHandlers}
        aria-hidden={!open}
        aria-label={t('sheet.title')}
      >
        <button
          type="button"
          className="fret-sheet__grab"
          tabIndex={open ? 0 : -1}
          aria-label={t('action.close')}
          onClick={onClose}
        />

        <div className="fret-sheet__body">
          <div className="fret-sheet__head">
            <div>
              <div className="fret-sheet__title">{t('sheet.title')}</div>
              <div className="fret-sheet__subtitle">
                {t('sheet.subtitle', {
                  links: counted(locale, transfers.length, 'link.count', 'link.countPlural'),
                  size: formatBytes(locale, storageUsed),
                })}
              </div>
            </div>
            <button
              type="button"
              className="fret-close"
              onClick={onClose}
              aria-label={t('action.close')}
              tabIndex={open ? 0 : -1}
            >
              ×
            </button>
          </div>

          <input
            className="fret-field fret-sheet__search"
            placeholder={t('sheet.search')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
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
            <Stat value={formatBytes(locale, storageUsed)} label={t('sheet.statStorage')} />
            <Stat value={String(expiringCount)} label={t('sheet.statExpiring')} />
          </div>

          <div className="fret-listhead">
            {filtered
              ? counted(locale, visible.length, 'sheet.result', 'sheet.results')
              : t('sheet.newestFirst', {
                  links: counted(locale, transfers.length, 'link.count', 'link.countPlural'),
                })}
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
  const expiry = countdown(locale, transfer.expiresAt)
  const tab = leaving ? -1 : interactive ? 0 : -1

  /*
   * The contents, fetched the first time the row is opened and kept.
   *
   * The list endpoint deliberately carries one file name per transfer and not
   * the rest: a hundred rows of a hundred files each would be a megabyte of
   * JSON to render five lines of summary. Almost nobody opens a row, so the
   * cost belongs to the person who does.
   */
  const [files, setFiles] = useState<TransferFile[] | null>(null)

  useEffect(() => {
    if (!open || files !== null) return
    let cancelled = false
    api
      .getTransfer(transfer.id)
      .then((full) => {
        if (!cancelled) setFiles(full.files ?? [])
      })
      .catch(() => {
        // Nothing to say: the row's own summary already states the count, and
        // an error banner inside a row would be louder than the failure.
        if (!cancelled) setFiles([])
      })
    return () => {
      cancelled = true
    }
  }, [open, files, transfer.id])

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

        {/*
          Titled by what is in it, not by how it is reached.
          
          A slug is a random string by default, so a list of them is a list of
          things you cannot tell apart — you would have to open each one to
          find the transfer you meant. The first filename is the thing you
          actually remember sending. The link is still here, on the line
          below, because it is what you came to copy.
        */}
        <span className="fret-row__text">
          <span className="fret-row__title">
            {transfer.firstFile || transfer.slug}
            {transfer.fileCount > 1 && (
              <span className="fret-row__plus">
                {t('sheet.andMore', { count: transfer.fileCount - 1 })}
              </span>
            )}
          </span>
          {/*
            No count when nothing has been downloaded. It used to say so, and
            with the link now sharing this line it pushed every row into
            "NO DOWNL…" — the least useful thing on the line, truncated, on
            every row at once. A count that appears when there is one to show
            says the same thing by being absent, and says it without spending
            a third of the line to do it.
          */}
          <span className="fret-row__meta">
            <span className="fret-row__slug">{transfer.slug}</span>
            {' · '}
            {formatBytes(locale, transfer.totalBytes)}
            {transfer.downloads > 0 &&
              ` · ${counted(locale, transfer.downloads, 'sheet.download', 'sheet.downloads')}`}
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
        Opening a row answers the question the list cannot: what is actually
        in this. The names sit above the actions because that is the order you
        want them in — you look to check you have the right transfer, then you
        act on it.

        The height is measured rather than capped at a guess. The old
        max-height worked while the drawer held one fixed row of buttons; a
        list of unknown length inside it would either be clipped or ease
        against a ceiling it never reaches.
      */}
      <Grow open={open} className="fret-rowdrawer">
        {files === null ? (
          <div className="fret-rowfiles__waiting">{t('sheet.loadingFiles')}</div>
        ) : (
          <FileList files={files} locale={locale} plain cap={168} />
        )}
        <div className="fret-rowactions__strip">
          <Action
            label={t('action.copy')}
            confirm={t('action.copied')}
            onClick={onCopy}
            tabIndex={open ? tab : -1}
          />
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
      </Grow>
      </div>
    </div>
  )
}

function Action({
  label,
  confirm,
  onClick,
  danger,
  engaged,
  tabIndex,
}: {
  label: string
  /**
   * Shown briefly in place of the label after a press, for an action that
   * leaves nothing on screen to prove it happened. Copy is the whole reason
   * this exists: the clipboard is invisible, so without a word here the only
   * way to know the press registered is to go and paste it somewhere.
   */
  confirm?: string
  onClick: () => void
  danger?: boolean
  /** True while the surface this opens is still open. */
  engaged?: boolean
  tabIndex?: number
}) {
  const [confirmed, setConfirmed] = useState(false)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const press = () => {
    onClick()
    if (!confirm) return
    setConfirmed(true)
    // Cleared by its own timer rather than an effect cleanup, which would
    // cancel it on the very re-render the state change causes.
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setConfirmed(false), CONFIRM_MS)
  }

  const classes = [
    'fret-rowaction',
    danger && 'fret-rowaction--danger',
    engaged && 'fret-rowaction--engaged',
    confirmed && 'fret-rowaction--confirmed',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button
      type="button"
      className={classes}
      onClick={press}
      aria-expanded={engaged === undefined ? undefined : engaged}
      tabIndex={tabIndex}
    >
      <Morph>{confirmed && confirm ? confirm : label}</Morph>
    </button>
  )
}
