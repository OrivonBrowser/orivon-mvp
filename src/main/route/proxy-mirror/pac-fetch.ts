// Fetches the text of the proxy script the system names, as Chromium fetches one: direct, with no cookies or credentials,
// nothing cached, `http:` and `https:` only, a megabyte and thirty seconds at most, decoded by the charset the answer names
// (a byte-order mark, else Latin-1, when it names none). Tied to Electron through the session it makes for the purpose, which is
// in memory, on `{ mode: 'direct' }` and marked as one that sets a proxy of its own. A failure says why in one word and never
// carries the address or the text.

import type { Session } from 'electron'
import { markOwnProxy } from '../own-proxy.js'
import { within } from '../within.js'

/** The most bytes Chromium reads of a script; one byte more fails the fetch. */
export const MOST_SCRIPT_BYTES = 1_048_576
/** The longest Chromium waits for a script. */
export const SCRIPT_FETCH_MS = 30_000

export type PacFetchFailure = 'scheme' | 'credentials' | 'status' | 'size' | 'time' | 'network' | 'charset'

export class PacFetchFailed extends Error {
  constructor (readonly failure: PacFetchFailure) {
    super(`the proxy script could not be fetched (${failure})`)
  }
}

/** What a fetch needs of a session. */
export type PacFetchSession = Pick<Session, 'fetch' | 'setProxy'>

const BYTE_ORDER_MARKS: ReadonlyArray<readonly [readonly number[], string]> = [[[0xfe, 0xff], 'utf-16be'], [[0xff, 0xfe], 'utf-16le'], [[0xef, 0xbb, 0xbf], 'utf-8']]
const LATIN1 = new Set(['iso-8859-1', 'iso8859-1', 'latin1', 'l1', 'us-ascii', 'ascii'])

/** The charset a `Content-Type` names, or undefined. */
function charsetOf (contentType: string | null): string | undefined {
  const found = /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(contentType ?? '')
  return found?.[1]?.toLowerCase()
}

/** The text of `bytes` as Chromium reads a script: by the charset named, else by a byte-order mark, else as Latin-1. Undefined for a charset nothing here decodes. */
function decode (bytes: Buffer, charset: string | undefined): string | undefined {
  let label = charset
  let body = bytes
  if (label === undefined) {
    const mark = BYTE_ORDER_MARKS.find(([prefix]) => prefix.every((byte, at) => bytes[at] === byte))
    if (mark !== undefined) {
      label = mark[1]
      body = bytes.subarray(mark[0].length)
    }
  }
  if (label === undefined || LATIN1.has(label)) return body.toString('latin1')
  try {
    return new TextDecoder(label).decode(body)
  } catch {
    return undefined
  }
}

/** The address as a fetch may use it: `http:` or `https:` with no user name or password. */
function checkedAddress (url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new PacFetchFailed('scheme')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new PacFetchFailed('scheme')
  if (parsed.username !== '' || parsed.password !== '') throw new PacFetchFailed('credentials')
  return parsed.href
}

/** The body of `response`, cancelled once it passes the most a script may be. */
async function bodyOf (response: Response): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MOST_SCRIPT_BYTES) throw new PacFetchFailed('size')
  const reader = response.body?.getReader()
  if (reader === undefined) return Buffer.alloc(0)
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MOST_SCRIPT_BYTES) {
      await reader.cancel().catch(() => {})
      throw new PacFetchFailed('size')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

/**
 * The fetch of a proxy script. `makeSession` is called once, the first time a script is asked for, and the session it returns is put on
 * `{ mode: 'direct' }` before any request goes out; a request never leaves in a session that follows the system or a tunnel.
 */
export function createPacFetch (makeSession: () => PacFetchSession): (url: string) => Promise<string> {
  let ready: Promise<PacFetchSession> | undefined
  const direct = async (): Promise<PacFetchSession> => {
    const made = makeSession()
    markOwnProxy(made)
    await made.setProxy({ mode: 'direct' })
    return made
  }

  return async (url) => {
    const address = checkedAddress(url)
    ready ??= direct().catch((error: unknown) => {
      ready = undefined
      throw error
    })
    const pending = ready
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, SCRIPT_FETCH_MS)
    try {
      return await within((async () => {
        const session = await pending
        let response: Response
        try {
          response = await session.fetch(address, { credentials: 'omit', cache: 'no-store', redirect: 'follow', signal: controller.signal })
        } catch {
          throw new PacFetchFailed(controller.signal.aborted ? 'time' : 'network')
        }
        if (response.status !== 200) throw new PacFetchFailed('status')
        if (response.url !== '') checkedAddress(response.url)
        const text = decode(await bodyOf(response), charsetOf(response.headers.get('content-type')))
        if (text === undefined) throw new PacFetchFailed('charset')
        return text
      })(), SCRIPT_FETCH_MS + 1_000, 'the proxy script took too long').catch((error: unknown) => {
        if (error instanceof PacFetchFailed) throw error
        throw new PacFetchFailed(controller.signal.aborted || (error instanceof Error && error.message === 'the proxy script took too long') ? 'time' : 'network')
      })
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
  }
}
