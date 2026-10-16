// What the person set for the tunnel, per origin, kept across restarts in `routes.json` under the profile (memory only in
// a private session): the origins that go through a tunnel (Nym, or the person's proxy), the ones that are `off`, and the
// websites that have storage in each of the three profiles.
// The proxy itself lives in the settings. Disposable: plain JSON, tied to nothing but Node. A file that is there but
// cannot be trusted is not "nothing set": see `unreadable`.
//
// The file stays at version 1 so that an older build still reads it: `origins` lists every origin that goes through either
// tunnel (an older build routes them all, never direct), and `via` names the ones that use the proxy (absent: Nym).
import { copyFileSync, readFileSync } from 'node:fs'
import { writeFileAtomic } from '../../broker/adapters/atomic-write.js'
import { isPersistableOrigin, originFromUrl } from '../../broker/policy/origin.js'
import { isTunnelKind } from './route-state.js'
import type { TunnelEntry, TunnelKind } from './route-state.js'
import { PROFILES, profileOf } from './site-partition.js'
import type { Profile } from './site-partition.js'

const FILE_VERSION = 1
/** The `profiles` marker a file written since the profiles existed carries. */
const PROFILES_VERSION = 1
/** The `kinds` marker a file written since each origin names its own tunnel carries. */
const KINDS_VERSION = 1

/** What the file holds, each set of origins checked. */
export interface ParsedRoutes {
  /** Every origin that has an entry of its own: a tunnel, or `off`. */
  readonly entries: ReadonlyMap<string, TunnelEntry>
  /** The websites that have storage in each profile, whether or not they have an entry now: it is kept until the person removes it. */
  readonly apart: Readonly<Record<Profile, ReadonlySet<string>>>
  /** False for a file written before the profiles existed, whose `apart` names a session of each website's own. */
  readonly profiles: boolean
  /** False for a file written before each origin named its own tunnel: every origin it lists then goes through the tunnel that was the choice. */
  readonly kinds: boolean
  /** How many starts have tried to move the proxy-era storage out of Nym's profile folder and failed; the file stays unmarked until one succeeds or `MOVE_ATTEMPTS` is reached. */
  readonly moveAttempts: number
  /** The websites whose storage in Nym's profile is the proxy's (a move that could not be made), so Nym is never handed those cookies: moving one to Nym clears it first. */
  readonly foreign: ReadonlySet<string>
}

/** Starts that try to move the proxy-era storage before it is given up as foreign to Nym's profile. */
export const MOVE_ATTEMPTS = 3

/** The file's key for the websites that have storage in each profile. */
const APART_KEY: Readonly<Record<Profile, string>> = { nym: 'apart', socks5: 'apartProxy', direct: 'apartDirect' }

/** The origins of `listed` that are exactly the origin the broker would derive; undefined when `listed` is present but not a list. */
function originsOf (listed: unknown): Set<string> | undefined {
  if (listed === undefined) return new Set()
  if (!Array.isArray(listed)) return undefined
  const origins = new Set<string>()
  for (const origin of listed) if (typeof origin === 'string' && originFromUrl(origin) === origin) origins.add(origin)
  return origins
}

/**
 * The file is user-writable, so every entry is untrusted: kept only under the exact origin the broker would derive. An
 * origin listed both ways is on a tunnel. A file without the `kinds` marker names no tunnel for its origins: they take
 * `legacyKind`, the tunnel that was the choice when it was written. With the marker, an origin goes through the proxy only
 * when `via` says so, and through Nym otherwise. Undefined when the file is not a routes file at all.
 */
export function parseRoutes (raw: string, legacyKind: TunnelKind = 'nym'): ParsedRoutes | undefined {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof data !== 'object' || data === null) return undefined
  const file = data as Record<string, unknown>
  if (file.version !== FILE_VERSION || !Array.isArray(file.origins)) return undefined
  const on = originsOf(file.origins)
  const off = originsOf(file.off)
  const kept = {} as Record<Profile, Set<string>>
  for (const profile of PROFILES) {
    const listed = originsOf(file[APART_KEY[profile]])
    if (listed === undefined) return undefined
    kept[profile] = listed
  }
  if (on === undefined || off === undefined) return undefined
  const kinds = file.kinds === KINDS_VERSION
  const via = typeof file.via === 'object' && file.via !== null && !Array.isArray(file.via) ? file.via as Record<string, unknown> : {}
  const entries = new Map<string, TunnelEntry>()
  for (const origin of off) entries.set(origin, 'off')
  // A file still waiting for its migration names, in `pendingVia`, the tunnel of each origin a switch made since; every other origin took the legacy choice.
  const pending = typeof file.pendingVia === 'object' && file.pendingVia !== null && !Array.isArray(file.pendingVia) ? file.pendingVia as Record<string, unknown> : {}
  const named = kinds ? via : pending
  for (const origin of on) entries.set(origin, Object.hasOwn(named, origin) && isTunnelKind(named[origin]) ? named[origin] : kinds ? 'nym' : legacyKind)
  const foreign = originsOf(file.apartForeign) ?? new Set<string>()
  const attempts = typeof file.moveAttempts === 'number' && Number.isInteger(file.moveAttempts) && file.moveAttempts > 0 ? Math.min(file.moveAttempts, MOVE_ATTEMPTS) : 0
  return { entries, apart: kept, profiles: file.profiles === PROFILES_VERSION, kinds, moveAttempts: attempts, foreign }
}

