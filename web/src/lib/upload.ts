/**
 * The upload engine.
 *
 * Parts go straight from the browser to S3 over presigned URLs; this code
 * never routes bytes through the Fret server. That is what lets a 100 GB
 * transfer run at the storage backend's own speed.
 *
 * Three things make it survivable rather than merely fast:
 *
 *   - Every part that lands is reported to the server before the next one is
 *     attempted, so an interrupted upload can be resumed from the gaps.
 *   - Parts are retried with backoff, because one failed PUT out of thousands
 *     is ordinary on a long transfer and should not restart anything.
 *   - Progress is tracked per part from real XHR upload events, so the readout
 *     reflects bytes actually on the wire rather than a timer.
 */

import { api, ApiError, type Transfer, type TransferFile } from './api'

/** How many parts are in flight at once. */
const CONCURRENCY = 4

/** How many URLs are requested per round trip. */
const PRESIGN_BATCH = 50

const MAX_ATTEMPTS = 5
const BASE_BACKOFF_MS = 600

export interface UploadProgress {
  /** Bytes confirmed or in flight, across the whole transfer. */
  uploaded: number
  total: number
  /** 0-100, monotonic. */
  percent: number
  /** Seconds left, or null while there is not enough history to say. */
  secondsRemaining: number | null
  /** Bytes per second over a recent window. */
  bytesPerSecond: number
}

export interface UploadCallbacks {
  onProgress?: (progress: UploadProgress) => void
  onFileComplete?: (fileId: string) => void
  onError?: (error: Error) => void
}

interface PartJob {
  file: TransferFile
  blob: Blob
  partNumber: number
  size: number
}

/**
 * Drives one transfer's upload to completion.
 *
 * An instance is single-use: create it, call start(), and either let it finish
 * or call cancel().
 */
export class Upload {
  private cancelled = false
  private uploadedByPart = new Map<string, number>()
  private confirmed = new Set<string>()
  private inFlight = new Set<XMLHttpRequest>()
  private samples: { at: number; bytes: number }[] = []
  private lastReport = 0

  private readonly transfer: Transfer
  private readonly files: Map<string, File>
  private readonly callbacks: UploadCallbacks
  /** Parts already on the server, by file id — the resume case. */
  private readonly alreadyHave: Map<string, Set<number>>

  constructor(
    transfer: Transfer,
    files: Map<string, File>,
    callbacks: UploadCallbacks = {},
    alreadyHave: Map<string, Set<number>> = new Map(),
  ) {
    this.transfer = transfer
    this.files = files
    this.callbacks = callbacks
    this.alreadyHave = alreadyHave
  }

  get total(): number {
    return this.transfer.totalBytes
  }

  /** Runs the upload. Resolves with the finalized transfer. */
  async start(): Promise<Transfer> {
    // Count parts that arrived in a previous session so progress starts where
    // the last attempt left off rather than at zero.
    for (const file of this.transfer.files) {
      const have = this.alreadyHave.get(file.id)
      if (!have) continue
      for (const partNumber of have) {
        const key = `${file.id}:${partNumber}`
        this.confirmed.add(key)
        this.uploadedByPart.set(key, this.partSize(file, partNumber))
      }
    }
    this.report()

    for (const file of this.transfer.files) {
      if (this.cancelled) throw new CancelledError()
      if (file.status === 'complete') {
        this.callbacks.onFileComplete?.(file.id)
        continue
      }
      await this.uploadFile(file)
      if (this.cancelled) throw new CancelledError()
      await api.completeFile(this.transfer.id, file.id)
      this.callbacks.onFileComplete?.(file.id)
    }

    if (this.cancelled) throw new CancelledError()
    return api.finalize(this.transfer.id)
  }

  /** Stops the upload and abandons in-flight requests. */
  cancel(): void {
    this.cancelled = true
    for (const xhr of this.inFlight) xhr.abort()
    this.inFlight.clear()
  }

