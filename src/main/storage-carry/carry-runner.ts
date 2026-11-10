// One origin's storage, from the partition an app used to run in into the session websites run in. The Electron parts
// (the sessions, the hidden pages) come in as the two `CarrySide`s, so every step here runs against fakes in a unit test.
//
// The old partition's data replaces what the target holds for the origin, and it is all or nothing: when the old partition
// holds nothing for the origin, nothing changes; when it does, the target's storage for the origin is cleared first, and a
// carry that cannot finish clears the half copy again. Cookies go last, so a carry that fails before them leaves none.

import { callCode, carryPageCode } from './page-code.js'
import { cookieBelongsToHost, planCookie } from './cookies.js'
import type { CookieToSet, OldCookie } from './cookies.js'
import { addProblem, newReport, summarize } from './report.js'
import type { CarryReport } from './report.js'

/** A hidden page at the origin, in one session. */
export interface CarryPage {
  /** Runs `code` in the page and returns the string it ends with; rejects when the page cannot answer. */
  run: (code: string) => Promise<string>
  /** Hands the page one end of a message channel, for the script installed in it to take. */
  give: (port: unknown) => Promise<void>
  close: () => void
}

export interface CookieJar {
  all: () => Promise<readonly OldCookie[]>
  set: (cookie: CookieToSet) => Promise<void>
  remove: (url: string, name: string) => Promise<void>
}

export interface CarrySide {
  readonly cookies: CookieJar
  /** Opens a hidden page that `nonce` identifies: the page shows the nonce, so the shell knows it is its own. */
  readonly open: (nonce: string) => Promise<CarryPage>
}

export interface CarryLog {
  info: (text: string) => void
  warn: (text: string) => void
}

export interface CarryRequest {
  readonly origin: string
  readonly source: CarrySide
  readonly target: CarrySide
  /** Removes what the target session holds for the origin in local storage, databases, service workers and cache storage. */
  readonly clearTarget: () => Promise<void>
  /** The two ends of a new message channel between the two hidden pages. */
  readonly channel: () => { readonly first: unknown, readonly second: unknown }
  readonly nonce: () => string
  /** Aborts at the deadline: the carry stops, clears what it wrote and ends as failed. */
  readonly signal: AbortSignal
  /** What the old partition holds that the carry does not move: only named in the log. */
  readonly notCarried: readonly string[]
  readonly nowSeconds: () => number
  readonly log: CarryLog
  /** Called once, when the old partition has been read and holds something to carry, just before the carry first changes the website session. */
  readonly beforeWriting?: () => void
  /** The longest the clearing of a half copy may take; the carry ends when it has passed, with the clearing perhaps still running. */
  readonly cleanupMs?: number
}

export interface CarryOutcome {
  /** `failed` when the carry did not reach the end: it cleared what it had written, and the old partition is untouched. */
  readonly status: 'carried' | 'failed'
  readonly reason?: string
  readonly report: CarryReport
}

/** How long the carry waits for the clearing of a half copy to end or fail before it gives up waiting: the page of the app is held until then. Provisional: a profile with a database of several gigabytes would settle it. */
export const CLEANUP_MS = 5 * 60_000

interface StoreShape { name: string, keyPath: string | string[] | null, autoIncrement: boolean, indexes: unknown[], count: number }
interface DatabaseShape { name: string, version: number, stores: StoreShape[], error?: string }
interface Sent { read: number, done: boolean, skipped: string[] }
interface Written { written: number, problems: string[], aborted?: string }

interface Side {
  readonly page: CarryPage
  readonly nonce: string
}

