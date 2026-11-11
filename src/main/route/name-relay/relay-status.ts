// What the name relay is doing, as fixed words and counts: the one place `orivon://report` and the log read it from. No
// name, address, URL or proxy is ever part of it. Pure: no `electron`.

import { REFUSAL_WORDS } from './relay-failures.js'
import type { RefusalWord } from './relay-failures.js'
import type { DohProvider } from './proxied-lookup.js'

/**
 * `off`: the switch is off. `held`: the switch is on in a private window held to Nym, where nothing follows the system and the relay never
 * starts. `idle`: on, and no proxy applies. `relaying`: on, a proxy applies and the listener is up. `down`: a proxy applies and the
 * listener is not up, so the sessions that follow the system fail until it is started again.
 */
export type RelayState = 'off' | 'idle' | 'relaying' | 'held' | 'down'

export interface NameRelayStatus {
  readonly state: RelayState
  /** The DNS-over-HTTPS provider the lookups ask. */
  readonly provider: DohProvider
  /** `held`: Chromium's own resolver is held at this computer's DNS while the relay is active. */
  readonly resolver: 'setting' | 'held'
  /** How many connections each word stopped in this run. */
  readonly refused: Readonly<Record<RefusalWord, number>>
}

export interface RelayStatusFacts {
  readonly enabled: boolean
  readonly heldToNym: boolean
  readonly active: boolean
  readonly listening: boolean
  readonly resolverHeld: boolean
  readonly provider: DohProvider
  readonly refused: Readonly<Record<RefusalWord, number>>
}

export function nameRelayStatus (facts: RelayStatusFacts): NameRelayStatus {
  let state: RelayState
  if (!facts.enabled) state = 'off'
  else if (facts.heldToNym) state = 'held'
  else if (!facts.active) state = 'idle'
  else state = facts.listening ? 'relaying' : 'down'
  return { state, provider: facts.provider, resolver: facts.resolverHeld ? 'held' : 'setting', refused: Object.fromEntries(REFUSAL_WORDS.map((word) => [word, facts.refused[word]])) as Record<RefusalWord, number> }
}

/** The provider as a person reads it, for the sheet and the words about the setting. */
export function providerName (provider: DohProvider): string {
  return provider === 'cloudflare' ? 'Cloudflare' : 'Quad9'
}

const NOT_STARTED: NameRelayStatus = nameRelayStatus({ enabled: false, heldToNym: false, active: false, listening: false, resolverHeld: false, provider: 'quad9', refused: Object.fromEntries(REFUSAL_WORDS.map((word) => [word, 0])) as Record<RefusalWord, number> })

let current: (() => NameRelayStatus) | undefined

/** Called once at start by whoever runs the relay. */
export function setNameRelayStatusSource (next: (() => NameRelayStatus) | undefined): void {
  current = next
}

export function currentNameRelayStatus (): NameRelayStatus {
  return current?.() ?? NOT_STARTED
}

type ReasonSource = (host: string, port: number) => RefusalWord | undefined

let reasons: ReasonSource | undefined

/** Called once at start by whoever runs the relay: what it noted, in the last half minute, for a host and port. */
export function setRelayReasonSource (next: ReasonSource | undefined): void {
  reasons = next
}

/** Why the relay did not carry the `https:` load of `url`, as one of its words, for the sheet over the tab; undefined when it noted nothing for that host and port. A URL that is not `https:` or does not parse has none. */
export function relayReasonFor (url: string): RefusalWord | undefined {
  try {
    const { protocol, hostname, port } = new URL(url)
    if (protocol !== 'https:' || hostname === '') return undefined
    return reasons?.(hostname.startsWith('[') ? hostname.slice(1, -1) : hostname, port === '' ? 443 : Number(port))
  } catch {
    return undefined
  }
}

/** Whether `value` is one of the relay's words. */
export function isRefusalWord (value: unknown): value is RefusalWord {
  return typeof value === 'string' && (REFUSAL_WORDS as readonly string[]).includes(value)
}

/** The line for a change of state. */
export function stateLine (status: NameRelayStatus): string {
  return `[route] name relay: ${status.state}${status.state === 'relaying' ? ` (${status.provider}, resolver ${status.resolver})` : ''}`
}

/** At most one line a minute of each word for the log, counting the ones it left out, so a page with many subresources cannot fill the ring. */
export function createRefusalLog (options: { now?: () => number, everyMs?: number } = {}): (word: RefusalWord) => string | undefined {
  const now = options.now ?? Date.now
  const everyMs = options.everyMs ?? 60_000
  const said = new Map<RefusalWord, { lastAt: number, unsaid: number }>()
  return (word) => {
    const at = now()
    const earlier = said.get(word) ?? { lastAt: Number.NEGATIVE_INFINITY, unsaid: 0 }
    said.set(word, earlier)
    if (at - earlier.lastAt < everyMs) {
      earlier.unsaid += 1
      return undefined
    }
    earlier.lastAt = at
    const more = earlier.unsaid
    earlier.unsaid = 0
    return `[route] name relay stopped a connection: ${word}${more > 0 ? `; ${String(more)} more since the last line` : ''}`
  }
}
