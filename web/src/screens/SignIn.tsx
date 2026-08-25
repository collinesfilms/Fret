/**
 * The sign-in screen.
 *
 * One control, and no way to create an account. The identity provider owns
 * every credential; Fret only learns who arrived.
 */

import { Caret, Key, Panel } from '../components/Device'
import { translate, type Locale } from '../lib/i18n'

export function SignIn({
  locale,
  appName,
  providerHost,
  error,
}: {
  locale: Locale
  appName: string
  providerHost: string
  error?: string | null
}) {
  const t = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) =>
    translate(locale, key, vars)

  return (
    <div className="fret-stage">
      <Panel
        style={{
          maxWidth: 352,
          padding: '26px 24px 24px',
          gap: 0,
        }}
      >
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
            aria-hidden="true"
            style={{
              width: 7,
              height: 7,
              borderRadius: 999,
              background: 'var(--accent)',
              boxShadow: '0 0 6px var(--accent), inset 0 1px 1px rgba(255,255,255,.5)',
            }}
          />
        </div>

        <div
          className="fret-screen"
          style={{ margin: '22px 0 24px', borderRadius: 12 }}
        >
          <div className="fret-screen__inner" style={{ padding: '26px 20px' }}>
            <div className="fret-screen__stripLabel">{t('signin.session')}</div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                marginTop: 10,
                fontSize: 26,
                fontWeight: 500,
                letterSpacing: '-0.03em',
                color: 'var(--screenFg)',
              }}
            >
              {t('signin.signedOut')}
              <Caret fontSize={26} />
            </div>
            <div className="fret-screen__hint" style={{ marginTop: 14 }}>
              {t('signin.noAccounts')}
            </div>
            <div className="fret-screen__hint" style={{ marginTop: 3 }}>
              {error ?? t('signin.providerHandles')}
            </div>
          </div>
        </div>

        <Key
          className="fret-key--wide"
          onClick={() => {
            // A full navigation, not fetch: the provider owns the next screen.
            window.location.href = '/auth/login'
          }}
        >
          {providerHost
            ? t('signin.continue', { provider: providerHost })
            : t('signin.continueGeneric')}
        </Key>

        {providerHost && (
          <div
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 8.5,
              letterSpacing: '0.14em',
              color: 'var(--fg3)',
              textAlign: 'center',
              marginTop: 16,
            }}
          >
            {providerHost}
          </div>
        )}
      </Panel>
    </div>
  )
}
