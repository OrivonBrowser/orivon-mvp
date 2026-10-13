// What the person set for the tunnel, per origin, kept across restarts in `routes.json` under the profile (memory only in
// a private session): the origins that are `on`, the ones that are `off`, and the websites that have storage of their own.
// The proxy itself lives in the settings. Disposable: plain JSON, tied to nothing but Node. A file that is there but
// cannot be trusted is not "nothing set": see `unreadable`.
import { copyFileSync, readFileSync } from 'node:fs'
import { writeFileAtomic } from '../../broker/adapters/atomic-write.js'
import { isPersistableOrigin, originFromUrl } from '../../broker/policy/origin.js'
import type { TunnelEntry } from './route-state.js'

const FILE_VERSION = 1

/** What the file holds, each set of origins checked. */
export interface ParsedRoutes {
  readonly on: Set<string>
  readonly off: Set<string>
  /** The websites whose own session has been used: their storage is kept until the person removes it. */
  readonly apart: Set<string>
}

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
 * origin listed both ways is `on`. Undefined when the file is not a routes file at all.
 */
export function parseRoutes (raw: string): ParsedRoutes | undefined {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof data !== 'object' || data === null) return undefined
  const { version, origins: listed, off: listedOff, apart: listedApart } = data as { version?: unknown, origins?: unknown, off?: unknown, apart?: unknown }
  if (version !== FILE_VERSION || !Array.isArray(listed)) return undefined
  const on = originsOf(listed)
  const off = originsOf(listedOff)
  const apart = originsOf(listedApart)
  if (on === undefined || off === undefined || apart === undefined) return undefined
  for (const origin of on) off.delete(origin)
  return { on, off, apart }
}

/** What a switch reports when it could not be kept. */
export class RouteStoreError extends Error {}

export type RouteChange = (origin: string, entry: TunnelEntry | undefined, previous: TunnelEntry | undefined) => void

export class RouteStore {
  readonly #path: string | null
  #routes: ParsedRoutes | undefined
  #unreadable = false
  readonly #listeners = new Set<RouteChange>()

  /** A null path keeps the routes in memory only, for a private session. */
  constructor (path: string | null) {
    this.#path = path
  }

  /** Whether the origin has an entry of `on`: the answer for an installed app, whose default is off. */
  has (origin: string): boolean {
    return this.#loaded().on.has(origin)
  }

  /** What the person set for the origin, or undefined when it follows the default. */
  stateOf (origin: string): TunnelEntry | undefined {
    const { on, off } = this.#loaded()
    return on.has(origin) ? 'on' : off.has(origin) ? 'off' : undefined
  }

  /** The origins that are `on`. */
  origins (): string[] {
    return [...this.#loaded().on]
  }

  /** Every origin that has an entry. */
  entries (): Array<readonly [string, TunnelEntry]> {
    const { on, off } = this.#loaded()
    return [...[...on].map((origin) => [origin, 'on'] as const), ...[...off].map((origin) => [origin, 'off'] as const)]
  }

  /** The websites that have storage of their own, whether or not they have an entry now. */
  apart (): string[] {
    return [...this.#loaded().apart]
  }

  isApart (origin: string): boolean {
    return this.#loaded().apart.has(origin)
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

  /** `set(origin, true)` is an `on` entry and `set(origin, false)` takes the entry away: what the app card's switch does. */
  set (origin: string, routed: boolean): boolean {
    return this.setEntry(origin, routed ? 'on' : undefined)
  }

  /**
   * Whether anything changed: false for a repeat and for an origin that is not canonical. Throws `RouteStoreError`,
   * having changed nothing, when the choice could not be saved or while the file is unreadable (what was set is not
   * known, so an entry cannot be taken away or turned off).
   */
  setEntry (origin: string, entry: TunnelEntry | undefined): boolean {
    const routes = this.#loaded()
    const previous = this.stateOf(origin)
    if (this.#unreadable) {
      if (entry === 'on') return false
      throw new RouteStoreError('The list of tunnel settings could not be read, so every site and app stays on the tunnel until it is mended.')
    }
    if (previous === entry || (entry !== undefined && originFromUrl(origin) !== origin)) return false
    const next: ParsedRoutes = { on: new Set(routes.on), off: new Set(routes.off), apart: new Set(routes.apart) }
    next.on.delete(origin)
    next.off.delete(origin)
    if (entry === 'on') next.on.add(origin)
    if (entry === 'off') next.off.add(origin)
    this.#save(next)
    this.#routes = next
    for (const listener of [...this.#listeners]) listener(origin, entry, previous)
    return true
  }

  /** Records that the website's own session holds storage that stays until it is removed. A repeat changes nothing. */
  keepApart (origin: string): void {
    this.#changeApart(origin, true)
  }

  /** Forgets that the website has storage of its own, once the storage is gone. */
  dropApart (origin: string): void {
    this.#changeApart(origin, false)
  }

  /** Returns the removal. */
  onChange (listener: RouteChange): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  #changeApart (origin: string, apart: boolean): void {
    const routes = this.#loaded()
    if (routes.apart.has(origin) === apart || originFromUrl(origin) !== origin) return
    const next: ParsedRoutes = { on: routes.on, off: routes.off, apart: new Set(routes.apart) }
    if (apart) next.apart.add(origin)
    else next.apart.delete(origin)
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
    const none = (): ParsedRoutes => ({ on: new Set(), off: new Set(), apart: new Set() })
    if (this.#path === null) return none()
    let raw: string
    try {
      raw = readFileSync(this.#path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return none()
      this.#setAside(error)
      return none()
    }
    const parsed = parseRoutes(raw)
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
    const written = (origins: ReadonlySet<string>): string[] => [...origins].filter(isPersistableOrigin)
    try {
      writeFileAtomic(this.#path, JSON.stringify({ version: FILE_VERSION, origins: written(routes.on), off: written(routes.off), apart: written(routes.apart) }, null, 2))
    } catch (error) {
      console.error('[route] could not save the tunnel settings:', error)
      throw new RouteStoreError('The choice could not be saved.')
    }
  }
}