/** What a switch reports when it could not be kept. */
export class RouteStoreError extends Error {}

export type RouteChange = (origin: string, entry: TunnelEntry | undefined, previous: TunnelEntry | undefined) => void

export interface RouteStoreOptions {
  /** A private window held to one tunnel: an origin can be given no other entry than this one, and never `off`. */
  readonly onlyKind?: TunnelKind
  /** The tunnel that was the choice when the file was read, which a file written before each origin named its own is taken to have used. */
  readonly legacyKind?: TunnelKind
}

export class RouteStore {
  readonly #path: string | null
  #routes: ParsedRoutes | undefined
  #unreadable = false
  readonly #listeners = new Set<RouteChange>()

  readonly #onlyKind: TunnelKind | undefined
  readonly #legacyKind: TunnelKind

  /** A null path keeps the routes in memory only, for a private session. */
  constructor (path: string | null, options: RouteStoreOptions = {}) {
    this.#path = path
    this.#onlyKind = options.onlyKind
    this.#legacyKind = options.legacyKind ?? 'nym'
  }

  /** Whether the origin goes through a tunnel by an entry of its own: the answer for an installed app, whose default is off. */
  has (origin: string): boolean {
    const entry = this.#loaded().entries.get(origin)
    return entry !== undefined && entry !== 'off'
  }

  /** What the person set for the origin (a tunnel, or `off`), or undefined when it follows the default. */
  stateOf (origin: string): TunnelEntry | undefined {
    return this.#loaded().entries.get(origin)
  }

  /** The origins that go through a tunnel by an entry of their own. */
  origins (): string[] {
    return this.entries().filter(([, entry]) => entry !== 'off').map(([origin]) => origin)
  }

