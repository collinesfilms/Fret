/**
 * The app chrome above the device: the active-transfers pill on the left, and
 * theme, settings and account on the right.
 */

import { useEffect, useRef, useState } from 'react'
import { api, type AdminStats, type Expiry, type Me, type SlugStyle, type Theme } from '../lib/api'
import { formatBytes, pad2 } from '../lib/format'
import { translate, type Locale, type StringKey } from '../lib/i18n'
import { Segmented } from './Controls'

interface TopBarProps {
  me: Me
  locale: Locale
  activeCount: number
  storageUsed: number
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
  storageUsed,
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

        {menu === 'settings' && (
          <SettingsPopover
            me={me}
            locale={locale}
            storageUsed={storageUsed}
            onUpdateMe={onUpdateMe}
          />
        )}
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
  me,
  locale,
  storageUsed,
  onUpdateMe,
}: {
  me: Me
  locale: Locale
  storageUsed: number
  onUpdateMe: (me: Me) => void
}) {
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [saving, setSaving] = useState(false)
  const t = (key: StringKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars)

  useEffect(() => {
    if (!me.superadmin) return
    api.adminStats().then(setStats).catch(() => setStats(null))
  }, [me.superadmin])

  const save = async (patch: Parameters<typeof api.savePreferences>[0]) => {
    setSaving(true)
    try {
      onUpdateMe(await api.savePreferences(patch))
    } catch {
      // A failed preference save is not worth interrupting anyone over; the
      // control simply stays where it was.
    } finally {
      setSaving(false)
    }
  }

  const issuer = me.user.email || me.user.name

  return (
    <div className="fret-popover" style={{ opacity: saving ? 0.7 : 1 }}>
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
        {/* Length only means something for the code style. */}
        {me.user.slugStyle === 'code' && (
          <div className="fret-popover__row" style={{ borderTop: 'none', paddingBottom: 0 }}>
            <span className="fret-popover__label">{t('prefs.slugLength')}</span>
            <input
              type="range"
              min={4}
              max={16}
              step={1}
              value={me.user.slugLength}
              onChange={(e) => save({ slugLength: Number(e.target.value) })}
              style={{ flex: 1, accentColor: 'var(--fg2)' }}
              aria-label={t('prefs.slugLength')}
            />
            <span className="fret-popover__value" style={{ marginLeft: 0, minWidth: 18 }}>
              {me.user.slugLength}
            </span>
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

      <div className="fret-popover__row">
        <span className="fret-popover__label">{t('prefs.signedInVia')}</span>
        <span className="fret-popover__value" title={issuer}>
          {issuer}
        </span>
      </div>

      <div className="fret-popover__stack">
        <div className="fret-popover__stackLabel">{t('prefs.storage')}</div>
        <div className="fret-popover__value" style={{ textAlign: 'left', marginLeft: 0 }}>
          {formatBytes(storageUsed)}
        </div>
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
            {t('admin.accounts', { accounts: stats.accounts, objects: stats.bucketObjects })}
          </div>
          <div className="fret-admin__sub">
            {stats.bucket} · {stats.region}
          </div>
        </div>
      )}
    </div>
  )
}
