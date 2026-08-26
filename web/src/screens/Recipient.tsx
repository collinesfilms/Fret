/**
 * The recipient page.
 *
 * Public: no session, no account, nothing to sign up for. A password-protected
 * transfer shows only a lock — the filenames and the sender are part of what
 * the password protects, so nothing is revealed before it is entered.
 */

import { useEffect, useState } from 'react'
import { Field } from '../components/Controls'
import { FileList, Key, Panel, Screen, Strip, Typed, Vent } from '../components/Device'
import { api, ApiError, archiveUrl, fileUrl, type PublicTransfer } from '../lib/api'
import { countdown, formatBytes } from '../lib/format'
import { fileCount, translate, type Locale, type StringKey } from '../lib/i18n'

type State =
  | { kind: 'loading' }
  | { kind: 'locked' }
  | { kind: 'ready'; transfer: PublicTransfer }
  | { kind: 'gone'; reason: 'expired' | 'not_found' }

export function Recipient({
  slug,
  locale,
  appName,
  publicHost,
}: {
  slug: string
  locale: Locale
  appName: string
  publicHost: string
}) {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [password, setPassword] = useState('')
  const [unlocking, setUnlocking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const t = (key: StringKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars)

  useEffect(() => {
    let cancelled = false
    api
      .publicTransfer(slug)
      .then((transfer) => {
        if (cancelled) return
        setState(transfer.locked ? { kind: 'locked' } : { kind: 'ready', transfer })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const code = err instanceof ApiError ? err.code : undefined
        setState({ kind: 'gone', reason: code === 'expired' ? 'expired' : 'not_found' })
      })
    return () => {
      cancelled = true
    }
  }, [slug])

  const unlock = async (event: React.FormEvent) => {
    event.preventDefault()
    if (unlocking) return
    setUnlocking(true)
    setError(null)
    try {
      const transfer = await api.unlock(slug, password)
      setState({ kind: 'ready', transfer })
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) setError(t('recipient.tooMany'))
      else setError(t('recipient.wrongPassword'))
    } finally {
      setUnlocking(false)
    }
  }

  return (
    <div className="fret-stage">
      <Panel recipient>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 8.5,
              letterSpacing: '0.2em',
              textTransform: 'uppercase',
              color: 'var(--fg3)',
            }}
          >
            {appName}
          </span>
          <span
            style={{
              marginLeft: 'auto',
              fontFamily: 'var(--mono)',
              fontSize: 8.5,
              letterSpacing: '0.12em',
              color: 'var(--fg3)',
            }}
          >
            {publicHost}/{slug}
          </span>
        </div>

        {state.kind === 'loading' && (
          <Screen>
            <Strip color="var(--screenDim)" label="…" />
          </Screen>
        )}

        {state.kind === 'gone' && (
          <Screen>
            <Strip
              color="var(--accent)"
              label={
                state.reason === 'expired'
                  ? t('recipient.expiredStrip')
                  : t('recipient.notFoundStrip')
              }
            />
            <div className="fret-screen__title">
              {state.reason === 'expired' ? t('recipient.expired') : t('recipient.notFound')}
            </div>
          </Screen>
        )}

        {state.kind === 'locked' && (
          <>
            <Screen>
              <Strip color="var(--accent)" label={t('recipient.lockedStrip')} />
              <div className="fret-screen__title">
                <Typed>{t('recipient.locked')}</Typed>
              </div>
              <form onSubmit={unlock} style={{ marginTop: 16, display: 'flex', gap: 8 }}>
                <Field
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={t('recipient.enterPassword')}
                  aria-label={t('recipient.enterPassword')}
                  autoFocus
                  style={{
                    background: 'rgba(255,255,255,.05)',
                    borderColor: 'var(--screenLine)',
                    color: 'var(--screenFg)',
                  }}
                />
                <button type="submit" hidden aria-hidden="true" />
              </form>
              {error && (
                <div className="fret-screen__hint" style={{ color: 'var(--accent)', marginTop: 9 }}>
                  {error}
                </div>
              )}
            </Screen>
            <Vent />
            <Key className="fret-key--wide" onClick={unlock} inert={unlocking}>
              {t('recipient.unlock')}
            </Key>
          </>
        )}

        {state.kind === 'ready' && <ReadyView transfer={state.transfer} locale={locale} />}
      </Panel>
    </div>
  )
}

function ReadyView({ transfer, locale }: { transfer: PublicTransfer; locale: Locale }) {
  const t = (key: StringKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars)
  const expiry = countdown(locale, transfer.expiresAt)
  const count = fileCount(locale, transfer.files.length)
  const single = transfer.files.length === 1

  return (
    <>
      <Screen>
        <Strip
          color="var(--ok)"
          label={t('recipient.ready')}
          right={transfer.expiresAt ? expiry.label : undefined}
        />
        {/*
          The line the recipient came here to read, written rather than
          printed. It is the first thing on the screen and the only sentence
          on it, which is exactly what the caret is for.
        */}
        <div className="fret-screen__title">
          <Typed>
            {transfer.senderName
              ? t('recipient.sent', { name: transfer.senderName, count })
              : t('recipient.sentAnon', { count })}
          </Typed>
        </div>

        {/*
          Per-file buttons only earn their place when there is a choice to
          make. With one file the key below already does it, and a second
          control for the same act is just another thing to read.

          A single file goes straight to storage over a presigned URL, so the
          bytes never pass through the Fret server.
        */}
        <FileList files={transfer.files} locale={locale} cap={260}>
          {(file) =>
            single ? null : (
              <a
                href={fileUrl(transfer.slug, file.id)}
                className="fret-dl"
                aria-label={t('action.download', { name: file.name })}
              >
                ↓
              </a>
            )
          }
        </FileList>
      </Screen>

      <Vent />

      {/*
        Download all streams a zip assembled on the fly. Entries are stored
        rather than compressed, so the length is known in advance and the
        browser can show real progress on a large archive.
      */}
      <a
        href={single ? fileUrl(transfer.slug, transfer.files[0].id) : archiveUrl(transfer.slug)}
        className="fret-key fret-key--wide"
        style={{ textDecoration: 'none', color: 'var(--fg)' }}
      >
        <span className="fret-key__label">
          {single
            ? t('recipient.downloadOne', { size: formatBytes(locale, transfer.totalBytes) })
            : t('recipient.downloadAll', { size: formatBytes(locale, transfer.totalBytes) })}
        </span>
      </a>
    </>
  )
}
