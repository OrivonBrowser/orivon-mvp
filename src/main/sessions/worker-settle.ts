// When the workers at an origin the shell serves where websites run are the app's. A document no response was seen for, that a
// worker controls, is the app's only after the origin has settled, in this order (`ADR-0112`):
//   1. the verifier host has been told the shell serves the origin, and has said so: from then on every page it loads is answered
//      by the shell;
//   2. every page of the origin that is not a document the shell answered is loaded again (it was answered by the network, by the
//      HTTP cache or by a worker, before the host knew), and the page a first visit is sending in shows the shell's document;
//   3. when a website's page was open at any time since the serving began, the origin's service workers and Cache Storage are
//      removed: nothing a website's document wrote is left for the app's worker to answer with;
//   4. the origin is marked settled, and documents that commit from then on count.
// A worker script the shell served is held until then (`./app-workers.ts`), so no registration races the removal. Each wait is
// bounded, and a bound that runs out leaves the origin unsettled: worker-answered documents get no grants until a later attempt
// completes. Electron-free: the steps come in.

interface Settling {
  state: 'pending' | 'settled'
  /** Documents that committed at or after this tick were answered after nothing a website's document wrote could be in the origin's storage. */
  trustedFrom: number
  /** The moment the serving was prepared: a document committed since then has nothing of a website's behind it unless a page of one was open. */
  readonly began: number
  /** Whether a page showing a website's document was seen at the origin since the serving began, open or since closed: what it wrote must go. */
  sawWebsite: boolean
  /** Calls waiting in `settledOrigin`, ended when the origin settles. */
  readonly waiters: Set<() => void>
  running: boolean
  attempts: number
}

const origins = new Map<string, Settling>()
let ticks = 0

/** A moment on the order this module keeps: a document's commit and an origin's settling are both put on it. */
export function nextTick (): number {
  ticks += 1
  return ticks
}

function originKey (origin: string): string | undefined {
  try {
    return new URL(origin).origin
  } catch {
    return undefined
  }
}

function fresh (): Settling {
  return { state: 'pending', trustedFrom: Number.POSITIVE_INFINITY, began: nextTick(), sawWebsite: false, waiters: new Set(), running: false, attempts: 0 }
}

/** The shell is about to serve `origin` where websites run: until it settles, a worker's answer is not the app's. */
export function beginSettling (origin: string): void {
  const key = originKey(origin)
  if (key === undefined) return
  const held = origins.get(key)
  if (held !== undefined && held.state === 'pending') return
  origins.set(key, fresh())
}

/** The shell stops serving `origin`. */
export function forgetSettling (origin: string): void {
  const key = originKey(origin)
  if (key !== undefined) origins.delete(key)
}

/** Whether a document of `origin` that committed at `committedAt` (`nextTick`), which a worker answered, is the app's. */
export function workerAnswersTrusted (origin: string, committedAt: number): boolean {
  const key = originKey(origin)
  const held = key === undefined ? undefined : origins.get(key)
  return held !== undefined && held.state === 'settled' && committedAt >= held.trustedFrom
}

/** Whether `origin` has settled, waiting up to `ms` for it to: false when it has not by then (a later attempt may still settle it), and for an origin that is not being settled. */
export async function settledOrigin (origin: string, ms: number): Promise<boolean> {
  const key = originKey(origin)
  const held = key === undefined ? undefined : origins.get(key)
  if (held === undefined) return false
  if (held.state !== 'settled') {
    await new Promise<void>((resolve) => {
      const done = (): void => { clearTimeout(timer); held.waiters.delete(done); resolve() }
      const timer = setTimeout(done, ms)
      held.waiters.add(done)
    })
  }
  return held.state === 'settled'
}

export interface SettleLimits {
  /** How long the host may take to say it was told. */
  readonly hostMs: number
  /** How long one page may take to load again. */
  readonly pageMs: number
  /** How long the page a visit is sending in may take to show the shell's document. */
  readonly enteringMs: number
  /** How long the removal may take. */
  readonly clearMs: number
}

