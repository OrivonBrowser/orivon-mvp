// One origin's storage, from the partition an app used to run in into the session websites run in. The Electron parts
// (the sessions, the hidden pages) come in as the two `CarrySide`s, so every step here runs against fakes in a unit test.
// Nothing in the target is replaced: a cookie, a local storage item or a database the target already holds is left as it
// is, which is what makes a carry that is cut short, or that runs after the app has loaded once, safe to run again.

import { CARRY_PAGE_CODE } from './page-code.js'
import { planCookie, sameCookie } from './cookies.js'
import type { CookieToSet, OldCookie } from './cookies.js'
import { addProblem, newReport, summarize } from './report.js'
import type { CarryReport } from './report.js'

/** A hidden page at the origin, in one session. */
export interface CarryPage {
  /** Runs `code` in the page and returns the string it ends with; rejects when the page cannot answer. */
  run: (code: string) => Promise<string>
  close: () => void
}

export interface CookieJar {
  all: () => Promise<readonly OldCookie[]>
  find: (url: string, name: string) => Promise<readonly OldCookie[]>
  set: (cookie: CookieToSet) => Promise<void>
}

export interface CarrySide {
  readonly cookies: CookieJar
  readonly open: () => Promise<CarryPage>
}

export interface CarryLog {
  info: (text: string) => void
  warn: (text: string) => void
}

export interface CarryRequest {
  readonly origin: string
  readonly source: CarrySide
  readonly target: CarrySide
  /** What the old partition holds that the carry does not move: only named in the log. */
  readonly notCarried: readonly string[]
  readonly nowSeconds: () => number
  readonly log: CarryLog
}

export interface CarryOutcome {
  /** `failed` when a page or a session could not answer: the carry did not reach the end and is tried again at a later start. */
  readonly status: 'carried' | 'failed'
  readonly reason?: string
  readonly report: CarryReport
}

interface StoreShape { name: string, keyPath: string | string[] | null, autoIncrement: boolean, indexes: unknown[], count: number }
interface DatabaseShape { name: string, version: number, stores: StoreShape[], error?: string }
interface ReadBatch { records: unknown[], read: number, next?: unknown, done: boolean, problems: string[] }
interface WriteBatch { written: number, problems: string[] }

const call = (name: string, args?: unknown): string => `__orivonCarry.${name}(${args === undefined ? '' : JSON.stringify(args)})`

