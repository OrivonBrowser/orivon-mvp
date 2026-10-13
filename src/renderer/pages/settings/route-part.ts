// What Settings knows about the proxy test: whether one is under way and what the last one found. The test itself is
// main's (it reads the saved proxy and sends a SOCKS5 greeting); this keeps the answer for the row to draw.
import type { OrivonInternal } from '../shared/bridge.js'
import type { SettingsPart } from './settings-parts.js'

export type ProxyTestResult =
  | { readonly ok: true, readonly authentication: 'none' | 'password' }
  | { readonly ok: false, readonly reason: 'no-proxy' | 'unreachable' | 'silent' | 'not-socks5' | 'refused' }

const REASONS = ['no-proxy', 'unreachable', 'silent', 'not-socks5', 'refused'] as const

/** An answer that is not one of main's is read as "nothing answered", never as a proxy that works. */
export function resultOf (reply: unknown): ProxyTestResult {
  if (typeof reply === 'object' && reply !== null) {
    const { ok, authentication, reason } = reply as { ok?: unknown, authentication?: unknown, reason?: unknown }
    if (ok === true && (authentication === 'none' || authentication === 'password')) return { ok: true, authentication }
    const known = REASONS.find((candidate) => candidate === reason)
    if (ok === false && known !== undefined) return { ok: false, reason: known }
  }
  return { ok: false, reason: 'unreachable' }
}

/** The result in words for the person, about the proxy rather than the protocol. */
export function proxyTestWords (result: ProxyTestResult): string {
  if (result.ok) return result.authentication === 'password' ? 'A SOCKS5 proxy answered. It asks for a user name and password, and each app gets its own.' : 'A SOCKS5 proxy answered.'
  switch (result.reason) {
    case 'no-proxy': return 'Enter an address first.'
    case 'unreachable': return 'Nothing answered at that address.'
    case 'silent': return 'It did not answer in time.'
    case 'not-socks5': return 'Something answered, but it is not a SOCKS5 proxy.'
    case 'refused': return 'A SOCKS5 proxy answered, but it takes neither of the ways Orivon signs in.'
  }
}

export class RoutePart implements SettingsPart {
  /** The test was pressed and main has not answered. */
  busy = false
  /** The last answer and the address it was for: it is shown only while the setting still holds that address. */
  last: { readonly address: string, readonly result: ProxyTestResult } | null = null

  constructor (private readonly bridge: OrivonInternal, private readonly notify: () => void) {}

  /** Main pushes nothing about the test: it is answered to the press that asked. */
  handle (): boolean {
    return false
  }

  /** Tests the proxy saved under `address` (the value the setting holds now). */
  async test (address: string): Promise<void> {
    if (this.busy) return
    this.busy = true
    this.notify()
    try {
      this.last = { address, result: resultOf(await this.bridge.request('route', { type: 'test' })) }
    } catch {
      this.last = { address, result: { ok: false, reason: 'unreachable' } }
    } finally {
      this.busy = false
    }
    this.notify()
  }
}
