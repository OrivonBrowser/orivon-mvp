// The apps the person routed through their proxy, kept across restarts: a set of origins in `routes.json` under the
// profile (memory only in a private session). Which proxy that is lives in the settings. Disposable: plain JSON,
// tied to nothing but Node.
import { readFileSync } from 'node:fs'
import { writeFileAtomic } from '../../broker/adapters/atomic-write.js'
import { isPersistableOrigin, originFromUrl } from '../../broker/policy/origin.js'

const FILE_VERSION = 1

/** The file is user-writable, so every entry is untrusted: kept only under the exact origin the broker would derive. */
export function parseRoutes (raw: string): Set<string> {
  const origins = new Set<string>()
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return origins
  }
  if (typeof data !== 'object' || data === null) return origins
  const { version, origins: listed } = data as { version?: unknown, origins?: unknown }
  if (version !== FILE_VERSION || !Array.isArray(listed)) return origins
  for (const origin of listed) if (typeof origin === 'string' && originFromUrl(origin) === origin) origins.add(origin)
  return origins
}

export class RouteStore {
  readonly #path: string | null
  #origins: Set<string> | undefined
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

  /** Whether anything changed: false for a repeat and for an origin that is not canonical. */
  set (origin: string, routed: boolean): boolean {
    const origins = this.#loaded()
    if (routed ? origins.has(origin) || originFromUrl(origin) !== origin : !origins.delete(origin)) return false
    if (routed) origins.add(origin)
    this.#save()
    for (const listener of [...this.#listeners]) listener(origin, routed)
    return true
  }

  /** Returns the removal. */
  onChange (listener: (origin: string, routed: boolean) => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  #loaded (): Set<string> {
    if (this.#origins === undefined) {
      let raw = ''
      try {
        if (this.#path !== null) raw = readFileSync(this.#path, 'utf8')
      } catch {
        // No file yet: nothing was routed.
      }
      this.#origins = parseRoutes(raw)
    }
    return this.#origins
  }

  /** Never throws: the route already holds in memory for this run. A loopback or plain-http origin is not written (T13c). */
  #save (): void {
    if (this.#path === null) return
    try {
      writeFileAtomic(this.#path, JSON.stringify({ version: FILE_VERSION, origins: [...this.#loaded()].filter(isPersistableOrigin) }, null, 2))
    } catch (error) {
      console.error('[route] could not save the routed apps:', error)
    }
  }
}
