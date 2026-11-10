// Keeps the default session's cookies and those of the profile sessions in step, for the sites a person opens in a tunnelled tab and
// no others. Electron-free over the stores it is handed. README.md's Design notes say how a change is carried and why.

import { siteOf } from '../../privacy/site-of.js'
import { addressOf, followsChange, identityOf, planSet, sameCookie, siteOfCookie, wouldSend } from './cookies.js'
import type { CookieStore, StoredCookie } from './cookies.js'
import { MAX_SITES_PER_PROFILE } from './mirror-record.js'
import type { MirrorRecord } from './mirror-record.js'
import type { CookieMirrorStatus } from './mirror-status.js'

export interface MirrorSide {
  /** What the log says: the session's name, never a site. */
  readonly label: string
  readonly store: CookieStore
}

export interface CookieMirrorDeps {
  readonly main: MirrorSide
  /** The sites copied so far and whether a clear is owed: read once, and written (durably) before the step it protects. */
  readonly record: { readonly read: () => MirrorRecord, readonly write: (record: MirrorRecord) => boolean }
  /** The store of a profile session that has not joined, for the clear a turned-on switch owes after a restart. */
  readonly open?: (label: string) => CookieStore | undefined
  readonly now: () => number
  readonly log: (line: string) => void
}

export interface CookieMirror {
  /** A profile session exists. Resolves once it holds what the default session does for the sites already copied into it (at once while the mirror is off). */
  readonly join: (side: MirrorSide) => Promise<void>
  /**
   * A tab in the profile named `label` is about to load `address` as a page. When its site is new to that profile, the default
   * session's cookies of the site are copied in first. A promise to wait for, or undefined when there is nothing to wait for.
   */
  readonly visit: (label: string, address: string) => Promise<void> | undefined
  /** Makes each profile equal to the default session for the sites recorded, then follows every change to cookies of those sites. */
  readonly start: () => Promise<void>
  /** Stops following and clears the recorded sites' cookies from the profiles; the default session's stay. */
  readonly stop: () => Promise<void>
  /** With the switch on at launch: finishes a clear an earlier run owed. */
  readonly settle: () => Promise<void>
  /** Resolves when everything asked for so far, and what it set off, has been done. */
  readonly idle: () => Promise<void>
  readonly status: () => CookieMirrorStatus
}

/** A cookie one store keeps changing in a loop is written to a session at most this often. */
const WRITES_PER_WINDOW = 30
const WINDOW_MS = 5000
const BUDGETS_KEPT = 5000

interface Change {
  readonly side: MirrorSide
  readonly seen: StoredCookie
  readonly removed: boolean
  /** The order changes were observed in: the later of two conflicting changes wins. */
  readonly order: number
}

type Written = 'written' | 'skipped' | 'failed'
const ABSENT = Symbol('absent')
const AMBIGUOUS = Symbol('ambiguous')
type Value = StoredCookie | typeof ABSENT | typeof AMBIGUOUS

