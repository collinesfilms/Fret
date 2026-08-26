/**
 * The app chrome above the device: the active-transfers pill on the left, and
 * theme, settings and account on the right.
 */

import { useEffect, useRef, useState } from 'react'
import { api, type AdminStats, type Expiry, type Me, type SlugStyle, type Theme } from '../lib/api'
import { formatBytes, pad2 } from '../lib/format'
import { counted, translate, type Locale, type StringKey } from '../lib/i18n'
import { Segmented, useGrabToDismiss } from './Controls'

/** The offered slug lengths. Six is still unguessable; twelve is belt-and-braces. */
const SLUG_LENGTHS = [6, 8, 10, 12]

/** Maps a stored length onto the nearest preset, so an older value still shows. */
function nearestLength(length: number): number {
  return SLUG_LENGTHS.reduce((best, n) =>
    Math.abs(n - length) < Math.abs(best - length) ? n : best,
  )
}

interface TopBarProps {
  me: Me
  locale: Locale
  activeCount: number
  resolvedTheme: 'light' | 'dark'
  onToggleTheme: () => void
  onOpenSheet: () => void
  onUpdateMe: (me: Me) => void
  onSignOut: () => void
}

export function TopBar({
  me,
  locale,
  activeCount,
  resolvedTheme,
  onToggleTheme,
  onOpenSheet,
  onUpdateMe,
  onSignOut,
}: TopBarProps) {
  const [menu, setMenu] = useState<'settings' | null>(null)
  const [avatarOpen, setAvatarOpen] = useState(false)
  const chromeRef = useRef<HTMLDivElement>(null)
  const t = (key: StringKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars)

  // Both the popover and the expanded avatar collapse on an outside click or
  // Escape, so neither can be left hanging open.
  useEffect(() => {
    if (!menu && !avatarOpen) return
    const onPointer = (event: PointerEvent) => {
      if (!chromeRef.current?.contains(event.target as Node)) {
        setMenu(null)
        setAvatarOpen(false)
      }
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenu(null)
        setAvatarOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [menu, avatarOpen])

  return (
    <div className="fret-chrome" ref={chromeRef}>
      <button type="button" className="fret-pill" onClick={onOpenSheet}>
        <span
          className="fret-lamp fret-lamp--breathe"
          aria-hidden="true"
          style={{
            width: 6,
            height: 6,
            background: 'var(--accent)',
            boxShadow: '0 0 6px var(--accent), inset 0 1px 1px rgba(255,255,255,.5)',
          }}
        />
        <span className="fret-pill__count">{pad2(activeCount)}</span>
        <span className="fret-pill__label">{t('app.active')}</span>
      </button>

      <div className="fret-chrome__right" style={{ position: 'relative' }}>
        <button
          type="button"
          className="fret-iconpill"
          onClick={onToggleTheme}
          aria-label={resolvedTheme === 'dark' ? t('prefs.themeLight') : t('prefs.themeDark')}
        >
          <span
            className={`fret-themeglyph${resolvedTheme === 'dark' ? ' fret-themeglyph--dark' : ''}`}
          />
        </button>

        <button
          type="button"
          className="fret-iconpill"
          onClick={() => setMenu(menu ? null : 'settings')}
          aria-label={t('prefs.theme')}
          aria-expanded={menu === 'settings'}
        >
          <SettingsGlyph />
        </button>

        {/*
          The avatar expands to reveal "Sign out" and only signs out on a second,
          deliberate click.
        */}
        <button
          type="button"
          className={`fret-avatar${avatarOpen ? ' fret-avatar--open' : ''}`}
          onClick={() => (avatarOpen ? onSignOut() : setAvatarOpen(true))}
          aria-label={avatarOpen ? t('prefs.signOut') : me.user.name}
          title={me.user.email}
        >
          <span className="fret-avatar__initials">{me.initials}</span>
          <span className="fret-avatar__signout">{t('prefs.signOut')}</span>
        </button>

        {/*
          Mounted whether or not it is showing, so it can leave the way it
          arrived. Rendering it only while open meant it slid up on a phone
          and then simply blinked out of existence — an entrance with no exit.

          The scrim only exists on a phone, where the settings are a sheet
          rather than a card hanging off the button that opened them. On a
          desktop a popover that dimmed the whole page to show three segmented
          controls would be shouting.
        */}
        <div
          className={`fret-popover__scrim${menu === 'settings' ? ' fret-popover__scrim--on' : ''}`}
          onClick={() => setMenu(null)}
          aria-hidden="true"
        />
        <SettingsPopover
          open={menu === 'settings'}
          me={me}
          locale={locale}
          onUpdateMe={onUpdateMe}
          onClose={() => setMenu(null)}
        />
      </div>
    </div>
  )
}

function SettingsGlyph() {
  // Three bars with knobs at different positions, drawn from divs.
  const bars: [number, number][] = [
    [2, 3],
    [4, 1],
    [1, 4],
  ]
  return (
    <span className="fret-settingsglyph" aria-hidden="true">
      {bars.map(([before, after], i) => (
        <span className="fret-settingsglyph__bar" key={i}>
          <span className="fret-settingsglyph__track" style={{ flex: before }} />
          <span className="fret-settingsglyph__knob" />
          <span className="fret-settingsglyph__track" style={{ flex: after }} />
        </span>
      ))}
    </span>
  )
}

function SettingsPopover({
  open,
  me,
  locale,
  onUpdateMe,
  onClose,
}: {
  open: boolean
  me: Me
  locale: Locale
  onUpdateMe: (me: Me) => void
  onClose: () => void
}) {
  const [stats, setStats] = useState<AdminStats | null>(null)
  const { grabHandlers, grabStyle } = useGrabToDismiss(open, onClose)
  const t = (key: StringKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars)

  useEffect(() => {
    if (!me.superadmin) return
    api.adminStats().then(setStats).catch(() => setStats(null))
  }, [me.superadmin])

  /*
   * Nothing is dimmed while this is in flight. The surface used to drop to
   * 70% opacity for the length of the request, which on a phone-sized sheet
   * read as the whole panel flickering every time you touched a control — a
   * bigger event than the change itself. The segmented control already
   * confirms for itself when the server has taken it.
   */
  const save = async (patch: Parameters<typeof api.savePreferences>[0]) => {
    try {
      onUpdateMe(await api.savePreferences(patch))
    } catch {
      // A failed preference save is not worth interrupting anyone over; the
      // control simply stays where it was.
    }
  }

  return (
    <div
      className={`fret-popover${open ? ' fret-popover--open' : ''}`}
      style={grabStyle}
      inert={!open}
      aria-hidden={!open}
    >
      {/*
        Only drawn at phone widths, where this is a sheet: the same grab bar
        the transfers sheet wears, and now the same gesture too, because they
        arrive the same way and a thumb should not have to learn two
        vocabularies for it.
      */}
      <div className="fret-popover__grab" {...grabHandlers} />

      <div className="fret-popover__stack">
        <div className="fret-popover__stackLabel">{t('prefs.theme')}</div>
        <Segmented<Theme>
          value={me.user.theme}
          onChange={(theme) => save({ theme })}
          label={t('prefs.theme')}
          segments={[
            { value: 'system', label: t('prefs.themeSystem') },
            { value: 'light', label: t('prefs.themeLight') },
            { value: 'dark', label: t('prefs.themeDark') },
          ]}
        />
      </div>

      <div className="fret-popover__stack">
        <div className="fret-popover__stackLabel">{t('prefs.slug')}</div>
        <Segmented<SlugStyle>
          value={me.user.slugStyle}
          onChange={(slugStyle) => save({ slugStyle })}
          label={t('prefs.slug')}
          segments={[
            { value: 'code', label: t('prefs.slugCode') },
            { value: 'words', label: t('prefs.slugWords') },
          ]}
        />
        {/*
          Length only means something for the code style. Presets rather than a
          slider: a range input was the one stock control in an interface built
          entirely from its own parts, and nobody needs eleven characters.
        */}
        {me.user.slugStyle === 'code' && (
          <div style={{ marginTop: 9 }}>
            <div className="fret-popover__stackLabel">{t('prefs.slugLength')}</div>
            <Segmented<string>
              value={String(nearestLength(me.user.slugLength))}
              onChange={(value) => save({ slugLength: Number(value) })}
              label={t('prefs.slugLength')}
              segments={SLUG_LENGTHS.map((n) => ({ value: String(n), label: String(n) }))}
            />
          </div>
        )}
      </div>

      <div className="fret-popover__stack">
        <div className="fret-popover__stackLabel">{t('prefs.expiry')}</div>
        <Segmented<Expiry>
          value={me.user.defaultExpiry}
          onChange={(defaultExpiry) => save({ defaultExpiry })}
          label={t('prefs.expiry')}
          segments={[
            { value: '24h', label: '24h' },
            { value: '7d', label: '7d' },
            { value: '30d', label: '30d' },
            { value: 'never', label: '∞' },
          ]}
        />
      </div>

      {/*
        Superadmin reports on the whole instance rather than this account, so it
        is boxed off from the personal settings above. The flag itself is
        decided server-side from an environment variable.
      */}
      {me.superadmin && stats && (
        <div className="fret-admin">
          <div className="fret-admin__head">
            <span className="fret-admin__dot" />
            <span className="fret-admin__label">{t('admin.label')}</span>
          </div>
          <div className="fret-popover__label" style={{ marginBottom: 4 }}>
            {t('admin.bucket')}
          </div>
          <div className="fret-admin__value">{formatBytes(stats.bucketBytes)}</div>
          <div className="fret-admin__sub">
            {counted(locale, stats.accounts, 'admin.account', 'admin.accountPlural')} ·{' '}
            {counted(locale, stats.bucketObjects, 'admin.object', 'admin.objectPlural')}
          </div>
          <div className="fret-admin__sub">
            {stats.bucket} · {stats.region}
          </div>
        </div>
      )}
    </div>
  )
}
