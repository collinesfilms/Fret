/**
 * The core screen: drop, upload, adjust, share.
 *
 * Two behaviours here are the product rather than decoration. Dropping files
 * starts the upload immediately and the device grows into its settings while
 * bytes are still moving — settings are configured during transit, not before.
 * And the primary key carries the transfer's whole state, which is why there
 * is no separate status line and no separate save button.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Field, Grow, Segmented, SettingsRow } from '../components/Controls'
import { Key, Panel, Screen, Strip, Vent } from '../components/Device'
import { api, ApiError, type Expiry, type Me, type Resumable, type Transfer } from '../lib/api'
import { filterSlug, formatBytes, rate, remaining, splitBytes } from '../lib/format'
import { fileCount, translate, type Locale, type StringKey } from '../lib/i18n'
import { CancelledError, matchResumable, readDrop, Upload, type UploadProgress } from '../lib/upload'

type Phase = 'empty' | 'uploading' | 'ready' | 'failed'

/** How long the saved and copied confirmations hold before reverting. */
const SAVED_FLASH_MS = 2600
const COPIED_FLASH_MS = 1800

interface Settings {
  slug: string
  password: string
  expiry: Expiry
}

export function TransferScreen({
  me,
  locale,
  onTransfersChanged,
  onOpenRecipient,
}: {
  me: Me
  locale: Locale
  onTransfersChanged: () => void
  onOpenRecipient: (slug: string) => void
}) {
  const [phase, setPhase] = useState<Phase>('empty')
  const [dragging, setDragging] = useState(false)
  const [transfer, setTransfer] = useState<Transfer | null>(null)
  const [progress, setProgress] = useState<UploadProgress | null>(null)
  const [draining, setDraining] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [settings, setSettings] = useState<Settings>({ slug: '', password: '', expiry: '7d' })
  const [saved, setSaved] = useState<Settings>({ slug: '', password: '', expiry: '7d' })
  const [shared, setShared] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  const [copied, setCopied] = useState(false)
  const [slugError, setSlugError] = useState<string | null>(null)
  const [savingSettings, setSavingSettings] = useState(false)

  const [resumable, setResumable] = useState<Resumable | null>(null)
  const [awaitingResume, setAwaitingResume] = useState(false)

  const uploadRef = useRef<Upload | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const flashTimer = useRef<number | undefined>(undefined)
  const copyTimer = useRef<number | undefined>(undefined)

  const t = useCallback(
    (key: StringKey, vars?: Record<string, string | number>) => translate(locale, key, vars),
    [locale],
  )

  useEffect(() => {
    return () => {
      window.clearTimeout(flashTimer.current)
      window.clearTimeout(copyTimer.current)
      uploadRef.current?.cancel()
    }
  }, [])

  // Offer to resume anything left unfinished by a previous session.
  useEffect(() => {
    api
      .resumable()
      .then(({ transfers }) => {
        if (transfers.length > 0) setResumable(transfers[0])
      })
      .catch(() => setResumable(null))
  }, [])

  const dirty =
    settings.slug !== saved.slug ||
    settings.password !== saved.password ||
    settings.expiry !== saved.expiry

  const startUpload = useCallback(
    async (picked: File[], resume?: Resumable) => {
      if (picked.length === 0) return
      setError(null)
      setSlugError(null)
      setDraining(false)
      setCopied(false)
      setSavedFlash(false)
      setShared(false)

      let created: Transfer
      let byFileId: Map<string, File>
      let have = new Map<string, Set<number>>()

      try {
        if (resume) {
          const matched = matchResumable(resume, picked)
          if (!matched) {
            setError(t('app.resumeHint'))
            return
          }
          created = await api.getTransfer(resume.id)
          byFileId = matched
          have = new Map(resume.files.map((f) => [f.id, new Set(f.havePart)]))
        } else {
          created = await api.createTransfer(
            picked.map((file) => ({ name: file.name, size: file.size, type: file.type })),
          )
          // The server flattens and de-duplicates names, and returns them in
          // the order they were sent, so files pair up by position.
          byFileId = new Map(created.files.map((file, i) => [file.id, picked[i]]))
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : t('error.generic'))
        setPhase('failed')
        return
      }

      setTransfer(created)
      setResumable(null)
      setAwaitingResume(false)
      const initial: Settings = { slug: created.slug, password: '', expiry: created.expiry }
      setSettings(initial)
      setSaved(initial)
      setPhase('uploading')
      setProgress({
        uploaded: 0,
        total: created.totalBytes,
        percent: 0,
        secondsRemaining: null,
        bytesPerSecond: 0,
      })

      const upload = new Upload(created, byFileId, { onProgress: setProgress }, have)
      uploadRef.current = upload

      try {
        const finished = await upload.start()
        setTransfer(finished)
        setPhase('ready')
        // The material drains rather than snapping to empty.
        setDraining(true)
        onTransfersChanged()
      } catch (err) {
        if (err instanceof CancelledError) return
        setError(err instanceof Error ? err.message : t('error.generic'))
        setPhase('failed')
      } finally {
        uploadRef.current = null
      }
    },
    [onTransfersChanged, t],
  )

  const onPick = (files: FileList | null) => {
    if (!files || files.length === 0) return
    const picked = Array.from(files)
    startUpload(picked, awaitingResume && resumable ? resumable : undefined)
  }

  const onDrop = async (event: React.DragEvent) => {
    event.preventDefault()
    setDragging(false)
    const picked = await readDrop(event.dataTransfer)
    startUpload(picked, awaitingResume && resumable ? resumable : undefined)
  }

  /**
   * Retries a failed upload through the resume path, so the parts that already
   * landed are not sent a second time. The browser cannot reach back into the
   * filesystem on its own, so this asks for the same files again.
   */
  const retry = async () => {
    try {
      const { transfers } = await api.resumable()
      const match = transfers.find((entry) => entry.id === transfer?.id) ?? transfers[0]
      if (match) {
        setResumable(match)
        setAwaitingResume(true)
      }
    } catch {
      // Falling through still opens the picker, which starts a fresh transfer.
    }
    inputRef.current?.click()
  }

  const reset = () => {
    uploadRef.current?.cancel()
    uploadRef.current = null
    if (transfer && phase === 'uploading') {
      // An abandoned upload is discarded outright rather than left for the
      // sweeper: the user said no.
      api.deleteTransfer(transfer.id).catch(() => undefined)
    }
    setPhase('empty')
    setTransfer(null)
    setProgress(null)
    setDraining(false)
    setError(null)
    setSlugError(null)
    setShared(false)
    setCopied(false)
    setSavedFlash(false)
    if (inputRef.current) inputRef.current.value = ''
    onTransfersChanged()
  }

  const linkFor = (slug: string) => `${window.location.origin}/${slug}`

  const copyLink = async () => {
    if (!transfer) return
    try {
      await navigator.clipboard.writeText(linkFor(saved.slug))
    } catch {
      // Clipboard access can be refused; the link is on screen either way.
    }
    setShared(true)
    setCopied(true)
    window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => setCopied(false), COPIED_FLASH_MS)
  }

  const saveSettings = async () => {
    if (!transfer || savingSettings) return
    setSavingSettings(true)
    setSlugError(null)
    try {
      const updated = await api.updateTransfer(transfer.id, {
        slug: settings.slug !== saved.slug ? settings.slug : undefined,
        password: settings.password !== saved.password ? settings.password : undefined,
        expiry: settings.expiry !== saved.expiry ? settings.expiry : undefined,
      })
      setTransfer(updated)
      setSaved({ ...settings })
      setSavedFlash(true)
      window.clearTimeout(flashTimer.current)
      flashTimer.current = window.setTimeout(() => setSavedFlash(false), SAVED_FLASH_MS)
      onTransfersChanged()
    } catch (err) {
      if (err instanceof ApiError && err.code === 'slug_taken') setSlugError(t('error.slugTaken'))
      else if (err instanceof ApiError && err.code === 'slug_invalid')
        setSlugError(t('error.slugInvalid'))
      else setError(err instanceof Error ? err.message : t('error.generic'))
    } finally {
      setSavingSettings(false)
    }
  }

  const uploading = phase === 'uploading'
  const percent = Math.floor(progress?.percent ?? 0)

  /*
   * The primary key's state table. `dirty` and `shared` together decide the
   * label and the action, which is why the pair is tracked rather than a
   * single status enum.
   */
  const keyState = (() => {
    if (phase === 'failed') {
      // The transfer never went live, so there is no link worth copying.
      return {
        label: t('app.retry'),
        lamp: { color: 'var(--accent)', pulse: true },
        inert: false,
        action: retry,
      }
    }
    if (uploading) {
      return {
        label: t('key.uploading', { percent }),
        lamp: { color: 'var(--accent)', pulse: true },
        inert: true,
        action: () => undefined,
      }
    }
    if (dirty) {
      return {
        label: shared ? t('key.update') : t('key.save'),
        lamp: { color: 'var(--accent)', pulse: true },
        inert: savingSettings,
        action: saveSettings,
      }
    }
    if (savedFlash) {
      return { label: t('key.saved'), lamp: { color: 'var(--ok)' }, inert: false, action: copyLink }
    }
    if (copied) {
      return { label: t('key.copied'), lamp: { color: 'var(--ok)' }, inert: false, action: copyLink }
    }
    return {
      label: shared ? t('key.live') : t('key.copy'),
      lamp: { color: 'var(--ok)' },
      inert: false,
      action: copyLink,
    }
  })()

  const files = transfer?.files ?? []
  const [totalFigure, totalUnit] = splitBytes(transfer?.totalBytes ?? 0)

  return (
    <div className="fret-stage">
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => onPick(e.target.files)}
      />

      <Panel>
        <Screen
          dragging={dragging}
          fill={phase === 'empty' ? 0 : draining ? 0 : percent}
          draining={draining}
          sheen={uploading}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault()
            if (!dragging) setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          label={t('app.drop')}
        >
          {phase === 'empty' && (
            <>
              <Strip
                color={dragging ? 'var(--accent)' : 'var(--ok)'}
                label={dragging ? t('app.releaseStrip') : t('app.ready')}
                right={`s3 · ${me.region}`}
              />
              <div className="fret-screen__title">
                {dragging ? t('app.release') : t('app.drop')}
              </div>
              <div className="fret-screen__hint">{t('app.browse')}</div>

              {/* An unfinished upload is offered here rather than as a dialog. */}
              {resumable && (
                <div
                  className="fret-screen__hint"
                  style={{ marginTop: 12, color: 'var(--accent)' }}
                  onClick={(e) => {
                    e.stopPropagation()
                    setAwaitingResume(true)
                    inputRef.current?.click()
                  }}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.stopPropagation()
                      setAwaitingResume(true)
                      inputRef.current?.click()
                    }
                  }}
                >
                  {t('app.resumable')} · {resumable.slug} ·{' '}
                  {formatBytes(resumable.uploadedBytes)} of {formatBytes(resumable.totalBytes)}
                  <div style={{ color: 'var(--screenDim)', marginTop: 3 }}>
                    {t('app.resumeHint')}
                  </div>
                </div>
              )}
            </>
          )}

          {phase !== 'empty' && (
            <>
              <Strip
                color={uploading ? 'var(--accent)' : phase === 'failed' ? 'var(--accent)' : 'var(--ok)'}
                label={
                  uploading
                    ? t('app.uploading')
                    : phase === 'failed'
                      ? t('app.failed')
                      : t('app.complete')
                }
                pulse={uploading}
                right={saved.slug}
              />

              <div className="fret-filelist">
                {files.map((file) => (
                  <div className="fret-filelist__row" key={file.id}>
                    <span className="fret-filelist__name">{file.name}</span>
                    <span className="fret-filelist__size">{formatBytes(file.size)}</span>
                  </div>
                ))}
              </div>

              <div className="fret-readout">
                {uploading ? (
                  <>
                    <span className="fret-readout__value">{percent}</span>
                    <span className="fret-readout__unit">
                      % of {formatBytes(transfer?.totalBytes ?? 0)}
                    </span>
                    <span className="fret-readout__right">
                      {progress?.bytesPerSecond
                        ? `${rate(progress.bytesPerSecond)} · ${remaining(progress.secondsRemaining)}`
                        : remaining(progress?.secondsRemaining ?? null)}
                    </span>
                  </>
                ) : (
                  <>
                    <span className="fret-readout__value">{totalFigure}</span>
                    <span className="fret-readout__unit">{totalUnit}</span>
                    <span className="fret-readout__right">
                      {t('app.readyCount', { count: fileCount(locale, files.length) })}
                    </span>
                  </>
                )}
              </div>

              {error && (
                <div className="fret-screen__hint" style={{ color: 'var(--accent)', marginTop: 10 }}>
                  {error}
                </div>
              )}
            </>
          )}
        </Screen>

        {/*
          The device grows into its settings the moment files exist, and
          collapses again on New. The reverse is as much a part of the gesture
          as the growth.
        */}
        <Grow open={phase !== 'empty'}>
          <Vent />
          <div className="fret-settings">
            <SettingsRow label={t('settings.link')}>
              <Field
                value={settings.slug}
                error={slugError ?? undefined}
                onChange={(e) => {
                  setSettings({ ...settings, slug: filterSlug(e.target.value) })
                  setSlugError(null)
                }}
                aria-label={t('settings.link')}
              />
            </SettingsRow>

            <SettingsRow label={t('settings.password')}>
              <Field
                type="password"
                value={settings.password}
                placeholder={t('settings.passwordNone')}
                onChange={(e) => setSettings({ ...settings, password: e.target.value })}
                aria-label={t('settings.password')}
              />
            </SettingsRow>

            <SettingsRow label={t('settings.expires')}>
              <Segmented<Expiry>
                value={settings.expiry}
                onChange={(expiry) => setSettings({ ...settings, expiry })}
                label={t('settings.expires')}
                segments={[
                  { value: '24h', label: '24h' },
                  { value: '7d', label: '7d' },
                  { value: '30d', label: '30d' },
                  { value: 'never', label: 'never' },
                ]}
              />
            </SettingsRow>
          </div>

          <div className="fret-actions" style={{ marginTop: 14 }}>
            <Key
              className="fret-actions__primary"
              inert={keyState.inert}
              lamp={keyState.lamp}
              onClick={keyState.action}
            >
              {keyState.label}
            </Key>
            <Key
              variant="alt"
              className="fret-actions__secondary"
              onClick={() => onOpenRecipient(saved.slug)}
              /* Nothing to preview until the transfer is actually live. */
              inert={uploading}
            >
              {t('key.open')}
            </Key>
            <Key variant="alt" className="fret-actions__secondary" onClick={reset}>
              {uploading ? t('key.cancel') : t('key.new')}
            </Key>
          </div>
        </Grow>
      </Panel>
    </div>
  )
}
