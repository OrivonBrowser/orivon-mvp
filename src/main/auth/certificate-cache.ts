// The certificates connections presented, by host: what the viewer shows for the page a tab is on. Public data
// only, bounded, and the oldest host goes first, except a host a tab is showing, which stays. Pure.
import type { CertificateView } from './certificate-view.js'

export const MAX_HOSTS = 200

export interface CachedChain {
  readonly chain: readonly CertificateView[]
  /** When the connection presented it, in milliseconds. */
  readonly at: number
  /** The connection was accepted: by the browser's own checks, or by the verifier for a name it serves. */
  readonly trusted: boolean
}

export class CertificateCache {
  private readonly hosts = new Map<string, CachedChain>()

  private pinned: () => ReadonlySet<string> = () => new Set()

  constructor (private readonly now: () => number = Date.now) {}

  /** The hosts that stay however many others connect: those of the pages on screen, lower-case. Read only when the cache is full. */
  keepHosts (hosts: () => ReadonlySet<string>): void {
    this.pinned = hosts
  }

  /**
   * Records what a connection presented. A connection that was not accepted never replaces the chain of one that was:
   * a failed or intercepted request to a host must not rewrite what the page loaded over.
   */
  set (host: string, chain: readonly CertificateView[], trusted = true): void {
    const key = host.toLowerCase()
    if (key === '' || chain.length === 0) return
    if (!trusted && this.hosts.get(key)?.trusted === true) return
    // Re-inserting puts the host last, so the first key is always the one used longest ago.
    this.hosts.delete(key)
    this.hosts.set(key, { chain, at: this.now(), trusted })
    if (this.hosts.size > MAX_HOSTS) this.evict()
  }

  private evict (): void {
    const kept = this.pinned()
    for (const key of [...this.hosts.keys()]) {
      if (this.hosts.size <= MAX_HOSTS) return
      if (!kept.has(key)) this.hosts.delete(key)
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

  /** Whether the chain held for a host came from an accepted connection; false for a host with none. */
  trustedOf (host: string): boolean {
    return this.hosts.get(host.toLowerCase())?.trusted === true
  }

  get size (): number {
    return this.hosts.size
  }
}
