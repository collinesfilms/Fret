/**
 * The edit modal.
 *
 * Editing deliberately never loads a transfer back into the upload device: the
 * upload UI is about something arriving, and an edit is not. It gets its own
 * surface, with the fields stacked rather than in the panel's label column.
 */

import { useEffect, useRef, useState } from 'react'
import { api, ApiError, type Expiry, type TransferSummary } from '../lib/api'
import { filterSlug, formatBytes, plural } from '../lib/format'
import { translate, type Locale, type StringKey } from '../lib/i18n'
import { Field, Segmented } from './Controls'
import { Key } from './Device'

interface EditModalProps {
  transfer: TransferSummary
  locale: Locale
  /** True while the transfers sheet is open beside it, on desktop. */
  besideSheet?: boolean
  onClose: () => void
  onSaved: () => void
  onDeleted: () => void
}

export function EditModal({
  transfer,
  locale,
  besideSheet,
  onClose,
  onSaved,
  onDeleted,
}: EditModalProps) {
  const [slug, setSlug] = useState(transfer.slug)
  // A stored password is never sent back, so the field starts empty and only
  // means something if the user types in it.
  const [password, setPassword] = useState('')
  const [passwordTouched, setPasswordTouched] = useState(false)
  const [expiry, setExpiry] = useState<Expiry>(transfer.expiry)
  const [error, setError] = useState<string | null>(null)
  const [slugError, setSlugError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const firstField = useRef<HTMLInputElement>(null)

  const t = (key: StringKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars)

  useEffect(() => {
    firstField.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const dirty =
    slug !== transfer.slug || expiry !== transfer.expiry || (passwordTouched && password !== '')

  const save = async () => {
    if (!dirty || saving) return
    setSaving(true)
    setError(null)
    setSlugError(null)
    try {
      await api.updateTransfer(transfer.id, {
        slug: slug !== transfer.slug ? slug : undefined,
        // Sending the field only when touched is what makes clearing it an
        // explicit act rather than a side effect of opening the modal.
        password: passwordTouched ? password : undefined,
        expiry: expiry !== transfer.expiry ? expiry : undefined,
      })
      onSaved()
      onClose()
    } catch (err) {
      if (err instanceof ApiError && err.code === 'slug_taken') {
        setSlugError(t('error.slugTaken'))
      } else if (err instanceof ApiError && err.code === 'slug_invalid') {
        setSlugError(t('error.slugInvalid'))
      } else {
        setError(err instanceof Error ? err.message : t('error.generic'))
      }
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!confirmDelete) {
      // Deleting a live link is not undoable, so it asks once.
      setConfirmDelete(true)
      return
    }
    setSaving(true)
    try {
      await api.deleteTransfer(transfer.id)
      onDeleted()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('error.generic'))
      setSaving(false)
    }
  }

  return (
    <>
      <div className="fret-scrim fret-scrim--on fret-scrim--strong" onClick={onClose} />
      <div
        className={`fret-modal${besideSheet ? ' fret-modal--beside-sheet' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={t('edit.title')}
      >
        <div className="fret-modal__head">
          <div>
            <div className="fret-modal__title">{t('edit.title')}</div>
            <div className="fret-modal__meta">
              {plural(transfer.fileCount, 'file', 'files')} · {formatBytes(transfer.totalBytes)} ·{' '}
              {transfer.downloads === 0
                ? t('sheet.noDownloads')
                : t('sheet.downloads', { count: transfer.downloads })}
            </div>
          </div>
          <button type="button" className="fret-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="fret-modal__body">
          <div className="fret-modal__field">
            <label htmlFor="edit-slug">{t('settings.link')}</label>
            <Field
              id="edit-slug"
              ref={firstField}
              value={slug}
              error={slugError ?? undefined}
              onChange={(e) => {
                setSlug(filterSlug(e.target.value))
                setSlugError(null)
              }}
            />
            {/*
              Renaming here has the same consequence as renaming on the device,
              so it carries the same offer — inline rather than as a tag, since
              a modal has no base to tuck one into.
            */}
            {transfer.sharedSlug !== '' && transfer.sharedSlug !== slug && (
              <div className="fret-modal__restore">
                <div className="fret-modal__restoreText">
                  <span className="fret-modal__restoreSlug">
                    {t('tag.sharedAs')} {transfer.sharedSlug}
                  </span>
                  <span className="fret-modal__restoreNote">{t('tag.note')}</span>
                </div>
                <button
                  type="button"
                  className="fret-modal__restoreButton"
                  onClick={() => {
                    setSlug(transfer.sharedSlug)
                    setSlugError(null)
                  }}
                >
                  {t('tag.restore')}
                </button>
              </div>
            )}
          </div>

          <div className="fret-modal__field">
            <label htmlFor="edit-password">{t('settings.password')}</label>
            <Field
              id="edit-password"
              type="password"
              value={password}
              placeholder={
                transfer.hasPassword ? t('settings.passwordKept') : t('settings.passwordNone')
              }
              onChange={(e) => {
                setPassword(e.target.value)
                setPasswordTouched(true)
              }}
            />
          </div>

          <div className="fret-modal__field">
            <label>{t('settings.expires')}</label>
            <Segmented<Expiry>
              value={expiry}
              onChange={setExpiry}
              label={t('settings.expires')}
              segments={[
                { value: '24h', label: '24h' },
                { value: '7d', label: '7d' },
                { value: '30d', label: '30d' },
                { value: 'never', label: 'never' },
              ]}
            />
          </div>

          {error && <div className="fret-field__error">{error}</div>}
        </div>

        <div className="fret-modal__foot">
          <Key inert={!dirty || saving} onClick={save}>
            {dirty ? t('edit.save') : t('edit.noChanges')}
          </Key>
          <button type="button" className="fret-delete" onClick={remove} disabled={saving}>
            {confirmDelete ? t('edit.confirmDelete') : t('edit.delete')}
          </button>
        </div>
      </div>
    </>
  )
}
