/** Typed client for Fret's HTTP API. */

export type Theme = 'system' | 'light' | 'dark'
export type SlugStyle = 'code' | 'words'
export type Expiry = '24h' | '7d' | '30d' | 'never'

export interface User {
  email: string
  name: string
  theme: Theme
  slugStyle: SlugStyle
  slugLength: number
  defaultExpiry: Expiry
}

export interface Me {
  user: User
  initials: string
  superadmin: boolean
  appName: string
  locale: string
  publicHost: string
  region: string
}

export interface TransferFile {
  id: string
  name: string
  size: number
  partSize: number
  partCount: number
  status: 'pending' | 'complete'
}

export interface Transfer {
  id: string
  slug: string
  /** The name the link was first copied under; '' until it has been. */
  sharedSlug: string
  status: 'pending' | 'live'
  expiry: Expiry
  expiresAt: number | null
  totalBytes: number
  files: TransferFile[]
  hasPassword: boolean
  downloads: number
  createdAt: number
}

export interface TransferSummary {
  id: string
  slug: string
  sharedSlug: string
  fileCount: number
  totalBytes: number
  downloads: number
  hasPassword: boolean
  expiry: Expiry
  expiresAt: number | null
  createdAt: number
}

export interface ResumableFile {
  id: string
  name: string
  size: number
  partSize: number
  partCount: number
  status: 'pending' | 'complete'
  havePart: number[]
}

export interface Resumable {
  id: string
  slug: string
  createdAt: number
  totalBytes: number
  uploadedBytes: number
  files: ResumableFile[]
}

export interface PublicFile {
  id: string
  name: string
  size: number
}

export interface PublicTransfer {
  slug: string
  senderName: string
  totalBytes: number
  expiresAt: number | null
  files: PublicFile[]
  locked: boolean
  fileCount: number
}

/**
 * The instance's own identity, readable without a session. The sign-in screen
 * and the recipient page both need it before — or without — anyone signing in.
 */
export interface PublicConfig {
  appName: string
  locale: string
  publicHost: string
  providerHost: string
}

export interface AdminStats {
  bucketBytes: number
  bucketObjects: number
  trackedBytes: number
  accounts: number
  region: string
  bucket: string
}

/** An API failure carrying the server's status and machine-readable code. */
export class ApiError extends Error {
  readonly status: number
  readonly code?: string

  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      credentials: 'same-origin',
      headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
      ...init,
    })
  } catch {
    throw new ApiError(0, 'connection lost', 'offline')
  }

  if (response.status === 204) return undefined as T

  const text = await response.text()
  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
  }

  if (!response.ok) {
    const detail = body as { error?: string; code?: string } | null
    throw new ApiError(response.status, detail?.error ?? response.statusText, detail?.code)
  }
  return body as T
}

const json = (value: unknown) => JSON.stringify(value)

export const api = {
  config: () => request<PublicConfig>('/api/config'),

  me: () => request<Me>('/api/me'),

  savePreferences: (patch: Partial<Pick<User, 'theme' | 'slugStyle' | 'slugLength' | 'defaultExpiry'>>) =>
    request<Me>('/api/me/preferences', { method: 'PATCH', body: json(patch) }),

  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),

  listTransfers: () =>
    request<{ transfers: TransferSummary[]; storageUsed: number }>('/api/transfers'),

  createTransfer: (files: { name: string; size: number; type: string }[]) =>
    request<Transfer>('/api/transfers', { method: 'POST', body: json({ files }) }),

  getTransfer: (id: string) => request<Transfer>(`/api/transfers/${id}`),

  updateTransfer: (
    id: string,
    patch: { slug?: string; password?: string; expiry?: Expiry },
  ) => request<Transfer>(`/api/transfers/${id}`, { method: 'PATCH', body: json(patch) }),

  deleteTransfer: (id: string) =>
    request<{ ok: boolean }>(`/api/transfers/${id}`, { method: 'DELETE' }),

  presignParts: (id: string, fileId: string, parts: number[]) =>
    request<{ urls: Record<string, string> }>(`/api/transfers/${id}/parts`, {
      method: 'POST',
      body: json({ fileId, parts }),
    }),

  recordPart: (id: string, fileId: string, partNumber: number, etag: string, size: number) =>
    request<{ ok: boolean }>(`/api/transfers/${id}/files/${fileId}/parts`, {
      method: 'POST',
      body: json({ partNumber, etag, size }),
    }),

  completeFile: (id: string, fileId: string) =>
    request<{ ok: boolean }>(`/api/transfers/${id}/files/${fileId}/complete`, { method: 'POST' }),

  finalize: (id: string) => request<Transfer>(`/api/transfers/${id}/finalize`, { method: 'POST' }),

  /** Records the name this link was handed out under. */
  markShared: (id: string) => request<Transfer>(`/api/transfers/${id}/shared`, { method: 'POST' }),

  /** Draws a fresh generated name, in whatever style the user prefers. */
  mintSlug: (id: string) => request<Transfer>(`/api/transfers/${id}/slug`, { method: 'POST' }),

  resumable: () => request<{ transfers: Resumable[] }>('/api/transfers/resumable'),

  adminStats: () => request<AdminStats>('/api/admin/stats'),

  publicTransfer: (slug: string) => request<PublicTransfer>(`/api/t/${encodeURIComponent(slug)}`),

  unlock: (slug: string, password: string) =>
    request<PublicTransfer>(`/api/t/${encodeURIComponent(slug)}/unlock`, {
      method: 'POST',
      body: json({ password }),
    }),
}

/** Where a recipient downloads one file. */
export function fileUrl(slug: string, fileId: string): string {
  return `/api/t/${encodeURIComponent(slug)}/files/${encodeURIComponent(fileId)}`
}

/** Where a recipient downloads everything as one archive. */
export function archiveUrl(slug: string): string {
  return `/api/t/${encodeURIComponent(slug)}/archive`
}
