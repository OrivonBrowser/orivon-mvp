// What Settings knows about the tunnel: what Nym is doing, whether a test is under way and what the last one found. The
// tests are main's (the one of Nym brings it up; the one of an address sends a SOCKS5 greeting); this keeps the answer
// for the row to draw.
import type { NymState } from '../../../main/route/nym-status.js'
import type { OrivonInternal } from '../shared/bridge.js'
import { resultOf } from '../shared/proxy-words.js'
import type { ProxyTestResult } from '../shared/proxy-words.js'
import type { SettingsPart } from './settings-parts.js'

const NYM_STATES = ['off', 'idle', 'connecting', 'ready', 'failed', 'unavailable'] as const
const CAUSES = ['not-in-build', 'proxy', 'other'] as const

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

/** One site or app with a tunnel setting or storage of its own, as main lists it. */
export interface TunnelRowView {
  readonly origin: string
  readonly kind: 'app' | 'site'
  /** The tunnel the person chose for it, `off`, or none (kept only for its storage). */
  readonly entry: 'nym' | 'socks5' | 'off' | undefined
  readonly state: 'off' | 'no-proxy' | 'idle' | 'ok' | 'down'
  /** The profile its entry puts a website in. */
  readonly profile: 'nym' | 'socks5' | 'direct' | undefined
  readonly apart: boolean
  /** The profiles it has storage in. */
  readonly apartIn: readonly ('nym' | 'socks5' | 'direct')[]
}

/** How a sentence names a tunnel's profile and the tunnel itself. */
export const PROFILE_NAMES = { nym: 'Nym', socks5: 'proxy', direct: 'direct' } as const
const TUNNEL_NAMES = { nym: 'Nym', socks5: 'your proxy' } as const

/** What a row says about the origin's tunnel, in words that name the tunnel. */
export function tunnelRowWords (row: TunnelRowView): string {
  const subject = row.kind === 'app' ? 'app' : 'site'
  if (row.entry === undefined) {
    const kept = row.apartIn.length === 0 ? '' : ` What it stored in your ${row.apartIn.map((profile) => PROFILE_NAMES[profile]).join(' and ')} profile is kept.`
    return `This ${subject} follows your browser's tunnel setting.${kept}`
  }
  if (row.entry === 'off') return `The tunnel is off for this ${subject}.${row.kind === 'site' ? ' It lives in your direct profile.' : ''}`
  const tunnel = TUNNEL_NAMES[row.entry]
  const where = row.kind === 'site' ? ` It lives in your ${PROFILE_NAMES[row.entry]} profile.` : ''
  switch (row.state) {
    case 'no-proxy': return `Through ${tunnel}, but no address is set for it, so this ${subject}'s traffic is stopped.${where}`
    case 'down': return `Through ${tunnel}, but it is not answering, so this ${subject}'s traffic is stopped.${where}`
    case 'off':
    case 'idle':
    case 'ok': return `Through ${tunnel}: this ${subject}'s traffic goes through it.${where}`
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
  /** Which tunnel the test under way is of. */
  testing: 'nym' | 'socks5' | null = null
  /** What Nym is doing, kept in step with main. */
  nym: NymState = { state: 'off' }
  /** The settings file could not be used, so the whole browser is on the tunnel until the person turns that off. */
  heldOn = false
  /** The last answer, the tunnel it was for and what that tunnel was then (Nym, or the address it asked): it is shown only while the setting still holds that. */
  last: { readonly kind: 'nym' | 'socks5', readonly subject: string, readonly result: ProxyTestResult } | null = null

  constructor (private readonly bridge: OrivonInternal, private readonly notify: () => void) {}

  async load (): Promise<void> {
    if (this.loading) { this.reloadAgain = true; return }
    this.loading = true
    try {
      do {
        this.reloadAgain = false
        const reply = await this.bridge.request('route', { type: 'list' }) as { rows?: unknown } | undefined
        this.rows = Array.isArray(reply?.rows) ? reply.rows as TunnelRowView[] : []
        try {
          const status = await this.bridge.request('route', { type: 'status' }) as { nym?: unknown, unreadable?: unknown } | undefined
          this.nym = nymStateOf(status?.nym)
          this.heldOn = status?.unreadable === true
        } catch {
          this.nym = { state: 'off' }
          this.heldOn = false
        }
      } while (this.reloadAgain)
    } finally {
      this.loading = false
    }
    this.notify()
  }

  /** The test is answered to the press that asked; the list changes when a site or app is switched, and what Nym is doing as it changes, which main pushes. */
  handle (topic: string, payload: unknown): boolean {
    if (topic === 'nym.changed') {
      this.nym = nymStateOf((payload as { nym?: unknown } | null)?.nym)
      this.notify()
      return true
    }
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

  /** Tests a tunnel: `subject` is Nym, or the address saved for the proxy, which the answer is shown against; main tests what is saved, whatever the page says. */
  async test (subject: string, kind: 'nym' | 'socks5'): Promise<void> {
    if (this.busy) return
    this.busy = true
    this.testing = kind
    this.notify()
    try {
      this.last = { kind, subject, result: resultOf(await this.bridge.request('route', { type: 'test', kind })) }
    } catch {
      this.last = { kind, subject, result: { ok: false, reason: 'unreachable' } }
    } finally {
      this.busy = false
      this.testing = null
    }
    this.notify()
  }
}
