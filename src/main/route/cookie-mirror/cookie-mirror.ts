// Keeps the default session's cookies and those of the profile sessions in step, in both directions. Electron-free over the stores it
// is handed.

import { addressOf, followsChange, identityOf, planSet, sameCookie, wouldSend } from './cookies.js'
import type { CookieStore, StoredCookie } from './cookies.js'
import type { CookieMirrorStatus } from './mirror-status.js'

export interface MirrorSide {
  /** What the log says: the session's name, never a site. */
  readonly label: string
  readonly store: CookieStore
}

export interface CookieMirrorDeps {
  readonly main: MirrorSide
  readonly now: () => number
  readonly log: (line: string) => void
}

export interface CookieMirror {
  /** A profile session exists. It is kept in step from the moment the mirror runs, or now when it already does; resolves once it holds what the default session does (at once while the mirror is off). */
  readonly join: (side: MirrorSide) => Promise<void>
  /** Merges the profiles into the default session and follows every change from then on; resolves when the merge is done. */
  readonly start: () => Promise<void>
  /** Stops following and clears the profiles' cookies; the default session's stay. */
  readonly stop: () => Promise<void>
  /** Resolves when everything asked for so far, and what it set off, has been done. */
  readonly idle: () => Promise<void>
  readonly status: () => CookieMirrorStatus
}

/** A cookie one store keeps changing in a loop is written to a session at most this often. */
const WRITES_PER_WINDOW = 30
const WINDOW_MS = 5000
const BUDGETS_KEPT = 5000