class CarryAborted extends Error {
  constructor () { super('the carry did not finish in time') }
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** Carries `request.origin`'s cookies, local storage and databases, and says what it did. It does not throw. */
export async function carryStorage (request: CarryRequest): Promise<CarryOutcome> {
  const { origin, log, signal } = request
  const host = new URL(origin).hostname
  const report = newReport()
  report.notCarried.push(...request.notCarried)

  const aborted = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) reject(new CarryAborted())
    else signal.addEventListener('abort', () => { reject(new CarryAborted()) }, { once: true })
  })
  aborted.catch(() => undefined)
  /** Waits for `work`, or ends the carry when the deadline passes first. */
  const step = async <T>(work: Promise<T>): Promise<T> => await Promise.race([work, aborted])

  const sides: Side[] = []
  const written: CookieToSet[] = []
  let cleared = false
  let failure: string | undefined
  let batchId = 0

  const open = async (side: CarrySide): Promise<Side> => {
    const nonce = request.nonce()
    const opening = side.open(nonce)
    let page: CarryPage
    try {
      page = await step(opening)
    } catch (error) {
      // A page that finishes opening after the carry stopped waiting for it is held by nobody else: it is closed as it arrives.
      void opening.then((late) => { try { late.close() } catch { /* a page that is already gone needs no closing */ } }, () => undefined)
      throw error
    }
    const opened = { page, nonce }
    sides.push(opened)
    if (await step(page.run(carryPageCode(nonce))) !== 'ready') throw new Error('the hidden page already defines the name the carry installs under')
    return opened
  }
  const tell = async (side: Side, name: string, args?: unknown): Promise<string> => await step(side.page.run(callCode(side.nonce, name, args)))
  const ask = async <T>(side: Side, name: string, args?: unknown): Promise<T> => JSON.parse(await tell(side, name, args)) as T

  try {
    const all = await step(request.source.cookies.all())
    const own = all.filter((cookie) => cookieBelongsToHost(cookie, host))
    report.cookies.skipped += all.length - own.length

    const source = await open(request.source)
    const entries = await ask<Array<[string, string]>>(source, 'readLocalStorage')
    const shapes = await ask<DatabaseShape[]>(source, 'readDatabases')
    if (own.length === 0 && entries.length === 0 && shapes.length === 0) {
      log.info(`[carry] ${origin}: the old partition holds nothing for this origin; the website session is left as it is`)
      return { status: 'carried', report }
    }

    request.beforeWriting?.()
    cleared = true
    await step(request.clearTarget())
    const target = await open(request.target)
    const channel = request.channel()
    await step(source.page.give(channel.first))
    await step(target.page.give(channel.second))
    const connected = await Promise.all([tell(source, 'connect').catch(() => 'no'), tell(target, 'connect').catch(() => 'no')])
    if (connected.some((answer) => answer !== 'connected')) throw new Error('the hidden pages did not get their message port')

    await carryLocalStorage(target, entries, report, ask)
    await carryDatabases(source, target, shapes, report, { ask, tell }, () => ++batchId)
    await carryCookies(request, own, report, written, step)
    await Promise.allSettled(sides.map(async (side) => await tell(side, 'closeAll')))
  } catch (error) {
    failure = messageOf(error)
  } finally {
    for (const side of sides) {
      try { side.page.close() } catch { /* a page that is already gone needs no closing */ }
    }
  }

  if (failure !== undefined && cleared) {
    const left = await clearHalfCopy(request, written)
    if (left !== undefined) failure += `; ${left}`
  }

  for (const problem of report.problems) log.warn(`[carry] ${origin}: could not carry ${problem}`)
  if (report.problemsLeftOut > 0) log.warn(`[carry] ${origin}: ${String(report.problemsLeftOut)} more problems are not listed`)
  if (report.notCarried.length > 0) log.info(`[carry] ${origin}: not carried: ${report.notCarried.join(', ')}; the app makes them again`)
  if (failure === undefined) {
    log.info(`[carry] ${origin}: carried ${summarize(report)}`)
    return { status: 'carried', report }
  }
  log.warn(`[carry] ${origin}: stopped, ${failure}; ${cleared ? 'what it had written was cleared, and ' : ''}the old partition is untouched`)
  return { status: 'failed', reason: failure, report }
}

/**
 * Clears what a carry that stopped wrote into the target. Returns what is left when that fails, else undefined. It returns
 * once every part of the clearing has ended or failed, or `cleanupMs` has passed: the page of the app is let through when the
 * carry returns, so a part still running at that point can remove what the page writes.
 */
async function clearHalfCopy (request: CarryRequest, written: readonly CookieToSet[]): Promise<string | undefined> {
  const limit = request.cleanupMs ?? CLEANUP_MS
  let timer: NodeJS.Timeout | undefined
  const parts = Promise.allSettled([request.clearTarget(), ...written.map(async (cookie) => { await request.target.cookies.remove(cookie.url, cookie.name) })])
  try {
    const settled = await Promise.race([
      parts,
      new Promise<'late'>((resolve) => { timer = setTimeout(() => { resolve('late') }, limit) })
    ])
    if (settled === 'late') return `the half copy could not be cleared (it was still being cleared after ${String(limit)} ms)`
    const refused = settled.find((part): part is PromiseRejectedResult => part.status === 'rejected')
    return refused === undefined ? undefined : `the half copy could not be cleared (${messageOf(refused.reason)})`
  } finally {
    clearTimeout(timer)
  }
}

type Ask = <T>(side: Side, name: string, args?: unknown) => Promise<T>
type Tell = (side: Side, name: string, args?: unknown) => Promise<string>

async function carryLocalStorage (target: Side, entries: ReadonlyArray<[string, string]>, report: CarryReport, ask: Ask): Promise<void> {
  // A page can hold about 10 MB: sent in slices, so that no script text is larger than a batch of records.
  let slice: Array<[string, string]> = []
  let bytes = 0
  const send = async (): Promise<void> => {
    if (slice.length === 0) return
    const wrote = await ask<{ carried: number, problems: string[] }>(target, 'writeLocalStorage', slice)
    report.localStorage.carried += wrote.carried
    report.localStorage.failed += wrote.problems.length
    for (const problem of wrote.problems) addProblem(report, `local storage ${problem}`)
    slice = []
    bytes = 0
  }
  for (const entry of entries) {
    slice.push(entry)
    bytes += entry[0].length + entry[1].length
    if (bytes >= 1_000_000) await send()
  }
  await send()
}

