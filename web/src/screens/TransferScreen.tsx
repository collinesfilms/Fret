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
import { Grow, LiveField, Segmented, SettingsRow, Tray } from '../components/Controls'
import { Key, LinkReadout, Morph, Panel, Screen, Strip, Vent } from '../components/Device'
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
  const [trayOpen, setTrayOpen] = useState(false)
  /** Which field last committed, so it can confirm itself briefly. */
  const [confirmed, setConfirmed] = useState<keyof Settings | null>(null)
  /** True for a moment after an upload lands, to play the completion once. */
  const [justLanded, setJustLanded] = useState(false)
  /*
   * The last name the server drew, so a typed one can be told from a minted
   * one. Without it there is no way to know whether the field holds a choice
   * worth keeping, and the trailing action cannot decide whether it is
   * offering another draw or a way back.
   */
  const [generated, setGenerated] = useState('')
  /** Measured, so the deck can make room for the drawer and stay centred. */
  const [trayHeight, setTrayHeight] = useState(0)


  const uploadRef = useRef<Upload | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const copyTimer = useRef<number | undefined>(undefined)
  const confirmTimer = useRef<number | undefined>(undefined)

  const t = useCallback(
    (key: StringKey, vars?: Record<string, string | number>) => translate(locale, key, vars),
    [locale],
  )

  useEffect(() => {
    return () => {
      window.clearTimeout(copyTimer.current)
      window.clearTimeout(confirmTimer.current)
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
      setGenerated(created.slug)
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
        setJustLanded(true)
        window.setTimeout(() => setJustLanded(false), 900)
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
    setTrayOpen(false)
    setTransfer(null)
    setGenerated('')
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
  const confirm = useCallback((field: keyof Settings) => {
    setConfirmed(field)
    window.clearTimeout(confirmTimer.current)
    confirmTimer.current = window.setTimeout(() => setConfirmed(null), 1400)
  }, [])

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
        confirm(Object.keys(patch)[0] as keyof Settings)
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
    [transfer, committed, confirm, onTransfersChanged, t],
  )

  /*
   * A name the user typed is a decision; a name the server drew is not. The
   * trailing action on the link field offers whichever of the two is missing:
   * another draw while the name is still the machine's, and a way back to it
   * once it is yours.
   */
  const isCustom = generated !== '' && committed.slug !== generated

  const drawSlug = async () => {
    if (!transfer) return
    setSlugError(null)
    try {
      const updated = await api.mintSlug(transfer.id)
      setTransfer(updated)
      setGenerated(updated.slug)
      setSettings((current) => ({ ...current, slug: updated.slug }))
      setCommitted((current) => ({ ...current, slug: updated.slug }))
      confirm('slug')
      onTransfersChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('error.generic'))
    }
  }

  const restoreDrawn = () => {
    setSettings((current) => ({ ...current, slug: generated }))
    setSlugError(null)
    commit({ slug: generated })
  }

  const hasPassword = settings.password !== '' || Boolean(transfer?.hasPassword)

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
      lamp: { color: 'var(--ok)', bloom: justLanded },
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

      {/*
        The drawer is a sibling of the panel so it can pass behind it, and it
        is positioned out of flow — so the deck reserves its height below
        itself instead. The stage centres the deck, which means reserving the
        space is also what lifts the device: the panel rises by half the
        drawer as it comes out, and the object as a whole stays centred.
      */}
      <div
        className="fret-deck"
        style={
          {
            '--trayH': `${trayOpen && phase !== 'empty' ? trayHeight : 0}px`,
          } as React.CSSProperties
        }
      >
        <Panel settled={justLanded}>
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
                right={
                  <LinkReadout
                    host={me.publicHost}
                    slug={committed.slug}
                    onOpen={phase === 'ready' ? () => onOpenRecipient(committed.slug) : undefined}
                  />
                }
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

        {/*
          The device shows three keys and nothing else: what you came to do,
          how to stop, and where the rest lives. Everything a transfer can be
          adjusted to is real but out of the way, which is the point — most
          transfers need none of it.
        */}
        <Grow open={phase !== 'empty'}>
          <div className="fret-actions">
            <Key
              className="fret-actions__primary"
              inert={keyState.inert}
              lamp={keyState.lamp}
              onClick={keyState.action}
            >
              {/* The label is the status readout for this key, so it changes
                  by being replaced rather than rewritten in place. */}
              <Morph>{keyState.label}</Morph>
            </Key>
            <Key
              variant="alt"
              className="fret-actions__secondary"
              onClick={() => setTrayOpen(!trayOpen)}
              aria-expanded={trayOpen}
              pressed={trayOpen}
            >
              {t('key.options')}
            </Key>
            <Key variant="alt" className="fret-actions__secondary" onClick={reset}>
              <Morph>{uploading ? t('key.cancel') : t('key.new')}</Morph>
            </Key>
          </div>
        </Grow>
        </Panel>

        {/*
          The drawer's own settings. No consequence is stated here: this device
          only ever holds a transfer that is arriving, so its name has not been
          anywhere yet. Renaming something already sent happens in the edit
          modal, and the warning lives there with it.
        */}
        <Tray
          open={trayOpen && phase !== 'empty'}
          label={me.publicHost}
          onHeight={setTrayHeight}
        >
          <div className="fret-settings">
            <SettingsRow label={t('settings.link')}>
              <LiveField
                value={settings.slug}
                error={slugError ?? undefined}
                committed={confirmed === 'slug'}
                onChange={(e) => {
                  setSettings({ ...settings, slug: filterSlug(e.target.value) })
                  setSlugError(null)
                }}
                onBlur={() => commit({ slug: settings.slug })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                  if (e.key === 'Escape') setSettings({ ...settings, slug: committed.slug })
                }}
                action={{
                  label: isCustom ? t('settings.slugReset') : t('settings.slugDraw'),
                  onClick: isCustom ? restoreDrawn : drawSlug,
                  title: isCustom ? t('settings.slugResetHint') : t('settings.slugDrawHint'),
                }}
                aria-label={t('settings.link')}
              />
            </SettingsRow>

            <SettingsRow label={t('settings.password')}>
              <LiveField
                type="password"
                value={settings.password}
                placeholder={t('settings.passwordNone')}
                committed={confirmed === 'password'}
                onChange={(e) => setSettings({ ...settings, password: e.target.value })}
                onBlur={() => commit({ password: settings.password })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                }}
                action={{
                  label: t('settings.passwordClear'),
                  disabled: !hasPassword,
                  onClick: () => {
                    setSettings({ ...settings, password: '' })
                    commit({ password: '' })
                  },
                }}
                aria-label={t('settings.password')}
              />
            </SettingsRow>

            <SettingsRow label={t('settings.expires')}>
              <Segmented<Expiry>
                value={settings.expiry}
                onChange={(expiry) => {
                  setSettings({ ...settings, expiry })
                  commit({ expiry })
                }}
                label={t('settings.expires')}
                committed={confirmed === 'expiry'}
                segments={[
                  { value: '24h', label: '24h' },
                  { value: '7d', label: '7d' },
                  { value: '30d', label: '30d' },
                  { value: 'never', label: 'never' },
                ]}
              />
            </SettingsRow>
          </div>
        </Tray>
      </div>
    </div>
  )
}
