/**
 * Interface strings.
 *
 * The locale is an instance-wide setting supplied by the server from
 * `FRET_LOCALE`, not a per-user preference: an operator picks the language
 * their team works in. Adding a language means adding one catalog below and
 * one arm to `resolveLocale`.
 *
 * `en` is the source of truth — its keys generate `StringKey`, so every other
 * catalog is a `Record<StringKey, string>` and TypeScript fails the build on a
 * key that is missing or misspelt. Adding an English string and forgetting the
 * French one is a compile error, not a run-time fallback.
 *
 * Two rules worth knowing before editing a value:
 *
 *   1. **Some of these live in boxes with a fixed width.** The file tile in
 *      the transfers list is 41px square (36px on a phone) and `sheet.files`
 *      has to fit inside it, which is why French says `fich.` and not
 *      `fichiers`. `npm run audit:i18n` measures every string in a real
 *      browser and fails on anything that overflows — run it after editing.
 *
 *   2. **A count and its noun have to agree.** French adjectives inflect where
 *      English ones do not (`1 fichier · prêt` but `4 fichiers · prêts`), so
 *      anything that takes a `{count}` has a singular key and a plural one and
 *      is looked up through `counted`.
 */

export type Locale = 'en' | 'fr'

const en = {
  'signin.session': 'SESSION',
  'signin.signedOut': 'Signed out',
  'signin.noAccounts': 'no accounts · oidc only',
  'signin.providerHandles': 'provider handles credentials',
  'signin.continue': 'Continue with {provider}',
  'signin.continueGeneric': 'Continue with single sign-on',
  'signin.failed': 'sign-in failed · try again',
  'signin.expired': 'sign-in timed out · try again',
  'signin.unreachable': 'provider unreachable',

  'app.active': 'active',
  'app.ready': 'READY',
  'app.drop': 'Drop your files',
  'app.browse': 'click to browse',
  'app.release': 'Release',
  'app.releaseStrip': 'release to upload',
  'app.uploading': 'uploading',
  'app.complete': 'upload complete',
  'app.readyCount': '{count} · ready',
  'app.readyCountPlural': '{count} · ready',
  'app.resumable': 'unfinished upload',
  'app.resumeHint': 'reselect the same files to resume',
  'app.failed': 'upload failed',
  'app.retry': 'Retry',

  'settings.link': 'LINK',
  'settings.password': 'PASSWORD',
  'settings.expires': 'EXPIRES',
  'settings.passwordNone': 'none',
  'settings.passwordKept': 'unchanged',
  'settings.passwordClear': 'CLEAR',
  'settings.slugDraw': 'SHUFFLE',
  'settings.slugDrawHint': 'Draw another link',
  'settings.slugReset': 'RESET',
  'settings.slugResetHint': 'Back to the generated link',
  'settings.linkConsequence': 'the link you sent will stop working',

  'tag.sharedAs': 'PREVIOUS LINK',
  'tag.restore': 'RESTORE',
  'tag.note': 'still reserved for you',

  'key.waiting': 'Waiting for upload',
  'key.copied': 'Copied to clipboard',
  'key.copy': 'Copy link',
  'key.open': 'OPEN',
  'key.options': 'OPTIONS',
  'key.new': 'NEW',
  'key.cancel': 'CANCEL',

  'sheet.title': 'Transfers',
  'sheet.subtitle': '{links} · {size}',
  'sheet.search': 'Search transfers',
  'sheet.all': 'All',
  'sheet.expiring': 'Expiring',
  'sheet.password': 'Password',
  'sheet.statActive': 'ACTIVE',
  'sheet.statStorage': 'STORAGE',
  'sheet.statExpiring': 'EXPIRING 24H',
  'sheet.newestFirst': '{links} · newest first',
  'sheet.result': '{count} result',
  'sheet.results': '{count} results',
  'sheet.empty': 'no transfers yet',
  'sheet.noResults': 'nothing matches',
  /* The unit under the figure on a 41px tile — 36px on a phone. Whatever this
     says has to fit in that box at five or six characters. */
  'sheet.files': 'files',
  'sheet.andMore': '+{count}',
  'sheet.loadingFiles': 'reading…',
  'sheet.download': '{count} download',
  'sheet.downloads': '{count} downloads',
  'sheet.noDownloads': 'no downloads',

  'action.copy': 'COPY',
  'action.copied': 'COPIED',
  'action.edit': 'EDIT',
  'action.open': 'OPEN',
  'action.delete': 'DELETE',
  /* Every surface that can be dismissed carries one of these somewhere, and
     none of them is a word anybody sees — they are what a screen reader
     announces for a control whose whole job is a shape. */
  'action.close': 'Close',
  'action.download': 'Download {name}',

  'edit.title': 'Edit transfer',
  'edit.save': 'Save changes',
  'edit.noChanges': 'No changes',
  'edit.delete': 'Delete',

  'delete.title': 'Delete this transfer?',
  'delete.note': 'The link stops working and the files are removed from storage. This cannot be undone.',
  'delete.keep': 'Keep it',
  'delete.confirm': 'Delete',

  'prefs.theme': 'THEME',
  'prefs.slug': 'LINK STYLE',
  'prefs.slugLength': 'LENGTH',
  'prefs.slugLengthShort': 'SHORT',
  'prefs.expiry': 'DEFAULT EXPIRY',
  'prefs.themeSystem': 'Auto',
  'prefs.themeLight': 'Light',
  'prefs.themeDark': 'Dark',
  'prefs.slugCode': 'Code',
  'prefs.slugWords': 'Words',
  'prefs.signOut': 'Sign out',

  'admin.label': 'superadmin',
  'admin.bucket': 'Bucket, all users',
  'admin.account': '{count} account',
  'admin.accountPlural': '{count} accounts',
  'admin.object': '{count} object',
  'admin.objectPlural': '{count} objects',

  'recipient.ready': 'ready to download',
  'recipient.sent': '{name} sent you {count}',
  'recipient.sentAnon': 'You were sent {count}',
  'recipient.downloadAll': 'Download all · {size}',
  'recipient.downloadOne': 'Download · {size}',
  'recipient.locked': 'Password required',
  'recipient.lockedStrip': 'locked',
  'recipient.enterPassword': 'Enter password',
  'recipient.unlock': 'Unlock',
  'recipient.wrongPassword': 'that password is not right',
  'recipient.tooMany': 'too many attempts · wait a while',
  'recipient.notFound': 'This link does not exist',
  'recipient.notFoundStrip': 'not found',
  'recipient.expired': 'This link has expired',
  'recipient.expiredStrip': 'expired',
  'recipient.expiresIn': '{countdown}',

  'error.slugTaken': 'that link is taken',
  'error.slugInvalid': 'letters, numbers and dashes',
  'error.generic': 'something went wrong',
  'error.offline': 'connection lost',

  'file.count': '{count} file',
  'file.countPlural': '{count} files',
  'link.count': '{count} link',
  'link.countPlural': '{count} links',

  /*
   * Machine-produced values. They are set in mono and built in `format.ts`,
   * but the words inside them are still words — an English `expires in 3d`
   * under a French interface is the tell that a translation stopped at the
   * components.
   */
  'expiry.none': 'no expiry',
  'expiry.expired': 'expired',
  'expiry.minutes': 'expires in {n}m',
  'expiry.hours': 'expires in {n}h',
  'expiry.days': 'expires in {n}d',

  /* The four segments of the expiry track. Units, so they are mono and short:
     French writes a thin gap before the unit and counts days as `j`. */
  'expiry.opt24h': '24h',
  'expiry.opt7d': '7d',
  'expiry.opt30d': '30d',
  'expiry.optNever': 'never',

  'upload.estimating': 'estimating',
  'upload.secondsLeft': '{s} s remaining',
  'upload.minutesLeft': '{m} min remaining',
  'upload.hoursLeft': '{h} h {m} min remaining',
  'upload.percentOf': '% of {size}',

  /*
   * Byte units. English counts bytes, French counts octets — `1,25 Go` is what
   * a French file manager shows, down to the decimal comma.
   */
  'bytes.b': 'B',
  'bytes.kb': 'KB',
  'bytes.mb': 'MB',
  'bytes.gb': 'GB',
  'bytes.decimal': '.',
} as const

