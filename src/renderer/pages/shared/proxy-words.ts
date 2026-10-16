// The words about a test of a tunnel, for the Settings page and the tunnel menu alike: what the answer main sent means, and how it is
// said. Pure.
import type { NymTestResult } from '../../../main/route/nym-status.js'

export type ProxyTestResult =
  | { readonly nym?: undefined, readonly ok: true, readonly authentication: 'none' | 'password' }
  | { readonly nym?: undefined, readonly ok: false, readonly reason: 'no-proxy' | 'unreachable' | 'silent' | 'not-socks5' | 'refused' }
  | ({ readonly nym: true } & NymTestResult)

const REASONS = ['no-proxy', 'unreachable', 'silent', 'not-socks5', 'refused'] as const
const NYM_REASONS = ['unavailable', 'failed', 'silent'] as const

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