  /** Every origin that has an entry. */
  entries (): Array<readonly [string, TunnelEntry]> {
    return [...this.#loaded().entries]
  }

  /** The websites that have storage in `profile`, whether or not they have an entry now. */
  apart (profile: Profile): string[] {
    return [...this.#loaded().apart[profile]]
  }

  isApart (origin: string, profile: Profile): boolean {
    return this.#loaded().apart[profile].has(origin)
  }

  /** Whether the website has storage in any profile. */
  isApartAnywhere (origin: string): boolean {
    return PROFILES.some((profile) => this.isApart(origin, profile))
  }

  /**
   * Whether the file was written before the profiles existed: each website it names then has a session of its own that
   * `migrateToProfiles` must clear. False for a new profile and for a private session.
   */
  needsMigration (): boolean {
    const routes = this.#loaded()
    return !routes.profiles && !this.#unreadable
  }

  /** The websites whose old sessions of their own hold data: every one the old file listed as having storage. */
  legacySites (): string[] {
    const routes = this.#loaded()
    return routes.profiles ? [] : [...routes.apart.nym]
  }

  /**
   * Records that the old sessions are cleared: each entry's website now has the storage the profile it is in will hold, and the
   * file carries the marker. Throws `RouteStoreError` when it cannot be saved, and then the migration runs again next start.
   */
  migrateToProfiles (): void {
    const routes = this.#loaded()
    if (routes.profiles || this.#unreadable) return
    // A website that had an entry now lives in the profile the entry names, so the notice about its storage is not asked again; one with no entry left has nothing.
    const apart = emptyApart()
    for (const origin of routes.apart.nym) {
      const profile = profileOf(routes.entries.get(origin))
      if (profile !== undefined) apart[profile].add(origin)
    }
    const next: ParsedRoutes = { ...routes, apart, profiles: true }
    this.#save(next)
    this.#routes = next
  }

  /** Whether the file was written before each origin named its own tunnel, so `migrateToKinds` has the file to rewrite. False for a new profile and for a private session. */
  needsKinds (): boolean {
    const routes = this.#loaded()
    return !routes.kinds && !this.#unreadable
  }

  /** The tunnel that was the choice when this file was read, which an unmarked file's origins are taken to have used. */
  get legacyKind (): TunnelKind {
    return this.#legacyKind
  }

  /**
   * Records that every origin the file lists goes through `legacyKind`, and marks the file. With `storageMoved`, the storage
   * the websites had in Nym's profile was moved to the proxy's profile (the profile of the tunnel that carried them), so the
   * list of websites that have storage there moves with it; without it, when the proxy carried them, that storage stays in
   * Nym's profile and is recorded as the proxy's, so Nym is never handed it unannounced. Throws `RouteStoreError` when it cannot
   * be saved, and then the migration runs again next start.
   */
  migrateToKinds (storageMoved: boolean): void {
    const routes = this.#loaded()
    if (routes.kinds || this.#unreadable) return
    const apart = emptyApart()
    for (const profile of PROFILES) for (const origin of routes.apart[profile]) apart[profile].add(origin)
    const foreign = new Set<string>()
    if (this.#legacyKind === 'socks5' && routes.profiles) {
      if (storageMoved) {
        for (const origin of routes.apart.nym) apart.socks5.add(origin)
        apart.nym.clear()
      } else {
        for (const origin of routes.apart.nym) foreign.add(origin)
      }
    }
    const next: ParsedRoutes = { ...routes, apart, kinds: true, moveAttempts: 0, foreign }
    this.#save(next)
    this.#routes = next
  }

  /**
   * Records a start whose move of the proxy-era storage failed (a handle held on the folder), leaving the file unmarked so the
   * next start tries again. Returns whether it will: false once `MOVE_ATTEMPTS` starts have failed, and the caller then marks the
   * file without the move. Throws `RouteStoreError` when it cannot be saved.
   */
  deferKindsMove (): boolean {
    const routes = this.#loaded()
    if (routes.kinds || this.#unreadable) return false
    const attempts = routes.moveAttempts + 1
    if (attempts >= MOVE_ATTEMPTS) return false
    const next: ParsedRoutes = { ...routes, moveAttempts: attempts }
    this.#save(next)
    this.#routes = next
    return true
  }

  /**
   * Whether the storage the website has in Nym's profile is the proxy's: from a move that could not be made, or one still to be
   * made. Moving the website to Nym must clear it first, and tell the person.
   */
  isForeignToNym (origin: string): boolean {
    const routes = this.#loaded()
    if (this.#unreadable) return false
    return routes.foreign.has(origin) || (!routes.kinds && this.#legacyKind === 'socks5' && routes.profiles && routes.apart.nym.has(origin))
  }

  /** The storage the website has in Nym's profile was cleared, so it is Nym's own again. */
  dropForeign (origin: string): void {
    const routes = this.#loaded()
    if (!routes.foreign.has(origin) || this.#unreadable) return
    const foreign = new Set(routes.foreign)
    foreign.delete(origin)
    const next: ParsedRoutes = { ...routes, foreign }
    this.#save(next)
    this.#routes = next
  }

  /**
   * Whether the file is there but cannot be read or understood, so what the person set is not known: whoever decides
   * what goes through the tunnel treats every origin as on while this holds. A copy of the file is kept beside it, the
   * file itself is never written over, and it stays unreadable at the next start until the person mends or removes it.
   */
  unreadable (): boolean {
    this.#loaded()
    return this.#unreadable
  }

  /**
   * Whether anything changed: false for a repeat and for an origin that is not canonical. Throws `RouteStoreError`,
   * having changed nothing, when the choice could not be saved, when a private window held to one tunnel is given another
   * entry, or while the file is unreadable (what was set is not known, so an entry cannot be taken away or turned off).
   */
  setEntry (origin: string, entry: TunnelEntry | undefined): boolean {
    if (this.#onlyKind !== undefined && entry !== undefined && entry !== this.#onlyKind) {
      throw new RouteStoreError(entry === 'off' ? 'This private window always goes through the tunnel, so nothing in it can be switched off.' : 'This private window always goes through Nym, so nothing in it can use another tunnel.')
    }
    const routes = this.#loaded()
    const previous = this.stateOf(origin)
    if (this.#unreadable) {
      if (entry !== undefined && entry !== 'off') return false
      throw new RouteStoreError('The list of tunnel settings could not be read, so every site and app stays on the tunnel until it is mended.')
    }
    if (previous === entry || (entry !== undefined && originFromUrl(origin) !== origin)) return false
    const entries = new Map(routes.entries)
    if (entry === undefined) entries.delete(origin)
    else entries.set(origin, entry)
    const next: ParsedRoutes = { ...routes, entries }
    this.#save(next)
    this.#routes = next
    for (const listener of [...this.#listeners]) listener(origin, entry, previous)
    return true
  }

  /** Records that the website has storage in `profile` that stays until it is removed. A repeat changes nothing. */
  keepApart (origin: string, profile: Profile): void {
    this.#changeApart(origin, profile, true)
  }

  /** Forgets that the website has storage in `profile`, once the storage is gone. */
  dropApart (origin: string, profile: Profile): void {
    this.#changeApart(origin, profile, false)
  }

  /** Returns the removal. */
  onChange (listener: RouteChange): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  #changeApart (origin: string, profile: Profile, apart: boolean): void {
    const routes = this.#loaded()
    if (routes.apart[profile].has(origin) === apart || originFromUrl(origin) !== origin) return
    const kept = emptyApart()
    for (const each of PROFILES) for (const listed of routes.apart[each]) kept[each].add(listed)
    if (apart) kept[profile].add(origin)
    else kept[profile].delete(origin)
    const foreign = new Set(routes.foreign)
    if (!apart && profile === 'nym') foreign.delete(origin)
    const next: ParsedRoutes = { ...routes, apart: kept, foreign }
    // What the person set is not known while the file is unreadable, so nothing is written over it.
    if (!this.#unreadable) this.#save(next)
    this.#routes = next
  }

  #loaded (): ParsedRoutes {
    this.#routes ??= this.#read()
    return this.#routes
  }

  /** A file that is not there is nothing set; a file that is there and cannot be used is kept aside and reported. */
  #read (): ParsedRoutes {
    // Nothing stored is nothing to migrate.
    const none = (): ParsedRoutes => ({ entries: new Map(), apart: emptyApart(), profiles: true, kinds: true, moveAttempts: 0, foreign: new Set() })
    if (this.#path === null) return none()
    let raw: string
    try {
      raw = readFileSync(this.#path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return none()
      this.#setAside(error)
      return none()
    }
    const parsed = parseRoutes(raw, this.#legacyKind)
    if (parsed !== undefined) return parsed
    this.#setAside(new Error('not a routes file'))
    return none()
  }

  #setAside (reason: unknown): void {
    this.#unreadable = true
    console.error('[route] the list of tunnel settings cannot be used, so every origin is treated as on:', reason)
    try {
      if (this.#path !== null) copyFileSync(this.#path, `${this.#path}.corrupt`)
    } catch (error) {
      console.error('[route] could not keep a copy of the unreadable list of tunnel settings:', error)
    }
  }

  /** A loopback or plain-http origin is not written (T13c): its setting holds until the next start. */
  #save (routes: ParsedRoutes): void {
    if (this.#path === null) return
    const written = (origins: Iterable<string>): string[] => [...origins].filter(isPersistableOrigin)
    const entries = [...routes.entries]
    const via: Record<string, TunnelKind> = {}
    for (const [origin, entry] of entries) if (entry === 'socks5' && isPersistableOrigin(origin)) via[origin] = entry
    // A file still waiting for its migration would read every origin as the legacy choice, so it says outright which tunnel each picked.
    const pendingVia: Record<string, TunnelKind> = {}
    if (!routes.kinds) for (const [origin, entry] of entries) if (entry !== 'off' && isPersistableOrigin(origin)) pendingVia[origin] = entry
    try {
      writeFileAtomic(this.#path, JSON.stringify({
        version: FILE_VERSION,
        profiles: routes.profiles ? PROFILES_VERSION : undefined,
        kinds: routes.kinds ? KINDS_VERSION : undefined,
        origins: written(entries.filter(([, entry]) => entry !== 'off').map(([origin]) => origin)),
        via,
        pendingVia: routes.kinds ? undefined : pendingVia,
        off: written(entries.filter(([, entry]) => entry === 'off').map(([origin]) => origin)),
        apart: written(routes.apart.nym),
        apartProxy: written(routes.apart.socks5),
        apartDirect: written(routes.apart.direct),
        apartForeign: routes.foreign.size === 0 ? undefined : written(routes.foreign),
        moveAttempts: routes.moveAttempts === 0 ? undefined : routes.moveAttempts
      }, null, 2))
    } catch (error) {
      console.error('[route] could not save the tunnel settings:', error)
      throw new RouteStoreError('The choice could not be saved.')
    }
  }
}

function emptyApart (): Record<Profile, Set<string>> {
  return { nym: new Set(), socks5: new Set(), direct: new Set() }
}
