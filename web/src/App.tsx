/**
 * Application shell: theme, routing and the shared transfer list.
 *
 * Routing is deliberately minimal. Fret has exactly two addresses — the app at
 * "/" and a recipient page at "/<slug>" — so a router library would be more
 * machinery than the product has states.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { DeleteModal } from './components/DeleteModal'
import { EditModal } from './components/EditModal'
import { TopBar } from './components/TopBar'
import { TransfersSheet, type EngagedAction } from './components/TransfersSheet'
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
  const [deleting, setDeleting] = useState<TransferSummary | null>(null)
  // Which row action opened the modal, so that cell can stay visibly pressed.
  const [engaged, setEngaged] = useState<EngagedAction | null>(null)
  /*
   * On a phone the modal replaces the sheet rather than stacking on it, and
   * the sheet comes back when the modal closes. Two stacked sheets never feel
   * like anything but a mistake.
   */
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 640px)').matches)
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
    const media = window.matchMedia('(max-width: 640px)')
    const onChange = (event: MediaQueryListEvent) => setNarrow(event.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
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

    /*
     * Tell the browser what colour its own furniture should be.
     *
     * Left to itself Safari samples the page and lands near the background
     * rather than on it, which on a phone drew a seam across the top of the
     * screen and another under it — the status bar and the toolbar each a
     * slightly different grey from the app between them. It cannot be a
     * static tag in the head, because the theme here is a stored preference
     * that changes without a reload, so the value is read back out of the
     * palette that is actually in force.
     */
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    if (meta) {
      const background = getComputedStyle(document.documentElement)
        .getPropertyValue('--bg')
        .trim()
      if (background) meta.content = background
    }
  }, [resolvedTheme])

  /*
   * The part of the screen that is actually visible, published as two custom
   * properties.
   *
   * A modal is `position: fixed`, which on iOS means fixed to the layout
   * viewport — and the layout viewport does not shrink when the keyboard
   * comes up. So a dialog centred the obvious way is centred on a screen half
   * of which is behind the keyboard, and the editor's buttons end up under
   * it. The visual viewport is the one that knows, so the modal is centred on
   * that instead. offsetTop matters as much as the height: Safari also slides
   * the visible region up to follow a focused field, and a modal that ignored
   * that would drift as you typed.
   *
   * Everything falls back to the dynamic viewport height, which is right on
   * every browser without a keyboard in the way.
   */
  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return
    const publish = () => {
      const style = document.documentElement.style
      style.setProperty('--fret-vvH', `${viewport.height}px`)
      style.setProperty('--fret-vvTop', `${viewport.offsetTop}px`)
    }
    publish()
    viewport.addEventListener('resize', publish)
    viewport.addEventListener('scroll', publish)
    return () => {
      viewport.removeEventListener('resize', publish)
      viewport.removeEventListener('scroll', publish)
    }
  }, [])

  useEffect(() => {
    const name = me?.appName ?? config?.appName
    if (name) document.title = name
  }, [me, config])

  /*
   * The document's language, which the markup cannot know: `index.html` is a
   * static file and the locale arrives from the server. It is what decides
   * whether a screen reader pronounces this interface as French, and whether
   * the browser offers to translate a page that is already in the reader's
   * language.
   */
  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

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

  /**
   * Opens a recipient link the way you would send it: in its own tab.
   *
   * Previewing in place replaced the transfer you were working on, and coming
   * back meant the browser's back button rather than closing what you opened.
   */
  const openRecipient = useCallback((target: string) => {
    window.open(`/${target}`, '_blank', 'noopener,noreferrer')
  }, [])

  /*
   * The editor opens over the sheet rather than in place of it.
   *
   * On a phone the sheet used to be dismissed first, because the modal's
   * scrim sat underneath it. That made editing one field cost three
   * movements — the sheet leaving, the modal arriving, the keyboard rising —
   * and a fourth when the sheet slid back afterwards. The scrim now covers
   * the sheet, so nothing has to move out of the way.
   */
  const openEditor = (transfer: TransferSummary, action: EngagedAction['action']) => {
    setEngaged({ id: transfer.id, action })
    setEditing(transfer)
  }

  const closeEditor = () => {
    setEditing(null)
    setEngaged(null)
  }

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
        onOpenRecipient={openRecipient}
      />

      <TransfersSheet
        open={sheetOpen}
        locale={locale}
        transfers={transfers}
        storageUsed={storageUsed}
        publicHost={session.me.publicHost}
        engaged={engaged}
        onClose={() => setSheetOpen(false)}
        onCopy={copyLink}
        onEdit={(transfer) => openEditor(transfer, 'edit')}
        onOpen={openRecipient}
        onDelete={(transfer) => {
          setEngaged({ id: transfer.id, action: 'delete' })
          setDeleting(transfer)
        }}
      />

      {/*
        Editing and deleting are separate surfaces. Delete used to open the
        editor with its own delete already armed, which meant arriving on a
        form you had not asked for, under a title that said "Edit transfer",
        with one control mid-gesture.
      */}
      {editing && (
        <EditModal
          transfer={editing}
          locale={locale}
          besideSheet={sheetOpen && !narrow}
          onClose={closeEditor}
          onSaved={refreshTransfers}
          onDelete={() => {
            setEditing(null)
            setDeleting(editing)
          }}
        />
      )}

      {deleting && (
        <DeleteModal
          transfer={deleting}
          locale={locale}
          onClose={() => {
            setDeleting(null)
            setEngaged(null)
          }}
          onDeleted={refreshTransfers}
        />
      )}
    </div>
  )
}
