// The certificates connections presented, by host: what the viewer shows for the page a tab is on. Public data
// only, bounded, and the oldest host goes first. Pure.
import type { CertificateView } from './certificate-view.js'

export const MAX_HOSTS = 200

export interface CachedChain {
  readonly chain: readonly CertificateView[]
  /** When the connection presented it, in milliseconds. */
  readonly at: number
}

export class CertificateCache {
  private readonly hosts = new Map<string, CachedChain>()

  constructor (private readonly now: () => number = Date.now) {}

  set (host: string, chain: readonly CertificateView[]): void {
    const key = host.toLowerCase()
    if (key === '' || chain.length === 0) return
    // Re-inserting puts the host last, so the first key is always the one used longest ago.
    this.hosts.delete(key)
    this.hosts.set(key, { chain, at: this.now() })
    while (this.hosts.size > MAX_HOSTS) {
      const oldest = this.hosts.keys().next()
      if (oldest.done === true) break
      this.hosts.delete(oldest.value)
    }
  }

  get (host: string): CachedChain | undefined {
    const key = host.toLowerCase()
    const found = this.hosts.get(key)
    if (found !== undefined) {
      this.hosts.delete(key)
      this.hosts.set(key, found)
    }
    return found
  }

  /** The leaf's fingerprint for a host, without counting as a use. */
  leafOf (host: string): string | undefined {
    return this.hosts.get(host.toLowerCase())?.chain[0]?.fingerprint
  }

  get size (): number {
    return this.hosts.size
  }
}