export function createCookieMirror (deps: CookieMirrorDeps): CookieMirror {
  const { main } = deps
  const profiles: MirrorSide[] = []
  const watching = new Map<MirrorSide, () => void>()
  /** The sites copied into each profile, by the profile's name. */
  const scope = new Map<string, Set<string>>()
  const earlier = deps.record.read()
  let owed = earlier.owed
  for (const [label, sites] of Object.entries(earlier.domains)) scope.set(label, new Set(sites))
  /** What a cookie held when the default session and a profile last agreed on it, for each profile and cookie: it tells which side has changed since. */
  const agreed = new Map<string, StoredCookie>()
  /** Cookies a listing has shown more than once (only partitioned cookies share a name, domain and path): never written, removed when the one mirrored is. */
  const twinned = new Set<string>()
  /** The cookies changed and not yet carried, one entry for each session and cookie: a cookie changed again meanwhile is carried once, as it is then. */
  const dirty = new Map<string, Change>()
  const adding = new Map<string, Promise<void>>()
  const budgets = new Map<string, { since: number, count: number }>()
  const counts = { copied: 0, removed: 0, failed: 0, suppressed: 0 }
  const warned = new Set<string>()
  let order = 0
  /** What the last call to `start` or `stop` asked for; set when it is made, so work for an earlier ask can stop early. */
  let asked = false
  let running = false
  let starting: Promise<void> = Promise.resolve()
  /** Steps that must not wait behind the carrying of changes, in the order they were asked for. */
  const steps: Array<() => Promise<void>> = []
  let pumping: Promise<void> | undefined

  const failed = (side: MirrorSide, what: string): void => {
    counts.failed += 1
    const once = `${side.label}\u0000${what}`
    if (warned.has(once)) return
    warned.add(once)
    deps.log(`[cookie-mirror] ${what} ${side.label}; further failures of that kind there are counted, not logged`)
  }

  const warnOnce = (key: string, line: string): void => {
    if (warned.has(key)) return
    warned.add(key)
    deps.log(line)
  }

  const leftAlone = (): void => {
    warnOnce('shared identity', '[cookie-mirror] cookies that share a name, domain and path (partitioned cookies do) are not written between sessions')
  }

  const agreedKey = (label: string, identity: string): string => `${label}\u0000${identity}`
  const inScope = (label: string, site: string): boolean => scope.get(label)?.has(site) === true
  const mirroring = (site: string): MirrorSide[] => profiles.filter((profile) => inScope(profile.label, site))

  function persist (): boolean {
    const domains: Record<string, string[]> = {}
    for (const [label, sites] of scope) if (sites.size > 0) domains[label] = [...sites].sort()
    const kept = deps.record.write({ domains, owed })
    if (!kept) warnOnce('record', '[cookie-mirror] what it mirrors could not be recorded; a site is not mirrored until it can be')
    return kept
  }

  /** The cookies by identity, and the identities a listing shows more than once. */
  function distinct (cookies: readonly StoredCookie[]): { readonly cookies: Map<string, StoredCookie>, readonly shared: Set<string> } {
    const found = new Map<string, StoredCookie>()
    const shared = new Set<string>()
    for (const cookie of cookies) {
      const identity = identityOf(cookie)
      if (found.has(identity)) { shared.add(identity); twinned.add(identity) }
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

  async function put (target: MirrorSide, cookie: StoredCookie): Promise<Written> {
    const identity = identityOf(cookie)
    if (twinned.has(identity)) { leftAlone(); return 'skipped' }
    const plan = planSet(cookie, deps.now() / 1000)
    if (plan.kind === 'skip') return 'skipped'
    if (!allowed(target, identity)) return 'failed'
    try {
      await target.store.set(plan.cookie)
      counts.copied += 1
      return 'written'
    } catch {
      failed(target, 'a cookie could not be written to')
      return 'failed'
    }
  }

  /**
   * Writes `value` into `to`, and notes that `profile` and the default session agree on it before the write is made: its own change
   * comes back as an event that may arrive before the write returns, and is then recognised as nothing to carry.
   */
  async function give (to: MirrorSide, profile: MirrorSide, value: StoredCookie): Promise<void> {
    const key = agreedKey(profile.label, identityOf(value))
    const before = agreed.get(key)
    agreed.set(key, value)
    if (await put(to, value) === 'written') return
    if (before === undefined) agreed.delete(key)
    else agreed.set(key, before)
  }

  /**
   * Removes `cookie` from `target`. A removal by address and name takes every cookie of that name the address would send, so the
   * ones of another identity are written back; one that cannot be is forgotten, which makes the next look at it a new cookie to copy
   * from the other session and never a removal to carry.
   */
  async function take (target: MirrorSide, cookie: StoredCookie, restore: boolean): Promise<boolean> {
    const address = addressOf(cookie)
    const identity = identityOf(cookie)
    if (address === undefined || !allowed(target, identity)) return false
    let casualties: StoredCookie[] = []
    try {
      if (restore) casualties = (await target.store.find(address, cookie.name)).filter((other) => identityOf(other) !== identity)
      await target.store.remove(address, cookie.name)
      counts.removed += 1
    } catch {
      failed(target, 'a cookie could not be removed from')
      return false
    }
    for (const casualty of casualties) {
      if (await put(target, casualty) !== 'failed') continue
      for (const profile of target === main ? profiles : [target]) agreed.delete(agreedKey(profile.label, identityOf(casualty)))
    }
    return true
  }

  /** The cookies of one identity a side lists. */
  async function held (side: MirrorSide, address: string, cookie: StoredCookie): Promise<StoredCookie[]> {
    const identity = identityOf(cookie)
    const found = (await side.store.find(address, cookie.name)).filter((other) => identityOf(other) === identity)
    if (found.length > 1) { twinned.add(identity); leftAlone() }
    return found
  }

  /** What a side holds of a cookie, read against what the sessions last agreed on and the change just seen there. */
  function valueOf (list: readonly StoredCookie[], base: StoredCookie | undefined, change: Change | undefined): Value {
    if (base !== undefined && list.some((cookie) => sameCookie(cookie, base))) return base
    if (change?.removed === true && base !== undefined && sameCookie(change.seen, base)) {
      if (list.length > 0) twinned.add(identityOf(base))
      return ABSENT
    }
    if (list.length === 0) return ABSENT
    return list.length === 1 ? list[0] as StoredCookie : AMBIGUOUS
  }

  /** Makes the default session and `profile` hold the same of one cookie: the side that changed since they agreed gives, and of two changes the later one wins. */
  async function settleCookie (profile: MirrorSide, sample: StoredCookie, changes: Map<string, Change>): Promise<void> {
    const address = addressOf(sample)
    if (address === undefined) return
    const identity = identityOf(sample)
    const key = agreedKey(profile.label, identity)
    const mine = await held(main, address, sample)
    const theirs = await held(profile, address, sample)
    // A change that arrived while the two were being read is part of what they were found to hold.
    for (const side of [main, profile]) {
      const later = dirty.get(`${side.label}\u0000${identity}`)
      if (later === undefined) continue
      changes.set(side.label, later)
      dirty.delete(`${side.label}\u0000${identity}`)
    }
    const base = agreed.get(key)
    const here = valueOf(mine, base, changes.get(main.label))
    const there = valueOf(theirs, base, changes.get(profile.label))
    if (here === AMBIGUOUS || there === AMBIGUOUS) { leftAlone(); return }
    if (here === ABSENT && there === ABSENT) { agreed.delete(key); return }
    if (here !== ABSENT && there !== ABSENT && sameCookie(here, there)) { agreed.set(key, here); return }
    const changed = (value: StoredCookie | typeof ABSENT): boolean => value === ABSENT ? base !== undefined : base === undefined || !sameCookie(value, base)
    const hereChanged = changed(here)
    const fromMain = hereChanged && changed(there)
      ? (changes.get(main.label)?.order ?? 0) >= (changes.get(profile.label)?.order ?? 0)
      : hereChanged
    const to = fromMain ? profile : main
    const value = fromMain ? here : there
    if (value === ABSENT) {
      const gone = (fromMain ? theirs : mine)[0]
      if (gone !== undefined && await take(to, gone, true)) agreed.delete(key)
      return
    }
    await give(to, profile, value)
  }

  /** Carries the change `first` and, with it, the ones pending for the same cookie in the other sessions. */
  async function carry (first: Change): Promise<void> {
    const identity = identityOf(first.seen)
    const changes = new Map<string, Change>()
    for (const side of [main, ...profiles]) {
      const key = `${side.label}\u0000${identity}`
      const change = dirty.get(key)
      if (change === undefined) continue
      changes.set(side.label, change)
      dirty.delete(key)
    }
    changes.set(first.side.label, first)
    dirty.delete(`${first.side.label}\u0000${identity}`)
    const site = siteOfCookie(first.seen)
    if (site === undefined) return
    const affected = new Set<MirrorSide>()
    if (changes.has(main.label)) for (const profile of mirroring(site)) affected.add(profile)
    for (const profile of profiles) if (changes.has(profile.label) && inScope(profile.label, site)) affected.add(profile)
    for (const profile of affected) {
      if (!running) return
      await settleCookie(profile, first.seen, changes)
    }
  }

  /** Makes `profile` equal to the default session for `sites`: what only the profile holds goes, what the default holds is written. Never the other way. */
  async function equalize (profile: MirrorSide, sites: readonly string[]): Promise<void> {
    const mine = distinct(await main.store.list(sites))
    const theirs = distinct(await profile.store.list(sites))
    const present = new Map(theirs.cookies)
    for (const [identity, cookie] of theirs.cookies) {
      if (!asked) return
      if (mine.cookies.has(identity) || !present.has(identity)) continue
      agreed.delete(agreedKey(profile.label, identity))
      if (!await take(profile, cookie, false)) continue
      const address = addressOf(cookie)
      for (const [other, there] of present) if (there.name === cookie.name && address !== undefined && wouldSend(there, address)) present.delete(other)
    }
    for (const [identity, cookie] of mine.cookies) {
      if (!asked) return
      if (mine.shared.has(identity) || twinned.has(identity)) continue
      const there = present.get(identity)
      if (there !== undefined && !theirs.shared.has(identity) && sameCookie(cookie, there)) { agreed.set(agreedKey(profile.label, identity), cookie); continue }
      await give(profile, profile, cookie)
    }
  }

  /** An insert of the value the sessions last agreed on is the mirror's own write coming back, or nothing: there is nothing to carry. */
  function isEcho (side: MirrorSide, seen: StoredCookie, site: string): boolean {
    const identity = identityOf(seen)
    const here = side === main ? mirroring(site) : [side]
    return here.length > 0 && here.every((profile) => {
      const base = agreed.get(agreedKey(profile.label, identity))
      return base !== undefined && sameCookie(base, seen)
    })
  }

  const follow = (side: MirrorSide): (() => void) => side.store.watch((seen, cause, removed) => {
    if (!running || !followsChange(cause, removed)) return
    const site = siteOfCookie(seen)
    if (site === undefined || (side === main ? mirroring(site).length === 0 : !inScope(side.label, site))) return
    if (!removed && isEcho(side, seen, site)) return
    order += 1
    dirty.set(`${side.label}\u0000${identityOf(seen)}`, { side, seen, removed, order })
    pump()
  })

  async function clearSites (store: CookieStore, sites: readonly string[]): Promise<void> {
    const done = new Set<string>()
    for (const cookie of await store.list(sites)) {
      const address = addressOf(cookie)
      if (address === undefined || done.has(`${address}\u0000${cookie.name}`)) continue
      done.add(`${address}\u0000${cookie.name}`)
      await store.remove(address, cookie.name)
    }
    await store.flush()
  }

  /**
   * Clears the recorded sites' cookies from every profile that has any, after recording that a clear is owed. The record is
   * emptied only when every profile has been cleared, so a failure or a crash leaves the clear owed for the next start.
   */
  async function clearRecorded (): Promise<void> {
    const targets = [...scope].filter(([, sites]) => sites.size > 0)
    if (targets.length === 0 && !owed) return
    if (!owed) { owed = true; persist() }
    let everyProfile = true
    for (const [label, sites] of targets) {
      const store = profiles.find((profile) => profile.label === label)?.store ?? deps.open?.(label)
      try {
        if (store === undefined) throw new Error('no session')
        await clearSites(store, [...sites])
      } catch {
        failed({ label, store: store as CookieStore }, 'the cookies could not be cleared from')
        everyProfile = false
      }
    }
    if (!everyProfile) return
    scope.clear()
    owed = false
    persist()
  }

  async function begin (): Promise<void> {
    if (running || !asked) return
    if (owed) await clearRecorded()
    if (!asked) return
    running = true
    for (const side of [main, ...profiles]) watching.set(side, follow(side))
    const joined = [...profiles]
    deps.log(`[cookie-mirror] keeping the cookies of the sites opened in ${String(joined.length)} tunnel profile session(s) in step with the default session`)
    for (const profile of joined) {
      const sites = [...(scope.get(profile.label) ?? [])]
      if (sites.length > 0) await equalize(profile, sites)
    }
  }

  async function end (): Promise<void> {
    const wasRunning = running
    running = false
    for (const off of watching.values()) off()
    watching.clear()
    dirty.clear()
    agreed.clear()
    if (asked) return
    if (wasRunning) deps.log('[cookie-mirror] stopped; clearing the cookies the tunnel profile sessions were given')
    await clearRecorded()
  }

  async function addSite (profile: MirrorSide, site: string): Promise<void> {
    if (!running || inScope(profile.label, site)) return
    const sites = scope.get(profile.label) ?? new Set<string>()
    if (sites.size >= MAX_SITES_PER_PROFILE) { warnOnce('full', '[cookie-mirror] a profile mirrors as many sites as it may; further sites are not mirrored'); return }
    sites.add(site)
    scope.set(profile.label, sites)
    if (!persist()) { sites.delete(site); return }
    await equalize(profile, [site])
  }

  function step (task: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve) => {
      steps.push(async () => {
        try {
          await task()
        } catch (error) {
          counts.failed += 1
          deps.log(`[cookie-mirror] a step failed: ${error instanceof Error ? error.name : 'error'}`)
        } finally {
          resolve()
        }
      })
      pump()
    })
  }

  /** One worker does everything in turn: the steps asked for first, then the changes to carry. */
  function pump (): void {
    if (pumping !== undefined) return
    pumping = (async () => {
      try {
        for (;;) {
          const task = steps.shift()
          if (task !== undefined) { await task(); continue }
          const next = running ? dirty.values().next() : undefined
          if (next === undefined || next.done === true) break
          try {
            await carry(next.value)
          } catch {
            failed(next.value.side, 'a change could not be carried from')
          }
        }
      } finally {
        pumping = undefined
      }
    })()
  }

  return {
    join: (side) => {
      if (side === main || profiles.some((known) => known.label === side.label || known.store === side.store)) return Promise.resolve()
      profiles.push(side)
      if (!asked) return Promise.resolve()
      if (!running) return starting
      watching.set(side, follow(side))
      return step(async () => {
        const sites = [...(scope.get(side.label) ?? [])]
        if (running && sites.length > 0) await equalize(side, sites)
      })
    },
    visit: (label, address) => {
      if (!asked) return undefined
      const site = siteOf(address)
      if (site === null) return undefined
      const key = `${label}\u0000${site}`
      const pending = adding.get(key)
      if (pending !== undefined) return pending
      if (inScope(label, site)) return undefined
      const profile = profiles.find((known) => known.label === label)
      if (profile === undefined) return undefined
      const added = step(async () => { await addSite(profile, site) }).finally(() => { adding.delete(key) })
      adding.set(key, added)
      return added
    },
    start: () => {
      asked = true
      starting = step(begin)
      return starting
    },
    stop: () => {
      asked = false
      return step(end)
    },
    settle: () => step(async () => { if (!asked) await clearRecorded() }),
    idle: async () => {
      for (;;) {
        await Promise.resolve()
        const current = pumping
        if (current === undefined) {
          if (steps.length === 0 && !(running && dirty.size > 0)) return
          pump()
          continue
        }
        await current
      }
    },
    status: () => ({ state: asked ? 'mirroring' : 'separate', sessions: asked ? profiles.length : 0, ...counts })
  }
}
