// Each site's answer to "may this site show notifications?", kept across
// restarts. Read once, synchronously, into memory: the permission gate's
// CHECK handler is synchronous, so it answers from memory and never waits on
// disk. Disposable: plain JSON under userData, tied to nothing but Node.
import { readFileSync } from 'node:fs'
import { writeFileAtomic } from '../../broker/grants/node-ledger-storage.js'
import { originFromUrl } from '../../broker/policy/origin.js'

export type NotificationDecision = 'allow' | 'block'

const FILE_VERSION = 1

function isDecision (value: unknown): value is NotificationDecision {
  return value === 'allow' || value === 'block'
}

/** The file is user-writable, so every entry is untrusted: kept only when
 * its key is exactly the origin the gate itself would derive, and its value
 * is one of the two answers. Anything else starts the store empty. */
export function parseNotificationDecisions (raw: string): Map<string, NotificationDecision> {
  const decisions = new Map<string, NotificationDecision>()
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return decisions
  }
  if (typeof data !== 'object' || data === null) return decisions
  const { version, origins } = data as { version?: unknown, origins?: unknown }
  if (version !== FILE_VERSION || typeof origins !== 'object' || origins === null || Array.isArray(origins)) return decisions
  for (const [origin, decision] of Object.entries(origins)) {
    if (originFromUrl(origin) === origin && isDecision(decision)) decisions.set(origin, decision)
  }
  return decisions
}

export class NotificationDecisions {
  readonly #path: string
  #decisions: Map<string, NotificationDecision> | undefined

  constructor (path: string) {
    this.#path = path
  }

  get (origin: string): NotificationDecision | undefined {
    return this.#loaded().get(origin)
  }

  set (origin: string, decision: NotificationDecision): void {
    this.#loaded().set(origin, decision)
    this.#save()
  }

  /** Back to "never asked": the site's next request prompts again. */
  forget (origin: string): void {
    if (this.#loaded().delete(origin)) this.#save()
  }

  entries (): Array<{ origin: string, decision: NotificationDecision }> {
    return [...this.#loaded()].map(([origin, decision]) => ({ origin, decision }))
  }

  #loaded (): Map<string, NotificationDecision> {
    if (this.#decisions === undefined) {
      let raw = ''
      try {
        raw = readFileSync(this.#path, 'utf8')
      } catch {
        // No file yet: nobody has answered for any site.
      }
      this.#decisions = parseNotificationDecisions(raw)
    }
    return this.#decisions
  }

  /** Never throws: the answer already holds in memory for this session, and
   * a disk that refuses the copy must not undo it. */
  #save (): void {
    const origins = Object.fromEntries(this.#loaded())
    try {
      writeFileAtomic(this.#path, JSON.stringify({ version: FILE_VERSION, origins }, null, 2))
    } catch (error) {
      console.error('[notifications] could not save site notification decisions:', error)
    }
  }
}
