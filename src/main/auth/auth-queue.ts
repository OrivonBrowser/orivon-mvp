// The HTTP sign-in challenges waiting for an answer, and the rules that keep a page from wearing the person
// down with them. Pure: no `electron` import; the real callback and timers are handed in.

/** The server that asked, as Electron reports it (`AuthInfo`), plus the scheme of the address it was asked at. */
export interface AuthServer {
  readonly scheme: string
  readonly host: string
  readonly port: number
  readonly isProxy: boolean
  readonly realm: string
}

export interface Credentials { readonly username: string, readonly password: string }

/** What a sheet's "Remember this password" keeps once the sign-in is seen to work. */
export interface RememberedLogin { readonly origin: string, readonly username: string, readonly password: string }

export interface ChallengeInput {
  /** The window that holds the tab: an object, compared by identity. */
  readonly owner: object
  readonly tabId: string
  /** Changes whenever the tab starts a new main-frame navigation. */
  readonly load: number
  readonly server: AuthServer
  /** False when the server is asking again after a wrong answer. */
  readonly first: boolean
  /** The request travels over plain `http:` to the server (never true for a proxy). */
  readonly insecure: boolean
  /** The request does not come from the page the person is looking at. */
  readonly mismatch: boolean
}

export interface Challenge extends ChallengeInput {
  readonly id: string
  /** The username this tab last sent to this server, kept for the sheet that asks again. */
  readonly username: string
}

/** A tab's sheets per page load: a page that keeps asking is answered with cancels after this many. */
export const MAX_PER_LOAD = 3
/** How long a challenge may wait out of sight before it is cancelled. */
export const WAIT_MS = 120_000

export interface AuthQueueDeps {
  schedule: (run: () => void, ms: number) => () => void
  newId: () => string
}

interface TabRecord {
  load: number
  count: number
  /** Servers this load's person already turned away. */
  cancelled: Set<string>
  submitted: Map<string, string>
  remember: (RememberedLogin & { key: string }) | undefined
  pending: Set<string>
}

interface Entry {
  readonly challenge: Challenge
  readonly key: string
  readonly respond: (answer: Credentials | null) => void
  readonly onExpire: () => void
  stop: (() => void) | undefined
}

const serverKey = (server: AuthServer): string => `${server.isProxy ? 'proxy' : server.scheme}://${server.host}:${String(server.port)}|${server.realm}`

export class AuthChallenges {
  private readonly entries = new Map<string, Entry>()
  private readonly tabs = new WeakMap<object, Map<string, TabRecord>>()

  constructor (private readonly deps: AuthQueueDeps) {}

  private record (owner: object, tabId: string, load: number): TabRecord {
    let byTab = this.tabs.get(owner)
    if (byTab === undefined) this.tabs.set(owner, byTab = new Map())
    let record = byTab.get(tabId)
    if (record === undefined) byTab.set(tabId, record = { load, count: 0, cancelled: new Set(), submitted: new Map(), remember: undefined, pending: new Set() })
    if (record.load !== load) {
      record.load = load
      record.count = 0
      record.cancelled.clear()
      record.submitted.clear()
      record.remember = undefined
    }
    return record
  }

  /**
   * Takes a challenge, or refuses it: a server already turned away during this load, or a fourth sign-in in one
   * load, is answered with a cancel at once and gets no sheet. `onExpire` runs after a challenge that waited too
   * long has been cancelled, so the caller can take its sheet away.
   */
  add (input: ChallengeInput, respond: (answer: Credentials | null) => void, onExpire: () => void): Challenge | null {
    const record = this.record(input.owner, input.tabId, input.load)
    const key = serverKey(input.server)
    // A second ask for the same server means the last answer was wrong: what was about to be remembered is not a login.
    if (!input.first && record.remember?.key === key) record.remember = undefined
    if (record.cancelled.has(key) || record.count >= MAX_PER_LOAD) {
      respond(null)
      return null
    }
    record.count++
    const challenge: Challenge = { ...input, id: this.deps.newId(), username: input.first ? '' : record.submitted.get(key) ?? '' }
    const entry: Entry = { challenge, key, respond, onExpire, stop: undefined }
    this.entries.set(challenge.id, entry)
    record.pending.add(challenge.id)
    this.arm(entry)
    return challenge
  }

  get (id: string): Challenge | undefined {
    return this.entries.get(id)?.challenge
  }

  /** The challenge is on screen: it waits as long as the person needs. */
  shown (id: string): void {
    this.disarm(this.entries.get(id))
  }

  /** The challenge went out of sight (its tab went to the background): the clock starts again. */
  hidden (id: string): void {
    const entry = this.entries.get(id)
    if (entry !== undefined) this.arm(entry)
  }

  /** Answers a challenge once; false when it was already answered or is unknown. */
  answer (id: string, answer: Credentials | null, remember?: { origin: string }): boolean {
    const entry = this.entries.get(id)
    if (entry === undefined) return false
    this.entries.delete(id)
    this.disarm(entry)
    const { owner, tabId, load } = entry.challenge
    const record = this.tabs.get(owner)?.get(tabId)
    record?.pending.delete(id)
    // An answer to a page the tab has since left says nothing about the page it shows now.
    if (record !== undefined && record.load === load) {
      if (answer === null) {
        record.cancelled.add(entry.key)
      } else {
        record.submitted.set(entry.key, answer.username)
        if (remember !== undefined) record.remember = { key: entry.key, origin: remember.origin, username: answer.username, password: answer.password }
      }
    }
    try {
      entry.respond(answer)
    } catch (error) {
      console.error('[auth] answering a sign-in failed:', error instanceof Error ? error.message : 'unknown')
    }
    return true
  }

  cancel (id: string): boolean {
    return this.answer(id, null)
  }

  /** The sign-in that was about to be remembered, if the server has not asked again since. Taking it clears it. */
  takeRemember (owner: object, tabId: string): RememberedLogin | undefined {
    const record = this.tabs.get(owner)?.get(tabId)
    const taken = record?.remember
    if (record === undefined || taken === undefined) return undefined
    record.remember = undefined
    return { origin: taken.origin, username: taken.username, password: taken.password }
  }

  /** The tab is gone: everything it was asked is cancelled and forgotten. */
  dropTab (owner: object, tabId: string): void {
    const record = this.tabs.get(owner)?.get(tabId)
    if (record === undefined) return
    for (const id of [...record.pending]) this.cancel(id)
    this.tabs.get(owner)?.delete(tabId)
  }

  pendingCount (): number {
    return this.entries.size
  }

  private arm (entry: Entry): void {
    this.disarm(entry)
    const { id } = entry.challenge
    entry.stop = this.deps.schedule(() => {
      entry.stop = undefined
      if (this.cancel(id)) entry.onExpire()
    }, WAIT_MS)
  }

  private disarm (entry: Entry | undefined): void {
    if (entry?.stop === undefined) return
    entry.stop()
    entry.stop = undefined
  }
}
