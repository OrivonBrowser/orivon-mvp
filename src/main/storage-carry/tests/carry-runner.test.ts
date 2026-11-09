import { describe, expect, it } from 'vitest'
import { carryStorage } from '../carry-runner.js'
import type { CarryLog, CarryPage, CarryRequest, CarrySide, CookieJar } from '../carry-runner.js'
import type { CookieToSet, OldCookie } from '../cookies.js'
import { fakePage, putAll, withDatabase } from './fake-page.js'
import type { FakePage } from './fake-page.js'

const ORIGIN = 'https://wiki.eth'
const NOW = 1_800_000_000

class FakeJar implements CookieJar {
  readonly set_: CookieToSet[] = []
  constructor (private readonly held: OldCookie[] = []) {}
  async all (): Promise<readonly OldCookie[]> { return this.held }
  async find (_url: string, name: string): Promise<readonly OldCookie[]> { return this.held.filter((cookie) => cookie.name === name) }
  async set (cookie: CookieToSet): Promise<void> {
    if (cookie.name === 'refused') throw new Error('the cookie was refused')
    this.set_.push(cookie)
    this.held.push({ name: cookie.name, value: cookie.value, ...(cookie.domain === undefined ? { hostOnly: true, domain: new URL(cookie.url).hostname } : { domain: cookie.domain, hostOnly: false }), path: cookie.path })
  }
}

function logOf (): CarryLog & { lines: string[] } {
  const lines: string[] = []
  return { lines, info: (text) => { lines.push(text) }, warn: (text) => { lines.push(text) } }
}

interface World { readonly request: CarryRequest, readonly log: ReturnType<typeof logOf>, readonly oldPage: FakePage, readonly newPage: FakePage, readonly target: FakeJar, readonly opened: CarryPage[] }

function world (options: { oldCookies?: OldCookie[], newCookies?: OldCookie[], openOld?: () => Promise<CarryPage> } = {}): World {
  const oldPage = fakePage()
  const newPage = fakePage()
  const log = logOf()
  const target = new FakeJar(options.newCookies ?? [])
  const opened: CarryPage[] = []
  const side = (page: FakePage): (() => Promise<CarryPage>) => async () => { opened.push(page); return page }
  const source: CarrySide = { cookies: new FakeJar(options.oldCookies ?? []), open: options.openOld ?? side(oldPage) }
  const request: CarryRequest = { origin: ORIGIN, source, target: { cookies: target, open: side(newPage) }, notCarried: [], nowSeconds: () => NOW, log }
  return { request, log, oldPage, newPage, target, opened }
}

const cookie = (name: string, extra: Partial<OldCookie> = {}): OldCookie => ({ name, value: `secret-${name}`, domain: 'wiki.eth', hostOnly: true, path: '/', secure: true, httpOnly: false, session: false, expirationDate: NOW + 100, sameSite: 'lax', ...extra })

async function seedNotes (page: FakePage): Promise<void> {
  await withDatabase(page.indexedDB, 'notes', async (db) => {
    await putAll(db, 'pages', [[{ slug: 'home', secret: 'database-secret' }, undefined], [{ slug: 'about' }, undefined]])
  }, (db) => { db.createObjectStore('pages', { keyPath: 'slug' }) }, 3)
}

