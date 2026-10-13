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

/** The result in words for the person, about the tunnel rather than the protocol. */
export function proxyTestWords (result: ProxyTestResult): string {
  if (result.ok) return result.authentication === 'password' ? 'The tunnel answered. It asks for a user name and password, and each app gets its own.' : 'The tunnel answered.'
  switch (result.reason) {
    case 'no-proxy': return 'Enter an address first.'
    case 'unreachable': return 'Nothing answered at that address.'
    case 'silent': return 'It did not answer in time.'
    case 'not-socks5': return 'Something answered, but it is not a SOCKS5 server.'
    case 'refused': return 'The tunnel answered, but it takes neither of the ways Orivon signs in.'
  }
}

/** One site or app with a tunnel setting or storage of its own, as main lists it. */
export interface TunnelRowView {
  readonly origin: string
  readonly kind: 'app' | 'site'
  readonly entry: 'on' | 'off' | undefined
  readonly state: 'off' | 'no-proxy' | 'idle' | 'ok' | 'down'
  /** The profile its entry puts a website in. */
  readonly profile: 'tunnel' | 'direct' | undefined
  readonly apart: boolean
  /** The profiles it has storage in. */
  readonly apartIn: readonly ('tunnel' | 'direct')[]
}

/** What a row says about the origin's tunnel, in words. */
export function tunnelRowWords (row: TunnelRowView): string {
  const subject = row.kind === 'app' ? 'app' : 'site'
  if (row.entry === undefined) {
    const kept = row.apartIn.length === 0 ? '' : ` What it stored in your ${row.apartIn.join(' and ')} profile is kept.`
    return `This ${subject} follows your browser's tunnel setting.${kept}`
  }
  if (row.entry === 'off') return `The tunnel is off for this ${subject}.${row.kind === 'site' ? ' It lives in your direct profile.' : ''}`
  const where = row.kind === 'site' ? ' It lives in your tunnel profile.' : ''
  switch (row.state) {
    case 'no-proxy': return `On, but no tunnel is set, so this ${subject}'s traffic is stopped.${where}`
    case 'down': return `On, but your tunnel is not answering, so this ${subject}'s traffic is stopped.${where}`
    case 'off':
    case 'idle':
    case 'ok': return `On: this ${subject}'s traffic goes through your tunnel.${where}`
  }
}

export class RoutePart implements SettingsPart {
  /** The sites and apps with a setting or storage of their own; null until main has answered. */
  rows: readonly TunnelRowView[] | null = null
  /** Origins whose storage is being cleared now. */
  readonly clearing = new Set<string>()
  /** Origins whose storage could not be cleared, until the next press. */
  readonly refused = new Set<string>()
  private loading = false
  private reloadAgain = false

  /** The test was pressed and main has not answered. */
  busy = false
  /** The last answer and the address it was for: it is shown only while the setting still holds that address. */
  last: { readonly address: string, readonly result: ProxyTestResult } | null = null

  constructor (private readonly bridge: OrivonInternal, private readonly notify: () => void) {}

  async load (): Promise<void> {
    if (this.loading) { this.reloadAgain = true; return }
    this.loading = true
    try {
      do {
        this.reloadAgain = false
        const reply = await this.bridge.request('route', { type: 'list' }) as { rows?: unknown } | undefined
        this.rows = Array.isArray(reply?.rows) ? reply.rows as TunnelRowView[] : []
      } while (this.reloadAgain)
    } finally {
      this.loading = false
    }
    this.notify()
  }

  /** The test is answered to the press that asked; the list changes when a site or app is switched, which main pushes. */
  handle (topic: string): boolean {
    if (topic !== 'route.changed') return false
    void this.load()
    return true
  }

  /** Clears a website's own storage; the row stays while the site has a setting of its own. */
  async removeStorage (origin: string): Promise<void> {
    if (this.clearing.has(origin)) return
    this.clearing.add(origin)
    this.refused.delete(origin)
    this.notify()
    try {
      const reply = await this.bridge.request('route', { type: 'removeStorage', origin }) as { ok?: unknown } | undefined
      if (reply?.ok !== true) this.refused.add(origin)
    } catch {
      this.refused.add(origin)
    } finally {
      this.clearing.delete(origin)
    }
    await this.load()
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
