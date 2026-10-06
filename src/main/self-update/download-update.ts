// Fetches a release's package into <userData>/pending-update, and keeps it only if it is exactly what the signed
// manifest lists. The address may redirect to GitHub's asset host: what is trusted is the signed hash, not the host.
import { mkdir, open, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { consumeDownload } from './download-verify.js'
import type { ManifestFile } from './update-manifest.js'

/** The part of `fetch` the download uses: what `net.fetch` and a test's stand-in both provide. */
export type FetchLike = (url: string, init?: { credentials?: 'omit', redirect?: 'follow', signal?: AbortSignal, headers?: Record<string, string> }) => Promise<Response>

/** How long the server may take to start answering, and how long the body may go without a byte. A download has no total limit. */
export const CONNECT_TIMEOUT_MS = 30_000
export const IDLE_TIMEOUT_MS = 60_000

export const PENDING_DIR = 'pending-update'

/** Removes whatever an earlier download left, at start and before a new one. Never throws. */
export async function clearPending (dir: string): Promise<void> {
  try {
    for (const name of await readdir(dir)) await rm(join(dir, name), { recursive: true, force: true })
  } catch { /* no folder: nothing to clear */ }
}

/** The body's pieces, ending the read with an error when `idleMs` passes without one. */
export async function * idleBounded (body: ReadableStream<Uint8Array>, idleMs: number, abort: () => void): AsyncGenerator<Uint8Array> {
  const reader = body.getReader()
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const idle = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { abort(); reject(new Error('The download stalled: no data arrived for a minute.')) }, idleMs)
      })
      let step: ReadableStreamReadResult<Uint8Array>
      try {
        step = await Promise.race([reader.read(), idle])
      } finally {
        clearTimeout(timer)
      }
      if (step.done) return
      yield step.value
    }
  } finally {
    reader.cancel().catch(() => {})
  }
}

export interface DownloadRequest {
  readonly fetch: FetchLike
  readonly url: string
  /** The folder the package lands in. */
  readonly dir: string
  readonly file: ManifestFile
  readonly progress: (received: number, total: number) => void
  readonly idleMs?: number
  readonly connectMs?: number
}

/** The path of the verified package. Rejects with a sentence for the person, having left nothing in `dir`. */
export async function downloadUpdate (request: DownloadRequest): Promise<string> {
  const { dir, file } = request
  await clearPending(dir)
  await mkdir(dir, { recursive: true })
  const part = join(dir, `${file.name}.part`)
  const controller = new AbortController()
  const connect = setTimeout(() => { controller.abort() }, request.connectMs ?? CONNECT_TIMEOUT_MS)
  const handle = await open(part, 'w', 0o600)
  try {
    let response: Response
    try {
      response = await request.fetch(request.url, { credentials: 'omit', redirect: 'follow', signal: controller.signal })
    } finally {
      clearTimeout(connect)
    }
    if (!response.ok) throw new Error(`GitHub answered ${String(response.status)} for the package.`)
    if (response.body === null) throw new Error('GitHub sent no data for the package.')
    const chunks = idleBounded(response.body, request.idleMs ?? IDLE_TIMEOUT_MS, () => { controller.abort() })
    const verdict = await consumeDownload(chunks, file, async (chunk) => { await handle.write(chunk) }, (received) => { request.progress(received, file.size) })
    if (!verdict.ok) throw new Error(verdict.reason)
    await handle.sync()
    await handle.close()
    const done = join(dir, file.name)
    await rename(part, done)
    return done
  } catch (error) {
    await handle.close().catch(() => {})
    await rm(part, { force: true })
    throw error instanceof Error && error.name !== 'AbortError' ? error : new Error('The download could not be completed.')
  }
}
