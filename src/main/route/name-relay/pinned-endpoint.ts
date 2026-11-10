// The name relay's listener for a caller that checks an address before it reads (a tab's icon, a CCIP-Read gateway): the caller
// has the relay look the name up once (`relayLookup`), judges the answer, and pins the host and port to the address it cleared;
// this listener then connects to that address and to nothing else. It never looks a name up, and it refuses a host and port
// nobody pinned. Electron-free: the system's answer is handed in, and a session is pointed at `config` by whoever reads.

import { isIP } from 'node:net'
import type { Socket } from 'node:net'
import { startRouteFront } from '../front.js'
import type { FrontTarget } from '../front.js'
import type { RouteChallengeSource } from '../lookup-session.js'
import type { SystemProxyConfig } from '../system-follow.js'
import { routedBypassRules } from '../verifier-name-guard.js'
import { RelayRefusal } from './relay-failures.js'
import type { RefusalWord, RelayFailures } from './relay-failures.js'
import type { RelayHostLookup } from './relay-lookup.js'
import { createRelayOpener } from './relay-opener.js'

/** One connection the endpoint made: the host asked for, the address connected to, and the road (the proxy's word, or `DIRECT`). */
export interface ConnectedReport {
  readonly host: string
  readonly port: number
  readonly address: string
  readonly road: string
}

export interface PinnedEndpoint {
  /** What the caller's session takes: every scheme to this endpoint, the names the verifier serves bypassed. */
  readonly config: SystemProxyConfig
  /** What a proxy challenge from this endpoint's own port is answered with, and undefined for a challenge from anywhere else. */
  readonly credentials: RouteChallengeSource
  /** Pins `host:port` to `address` until `untilMs` (a `Date.now()` time; a minute from now when left out); replaces an earlier pin of the same host and port. */
  pin: (host: string, port: number, address: string, untilMs?: number) => void
  /** Each connection the endpoint made. Returns what stops the listening. */
  onConnected: (listener: (report: ConnectedReport) => void) => () => void
  close: () => Promise<void>
}

export interface PinnedEndpointOptions {
  /** Which proxy the system names for a URL: T20's `resolveProxy` string. */
  readonly systemAnswer: (url: string) => Promise<string>
  /** Called with the word of every connection the endpoint refused. */
  readonly onRefused?: (word: RefusalWord) => void
  readonly now?: () => number
}

/** How long a pin lasts when the caller names no time, and how many an endpoint keeps (the oldest is dropped). */
export const PIN_MS = 60_000
export const MAX_PINS = 256

interface Pin {
  readonly until: number
  readonly open: (target: FrontTarget) => Promise<Socket>
}

const keyOf = (host: string, port: number): string => `${host.replace(/^\[(.*)\]$/, '$1').toLowerCase().replace(/\.$/, '')}:${String(port)}`

const live = new Set<PinnedEndpoint>()

/** What a proxy challenge from any live pinned endpoint is answered with: the route controller asks it beside the fronts and the relay's listener, so a request made from main signs in and the broker refuses an app's socket to the port. */
export const pinnedCredentials: RouteChallengeSource = (info) => {
  for (const endpoint of live) {
    const credentials = endpoint.credentials(info)
    if (credentials !== undefined) return credentials
  }
  return undefined
}

export async function pinnedEndpoint (options: PinnedEndpointOptions): Promise<PinnedEndpoint> {
  const now = options.now ?? Date.now
  const pins = new Map<string, Pin>()
  const listeners = new Set<(report: ConnectedReport) => void>()
  const refused = (word: RefusalWord): void => {
    try {
      options.onRefused?.(word)
    } catch {
      // A count that fails is not the connection's business.
    }
  }
  const counting: RelayFailures = { note: (_host, _port, word) => { refused(word) }, reasonFor: () => undefined }
  const report = (target: FrontTarget, address: string, road: string): void => {
    for (const listener of [...listeners]) {
      try {
        listener({ host: target.host, port: target.port, address, road })
      } catch {
        // A listener that fails is its own.
      }
    }
  }

  /** An opener for one address: its lookups answer that address and no other, so the relay's own steps run unchanged and nothing is asked of a resolver. */
  const openerFor = (address: string): Pin['open'] => createRelayOpener({
    systemAnswer: options.systemAnswer,
    lookup: async ({ family }) => isIP(address) === family ? [address] : [],
    lookupDirect: async () => [address],
    failures: counting,
    connected: report
  })

  const front = await startRouteFront({
    open: async (target) => {
      const key = keyOf(target.host, target.port)
      const pin = pins.get(key)
      if (pin === undefined || pin.until <= now()) {
        pins.delete(key)
        refused('unpinned')
        throw new RelayRefusal('unpinned')
      }
      return await pin.open(target)
    }
  })

  const endpoint: PinnedEndpoint = {
    config: { mode: 'fixed_servers', proxyRules: `http://127.0.0.1:${String(front.port)}`, proxyBypassRules: routedBypassRules().join(';') },
    credentials: (info) => info.isProxy && info.host === '127.0.0.1' && info.port === front.port ? { username: front.username, password: front.secret } : undefined,
    pin: (host, port, address, untilMs) => {
      if (isIP(address) === 0) throw new TypeError('a pin is an IP address')
      if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new TypeError('a pin is for a port')
      const key = keyOf(host, port)
      pins.delete(key)
      pins.set(key, { until: untilMs ?? now() + PIN_MS, open: openerFor(address) })
      while (pins.size > MAX_PINS) pins.delete(pins.keys().next().value as string)
    },
    onConnected: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    close: async () => {
      live.delete(endpoint)
      pins.clear()
      listeners.clear()
      await front.close()
    }
  }
  live.add(endpoint)
  return endpoint
}

/** What a caller of the relay needs of it while it runs. Whoever runs the relay installs it, and removes it when the relay stops. */
export interface RelayCallers {
  readonly lookup: RelayHostLookup
  readonly systemAnswer: (url: string) => Promise<string>
  readonly onRefused?: (word: RefusalWord) => void
}

let callers: RelayCallers | undefined
let shared: Promise<PinnedEndpoint> | undefined

export function installRelayCallers (next: RelayCallers | undefined): void {
  const old = shared
  shared = undefined
  callers = next
  void old?.then(async (endpoint) => { await endpoint.close() }, () => {})
}

/** The relay's lookup for a caller's check, or undefined while the relay is not active: the caller then keeps its own lookup and its own road. */
export function relayLookup (): RelayHostLookup | undefined {
  return callers?.lookup
}

/** The pinned endpoint the callers in main share, started when first asked for; undefined while the relay is not active. */
export function sharedPinnedEndpoint (): Promise<PinnedEndpoint> | undefined {
  const current = callers
  if (current === undefined) return undefined
  if (shared === undefined) {
    const started = pinnedEndpoint({ systemAnswer: current.systemAnswer, ...(current.onRefused === undefined ? {} : { onRefused: current.onRefused }) })
    shared = started
    // A listener that could not start is tried again by the next caller.
    started.catch(() => { if (shared === started) shared = undefined })
  }
  return shared
}