  private async uploadFile(file: TransferFile): Promise<void> {
    const source = this.files.get(file.id)
    if (!source) throw new Error(`no local file for ${file.name}`)

    // An empty file has no parts; the server writes the object directly.
    if (file.size === 0) return

    const have = this.alreadyHave.get(file.id) ?? new Set<number>()
    const pending: number[] = []
    for (let n = 1; n <= file.partCount; n++) {
      if (!have.has(n)) pending.push(n)
    }

    // Work through the file in windows, so a file with thousands of parts
    // does not need thousands of URLs signed up front.
    for (let offset = 0; offset < pending.length; offset += PRESIGN_BATCH) {
      if (this.cancelled) throw new CancelledError()
      const batch = pending.slice(offset, offset + PRESIGN_BATCH)
      const { urls } = await api.presignParts(this.transfer.id, file.id, batch)

      const jobs: PartJob[] = batch.map((partNumber) => {
        const start = (partNumber - 1) * file.partSize
        const end = Math.min(start + file.partSize, file.size)
        return {
          file,
          partNumber,
          blob: source.slice(start, end),
          size: end - start,
        }
      })
      await this.runJobs(jobs, urls)
    }
  }

  /** Uploads a window of parts with bounded concurrency. */
  private async runJobs(jobs: PartJob[], urls: Record<string, string>): Promise<void> {
    let next = 0
    const workers = Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
      while (!this.cancelled) {
        const index = next++
        if (index >= jobs.length) return
        const job = jobs[index]
        const url = urls[String(job.partNumber)]
        if (!url) throw new Error(`no upload url for part ${job.partNumber}`)
        await this.uploadPart(job, url)
      }
    })
    await Promise.all(workers)
  }

  /** PUTs one part, retrying transient failures with backoff. */
  private async uploadPart(job: PartJob, url: string): Promise<void> {
    const key = `${job.file.id}:${job.partNumber}`

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (this.cancelled) throw new CancelledError()
      try {
        const etag = await this.put(url, job, key)
        await api.recordPart(this.transfer.id, job.file.id, job.partNumber, etag, job.size)
        this.confirmed.add(key)
        this.uploadedByPart.set(key, job.size)
        this.report(true)
        return
      } catch (error) {
        if (this.cancelled) throw new CancelledError()
        // A part that failed contributed nothing; un-count it so the readout
        // does not drift upward on retries.
        this.uploadedByPart.set(key, 0)
        if (attempt === MAX_ATTEMPTS) {
          throw new Error(
            `part ${job.partNumber} of ${job.file.name} failed after ${MAX_ATTEMPTS} attempts: ${
              error instanceof Error ? error.message : String(error)
            }`,
          )
        }
        await delay(BASE_BACKOFF_MS * 2 ** (attempt - 1) + Math.random() * 250)
      }
    }
  }

  /** A single PUT, reporting progress as the bytes leave. */
  private put(url: string, job: PartJob, key: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      this.inFlight.add(xhr)
      xhr.open('PUT', url, true)

      xhr.upload.onprogress = (event) => {
        this.uploadedByPart.set(key, event.loaded)
        this.report()
      }

      xhr.onload = () => {
        this.inFlight.delete(xhr)
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new Error(`storage returned ${xhr.status}`))
          return
        }
        const etag = xhr.getResponseHeader('ETag')
        if (!etag) {
          // Without ETag exposed through CORS the parts cannot be assembled,
          // and this is by far the most common misconfiguration.
          reject(
            new Error(
              'storage did not expose an ETag header — add ExposeHeaders: ["ETag"] to the bucket CORS policy',
            ),
          )
          return
        }
        resolve(etag.replaceAll('"', ''))
      }

      xhr.onerror = () => {
        this.inFlight.delete(xhr)
        reject(new Error('network error while uploading a part'))
      }
      xhr.onabort = () => {
        this.inFlight.delete(xhr)
        reject(new CancelledError())
      }
      xhr.ontimeout = () => {
        this.inFlight.delete(xhr)
        reject(new Error('timed out uploading a part'))
      }

      xhr.send(job.blob)
    })
  }

  private partSize(file: TransferFile, partNumber: number): number {
    const start = (partNumber - 1) * file.partSize
    return Math.min(file.partSize, Math.max(0, file.size - start))
  }

  /** Recomputes progress and pushes it out, throttled to animation rate. */
  private report(force = false): void {
    const now = performance.now()
    if (!force && now - this.lastReport < 100) return
    this.lastReport = now

    let uploaded = 0
    for (const bytes of this.uploadedByPart.values()) uploaded += bytes
    uploaded = Math.min(uploaded, this.total)

    // A short sliding window keeps the estimate responsive without letting a
    // single slow part swing it wildly.
    this.samples.push({ at: now, bytes: uploaded })
    while (this.samples.length > 2 && now - this.samples[0].at > 8000) this.samples.shift()

    let bytesPerSecond = 0
    if (this.samples.length >= 2) {
      const first = this.samples[0]
      const last = this.samples[this.samples.length - 1]
      const seconds = (last.at - first.at) / 1000
      if (seconds > 0.4) bytesPerSecond = Math.max(0, (last.bytes - first.bytes) / seconds)
    }

    const remainingBytes = Math.max(0, this.total - uploaded)
    const secondsRemaining = bytesPerSecond > 0 ? remainingBytes / bytesPerSecond : null

    this.callbacks.onProgress?.({
      uploaded,
      total: this.total,
      percent: this.total > 0 ? Math.min(100, (uploaded / this.total) * 100) : 100,
      secondsRemaining,
      bytesPerSecond,
    })
  }
}