async function carryDatabases (source: Side, target: Side, shapes: readonly DatabaseShape[], report: CarryReport, calls: { ask: Ask, tell: Tell }, nextBatch: () => number): Promise<void> {
  const { ask, tell } = calls
  for (const shape of shapes) {
    const label = `database "${shape.name}"`
    if (shape.error !== undefined) {
      report.databases.failed += 1
      addProblem(report, `${label}: it could not be opened (${shape.error})`)
      continue
    }
    try {
      const made = await ask<{ status: 'created' | 'failed', reason?: string }>(target, 'writeSchema', { name: shape.name, version: shape.version, stores: shape.stores })
      if (made.status === 'failed') {
        report.databases.failed += 1
        addProblem(report, `${label}: it could not be made in the website session (${made.reason ?? 'no reason given'})`)
        continue
      }
      let lost = 0
      for (const store of shape.stores) lost += await carryStore(source, target, report, shape.name, store, label, ask, nextBatch)
      if (lost > 0) {
        report.databases.partial += 1
        addProblem(report, `${label}: partial, ${String(lost)} records not carried`)
      } else {
        report.databases.carried += 1
      }
    } catch (error) {
      if (error instanceof CarryAborted) throw error
      report.databases.failed += 1
      addProblem(report, `${label}: ${messageOf(error)}`)
      // The half-made database is removed, so the website session never holds a database that is only partly the app's. When it stays, the carry ends as failed: its clearing of the website session takes the database away.
      await dropFailed(target, shape.name, label, ask, report)
      // One database that fails is its own; two pages that no longer answer end the carry.
      try {
        await Promise.all([tell(source, 'connect'), tell(target, 'connect')])
      } catch (gone) {
        throw gone instanceof CarryAborted ? gone : new Error(`a hidden page stopped answering (${messageOf(gone)})`)
      }
    }
  }
}

/** Removes the database a failed carry of it left in the target; throws, naming the database, when it stays. */
async function dropFailed (target: Side, name: string, label: string, ask: Ask, report: CarryReport): Promise<void> {
  let reason: string | undefined
  try {
    const answer = await ask<{ dropped: boolean, reason?: string }>(target, 'dropDatabase', name)
    if (!answer.dropped) reason = answer.reason ?? 'no reason given'
  } catch (error) {
    if (error instanceof CarryAborted) throw error
    reason = messageOf(error)
  }
  if (reason === undefined) return
  addProblem(report, `${label}: it could not be removed after it failed (${reason})`)
  throw new Error(`${label} could not be removed after it failed (${reason})`)
}

/** Moves one store; returns how many of its records were not carried. */
async function carryStore (source: Side, target: Side, report: CarryReport, db: string, store: StoreShape, label: string, ask: Ask, nextBatch: () => number): Promise<number> {
  let offset = 0
  let lost = 0
  for (;;) {
    const id = nextBatch()
    const sent = await ask<Sent>(source, 'sendBatch', { db, store: store.name, id, offset, restart: offset === 0 })
    lost += sent.skipped.length
    report.records.failed += sent.skipped.length
    for (const problem of sent.skipped) addProblem(report, `${label} store "${store.name}" ${problem}`)
    const wrote = await ask<Written>(target, 'writeBatch', { db, store: store.name, id, offset })
    if (wrote.aborted !== undefined) throw new Error(`store "${store.name}": a batch could not be stored (${wrote.aborted})`)
    report.records.carried += wrote.written
    report.records.failed += wrote.problems.length
    lost += wrote.problems.length
    for (const problem of wrote.problems) addProblem(report, `${label} store "${store.name}" ${problem}`)
    offset += sent.read
    if (sent.done || sent.read === 0) return lost
  }
}

async function carryCookies (request: CarryRequest, own: readonly OldCookie[], report: CarryReport, written: CookieToSet[], step: <T>(work: Promise<T>) => Promise<T>): Promise<void> {
  const now = request.nowSeconds()
  for (const cookie of own) {
    const plan = planCookie(cookie, now)
    if (plan.kind === 'skip') {
      report.cookies.skipped += 1
      continue
    }
    // Listed before it is set, so a carry cut short in the middle of the call still removes it.
    written.push(plan.cookie)
    try {
      await step(request.target.cookies.set(plan.cookie))
      report.cookies.carried += 1
    } catch (error) {
      if (error instanceof CarryAborted) throw error
      written.pop()
      report.cookies.failed += 1
      addProblem(report, `cookie "${cookie.name}" of ${cookie.domain ?? 'no domain'}: ${messageOf(error)}`)
    }
  }
}
