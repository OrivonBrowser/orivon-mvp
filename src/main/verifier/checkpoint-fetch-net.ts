// The requests the checkpoint renewal makes: a GET of a beacon server's finalized header, block root or bootstrap, through Orivon's own
// request path so a tunnel and secure DNS apply (`ownFetch`); to a beacon server of the person's on this computer or their home
// network, straight over Node's sockets instead, never a proxy or a tunnel. Tied to Electron through `net`; the rule that decides
// what the answers are worth is checkpoint-fetch.ts.

import { ownFetch } from '../route/own-requests.js'
import { createLocalRpcFetch } from '../../protocols/verifier-host/local-rpc-fetch.js'
import { displayEndpoint } from '../../protocols/verifier-host/light-client/endpoint-mask.js'
import { BOOTSTRAP_SEGMENT, MalformedAnswer, NotFoundAnswer } from './checkpoint-fetch.js'

/** One request's whole time to answer; a whole attempt is cut off at `ATTEMPT_DEADLINE_MS` however many requests it makes. */
export const BEACON_TIMEOUT_MS = 6_000
/** A finalized header is about a kilobyte: anything far beyond that is not one. */
export const MAX_ANSWER_BYTES = 64 * 1024
/** A bootstrap carries a 512-key sync committee and is about 55 kilobytes. */
export const MAX_BOOTSTRAP_BYTES = 512 * 1024

let localFetch: ReturnType<typeof createLocalRpcFetch> | undefined

/**
 * Rejects when the server cannot be reached or answers with an error status, with `NotFoundAnswer` on a 404, and with
 * `MalformedAnswer` when the body is not JSON or is too large. `local` is the address of the person's beacon server when it is
 * on this computer or their home network: a request under it is made by the local fetch, which refuses any other address. The
 * errors name the server masked, because its address may hold a key.
 */
export async function beaconJson (url: string, local?: string): Promise<unknown> {
  const init = {
    headers: { accept: 'application/json' },
    redirect: 'error',
    credentials: 'omit',
    signal: AbortSignal.timeout(BEACON_TIMEOUT_MS)
  } as const
  let response: Response
  if (local !== undefined && url.startsWith(local)) {
    localFetch ??= createLocalRpcFetch()
    response = await localFetch(url, init)
  } else {
    const { net } = await import('electron')
    response = await ownFetch(async (target, options) => await net.fetch(target, options))(url, init)
  }
  const shown = displayEndpoint(url)
  if (response.status === 404) throw new NotFoundAnswer(`${shown} answered 404`)
  if (!response.ok) throw new Error(`${shown} answered ${String(response.status)}`)
  const text = await readCapped(response, url.includes(BOOTSTRAP_SEGMENT) ? MAX_BOOTSTRAP_BYTES : MAX_ANSWER_BYTES)
  try {
    return JSON.parse(text)
  } catch {
    throw new MalformedAnswer(`${shown} did not answer with JSON`)
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
