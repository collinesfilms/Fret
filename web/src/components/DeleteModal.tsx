/**
 * The confirmation for deleting a transfer.
 *
 * Its own surface rather than the edit modal with its delete already armed.
 * Arriving on a form you did not ask for, with one control mid-gesture, made
 * you read the whole thing to work out what you had pressed — and it put the
 * question in the corner of a dialog whose title said "Edit transfer". A
 * destructive act deserves to be the only thing on screen and to name what it
 * is about to destroy.
 */

import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import type { TransferSummary } from '../lib/api'
import { formatBytes, plural } from '../lib/format'
import { translate, type Locale, type StringKey } from '../lib/i18n'
import { Key } from './Device'

export function DeleteModal({
  transfer,
  locale,
  onClose,
  onDeleted,
}: {
  transfer: TransferSummary
  locale: Locale
  onClose: () => void
  onDeleted: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const t = (key: StringKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const remove = async () => {
    if (busy) return
    setBusy(true)
    try {
      await api.deleteTransfer(transfer.id)
      onDeleted()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('error.generic'))
      setBusy(false)
    }
  }

  return (
    <>
      <div className="fret-scrim fret-scrim--on fret-scrim--strong" onClick={onClose} />
      <div
        className="fret-modal fret-modal--ask"
        role="alertdialog"
        aria-modal="true"
        aria-label={t('delete.title')}
      >
        <div className="fret-modal__body">
          <div className="fret-ask__title">{t('delete.title')}</div>

          {/*
            Named, not described. "This transfer" could be any of them; the
            filename and the link are how you know it is the one you meant.
          */}
          <div className="fret-ask__subject">
            <span className="fret-ask__name">{transfer.firstFile || transfer.slug}</span>
            <span className="fret-ask__meta">
              {transfer.slug} · {plural(transfer.fileCount, 'file', 'files')} ·{' '}
              {formatBytes(transfer.totalBytes)}
            </span>
          </div>

          <div className="fret-ask__note">{t('delete.note')}</div>

          {error && <div className="fret-field__error">{error}</div>}
        </div>

        <div className="fret-modal__foot">
          <Key onClick={onClose} className="fret-ask__keep">
            {t('delete.keep')}
          </Key>
          <button
            type="button"
            className="fret-delete fret-delete--armed"
            onClick={remove}
            disabled={busy}
          >
            {t('delete.confirm')}
          </button>
        </div>
      </div>
    </>
  )
}