async function ask<T> (page: CarryPage, name: string, args?: unknown): Promise<T> {
  return JSON.parse(await page.run(call(name, args))) as T
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** Carries `request.origin`'s cookies, local storage and databases, and says what it did. It does not throw. */
export async function carryStorage (request: CarryRequest): Promise<CarryOutcome> {
  const { origin, log } = request
  const report = newReport()
  report.notCarried.push(...request.notCarried)
  let failure: string | undefined
  const fail = (what: string, error: unknown): void => {
    failure ??= `${what}: ${messageOf(error)}`
    addProblem(report, `${what}: ${messageOf(error)}`)
  }

  await carryCookies(request, report, fail)

  const pages: CarryPage[] = []
  try {
    const source = await request.source.open()
    pages.push(source)
    const target = await request.target.open()
    pages.push(target)
    await source.run(CARRY_PAGE_CODE)
    await target.run(CARRY_PAGE_CODE)
    await carryLocalStorage(source, target, report, fail)
    await carryDatabases(source, target, report, fail)
    await Promise.allSettled([source.run(call('closeAll')), target.run(call('closeAll'))])
  } catch (error) {
    fail('the hidden pages could not be used', error)
  } finally {
    for (const page of pages) {
      try { page.close() } catch { /* a page that is already gone needs no closing */ }
    }
  }

  for (const problem of report.problems) log.warn(`[carry] ${origin}: could not carry ${problem}`)
  if (report.problemsLeftOut > 0) log.warn(`[carry] ${origin}: ${String(report.problemsLeftOut)} more problems are not listed`)
  if (report.notCarried.length > 0) log.info(`[carry] ${origin}: not carried: ${report.notCarried.join(', ')}; the app makes them again`)
  log.info(`[carry] ${origin}: ${failure === undefined ? 'carried' : 'stopped after carrying'} ${summarize(report)}`)
  return failure === undefined ? { status: 'carried', report } : { status: 'failed', reason: failure, report }
}

async function carryCookies (request: CarryRequest, report: CarryReport, fail: (what: string, error: unknown) => void): Promise<void> {
  let old: readonly OldCookie[]
  try {
    old = await request.source.cookies.all()
  } catch (error) {
    fail('the cookies could not be read', error)
    return
  }
  const now = request.nowSeconds()
  for (const cookie of old) {
    const plan = planCookie(cookie, now)
    if (plan.kind === 'skip') {
      report.cookies.skipped += 1
      continue
    }
    try {
      const held = await request.target.cookies.find(plan.cookie.url, plan.cookie.name)
      if (held.some((existing) => sameCookie(existing, plan.cookie))) {
        report.cookies.skipped += 1
        continue
      }
      await request.target.cookies.set(plan.cookie)
      report.cookies.carried += 1
    } catch (error) {
      report.cookies.failed += 1
      addProblem(report, `cookie "${cookie.name}" of ${cookie.domain ?? 'no domain'}: ${messageOf(error)}`)
    }
  }
}

async function carryLocalStorage (source: CarryPage, target: CarryPage, report: CarryReport, fail: (what: string, error: unknown) => void): Promise<void> {
  try {
    const entries = JSON.parse(await source.run(call('readLocalStorage'))) as Array<[string, string]>
    const sizeOf = (entry: [string, string]): number => entry[0].length + entry[1].length
    // A page can hold about 10 MB: sent in slices, so that no script text is larger than the batches databases use.
    let slice: Array<[string, string]> = []
    let bytes = 0
    const send = async (): Promise<void> => {
      if (slice.length === 0) return
      const wrote = await ask<{ carried: number, skipped: number, problems: string[] }>(target, 'writeLocalStorage', slice)
      report.localStorage.carried += wrote.carried
      report.localStorage.skipped += wrote.skipped
      report.localStorage.failed += wrote.problems.length
      for (const problem of wrote.problems) addProblem(report, `local storage ${problem}`)
      slice = []
      bytes = 0
    }
    for (const entry of entries) {
      slice.push(entry)
      bytes += sizeOf(entry)
      if (bytes >= 1_000_000) await send()
    }
    await send()
  } catch (error) {
    fail('local storage could not be carried', error)
  }
}

async function carryDatabases (source: CarryPage, target: CarryPage, report: CarryReport, fail: (what: string, error: unknown) => void): Promise<void> {
  let shapes: DatabaseShape[]
  try {
    shapes = await ask<DatabaseShape[]>(source, 'readDatabases')
  } catch (error) {
    fail('the databases could not be listed', error)
    return
  }
  for (const shape of shapes) {
    const label = `database "${shape.name}"`
    if (shape.error !== undefined) {
      report.databases.failed += 1
      addProblem(report, `${label}: it could not be opened (${shape.error})`)
      continue
    }
    let created = false
    try {
      const made = await ask<{ status: 'created' | 'exists' | 'failed', reason?: string }>(target, 'writeSchema', { name: shape.name, version: shape.version, stores: shape.stores })
      if (made.status === 'exists') {
        report.databases.skipped += 1
        continue
      }
      if (made.status === 'failed') {
        report.databases.failed += 1
        addProblem(report, `${label}: it could not be made in the website session (${made.reason ?? 'no reason given'})`)
        continue
      }
      created = true
      for (const store of shape.stores) await carryStore(source, target, report, shape.name, store, label)
      report.databases.carried += 1
    } catch (error) {
      report.databases.failed += 1
      addProblem(report, `${label}: ${messageOf(error)}`)
      if (created) await target.run(call('dropDatabase', shape.name)).catch(() => undefined)
      // One database that fails is its own; two pages that no longer answer end the carry.
      try {
        await Promise.all([source.run('"ok"'), target.run('"ok"')])
      } catch (gone) {
        fail('a hidden page stopped answering', gone)
        return
      }
    }
  }
}

async function carryStore (source: CarryPage, target: CarryPage, report: CarryReport, db: string, store: StoreShape, label: string): Promise<void> {
  let offset = 0
  let after: unknown
  for (;;) {
    const batch = await ask<ReadBatch>(source, 'readBatch', { db, store: store.name, after, offset })
    report.records.failed += batch.problems.length
    for (const problem of batch.problems) addProblem(report, `${label} store "${store.name}" ${problem}`)
    if (batch.records.length > 0) {
      const wrote = await ask<WriteBatch>(target, 'writeBatch', { db, store: store.name, records: batch.records, offset })
      report.records.carried += wrote.written
      report.records.failed += wrote.problems.length
      for (const problem of wrote.problems) addProblem(report, `${label} store "${store.name}" ${problem}`)
    }
    offset += batch.read
    if (batch.done || batch.read === 0 || batch.next === undefined) return
    after = batch.next
  }
}