export interface SettleDeps<Page> {
  /** Resolves when the verifier host has the shell's set of served origins as it is now, or at once when no host runs. */
  readonly hostKnows: () => Promise<void>
  /** Every page that shows `origin`, in any session. */
  readonly pagesOf: (origin: string) => readonly Page[]
  /** Whether the page is the app's own: its document is one the shell answered, or it is a page the shell itself opened at the origin. */
  readonly isOwnDocument: (page: Page) => boolean
  /** Whether a first visit is sending the page into the app: its document is a website's until the visit's own load commits. */
  readonly isEntering: (page: Page) => boolean
  /** Loads the page again; resolves once the new document has committed, or the page is gone. */
  readonly reload: (page: Page) => Promise<void>
  /** Resolves once the page shows a document the shell answered, or is gone. */
  readonly becameOwn: (page: Page) => Promise<void>
  /** Removes the origin's service workers and Cache Storage in every session a website at the origin ran in. */
  readonly clear: (origin: string) => Promise<void>
  readonly limits: SettleLimits
  readonly log: (message: string, error?: unknown) => void
}

/** Rejects when `work` has not ended in `ms`; the work itself is not stopped. */
async function within (work: Promise<unknown>, ms: number, what: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { reject(new Error(`${what} did not end in ${ms} ms`)) }, ms) })])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** How long after attempt number `attempts` ran out the next one starts: it doubles from 3 s to a minute, and goes on for as long as the shell serves the origin. */
export function retryDelayMs (attempts: number): number {
  return Math.min(3_000 * 2 ** Math.max(0, attempts - 1), 60_000)
}

/** How many attempts at settling this serving of `origin` have been made. */
export function settleAttempts (origin: string): number {
  const key = originKey(origin)
  return (key === undefined ? undefined : origins.get(key))?.attempts ?? 0
}

/**
 * Settles `origin` as the module's header lays out. Resolves true when it settled, false when a wait ran out (the origin stays
 * unsettled and `settleAttempts` counts the try). A call while one runs, or for an origin settled already, does nothing.
 */
export async function settleServedOrigin<Page> (origin: string, deps: SettleDeps<Page>): Promise<boolean> {
  const key = originKey(origin)
  const held = key === undefined ? undefined : origins.get(key)
  if (key === undefined || held === undefined || held.running || held.state === 'settled') return held?.state === 'settled'
  held.running = true
  held.attempts += 1
  // A page that shows a website's document: one no response of the shell's was seen for, or the page a first visit is sending in.
  // The first look is taken before any wait, while that page still shows it.
  const look = (): Page[] => {
    const website = deps.pagesOf(origin).filter((page) => deps.isEntering(page) || !deps.isOwnDocument(page))
    if (website.length > 0) held.sawWebsite = true
    return website
  }
  look()
  try {
    await within(deps.hostKnows(), deps.limits.hostMs, 'the verifier host saying it was told what the shell serves')
    const website = look()
    await Promise.all(website.map(async (page) => {
      if (deps.isEntering(page)) await within(deps.becameOwn(page), deps.limits.enteringMs, 'the page being sent in showing the shell\'s document')
      else await within(deps.reload(page), deps.limits.pageMs, 'a website page loading again')
    }))
    let trustedFrom = held.began
    if (held.sawWebsite) {
      await within(deps.clear(origin), deps.limits.clearMs, 'the removal of the origin\'s workers and caches')
      trustedFrom = nextTick()
    }
    held.state = 'settled'
    held.trustedFrom = trustedFrom
    for (const waiter of [...held.waiters]) waiter()
    return true
  } catch (error) {
    deps.log(`[workers] ${origin} could not be settled (attempt ${held.attempts}); a page its worker answers gets no grants until it is:`, error)
    return false
  } finally {
    held.running = false
  }
}

/** Forgets every origin: for a test that starts clean. */
export function resetSettlingForTests (): void {
  origins.clear()
  ticks = 0
}