export function createCookieMirror (deps: CookieMirrorDeps): CookieMirror {
  const { main } = deps
  const profiles: MirrorSide[] = []
  const watching = new Map<MirrorSide, () => void>()
  /** The cookies changed and not yet carried, one entry for each session and cookie: a cookie changed again meanwhile is carried once, as it is then. */
  const dirty = new Map<string, { readonly side: MirrorSide, readonly seen: StoredCookie }>()
  const budgets = new Map<string, { since: number, count: number }>()
  const counts = { copied: 0, removed: 0, failed: 0, suppressed: 0 }
  const warned = new Set<string>()
  /** What the last call to `start` or `stop` asked for; set when it is made, so work for an earlier ask can stop early. */
  let asked = false
  let running = false
  let starting: Promise<void> = Promise.resolve()
  let chain: Promise<void> = Promise.resolve()
  let draining = false

  const enqueue = (task: () => Promise<void>): Promise<void> => {
    const next = chain.then(task).catch((error: unknown) => { counts.failed += 1; deps.log(`[cookie-mirror] a step failed: ${error instanceof Error ? error.name : 'error'}`) })
    chain = next
    return next
  }

  const failed = (side: MirrorSide, what: string): void => {
    counts.failed += 1
    const once = `${side.label}\u0000${what}`
    if (warned.has(once)) return
    warned.add(once)
    deps.log(`[cookie-mirror] ${what} ${side.label}; further failures of that kind there are counted, not logged`)
  }

  /** Electron lists a partitioned cookie with nothing to say it is one, beside the cookie of the same name, domain and path that another top-level site set; those are left alone. */
  const leftAlone = (): void => {
    if (warned.has('shared identity')) return
    warned.add('shared identity')
    deps.log('[cookie-mirror] cookies that share a name, domain and path (partitioned cookies do) are not carried between sessions')
  }

  /** The cookies by identity, and the identities a listing shows more than once. */
  function distinct (cookies: readonly StoredCookie[]): { readonly cookies: Map<string, StoredCookie>, readonly shared: Set<string> } {
    const found = new Map<string, StoredCookie>()
    const shared = new Set<string>()
    for (const cookie of cookies) {
      const identity = identityOf(cookie)
      if (found.has(identity)) shared.add(identity)
      found.set(identity, cookie)
    }
    if (shared.size > 0) leftAlone()
    return { cookies: found, shared }
  }

  /** Whether one more write of this cookie into `target` is within its budget: a store that changes what it is given would otherwise be written to for ever. */
  function allowed (target: MirrorSide, identity: string): boolean {
    const key = `${target.label}\u0000${identity}`
    const now = deps.now()
    if (budgets.size > BUDGETS_KEPT) for (const [stale, budget] of budgets) if (now - budget.since > WINDOW_MS) budgets.delete(stale)
    const budget = budgets.get(key)
    if (budget === undefined || now - budget.since > WINDOW_MS) { budgets.set(key, { since: now, count: 1 }); return true }
    budget.count += 1
    if (budget.count <= WRITES_PER_WINDOW) return true
    counts.suppressed += 1
    if (budget.count === WRITES_PER_WINDOW + 1) deps.log(`[cookie-mirror] a cookie keeps changing between sessions; it is not carried to ${target.label} for a while`)
    return false
  }

  async function put (target: MirrorSide, cookie: StoredCookie): Promise<void> {
    const plan = planSet(cookie, deps.now() / 1000)
    if (plan.kind === 'skip' || !allowed(target, identityOf(cookie))) return
    try {
      await target.store.set(plan.cookie)
      counts.copied += 1
    } catch {
      failed(target, 'a cookie could not be written to')
    }
  }

  async function take (target: MirrorSide, cookie: StoredCookie): Promise<void> {
    const address = addressOf(cookie)
    if (address === undefined || !allowed(target, identityOf(cookie))) return
    try {
      await target.store.remove(address, cookie.name)
      counts.removed += 1
    } catch {
      failed(target, 'a cookie could not be removed from')
    }
  }

  /** The cookie a side holds of this identity: none, the one, or `shared` when the listing shows several. */
  async function holds (side: MirrorSide, cookie: StoredCookie): Promise<StoredCookie | undefined | 'shared'> {
    const wanted = identityOf(cookie)
    const held = (await side.store.find(cookie.name, cookie.domain)).filter((candidate) => identityOf(candidate) === wanted)
    if (held.length > 1) { leftAlone(); return 'shared' }
    return held[0]
  }

  /** A removal by address and name takes every cookie of that name the address would send; the source's others of those are put back. */
  async function restore (source: MirrorSide, target: MirrorSide, name: string, address: string): Promise<void> {
    const kept = distinct(await source.store.find(name))
    for (const [identity, cookie] of kept.cookies) {
      if (kept.shared.has(identity) || !wouldSend(cookie, address)) continue
      const there = await holds(target, cookie)
      if (there === 'shared') continue
      if (there === undefined || !sameCookie(cookie, there)) await put(target, cookie)
    }
  }

  /** Makes the other side(s) hold what `source` holds now of the cookie `seen`: read again, so a change that has been overtaken carries what is true. */
  async function reconcile (source: MirrorSide, seen: StoredCookie): Promise<void> {
    const current = await holds(source, seen)
    if (current === 'shared') return
    for (const target of source === main ? [...profiles] : [main]) {
      if (!running) return
      const there = await holds(target, seen)
      if (there === 'shared') continue
      if (current === undefined) {
        if (there === undefined) continue
        await take(target, there)
        const address = addressOf(there)
        if (address !== undefined) await restore(source, target, seen.name, address)
      } else if (there === undefined || !sameCookie(current, there)) {
        await put(target, current)
      }
    }
  }

  function drain (): void {
    if (draining) return
    draining = true
    chain = chain.then(async () => {
      try {
        while (running && asked && dirty.size > 0) {
          const [key, entry] = dirty.entries().next().value as [string, { side: MirrorSide, seen: StoredCookie }]
          dirty.delete(key)
          try {
            await reconcile(entry.side, entry.seen)
          } catch {
            failed(entry.side, 'a change could not be carried from')
          }
        }
      } finally {
        draining = false
      }
    }).catch(() => {})
  }

  const follow = (side: MirrorSide): (() => void) => side.store.watch((seen, cause, removed) => {
    if (!running || !followsChange(cause, removed)) return
    dirty.set(`${side.label}\u0000${identityOf(seen)}`, { side, seen })
    drain()
  })

  /**
   * The default session wins where both hold the same cookie, and a cookie only a profile holds goes to the default session; then
   * every cookie goes to each profile that lacks it or holds another. Two profiles that hold different values of one cookie the default
   * lacks give the one joined first.
   */
  async function merge (targets: readonly MirrorSide[]): Promise<void> {
    const mine = distinct(await main.store.all())
    const known = new Map(mine.cookies)
    const skipped = new Set(mine.shared)
    const toMain: StoredCookie[] = []
    for (const side of targets) {
      const theirs = distinct(await side.store.all())
      for (const identity of theirs.shared) skipped.add(identity)
      for (const [identity, cookie] of theirs.cookies) {
        if (known.has(identity) || skipped.has(identity)) continue
        known.set(identity, cookie)
        toMain.push(cookie)
      }
    }
    for (const cookie of toMain) {
      if (!asked) return
      await put(main, cookie)
    }
    for (const side of targets) {
      const held = distinct(await side.store.all())
      for (const [identity, cookie] of known) {
        if (!asked) return
        if (skipped.has(identity) || held.shared.has(identity)) continue
        const there = held.cookies.get(identity)
        if (there === undefined || !sameCookie(cookie, there)) await put(side, cookie)
      }
    }
  }

  async function begin (): Promise<void> {
    if (running) return
    running = true
    for (const side of [main, ...profiles]) watching.set(side, follow(side))
    deps.log(`[cookie-mirror] keeping the cookies of the default session and ${String(profiles.length)} tunnel profile session(s) in step`)
    await merge([...profiles])
  }

  async function end (): Promise<void> {
    if (!running) return
    running = false
    for (const off of watching.values()) off()
    watching.clear()
    dirty.clear()
    deps.log('[cookie-mirror] stopped; clearing the cookies of the tunnel profile sessions')
    for (const side of profiles) {
      try {
        await side.store.clear()
        await side.store.flush()
      } catch {
        failed(side, 'the cookies could not be cleared from')
      }
    }
  }

  return {
    join: async (side) => {
      if (side === main || profiles.some((known) => known.label === side.label || known.store === side.store)) return
      profiles.push(side)
      if (!running) return await (asked ? starting : Promise.resolve())
      watching.set(side, follow(side))
      await enqueue(async () => { await merge([side]) })
    },
    start: () => {
      asked = true
      starting = enqueue(begin)
      return starting
    },
    stop: () => {
      asked = false
      return enqueue(end)
    },
    idle: async () => {
      let seen: Promise<void>
      do {
        seen = chain
        await seen
      } while (seen !== chain)
    },
    status: () => ({ state: asked ? 'mirroring' : 'separate', sessions: profiles.length, ...counts })
  }
}
