// What Settings knows about the tunnel: what Nym is doing, whether a test is under way and what the last one found. The
// tests are main's (the one of Nym brings it up; the one of an address sends a SOCKS5 greeting); this keeps the answer
// for the row to draw.
import type { NymState, NymTestResult } from '../../../main/route/nym-status.js'
import type { OrivonInternal } from '../shared/bridge.js'
import type { SettingsPart } from './settings-parts.js'

export type ProxyTestResult =
  | { readonly nym?: undefined, readonly ok: true, readonly authentication: 'none' | 'password' }
  | { readonly nym?: undefined, readonly ok: false, readonly reason: 'no-proxy' | 'unreachable' | 'silent' | 'not-socks5' | 'refused' }
  | ({ readonly nym: true } & NymTestResult)

const REASONS = ['no-proxy', 'unreachable', 'silent', 'not-socks5', 'refused'] as const
const NYM_REASONS = ['unavailable', 'failed', 'silent'] as const
const NYM_STATES = ['off', 'idle', 'connecting', 'ready', 'failed', 'unavailable'] as const
const CAUSES = ['not-in-build', 'proxy', 'other'] as const

/** An answer that is not one of main's is read as "nothing answered", never as a proxy that works. */
export function resultOf (reply: unknown): ProxyTestResult {
  if (typeof reply === 'object' && reply !== null) {
    const { ok, authentication, reason, nym, ms, detail } = reply as { ok?: unknown, authentication?: unknown, reason?: unknown, nym?: unknown, ms?: unknown, detail?: unknown }
    if (nym === true) {
      if (ok === true && typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) return { nym: true, ok: true, ms }
      const known = NYM_REASONS.find((candidate) => candidate === reason)
      if (ok === false && known !== undefined) return { nym: true, ok: false, reason: known, detail: typeof detail === 'string' ? detail : '' }
      return { nym: true, ok: false, reason: 'failed', detail: '' }
    }
    if (ok === true && (authentication === 'none' || authentication === 'password')) return { ok: true, authentication }
    const known = REASONS.find((candidate) => candidate === reason)
    if (ok === false && known !== undefined) return { ok: false, reason: known }
  }
  return { ok: false, reason: 'unreachable' }
}

/** What Nym is doing, from what main sent; anything else is read as not started. */
export function nymStateOf (value: unknown): NymState {
  if (typeof value === 'object' && value !== null) {
    const { state, reason, cause } = value as { state?: unknown, reason?: unknown, cause?: unknown }
    const known = NYM_STATES.find((candidate) => candidate === state)
    if (known === 'ready') return typeof reason === 'string' && reason !== '' ? { state: 'ready', reason } : { state: 'ready' }
    if (known === 'failed') return { state: 'failed', reason: typeof reason === 'string' ? reason : '' }
    if (known === 'unavailable') return { state: 'unavailable', cause: CAUSES.find((candidate) => candidate === cause) ?? 'other', reason: typeof reason === 'string' ? reason : '' }
    if (known !== undefined) return { state: known }
  }
  return { state: 'off' }
}

/** The result in words for the person, about the tunnel rather than the protocol. */
export function proxyTestWords (result: Exclude<ProxyTestResult, { readonly nym: true }>): string {
  if (result.ok) return result.authentication === 'password' ? 'The tunnel answered. It asks for a user name and password, and each app gets its own.' : 'The tunnel answered.'
  switch (result.reason) {
    case 'no-proxy': return 'Enter an address first.'
    case 'unreachable': return 'Nothing answered at that address.'
    case 'silent': return 'It did not answer in time.'
    case 'not-socks5': return 'Something answered, but it is not a SOCKS5 server.'
    case 'refused': return 'The tunnel answered, but it takes neither of the ways Orivon signs in.'
  }
}

export class RoutePart implements SettingsPart {
  /** The test was pressed and main has not answered. */
  busy = false
  /** What Nym is doing, kept in step with main. */
  nym: NymState = { state: 'off' }
  /** The last answer and what it was for (Nym, or the address it asked): it is shown only while the setting still holds that. */
  last: { readonly subject: string, readonly result: ProxyTestResult } | null = null

  constructor (private readonly bridge: OrivonInternal, private readonly notify: () => void) {}

  async load (): Promise<void> {
    try {
      this.nym = nymStateOf((await this.bridge.request('route', { type: 'status' }) as { nym?: unknown } | undefined)?.nym)
    } catch {
      this.nym = { state: 'off' }
    }
  }

  /** Main pushes what Nym is doing as it changes; a test is answered to the press that asked. */
  handle (topic: string, payload: unknown): boolean {
    if (topic !== 'route.changed') return false
    this.nym = nymStateOf((payload as { nym?: unknown } | null)?.nym)
    this.notify()
    return true
  }

  /** Tests the tunnel the settings hold now: `subject` is Nym, or the address saved. */
  async test (subject: string): Promise<void> {
    if (this.busy) return
    this.busy = true
    this.notify()
    try {
      this.last = { subject, result: resultOf(await this.bridge.request('route', { type: 'test' })) }
    } catch {
      this.last = { subject, result: { ok: false, reason: 'unreachable' } }
    } finally {
      this.busy = false
    }
    this.notify()
  }
}
