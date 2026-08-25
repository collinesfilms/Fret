/**
 * Application shell: theme, routing and the shared transfer list.
 *
 * Routing is deliberately minimal. Fret has exactly two addresses — the app at
 * "/" and a recipient page at "/<slug>" — so a router library would be more
 * machinery than the product has states.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { EditModal } from './components/EditModal'
import { TopBar } from './components/TopBar'
import { TransfersSheet } from './components/TransfersSheet'
import { api, ApiError, type Me, type PublicConfig, type TransferSummary } from './lib/api'
import { resolveLocale, translate, type Locale } from './lib/i18n'
import { Recipient } from './screens/Recipient'
import { SignIn } from './screens/SignIn'
import { TransferScreen } from './screens/TransferScreen'

type Session = { kind: 'loading' } | { kind: 'out' } | { kind: 'in'; me: Me }

export function App() {
  const [session, setSession] = useState<Session>({ kind: 'loading' })
  const [path, setPath] = useState(() => window.location.pathname)
  const [transfers, setTransfers] = useState<TransferSummary[]>([])
  const [storageUsed, setStorageUsed] = useState(0)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [editing, setEditing] = useState<TransferSummary | null>(null)
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  )
  const [config, setConfig] = useState<PublicConfig | null>(null)
  const [configLoaded, setConfigLoaded] = useState(false)

  const slug = path.replace(/^\/+/, '').split('/')[0]
  const isRecipient = slug !== ''

  // Sign-in failures come back as a query parameter on the redirect home.
  const signinError = useMemo(() => {
    const reason = new URLSearchParams(window.location.search).get('signin')
    if (!reason) return null
    if (reason === 'expired') return 'signin.expired' as const
    if (reason === 'provider_unreachable') return 'signin.unreachable' as const
    return 'signin.failed' as const
  }, [])

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname)
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    // The instance's identity is public, so it loads for recipients and for
    // anyone who has not signed in.
    api
      .config()
      .then(setConfig)
      .catch(() => setConfig(null))
      .finally(() => setConfigLoaded(true))
    api
      .me()
      .then((me) => setSession({ kind: 'in', me }))
      .catch(() => setSession({ kind: 'out' }))
  }, [])

  const me = session.kind === 'in' ? session.me : null
  const locale: Locale = resolveLocale(me?.locale ?? config?.locale)

  /*
   * The stored theme wins once the account has loaded, so the choice follows a
   * user between devices. Until then the pre-paint script's value stands, which
   * is what keeps a dark reload from flashing white.
   */
  const resolvedTheme: 'light' | 'dark' = useMemo(() => {
    const preference = me?.user.theme ?? 'system'
    if (preference === 'light' || preference === 'dark') return preference
    return systemDark ? 'dark' : 'light'
  }, [me?.user.theme, systemDark])

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme
    try {
      localStorage.setItem('fret.theme', resolvedTheme)
    } catch {
      // Private browsing refuses storage; the theme still applies this session.
    }
  }, [resolvedTheme])

  useEffect(() => {
    const name = me?.appName ?? config?.appName
    if (name) document.title = name
  }, [me, config])

  const refreshTransfers = useCallback(() => {
    if (session.kind !== 'in') return
    api
      .listTransfers()
      .then(({ transfers: list, storageUsed: used }) => {
        setTransfers(list ?? [])
        setStorageUsed(used ?? 0)
      })
      .catch((err: unknown) => {
        // A dropped session should return to sign-in rather than sit empty.
        if (err instanceof ApiError && err.status === 401) setSession({ kind: 'out' })
      })
  }, [session.kind])

  useEffect(() => {
    refreshTransfers()
  }, [refreshTransfers])

  const navigate = useCallback((to: string) => {
    window.history.pushState({}, '', to)
    setPath(to)
  }, [])

  const signOut = async () => {
    await api.logout().catch(() => undefined)
    setSession({ kind: 'out' })
    setTransfers([])
  }

  const copyLink = async (slugToCopy: string) => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/${slugToCopy}`)
    } catch {
      // Nothing to recover: the link is visible in the row.
    }
  }

  // Nothing renders until the instance has introduced itself, so a renamed
  // deployment never flashes the default name at anyone.
  if (session.kind === 'loading' || !configLoaded) {
    return <div className="fret-studio" />
  }

  // A recipient link renders for anyone, signed in or not.
  if (isRecipient) {
    return (
      <div className="fret-studio">
        <Recipient
          slug={slug}
          locale={locale}
          appName={config?.appName ?? me?.appName ?? 'Fret'}
          publicHost={config?.publicHost ?? me?.publicHost ?? window.location.host}
        />
      </div>
    )
  }

  if (session.kind === 'out') {
    return (
      <div className="fret-studio">
        <SignIn
          locale={locale}
          appName={config?.appName ?? 'Fret'}
          providerHost={config?.providerHost ?? ''}
          error={signinError ? translate(locale, signinError) : null}
        />
      </div>
    )
  }

  return (
    <div className="fret-studio">
      <TopBar
        me={session.me}
        locale={locale}
        activeCount={transfers.length}
        resolvedTheme={resolvedTheme}
        onToggleTheme={() => {
          const next = resolvedTheme === 'dark' ? 'light' : 'dark'
          setSession({ kind: 'in', me: { ...session.me, user: { ...session.me.user, theme: next } } })
          api.savePreferences({ theme: next }).catch(() => undefined)
        }}
        onOpenSheet={() => setSheetOpen(true)}
        onUpdateMe={(next) => setSession({ kind: 'in', me: next })}
        onSignOut={signOut}
      />

      <TransferScreen
        me={session.me}
        locale={locale}
        onTransfersChanged={refreshTransfers}
        onOpenRecipient={(target) => navigate(`/${target}`)}
      />

      <TransfersSheet
        open={sheetOpen}
        locale={locale}
        transfers={transfers}
        storageUsed={storageUsed}
        publicHost={session.me.publicHost}
        onClose={() => setSheetOpen(false)}
        onCopy={copyLink}
        onEdit={(transfer) => setEditing(transfer)}
        onOpen={(target) => {
          setSheetOpen(false)
          navigate(`/${target}`)
        }}
        onDelete={(transfer) => setEditing(transfer)}
      />

      {editing && (
        <EditModal
          transfer={editing}
          locale={locale}
          onClose={() => setEditing(null)}
          onSaved={refreshTransfers}
          onDeleted={refreshTransfers}
        />
      )}
    </div>
  )
}