/** Thrown when an upload is cancelled deliberately. */
export class CancelledError extends Error {
  constructor() {
    super('upload cancelled')
    this.name = 'CancelledError'
  }
}

export function isCancelled(error: unknown): boolean {
  return error instanceof CancelledError
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Reads a drop, expanding any dropped folders.
 *
 * Folders are flattened: the internal structure is discarded and the files
 * arrive as a flat list, which is the behaviour the product settled on. A
 * sender who needs the structure preserved sends one archive instead.
 */
export async function readDrop(dataTransfer: DataTransfer): Promise<File[]> {
  const entries: FileSystemEntry[] = []
  for (const item of Array.from(dataTransfer.items)) {
    if (item.kind !== 'file') continue
    const entry = item.webkitGetAsEntry?.()
    if (entry) entries.push(entry)
  }

  // Without the entries API there is nothing to expand; take the flat list.
  if (entries.length === 0) return Array.from(dataTransfer.files)

  const files: File[] = []
  await Promise.all(entries.map((entry) => walkEntry(entry, files)))
  return files
}

async function walkEntry(entry: FileSystemEntry, out: File[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File | null>((resolve) => {
      ;(entry as FileSystemFileEntry).file(resolve, () => resolve(null))
    })
    // Skip the metadata files a Finder or Explorer drop brings along.
    if (file && !isJunk(file.name)) out.push(file)
    return
  }
  if (!entry.isDirectory) return

  const reader = (entry as FileSystemDirectoryEntry).createReader()
  // readEntries returns at most 100 at a time and must be called until empty.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve) => {
      reader.readEntries(resolve, () => resolve([]))
    })
    if (batch.length === 0) return
    await Promise.all(batch.map((child) => walkEntry(child, out)))
  }
}

function isJunk(name: string): boolean {
  return name === '.DS_Store' || name === 'Thumbs.db' || name === 'desktop.ini'
}

/**
 * Matches files a user re-selected against an unfinished transfer.
 *
 * A page reload destroys the browser's File handles, so resuming cannot happen
 * silently — the user points at the same files again and this pairs them up by
 * name and size. Anything that does not match exactly is treated as a
 * different file, since uploading mismatched parts would corrupt the object.
 */
export function matchResumable(
  resumable: { files: { id: string; name: string; size: number }[] },
  picked: File[],
): Map<string, File> | null {
  const byKey = new Map<string, File>()
  for (const file of picked) byKey.set(`${file.name}:${file.size}`, file)

  const matched = new Map<string, File>()
  for (const wanted of resumable.files) {
    const file = byKey.get(`${wanted.name}:${wanted.size}`)
    if (!file) return null
    matched.set(wanted.id, file)
  }
  return matched
}

export { ApiError }