describe('carrying one origin\'s storage', () => {
  it('carries cookies, local storage and databases, and says so in one line without a single value', async () => {
    const w = world({ oldCookies: [cookie('sid'), cookie('prefs', { domain: '.wiki.eth', hostOnly: false, path: '/w' })] })
    w.oldPage.localStorage.setItem('theme', 'dark')
    await seedNotes(w.oldPage)
    const outcome = await carryStorage(w.request)
    expect(outcome.status).toBe('carried')
    expect(outcome.report).toMatchObject({ cookies: { carried: 2 }, localStorage: { carried: 1 }, databases: { carried: 1 }, records: { carried: 2 }, problems: [] })
    expect(w.target.set_.map((set) => set.name)).toEqual(['sid', 'prefs'])
    expect(w.newPage.localStorage.getItem('theme')).toBe('dark')
    expect((await w.newPage.indexedDB.databases()).map((info) => [info.name, info.version])).toEqual([['notes', 3]])
    expect(w.log.lines.join('\n')).toContain(`[carry] ${ORIGIN}: carried 2 cookies, 1 local storage items, 1 databases, 2 database records`)
    expect(w.log.lines.join('\n')).not.toMatch(/secret/)
    expect(w.opened.every((page) => (page as FakePage).closed)).toBe(true)
  })

  it('leaves alone what the website session already holds, and counts it', async () => {
    const w = world({ oldCookies: [cookie('sid')], newCookies: [cookie('sid')] })
    w.oldPage.localStorage.setItem('token', 'old')
    w.newPage.localStorage.setItem('token', 'fresh')
    await seedNotes(w.oldPage)
    await withDatabase(w.newPage.indexedDB, 'notes', async () => undefined, (db) => { db.createObjectStore('own') }, 1)
    const outcome = await carryStorage(w.request)
    expect(outcome.status).toBe('carried')
    expect(outcome.report).toMatchObject({ cookies: { carried: 0, skipped: 1 }, localStorage: { carried: 0, skipped: 1 }, databases: { carried: 0, skipped: 1 }, records: { carried: 0 } })
    expect(w.newPage.localStorage.getItem('token')).toBe('fresh')
    expect(w.target.set_).toEqual([])
  })

  it('runs again over what it carried without changing it', async () => {
    const w = world({ oldCookies: [cookie('sid')] })
    w.oldPage.localStorage.setItem('theme', 'dark')
    await seedNotes(w.oldPage)
    await carryStorage(w.request)
    const again = await carryStorage(w.request)
    expect(again.report).toMatchObject({ cookies: { carried: 0, skipped: 1 }, localStorage: { carried: 0, skipped: 1 }, databases: { carried: 0, skipped: 1 } })
  })

  it('does not carry a cookie that has expired', async () => {
    const w = world({ oldCookies: [cookie('gone', { expirationDate: NOW - 5 }), cookie('kept')] })
    const outcome = await carryStorage(w.request)
    expect(outcome.report.cookies).toEqual({ carried: 1, skipped: 1, failed: 0 })
  })

  it('names a cookie the session refuses and carries the rest', async () => {
    const w = world({ oldCookies: [cookie('refused'), cookie('fine')] })
    const outcome = await carryStorage(w.request)
    expect(outcome.status).toBe('carried')
    expect(outcome.report.cookies).toEqual({ carried: 1, skipped: 0, failed: 1 })
    expect(outcome.report.problems).toEqual(['cookie "refused" of wiki.eth: the cookie was refused'])
    expect(w.log.lines).toContain(`[carry] ${ORIGIN}: could not carry cookie "refused" of wiki.eth: the cookie was refused`)
  })

  it('carries every database of the origin, with values of every kind a store holds', async () => {
    const w = world()
    await withDatabase(w.oldPage.indexedDB, 'mixed', async (db) => {
      await putAll(db, 's', [[{ ok: true }, 'a'], [new Map([['k', 'v']]), 'c']])
    }, (db) => { db.createObjectStore('s') })
    await seedNotes(w.oldPage)
    const outcome = await carryStorage(w.request)
    expect(outcome.status).toBe('carried')
    expect(outcome.report.databases.carried).toBe(2)
    expect(outcome.report.records).toEqual({ carried: 4, skipped: 0, failed: 0 })
  })

  it('names a record that cannot be encoded by its position and carries the others', async () => {
    const w = world()
    await withDatabase(w.oldPage.indexedDB, 'keys', async (db) => {
      const sealed = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 128 }, false, ['encrypt'])
      await putAll(db, 's', [['first', 'a'], [sealed, 'b'], ['third', 'c']])
    }, (db) => { db.createObjectStore('s') })
    const outcome = await carryStorage(w.request)
    expect(outcome.status).toBe('carried')
    expect(outcome.report.records).toEqual({ carried: 2, skipped: 0, failed: 1 })
    expect(outcome.report.problems).toEqual(['database "keys" store "s" record 2: a key that is not extractable cannot be read'])
  })

  it('ends as failed, with the reason, when a hidden page cannot be opened, after carrying the cookies', async () => {
    const w = world({ oldCookies: [cookie('sid')], openOld: async () => { throw new Error('the empty document settled at chrome-error://chromewebdata') } })
    const outcome = await carryStorage(w.request)
    expect(outcome.status).toBe('failed')
    expect(outcome.reason).toContain('the hidden pages could not be used')
    expect(outcome.report.cookies.carried).toBe(1)
    expect(w.newPage.closed || w.opened.length === 0).toBe(true)
  })

  it('ends as failed when the pages stop answering, and closes them', async () => {
    const w = world()
    await seedNotes(w.oldPage)
    let calls = 0
    const dying = { ...w.oldPage, run: async (code: string): Promise<string> => { calls += 1; if (calls > 3) throw new Error('the hidden page did not answer'); return await w.oldPage.run(code) }, close: () => { w.oldPage.close() } } as CarryPage
    const outcome = await carryStorage({ ...w.request, source: { ...w.request.source, open: async () => dying } })
    expect(outcome.status).toBe('failed')
    expect(outcome.reason).toContain('did not answer')
    expect(w.oldPage.closed).toBe(true)
    expect(w.newPage.closed).toBe(true)
  })

  it('removes a database that stopped half way, so a later try makes it whole', async () => {
    const w = world()
    await seedNotes(w.oldPage)
    let reads = 0
    const flaky: CarryPage = { close: () => { w.oldPage.close() }, run: async (code) => { if (code.startsWith('__orivonCarry.readBatch')) { reads += 1; throw new Error('the database broke') } return await w.oldPage.run(code) } }
    const outcome = await carryStorage({ ...w.request, source: { ...w.request.source, open: async () => flaky } })
    expect(reads).toBe(1)
    expect(outcome.report.databases).toEqual({ carried: 0, skipped: 0, failed: 1 })
    expect(outcome.report.problems).toEqual(['database "notes": the database broke'])
    expect((await w.newPage.indexedDB.databases()).map((info) => info.name)).toEqual([])
  })

  it('names what the old partition holds that it does not carry', async () => {
    const w = world()
    const outcome = await carryStorage({ ...w.request, notCarried: ['service workers and Cache Storage'] })
    expect(outcome.report.notCarried).toEqual(['service workers and Cache Storage'])
    expect(w.log.lines).toContain(`[carry] ${ORIGIN}: not carried: service workers and Cache Storage; the app makes them again`)
  })

  it('carries a store of more records than one batch holds', async () => {
    const w = world()
    await withDatabase(w.oldPage.indexedDB, 'big', async (db) => {
      await putAll(db, 's', Array.from({ length: 430 }, (_unused, index) => [{ id: index, text: `row ${String(index)}` }, undefined] as const))
    }, (db) => { db.createObjectStore('s', { keyPath: 'id' }) })
    const outcome = await carryStorage(w.request)
    expect(outcome.report.records.carried).toBe(430)
    await withDatabase(w.newPage.indexedDB, 'big', async (db) => {
      const count = await new Promise<number>((resolve) => { const request = db.transaction('s').objectStore('s').count(); request.onsuccess = () => { resolve(request.result) } })
      expect(count).toBe(430)
    })
  })

  it('keeps the list of problems short and counts the rest', async () => {
    const w = world({ oldCookies: Array.from({ length: 60 }, (_unused, index) => cookie('refused', { path: `/p${String(index)}` })) })
    const outcome = await carryStorage(w.request)
    expect(outcome.report.problems).toHaveLength(25)
    expect(outcome.report.problemsLeftOut).toBe(35)
    expect(outcome.report.cookies.failed).toBe(60)
  })
})
