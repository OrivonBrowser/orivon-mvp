// The app the person chose to open each kind of link in, kept across restarts (d-0596): "always open magnet links in
// this app". Read once into memory; a question asked of the person each time is not stored here. Disposable: plain
// JSON under userData, tied to nothing but Node.
import { readFileSync } from 'node:fs'
import { writeFileAtomic } from '../../broker/adapters/atomic-write.js'
import { isPersistableOrigin, originFromUrl } from '../../broker/policy/origin.js'
import { isHandableScheme } from '../sessions/external-links.js'

const FILE_VERSION = 1

/** The file is user-writable, so every entry is untrusted: kept only for a scheme a link may go to an app for, under the exact origin the broker would derive. */
export function parseSchemeChoices (raw: string): Map<string, string> {
  const choices = new Map<string, string>()
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return choices
  }
  if (typeof data !== 'object' || data === null) return choices
  const { version, schemes } = data as { version?: unknown, schemes?: unknown }
  if (version !== FILE_VERSION || typeof schemes !== 'object' || schemes === null || Array.isArray(schemes)) return choices
  for (const [scheme, origin] of Object.entries(schemes)) {
    if (isHandableScheme(scheme) && typeof origin === 'string' && originFromUrl(origin) === origin) choices.set(scheme, origin)
  }
  return choices
}

export class SchemeChoices {
  readonly #path: string | null
  #choices: Map<string, string> | undefined
  readonly #listeners = new Set<() => void>()

  /** A null path keeps the choices in memory only, for a private session. */
  constructor (path: string | null) {
    this.#path = path
  }

  /** The origin of the app chosen for `scheme`, or undefined when the person is asked each time. */
  get (scheme: string): string | undefined {
    return this.#loaded().get(scheme)
  }

  set (scheme: string, origin: string): void {
    if (!isHandableScheme(scheme) || originFromUrl(origin) !== origin || this.#loaded().get(scheme) === origin) return
    this.#loaded().set(scheme, origin)
    this.#changed()
  }

  /** Back to asking each time. False when nothing was chosen. */
  forget (scheme: string): boolean {
    if (!this.#loaded().delete(scheme)) return false
    this.#changed()
    return true
  }

  /** Every scheme `origin` was chosen for. */
  schemesOf (origin: string): string[] {
    return [...this.#loaded()].filter(([, chosen]) => chosen === origin).map(([scheme]) => scheme)
  }

  /** Returns the removal. */
  onChange (listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  #changed (): void {
    this.#save()
    for (const listener of [...this.#listeners]) listener()
  }

  #loaded (): Map<string, string> {
    if (this.#choices === undefined) {
      let raw = ''
      try {
        if (this.#path !== null) raw = readFileSync(this.#path, 'utf8')
      } catch {
        // No file yet: nothing was chosen.
      }
      this.#choices = parseSchemeChoices(raw)
    }
    return this.#choices
  }

  /** Never throws: the choice already holds in memory for this session. A loopback or plain-http origin is not written (T13c). */
  #save (): void {
    if (this.#path === null) return
    const schemes: Record<string, string> = {}
    for (const [scheme, origin] of this.#loaded()) if (isPersistableOrigin(origin)) schemes[scheme] = origin
    try {
      writeFileAtomic(this.#path, JSON.stringify({ version: FILE_VERSION, schemes }, null, 2))
    } catch (error) {
      console.error('[scheme-routing] could not save the chosen apps:', error)
    }
  }
}
