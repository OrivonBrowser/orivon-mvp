// A request for a host the shell serves from a copy it keeps (an allowed app: its pinned files, or the verifier read live
// under a check) is handed to the shell, which answers it with the handler that app's partition uses. This is the host's
// half: it relays the request over the parent port and writes what comes back to the socket exactly as given, so the
// answer is the same whichever session asked. Flow control and the shell's half: `../../../main/verifier/README.md`.

import { timingSafeEqual } from 'node:crypto'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import { OWN_READ_HEADER } from '../../../loader/fetch/content-root.js'
import { isOwnSiteRequest } from '../../../loader/fetch/own-site-request.js'
import { MAX_RELAYS } from '../protocol.js'
import type { FromHost, HeaderPairs, RelayToHost } from '../protocol.js'

/** Request headers that belong to this connection or describe a body the relay does not carry, and the mark of the shell's own reads. */
const NOT_RELAYED_REQUEST = new Set(['host', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'content-length', OWN_READ_HEADER])

/** Response headers that belong to the connection the shell's answer was not made on. */
const NOT_RELAYED_RESPONSE = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer'])

/**
 * How long a relayed answer may go without a message from the shell, nor a write the socket finished, before it is cut. The
 * shell's own wait for a gateway is longer than any single step here, so this ends only an answer that was lost.
 */
export const RELAY_IDLE_MS = 5 * 60_000

export interface ShellRelayDeps {
  readonly post: (message: FromHost) => void
  /**
   * The secret a read of the shell's own carries (`loader/fetch/own-read.ts`), which this server never hands back to the shell.
   * Absent, nothing is relayed: a request could not be told from the shell's own, and a handler that reads this server would
   * be sent its own read again.
   */
  readonly ownReadToken: string | undefined
  readonly idleMs?: number
  /** Most requests held at once; further ones are answered 503. Defaults to `MAX_RELAYS`. */
  readonly limit?: number
}

interface Relayed {
  readonly res: ServerResponse
  readonly extraCsp: string
  headSent: boolean
  timer: NodeJS.Timeout | undefined
}

/** `rawHeaders` as pairs, names in lower case, without what must not cross. */
function relayedHeaders (req: IncomingMessage): HeaderPairs {
  const pairs: Array<readonly [string, string]> = []
  for (let at = 0; at + 1 < req.rawHeaders.length; at += 2) {
    const name = (req.rawHeaders[at] ?? '').toLowerCase()
    if (name !== '' && !NOT_RELAYED_REQUEST.has(name)) pairs.push([name, req.rawHeaders[at + 1] ?? ''])
  }
  return pairs
}