export type StringKey = keyof typeof en

/*
 * French.
 *
 * Not a gloss of the English. Where the two languages say a thing differently
 * this follows French, and where French runs long enough to break a fixed box
 * it says the shorter true thing rather than the longer literal one:
 *
 *   sheet.files      `fich.`, because `fichiers` does not fit a 41px tile
 *   key.copied       `Lien copié`, not `Copié dans le presse-papiers` — the
 *                    literal is 28 characters into a key that holds about 18,
 *                    and the key is mid-exchange with `Copier le lien` when it
 *                    lands, so an ellipsis there is a visible stumble
 *   sheet.expiring   `Bientôt`, the way a French filter chip is written
 *   sheet.password   `Protégés`, describing the transfers rather than naming
 *                    the field, which is what the English chip does too
 *   prefs.expiry     `EXPIRATION`; `PAR DÉFAUT` is what a preference means
 *
 * `\u00A0` is a non-breaking space. French sets one before `?` `!` `:` `;` and
 * between a figure and its unit, and it is written as an escape here so it is
 * visible to whoever edits this next.
 */
const fr: Record<StringKey, string> = {
  'signin.session': 'SESSION',
  'signin.signedOut': 'Déconnecté',
  'signin.noAccounts': 'aucun compte · oidc uniquement',
  'signin.providerHandles': 'identifiants gérés par le fournisseur',
  'signin.continue': 'Continuer avec {provider}',
  'signin.continueGeneric': 'Continuer avec le SSO',
  'signin.failed': 'échec de la connexion · réessayez',
  'signin.expired': 'délai dépassé · réessayez',
  'signin.unreachable': 'fournisseur injoignable',

  'app.active': 'actifs',
  'app.ready': 'PRÊT',
  'app.drop': 'Déposez vos fichiers',
  'app.browse': 'cliquez pour parcourir',
  'app.release': 'Relâchez',
  'app.releaseStrip': 'relâchez pour envoyer',
  'app.uploading': 'envoi',
  'app.complete': 'envoi terminé',
  'app.readyCount': '{count} · prêt',
  'app.readyCountPlural': '{count} · prêts',
  'app.resumable': 'envoi inachevé',
  'app.resumeHint': 'sélectionnez à nouveau les mêmes fichiers',
  'app.failed': "échec de l'envoi",
  'app.retry': 'Réessayer',

  'settings.link': 'LIEN',
  'settings.password': 'MOT DE PASSE',
  'settings.expires': 'EXPIRE',
  'settings.passwordNone': 'aucun',
  'settings.passwordKept': 'inchangé',
  'settings.passwordClear': 'EFFACER',
  'settings.slugDraw': 'AUTRE',
  'settings.slugDrawHint': 'Générer un autre lien',
  'settings.slugReset': 'RÉTABLIR',
  'settings.slugResetHint': 'Revenir au lien généré',
  'settings.linkConsequence': 'le lien envoyé cessera de fonctionner',

  'tag.sharedAs': 'LIEN PRÉCÉDENT',
  'tag.restore': 'RESTAURER',
  'tag.note': 'toujours réservé pour vous',

  'key.waiting': "En attente de l'envoi",
  'key.copied': 'Lien copié',
  'key.copy': 'Copier le lien',
  'key.open': 'VOIR',
  'key.options': 'OPTIONS',
  'key.new': 'NOUVEAU',
  'key.cancel': 'ANNULER',

  'sheet.title': 'Transferts',
  'sheet.subtitle': '{links} · {size}',
  'sheet.search': 'Rechercher un transfert',
  'sheet.all': 'Tous',
  'sheet.expiring': 'Bientôt',
  'sheet.password': 'Protégés',
  'sheet.statActive': 'ACTIFS',
  'sheet.statStorage': 'STOCKAGE',
  'sheet.statExpiring': 'EXPIRATION 24H',
  'sheet.newestFirst': '{links} · du plus récent',
  'sheet.result': '{count} résultat',
  'sheet.results': '{count} résultats',
  'sheet.empty': 'aucun transfert',
  'sheet.noResults': 'aucun résultat',
  'sheet.files': 'fich.',
  'sheet.andMore': '+{count}',
  'sheet.loadingFiles': 'lecture…',
  'sheet.download': '{count} téléchargement',
  'sheet.downloads': '{count} téléchargements',
  'sheet.noDownloads': 'aucun téléchargement',

  'action.copy': 'COPIER',
  'action.copied': 'COPIÉ',
  'action.edit': 'MODIFIER',
  'action.open': 'VOIR',
  'action.delete': 'SUPPRIMER',
  'action.close': 'Fermer',
  'action.download': 'Télécharger {name}',

  'edit.title': 'Modifier le transfert',
  'edit.save': 'Enregistrer',
  'edit.noChanges': 'Aucun changement',
  'edit.delete': 'Supprimer',

  'delete.title': 'Supprimer ce transfert\u00A0?',
  'delete.note':
    "Le lien cessera de fonctionner et les fichiers seront supprimés du stockage. C'est irréversible.",
  'delete.keep': 'Conserver',
  'delete.confirm': 'Supprimer',

  'prefs.theme': 'THÈME',
  'prefs.slug': 'STYLE DE LIEN',
  'prefs.slugLength': 'LONGUEUR',
  'prefs.slugLengthShort': 'COURT',
  'prefs.expiry': 'EXPIRATION',
  'prefs.themeSystem': 'Auto',
  'prefs.themeLight': 'Clair',
  'prefs.themeDark': 'Sombre',
  'prefs.slugCode': 'Code',
  'prefs.slugWords': 'Mots',
  'prefs.signOut': 'Déconnexion',

  'admin.label': 'superadmin',
  'admin.bucket': 'Bucket, tous les comptes',
  'admin.account': '{count} compte',
  'admin.accountPlural': '{count} comptes',
  'admin.object': '{count} objet',
  'admin.objectPlural': '{count} objets',

  'recipient.ready': 'prêt à télécharger',
  'recipient.sent': '{name} vous a envoyé {count}',
  'recipient.sentAnon': 'Vous avez reçu {count}',
  'recipient.downloadAll': 'Tout télécharger · {size}',
  'recipient.downloadOne': 'Télécharger · {size}',
  'recipient.locked': 'Mot de passe requis',
  'recipient.lockedStrip': 'verrouillé',
  'recipient.enterPassword': 'Mot de passe',
  'recipient.unlock': 'Déverrouiller',
  'recipient.wrongPassword': 'mot de passe incorrect',
  'recipient.tooMany': 'trop de tentatives · patientez',
  'recipient.notFound': "Ce lien n'existe pas",
  'recipient.notFoundStrip': 'introuvable',
  'recipient.expired': 'Ce lien a expiré',
  'recipient.expiredStrip': 'expiré',
  'recipient.expiresIn': '{countdown}',

  'error.slugTaken': 'lien déjà pris',
  'error.slugInvalid': 'lettres, chiffres et tirets',
  'error.generic': 'une erreur est survenue',
  'error.offline': 'connexion perdue',

  'file.count': '{count} fichier',
  'file.countPlural': '{count} fichiers',
  'link.count': '{count} lien',
  'link.countPlural': '{count} liens',

  'expiry.none': 'sans expiration',
  'expiry.expired': 'expiré',
  'expiry.minutes': 'expire dans {n}\u00A0min',
  'expiry.hours': 'expire dans {n}\u00A0h',
  'expiry.days': 'expire dans {n}\u00A0j',

  'expiry.opt24h': '24\u00A0h',
  'expiry.opt7d': '7\u00A0j',
  'expiry.opt30d': '30\u00A0j',
  'expiry.optNever': 'jamais',

  'upload.estimating': 'estimation',
  'upload.secondsLeft': '{s}\u00A0s restantes',
  'upload.minutesLeft': '{m}\u00A0min restantes',
  'upload.hoursLeft': '{h}\u00A0h {m}\u00A0min restantes',
  'upload.percentOf': '% de {size}',

  'bytes.b': 'o',
  'bytes.kb': 'Ko',
  'bytes.mb': 'Mo',
  'bytes.gb': 'Go',
  'bytes.decimal': ',',
}

