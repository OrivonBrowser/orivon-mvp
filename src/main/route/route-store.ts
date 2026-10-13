// The apps the person routed through their proxy, kept across restarts: a set of origins in `routes.json` under the
// profile (memory only in a private session). Which proxy that is lives in the settings. Disposable: plain JSON,
// tied to nothing but Node. A file that is there but cannot be trusted is not "nothing routed": see `unreadable`.
import { copyFileSync, readFileSync } from 'node:fs'
import { writeFileAtomic } from '../../broker/adapters/atomic-write.js'
import { isPersistableOrigin, originFromUrl } from '../../broker/policy/origin.js'

const FILE_VERSION = 1

/** The file is user-writable, so every entry is untrusted: kept only under the exact origin the broker would derive. Undefined when the file is not a routes file at all. */
export function parseRoutes (raw: string): Set<string> | undefined {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof data !== 'object' || data === null) return undefined
  const { version, origins: listed } = data as { version?: unknown, origins?: unknown }
  if (version !== FILE_VERSION || !Array.isArray(listed)) return undefined
  const origins = new Set<string>()
  for (const origin of listed) if (typeof origin === 'string' && originFromUrl(origin) === origin) origins.add(origin)
  return origins
}

/** What a switch reports when it could not be kept. */
/** What a switch reports when it could not be kept. */
export class RouteStoreError extends Error {}

export class RouteStore {
  readonly #path: string | null
  #origins: Set<string> | undefined
  #unreadable = false
  readonly #listeners = new Set<(origin: string, routed: boolean) => void>()

  /** A null path keeps the routes in memory only, for a private session. */
  constructor (path: string | null) {
    this.#path = path
  }

  has (origin: string): boolean {
    return this.#loaded().has(origin)
  }

  origins (): string[] {
    return [...this.#loaded()]
  }

  /**
   * Whether the file is there but cannot be read or understood, so which apps were routed is not known: whoever
   * decides what is routed treats every app as routed while this holds. A copy of the file is kept beside it, the
   * file itself is never written over, and it stays unreadable at the next start until the person mends or removes it.
   */
  unreadable (): boolean {
    this.#loaded()
    return this.#unreadable
  }

  /**
   * Whether anything changed: false for a repeat and for an origin that is not canonical. Throws `RouteStoreError`,
   * having changed nothing, when the choice could not be saved or while the file is unreadable (an app cannot be
   * switched off when the apps that were routed are not known).
   */
  set (origin: string, routed: boolean): boolean {
    const origins = this.#loaded()
    if (this.#unreadable) {
      if (routed) return false
      throw new RouteStoreError('The list of routed apps could not be read, so every app stays routed until it is mended.')
    }
    if (routed ? origins.has(origin) || originFromUrl(origin) !== origin : !origins.has(origin)) return false
    const next = new Set(origins)
    if (routed) next.add(origin)
    else next.delete(origin)
    this.#save(next)
    this.#origins = next
    for (const listener of [...this.#listeners]) listener(origin, routed)
    return true
  }

  /** Returns the removal. */
  onChange (listener: (origin: string, routed: boolean) => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  #loaded (): Set<string> {
    if (this.#origins === undefined) this.#origins = this.#read()
    return this.#origins
  }

  /** A file that is not there is no app routed; a file that is there and cannot be used is kept aside and reported. */
  #read (): Set<string> {
    if (this.#path === null) return new Set()
    let raw: string
    try {
      raw = readFileSync(this.#path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set()
      return this.#setAside(error)
    }
    return parseRoutes(raw) ?? this.#setAside(new Error('not a routes file'))
  }

  #setAside (reason: unknown): Set<string> {
    this.#unreadable = true
    console.error('[route] the list of routed apps cannot be used, so every app is treated as routed:', reason)
    try {
      if (this.#path !== null) copyFileSync(this.#path, `${this.#path}.corrupt`)
    } catch (error) {
      console.error('[route] could not keep a copy of the unreadable list of routed apps:', error)
    }
    return new Set()
  }

  /** A loopback or plain-http origin is not written (T13c): it is routed until the next start. */
  #save (origins: ReadonlySet<string>): void {
    if (this.#path === null) return
    try {
      writeFileAtomic(this.#path, JSON.stringify({ version: FILE_VERSION, origins: [...origins].filter(isPersistableOrigin) }, null, 2))
    } catch (error) {
      console.error('[route] could not save the routed apps:', error)
      throw new RouteStoreError('The choice could not be saved.')
    }
  }
}
