/**
 * Interface strings.
 *
 * The locale is an instance-wide setting supplied by the server from an
 * environment variable, not a per-user preference: an operator picks the
 * language their team works in. Adding a language means adding one entry here.
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
  'app.resumable': 'unfinished upload',
  'app.resumeHint': 'reselect the same files to resume',
  'app.failed': 'upload failed',
  'app.retry': 'Retry',

  'settings.link': 'LINK',
  'settings.password': 'PASSWORD',
  'settings.expires': 'EXPIRES',
  'settings.passwordNone': 'none',
  'settings.passwordKept': 'unchanged',

  'key.uploading': 'Uploading {percent}%',
  'key.save': 'Save settings',
  'key.update': 'Update live link',
  'key.saved': 'Saved · copy link',
  'key.copied': 'Copied to clipboard',
  'key.live': 'Link is live · copy again',
  'key.copy': 'Copy link',
  'key.open': 'OPEN',
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
  'sheet.results': '{count} results',
  'sheet.empty': 'no transfers yet',
  'sheet.noResults': 'nothing matches',
  'sheet.files': 'files',
  'sheet.downloads': '{count} downloads',
  'sheet.noDownloads': 'no downloads',

  'action.copy': 'COPY',
  'action.edit': 'EDIT',
  'action.open': 'OPEN',
  'action.delete': 'DELETE',

  'edit.title': 'Edit transfer',
  'edit.save': 'Save changes',
  'edit.noChanges': 'No changes',
  'edit.delete': 'Delete',
  'edit.confirmDelete': 'Delete for good?',

  'prefs.theme': 'THEME',
  'prefs.slug': 'LINK STYLE',
  'prefs.slugLength': 'LENGTH',
  'prefs.expiry': 'DEFAULT EXPIRY',
  'prefs.signedInVia': 'SIGNED IN VIA',
  'prefs.storage': 'YOUR STORAGE',
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
} as const

export type StringKey = keyof typeof en

const fr: Record<StringKey, string> = {
  'signin.session': 'SESSION',
  'signin.signedOut': 'Déconnecté',
  'signin.noAccounts': 'aucun compte · oidc uniquement',
  'signin.providerHandles': 'identifiants gérés par le fournisseur',
  'signin.continue': 'Continuer avec {provider}',
  'signin.continueGeneric': 'Continuer avec le SSO',
  'signin.failed': 'échec de la connexion · réessayez',
  'signin.expired': 'connexion expirée · réessayez',
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
  'app.resumable': 'envoi inachevé',
  'app.resumeHint': 'resélectionnez les mêmes fichiers',
  'app.failed': "échec de l'envoi",
  'app.retry': 'Réessayer',

  'settings.link': 'LIEN',
  'settings.password': 'MOT DE PASSE',
  'settings.expires': 'EXPIRE',
  'settings.passwordNone': 'aucun',
  'settings.passwordKept': 'inchangé',

  'key.uploading': 'Envoi {percent}%',
  'key.save': 'Enregistrer',
  'key.update': 'Mettre à jour le lien',
  'key.saved': 'Enregistré · copier',
  'key.copied': 'Copié',
  'key.live': 'Lien actif · copier',
  'key.copy': 'Copier le lien',
  'key.open': 'VOIR',
  'key.new': 'NOUVEAU',
  'key.cancel': 'ANNULER',

  'sheet.title': 'Transferts',
  'sheet.subtitle': '{links} · {size}',
  'sheet.search': 'Rechercher',
  'sheet.all': 'Tous',
  'sheet.expiring': 'Bientôt',
  'sheet.password': 'Protégés',
  'sheet.statActive': 'ACTIFS',
  'sheet.statStorage': 'STOCKAGE',
  'sheet.statExpiring': 'EXPIRE 24H',
  'sheet.newestFirst': '{links} · récents',
  'sheet.results': '{count} résultats',
  'sheet.empty': 'aucun transfert',
  'sheet.noResults': 'aucun résultat',
  'sheet.files': 'fichiers',
  'sheet.downloads': '{count} téléchargements',
  'sheet.noDownloads': 'aucun téléchargement',

  'action.copy': 'COPIER',
  'action.edit': 'MODIFIER',
  'action.open': 'VOIR',
  'action.delete': 'SUPPRIMER',

  'edit.title': 'Modifier le transfert',
  'edit.save': 'Enregistrer',
  'edit.noChanges': 'Aucun changement',
  'edit.delete': 'Supprimer',
  'edit.confirmDelete': 'Supprimer définitivement ?',

  'prefs.theme': 'THÈME',
  'prefs.slug': 'STYLE DE LIEN',
  'prefs.slugLength': 'LONGUEUR',
  'prefs.expiry': 'EXPIRATION',
  'prefs.signedInVia': 'CONNECTÉ VIA',
  'prefs.storage': 'VOTRE STOCKAGE',
  'prefs.themeSystem': 'Auto',
  'prefs.themeLight': 'Clair',
  'prefs.themeDark': 'Sombre',
  'prefs.slugCode': 'Code',
  'prefs.slugWords': 'Mots',
  'prefs.signOut': 'Déconnexion',

  'admin.label': 'superadmin',
  'admin.bucket': 'Bucket, tous comptes',
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
}

const catalogs: Record<Locale, Record<StringKey, string>> = { en, fr }

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