/** Exported so `npm run audit:i18n` can measure every string it holds. */
export const catalogs: Record<Locale, Record<StringKey, string>> = { en, fr }

/** Resolves an unknown locale to the one Fret always ships. */
export function resolveLocale(locale: string | undefined): Locale {
  return locale === 'fr' ? 'fr' : 'en'
}

/** Looks up a string and substitutes {named} placeholders. */
export function translate(
  locale: Locale,
  key: StringKey,
  vars?: Record<string, string | number>,
): string {
  const template = catalogs[locale][key] ?? en[key] ?? key
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  )
}

/** Renders a file count in the active locale. */
export function fileCount(locale: Locale, count: number): string {
  return translate(locale, count === 1 ? 'file.count' : 'file.countPlural', { count })
}

/** Renders a count with a noun that has its own singular and plural keys. */
export function counted(
  locale: Locale,
  count: number,
  singular: StringKey,
  plural: StringKey,
): string {
  return translate(locale, count === 1 ? singular : plural, { count })
}

/**
 * Picks the key that agrees with a count, for a phrase whose `{count}` is an
 * already-rendered string rather than a bare figure — `4 fichiers · prêts`
 * inflects on the number of files, but the number arrives inside `{count}`.
 */
export function agreeing(count: number, singular: StringKey, plural: StringKey): StringKey {
  return count === 1 ? singular : plural
}
