// The links sent to each app and not yet taken by its page. A page asks for the next one (a long poll, the
// way `web.awaitClose` waits) and a link routed while no page asks waits here, so an app opened by the link receives
// it once it has started. Memory only, bounded per app, and a link not taken within a few minutes is dropped: nobody
// expects it to arrive an hour later in an app opened for another reason.

/** Links waiting for one app; past this the oldest is dropped. */
export const MAX_PENDING_PER_APP = 16
/** How long a link waits for its app's page to start listening. */
export const PENDING_LIFETIME_MS = 2 * 60_000

interface Waiting { readonly url: string, readonly at: number }
interface Asker { readonly give: (url: string | null) => void }

export class OpenUrlQueue {
  readonly #now: () => number
  readonly #waiting = new Map<string, Waiting[]>()
  readonly #askers = new Map<string, Asker[]>()

  constructor (now: () => number = Date.now) {
    this.#now = now
  }

  /** Gives `url` to a page waiting for one of `origin`'s links, else holds it. */
  push (origin: string, url: string): void {
    const asker = this.#askers.get(origin)?.shift()
    if (asker !== undefined) {
      asker.give(url)
      return
    }
    const rest = this.#fresh(origin)
    rest.push({ url, at: this.#now() })
    while (rest.length > MAX_PENDING_PER_APP) rest.shift()
    this.#waiting.set(origin, rest)
  }

  /** The next link for `origin` once there is one, or null after `waitMs` or when `signal` fires. */
  async next (origin: string, waitMs: number, signal?: AbortSignal): Promise<string | null> {
    const held = this.#fresh(origin)
    const first = held.shift()
    if (first !== undefined) {
      this.#waiting.set(origin, held)
      return first.url
    }
    return await new Promise<string | null>((resolve) => {
      const asker: Asker = { give: (url) => { cleanup(); resolve(url) } }
      const timer = setTimeout(() => { remove(); resolve(null) }, waitMs)
      const onAbort = (): void => { remove(); resolve(null) }
      const cleanup = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort) }
      const remove = (): void => {
        cleanup()
        const askers = this.#askers.get(origin)?.filter((other) => other !== asker) ?? []
        if (askers.length === 0) this.#askers.delete(origin)
        else this.#askers.set(origin, askers)
      }
      if (signal?.aborted === true) {
        resolve(null)
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.#askers.set(origin, [...(this.#askers.get(origin) ?? []), asker])
    })
  }

  /** How many links wait for `origin`'s page. */
  pending (origin: string): number {
    return this.#fresh(origin).length
  }

  #fresh (origin: string): Waiting[] {
    const cutoff = this.#now() - PENDING_LIFETIME_MS
    const kept = (this.#waiting.get(origin) ?? []).filter((item) => item.at > cutoff)
    if (kept.length === 0) this.#waiting.delete(origin)
    else this.#waiting.set(origin, kept)
    return kept
  }
}
