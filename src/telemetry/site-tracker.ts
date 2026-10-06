// Turns "the tab in front now shows this address" into the site key accounting counts under. The
// trust layer's answer for a site is asked once per origin and kept for ten minutes, so moving around
// one site costs nothing and a slow answer never holds up counting: until it arrives the seconds go
// to the browser's own pages (`internal`), and an answer for an address the person has already left is
// dropped. Pure apart from the injected question and clock.
import { siteClassOfLevel } from '../trust/site-class.js'
import type { ScoreLevel } from '../trust/website-level.js'
import type { SiteKey } from './accounting.js'
import { siteKeyFor } from './site-key.js'

export const TRUST_CACHE_TTL_MS = 10 * 60 * 1000

/** What the trust layer concluded about an address: its displayed Website level, and whether a Web3 Score provider judged it. */
export interface SiteTrustAnswer {
  readonly level: ScoreLevel
  readonly judged: boolean
}

export interface SiteTrackerDeps {
  /** Null when there is no answer (the loader is not up, no origin). */
  readonly classify: (url: string) => Promise<SiteTrustAnswer | null>
  readonly emit: (key: SiteKey) => void
  readonly now: () => number
  readonly ttlMs?: number
}

interface Cached {
  readonly answer: SiteTrustAnswer | null
  readonly at: number
}

/** The part of an address trust is asked about: scheme and host, so every page of a site shares one answer. */
function cacheKeyOf (url: string): string | null {
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.hostname.toLowerCase()}`
  } catch {
    return null
  }
}

export class SiteTracker {
  private readonly cache = new Map<string, Cached>()
  private readonly asking = new Map<string, Promise<SiteTrustAnswer | null>>()
  private showing = ''
  private lastEmitted: SiteKey | undefined

  constructor (private readonly deps: SiteTrackerDeps) {}

  /** The tab in front, in the window the person is using, now shows `url` (an empty string: no tab). */
  show (url: string): void {
    this.showing = url
    const cacheKey = cacheKeyOf(url)
    if (cacheKey === null) {
      this.emit(siteKeyFor({ url, siteClass: null, judged: false }))
      return
    }
    const now = this.deps.now()
    const known = this.cache.get(cacheKey)
    if (known !== undefined && now - known.at < (this.deps.ttlMs ?? TRUST_CACHE_TTL_MS)) {
      this.emit(this.keyFor(url, known.answer))
      return
    }
    // A scheme that is not a site (the new tab page, Settings) needs no answer at all.
    const withoutAnswer = siteKeyFor({ url, siteClass: 'web3', judged: false })
    if (withoutAnswer === 'internal') {
      this.emit('internal')
      return
    }
    this.emit('internal')
    void this.ask(cacheKey, url).then((answer) => {
      if (this.showing === url) this.emit(this.keyFor(url, answer))
    })
  }

  private keyFor (url: string, answer: SiteTrustAnswer | null): SiteKey {
    return siteKeyFor({ url, siteClass: answer === null ? null : siteClassOfLevel(answer.level), judged: answer?.judged ?? false })
  }

  private ask (cacheKey: string, url: string): Promise<SiteTrustAnswer | null> {
    const running = this.asking.get(cacheKey)
    if (running !== undefined) return running
    const started = this.deps.classify(url)
      .catch(() => null)
      .then((answer) => {
        this.cache.set(cacheKey, { answer, at: this.deps.now() })
        this.asking.delete(cacheKey)
        return answer
      })
    this.asking.set(cacheKey, started)
    return started
  }

  private emit (key: SiteKey): void {
    if (key === this.lastEmitted) return
    this.lastEmitted = key
    this.deps.emit(key)
  }
}
