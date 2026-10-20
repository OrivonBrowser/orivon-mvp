// The one request the checkpoint renewal makes: a GET of a beacon server's finalized header, through Orivon's own
// request path so a tunnel and secure DNS apply (`ownFetch`). Tied to Electron through `net`; the rule that decides
// what the answers are worth is checkpoint-fetch.ts.

import { ownFetch } from '../route/own-requests.js'
import { MalformedAnswer } from './checkpoint-fetch.js'

/** One server's whole time to answer; the pair is asked together, so the renewal takes about this long at worst. */
export const BEACON_TIMEOUT_MS = 6_000
/** A finalized header is about a kilobyte: anything far beyond that is not one. */
export const MAX_ANSWER_BYTES = 64 * 1024

/** Rejects when the server cannot be reached or answers with an error status, and with `MalformedAnswer` when the body is not JSON or is too large. */
export async function beaconJson (url: string): Promise<unknown> {
  const { net } = await import('electron')
  const response = await ownFetch(async (target, init) => await net.fetch(target, init))(url, {
    headers: { accept: 'application/json' },
    redirect: 'error',
    credentials: 'omit',
    signal: AbortSignal.timeout(BEACON_TIMEOUT_MS)
  })
  if (!response.ok) throw new Error(`${url} answered ${String(response.status)}`)
  const text = await readCapped(response)
  try {
    return JSON.parse(text)
  } catch {
    throw new MalformedAnswer(`${url} did not answer with JSON`)
  }
}

async function readCapped (response: Response): Promise<string> {
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_ANSWER_BYTES) {
      await reader.cancel()
      throw new MalformedAnswer('the answer is larger than a header can be')
    }
    chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}