function isHeaderPairs (value: unknown): value is HeaderPairs {
  return Array.isArray(value) && value.every((pair) => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' && typeof pair[1] === 'string')
}

/** The hosts of the default-port `https:` origins in `origins`: the only ones this server could be asked for. */
function hostsOf (origins: readonly string[]): Set<string> {
  const hosts = new Set<string>()
  for (const origin of origins) {
    try {
      const parsed = new URL(origin)
      if (parsed.protocol === 'https:' && parsed.port === '' && parsed.origin === origin) hosts.add(parsed.hostname)
    } catch {
      // Not an origin: nothing is served for it.
    }
  }
  return hosts
}

export class ShellRelay {
  private served = new Set<string>()
  private pinned = new Set<string>()
  private readonly open = new Map<number, Relayed>()
  private nextId = 1

  constructor (private readonly deps: ShellRelayDeps) {}

  /**
   * The origins the shell now serves, and those of them it serves from a pin; only a default-port `https:` origin is a host
   * this server could be asked for. Replaces the sets held. A pinned origin has no bytes to fetch, so a tunnel profile's
   * request for it may be handed over; one served live reads the network, and stays on the path that leaves through the tunnel.
   */
  setServed (origins: readonly string[], pinned: readonly string[] = []): void {
    this.served = hostsOf(origins)
    this.pinned = hostsOf(pinned)
  }

  private isOwnRead (headers: IncomingHttpHeaders): boolean {
    const mark = headers[OWN_READ_HEADER]
    const token = this.deps.ownReadToken
    if (typeof mark !== 'string' || token === undefined) return false
    const given = Buffer.from(mark)
    const wanted = Buffer.from(token)
    return given.length === wanted.length && timingSafeEqual(given, wanted)
  }

  /**
   * Whether the shell answers this request: its host is one the shell serves, the request is not a read the shell made itself,
   * and the browser made it for the site (`loader/fetch/own-site-request.ts`). A request of a tunnel profile (`tunnelled`) is
   * the shell's only while the app is served from its pin. Anything else is answered as it always was, so no page can time an
   * allowed app's host and learn it is installed (A256), and a read for a tunnel still leaves through it.
   */
  wants (host: string, headers: IncomingHttpHeaders, tunnelled = false): boolean {
    if (this.deps.ownReadToken === undefined || !this.served.has(host) || this.isOwnRead(headers)) return false
    if (tunnelled && !this.pinned.has(host)) return false
    return isOwnSiteRequest(headers)
  }

  /** Hands `req` to the shell. `extraCsp` goes on the answer as a policy of its own, whatever policy the shell's answer carries: what every answer this server writes says of where it came from and who may frame it. */
  relay (req: IncomingMessage, res: ServerResponse, target: URL, extraCsp: string): void {
    if (this.open.size >= (this.deps.limit ?? MAX_RELAYS)) {
      res.writeHead(503, { 'content-type': 'text/plain', 'cache-control': 'no-store', 'retry-after': '1' }).end('the verifier is relaying too many requests to the shell right now')
      return
    }
    const id = this.nextId++
    const state: Relayed = { res, extraCsp, headSent: false, timer: undefined }
    this.open.set(id, state)
    // The client left, or the answer is complete: only the first leaves the shell something to stop.
    res.once('close', () => {
      if (this.open.get(id) !== state) return
      this.forget(id, state)
      this.deps.post({ type: 'relay-abort', id })
    })
    this.touch(id, state)
    this.deps.post({ type: 'relay-request', id, method: req.method ?? 'GET', url: target.href, headers: relayedHeaders(req) })
  }

  /** What the shell says of a request it was handed. A message for a request that is gone (its client left) is dropped. */
  receive (message: RelayToHost): void {
    const state = this.open.get(message.id)
    if (state === undefined) return
    switch (message.type) {
      case 'relay-head': this.head(message.id, state, message.status, message.headers); break
      case 'relay-body': this.body(message.id, state, message.chunk); break
      case 'relay-end':
        if (!state.headSent) { this.fail(message.id, state, 'the shell ended its answer before it began one'); break }
        this.forget(message.id, state)
        state.res.end()
        break
      case 'relay-error':
        // The shell had no answer (its handler failed, or refused with a network error): the request fails as a load does, with no page of ours in its place.
        console.error(`[verifier] the shell could not answer a relayed request: ${message.message}`)
        this.forget(message.id, state)
        state.res.destroy()
        break
    }
  }

  /** Cuts every request still waiting for the shell, as the server shuts down. */
  dispose (): void {
    for (const [id, state] of [...this.open]) {
      this.forget(id, state)
      state.res.destroy()
    }
  }

  private head (id: number, state: Relayed, status: unknown, headers: unknown): void {
    if (state.headSent || typeof status !== 'number' || !Number.isInteger(status) || status < 200 || status > 599 || !isHeaderPairs(headers)) {
      this.fail(id, state, 'the shell sent an answer this server cannot write')
      return
    }
    const flat: string[] = []
    for (const [name, value] of headers) {
      if (!NOT_RELAYED_RESPONSE.has(name.toLowerCase())) flat.push(name, value)
    }
    flat.push('content-security-policy', state.extraCsp)
    try {
      state.res.writeHead(status, flat)
    } catch (error) {
      this.fail(id, state, `the shell sent headers this server cannot write: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    state.headSent = true
    this.touch(id, state)
  }

  private body (id: number, state: Relayed, chunk: unknown): void {
    if (!state.headSent || !(chunk instanceof Uint8Array)) {
      this.fail(id, state, 'the shell sent a body this server cannot write')
      return
    }
    this.touch(id, state)
    const length = chunk.byteLength
    // Written means the socket took the chunk: that is what lets the shell send the next, so what waits here is never more than its window.
    state.res.write(chunk, (error) => {
      if (error !== null && error !== undefined) return
      if (this.open.get(id) !== state) return
      this.touch(id, state)
      this.deps.post({ type: 'relay-wrote', id, bytes: length })
    })
  }

  /** The answer cannot go on: the shell is told to stop, and the client's connection is cut. */
  private fail (id: number, state: Relayed, why: string): void {
    console.error(`[verifier] ${why}`)
    this.forget(id, state)
    this.deps.post({ type: 'relay-abort', id })
    state.res.destroy()
  }

  private forget (id: number, state: Relayed): void {
    if (state.timer !== undefined) clearTimeout(state.timer)
    state.timer = undefined
    this.open.delete(id)
  }

  private touch (id: number, state: Relayed): void {
    if (state.timer !== undefined) clearTimeout(state.timer)
    state.timer = setTimeout(() => {
      if (this.open.get(id) === state) this.fail(id, state, 'a relayed request had no word from the shell for too long')
    }, this.deps.idleMs ?? RELAY_IDLE_MS)
    state.timer.unref()
  }
}
