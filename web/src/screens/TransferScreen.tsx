/**
 * The core screen: drop, upload, adjust, share.
 *
 * Dropping files starts the upload immediately and the device grows into its
 * settings while bytes are still moving — settings are configured during
 * transit, not before.
 *
 * Nothing here is saved explicitly. Discrete choices commit the moment they
 * are made; the text fields commit when you leave them, or on Enter. Doing it
 * per keystroke would be wrong rather than merely chatty: each intermediate
 * slug is a real reservation, and a half-typed password would genuinely be the
 * transfer's password for as long as it took to finish typing.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Field, Grow, Segmented, SettingsRow } from '../components/Controls'
import { Key, LinkReadout, Panel, RestoreTag, Screen, Strip, Vent } from '../components/Device'
import { api, ApiError, type Expiry, type Me, type Resumable, type Transfer } from '../lib/api'
import { filterSlug, formatBytes, rate, remaining, splitBytes } from '../lib/format'
import { fileCount, translate, type Locale, type StringKey } from '../lib/i18n'
import { CancelledError, matchResumable, readDrop, Upload, type UploadProgress } from '../lib/upload'

type Phase = 'empty' | 'uploading' | 'ready' | 'failed'

interface Settings {
  slug: string
  password: string
  expiry: Expiry
}

/** How long the copied confirmation holds before reverting. */
const COPIED_FLASH_MS = 1800

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

  // `settings` is what the fields show; `committed` is what the server holds.
  // They differ only between a keystroke and the blur that commits it.
  const [settings, setSettings] = useState<Settings>({ slug: '', password: '', expiry: '7d' })
  const [committed, setCommitted] = useState<Settings>({ slug: '', password: '', expiry: '7d' })
  const [copied, setCopied] = useState(false)
  const [slugError, setSlugError] = useState<string | null>(null)


  const uploadRef = useRef<Upload | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const copyTimer = useRef<number | undefined>(undefined)

  const t = useCallback(
    (key: StringKey, vars?: Record<string, string | number>) => translate(locale, key, vars),
    [locale],
  )

  useEffect(() => {
    return () => {
      window.clearTimeout(copyTimer.current)
      uploadRef.current?.cancel()
    }
  }, [])

  const startUpload = useCallback(
    async (picked: File[], resume?: Resumable) => {
      if (picked.length === 0) return
      setError(null)
      setSlugError(null)
      setDraining(false)
      setCopied(false)

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
      const initial: Settings = { slug: created.slug, password: '', expiry: created.expiry }
      setSettings(initial)
      setCommitted(initial)
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

  /**
   * Finds an unfinished transfer these exact files belong to.
   *
   * Resuming is decided here rather than announced on arrival. An unfinished
   * upload used to be advertised the moment the app loaded, which meant a
   * prompt that could not be dismissed, survived every reload, and appeared on
   * devices that had never started it — the files it needed were on a
   * different machine. Matching at drop time removes all three: you can only
   * match by dropping the files, and dropping the files is the only thing that
   * makes resuming possible.
   */
  const findResumable = async (picked: File[]): Promise<Resumable | undefined> => {
    try {
      const { transfers } = await api.resumable()
      return transfers.find((entry) => matchResumable(entry, picked) !== null)
    } catch {
      return undefined
    }
  }

  const begin = async (picked: File[]) => {
    if (picked.length === 0) return
    startUpload(picked, await findResumable(picked))
  }

  const onPick = (files: FileList | null) => {
    if (!files || files.length === 0) return
    begin(Array.from(files))
  }

  const onDrop = async (event: React.DragEvent) => {
    event.preventDefault()
    setDragging(false)
    begin(await readDrop(event.dataTransfer))
  }

  /**
   * Retries a failed upload. The browser cannot reach back into the filesystem
   * on its own, so this asks for the same files again; whatever already landed
   * is matched and skipped by the same path a resume takes.
   */
  const retry = () => inputRef.current?.click()

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
    setCopied(false)
    if (inputRef.current) inputRef.current.value = ''
    onTransfersChanged()
  }

  const linkFor = (slug: string) => `${window.location.origin}/${slug}`

  const copyLink = async () => {
    if (!transfer) return
    try {
      await navigator.clipboard.writeText(linkFor(committed.slug))
    } catch {
      // Clipboard access can be refused; the link is on screen either way.
    }
    setCopied(true)
    window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => setCopied(false), COPIED_FLASH_MS)

    // Copying is what makes a link shared, so it is the moment the name worth
    // restoring gets recorded.
    try {
      setTransfer(await api.markShared(transfer.id))
      onTransfersChanged()
    } catch {
      // Only costs the restore tag; the link on the clipboard is unaffected.
    }
  }

  /**
   * Commits a change to the server.
   *
   * Discrete controls call this as they are clicked. Text fields call it when
   * they are left, which is late enough that a half-typed slug is never
   * reserved and a half-typed password is never the real one.
   */
  const commit = useCallback(
    async (patch: Partial<Settings>) => {
      if (!transfer) return
      const next = { ...committed, ...patch }
      if (
        next.slug === committed.slug &&
        next.password === committed.password &&
        next.expiry === committed.expiry
      ) {
        return
      }
      setSlugError(null)
      try {
        const updated = await api.updateTransfer(transfer.id, {
          slug: next.slug !== committed.slug ? next.slug : undefined,
          password: next.password !== committed.password ? next.password : undefined,
          expiry: next.expiry !== committed.expiry ? next.expiry : undefined,
        })
        setTransfer(updated)
        setCommitted({ slug: updated.slug, password: next.password, expiry: updated.expiry })
        setSettings((current) => ({ ...current, slug: updated.slug, expiry: updated.expiry }))
        onTransfersChanged()
      } catch (err) {
        // A rejected value snaps the field back to what the server holds,
        // rather than leaving the interface claiming something untrue.
        if (err instanceof ApiError && err.code === 'slug_taken') {
          setSlugError(t('error.slugTaken'))
          setSettings((current) => ({ ...current, slug: committed.slug }))
        } else if (err instanceof ApiError && err.code === 'slug_invalid') {
          setSlugError(t('error.slugInvalid'))
          setSettings((current) => ({ ...current, slug: committed.slug }))
        } else {
          setError(err instanceof Error ? err.message : t('error.generic'))
        }
      }
    },
    [transfer, committed, onTransfersChanged, t],
  )

  /** Puts the link back to the name it was handed out under. */
  const restoreSharedSlug = () => {
    const shared = transfer?.sharedSlug
    if (!shared) return
    setSettings((current) => ({ ...current, slug: shared }))
    commit({ slug: shared })
  }

  const uploading = phase === 'uploading'
  const percent = Math.floor(progress?.percent ?? 0)

  /*
   * The key does one job now: copy the link. It cannot do it while the upload
   * is running, because the link does not resolve until the transfer goes
   * live — and the screen above already reports the progress, so the key says
   * only why it is waiting.
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
        label: t('key.waiting'),
        lamp: { color: 'var(--accent)', pulse: true },
        inert: true,
        action: () => undefined,
      }
    }
    return {
      label: copied ? t('key.copied') : t('key.copy'),
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

      {/* The tag is a sibling of the panel so it can pass behind it. */}
      <div className="fret-deck">
        <Panel>
          {/*
            The screen only accepts files while it is empty. Once a transfer
            exists it is a readout, and a stray click opening a file picker —
            quietly abandoning the transfer on screen — is not what anyone
            meant by clicking it.
          */}
          <Screen
          dragging={dragging}
          fill={phase === 'empty' ? 0 : draining ? 0 : percent}
          draining={draining}
          sheen={uploading}
          onClick={phase === 'empty' ? () => inputRef.current?.click() : undefined}
          onDragOver={
            phase === 'empty'
              ? (e) => {
                  e.preventDefault()
                  if (!dragging) setDragging(true)
                }
              : undefined
          }
          onDragLeave={phase === 'empty' ? () => setDragging(false) : undefined}
          onDrop={phase === 'empty' ? onDrop : undefined}
          label={phase === 'empty' ? t('app.drop') : undefined}
        >
          {phase === 'empty' && (
            <>
              <Strip
                color={dragging ? 'var(--accent)' : 'var(--ok)'}
                label={dragging ? t('app.releaseStrip') : t('app.ready')}
                right={<LinkReadout host={me.publicHost} slug="" />}
              />
              <div className="fret-screen__title">
                {dragging ? t('app.release') : t('app.drop')}
              </div>
              <div className="fret-screen__hint">{t('app.browse')}</div>

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
                right={<LinkReadout host={me.publicHost} slug={committed.slug} />}
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
        {/*
          The vent belongs to the device, not to the settings: it is there when
          the panel holds nothing but the screen, which is what makes the empty
          state read as an object rather than a card.
        */}
        <Vent />

        <Grow open={phase !== 'empty'}>
          <div className="fret-settings">
            {/* Text fields commit when you leave them, or on Enter. */}
            <SettingsRow label={t('settings.link')}>
              <Field
                value={settings.slug}
                error={slugError ?? undefined}
                onChange={(e) => {
                  setSettings({ ...settings, slug: filterSlug(e.target.value) })
                  setSlugError(null)
                }}
                onBlur={() => commit({ slug: settings.slug })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                  if (e.key === 'Escape') setSettings({ ...settings, slug: committed.slug })
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
                onBlur={() => commit({ password: settings.password })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                }}
                aria-label={t('settings.password')}
              />
            </SettingsRow>

            {/* A discrete choice has no half-made state, so it commits at once. */}
            <SettingsRow label={t('settings.expires')}>
              <Segmented<Expiry>
                value={settings.expiry}
                onChange={(expiry) => {
                  setSettings({ ...settings, expiry })
                  commit({ expiry })
                }}
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
              onClick={() => onOpenRecipient(committed.slug)}
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

        <RestoreTag
          slug={transfer?.sharedSlug ?? ''}
          current={committed.slug}
          locale={locale}
          onRestore={restoreSharedSlug}
        />
      </div>
    </div>
  )
}
