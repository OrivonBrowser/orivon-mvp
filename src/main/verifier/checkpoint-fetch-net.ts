// The requests the checkpoint renewal makes: a GET of a beacon server's finalized header, block root or bootstrap, through Orivon's own
// request path so a tunnel and secure DNS apply (`ownFetch`). Tied to Electron through `net`; the rule that decides
// what the answers are worth is checkpoint-fetch.ts.

import { ownFetch } from '../route/own-requests.js'
import { BOOTSTRAP_SEGMENT, MalformedAnswer, NotFoundAnswer } from './checkpoint-fetch.js'

/** One request's whole time to answer; the servers are asked together for the finalized head, then one request at a time, so a renewal that meets a slow server takes a few of these. */
export const BEACON_TIMEOUT_MS = 6_000
/** A finalized header is about a kilobyte: anything far beyond that is not one. */
export const MAX_ANSWER_BYTES = 64 * 1024
/** A bootstrap carries a 512-key sync committee and is about 55 kilobytes. */
export const MAX_BOOTSTRAP_BYTES = 512 * 1024

/** Rejects when the server cannot be reached or answers with an error status, with `NotFoundAnswer` on a 404, and with `MalformedAnswer` when the body is not JSON or is too large. */
export async function beaconJson (url: string): Promise<unknown> {
  const { net } = await import('electron')
  const response = await ownFetch(async (target, init) => await net.fetch(target, init))(url, {
    headers: { accept: 'application/json' },
    redirect: 'error',
    credentials: 'omit',
    signal: AbortSignal.timeout(BEACON_TIMEOUT_MS)
  })
  if (response.status === 404) throw new NotFoundAnswer(`${url} answered 404`)
  if (!response.ok) throw new Error(`${url} answered ${String(response.status)}`)
  const text = await readCapped(response, url.includes(BOOTSTRAP_SEGMENT) ? MAX_BOOTSTRAP_BYTES : MAX_ANSWER_BYTES)
  try {
    return JSON.parse(text)
  } catch {
    throw new MalformedAnswer(`${url} did not answer with JSON`)
  }
}

async function readCapped (response: Response, limit: number): Promise<string> {
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel()
      throw new MalformedAnswer('the answer is larger than a header can be')
    }
    chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}
