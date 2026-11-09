import { webcrypto } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { carryStorage } from '../carry-runner.js'
import type { CarryLog, CarryPage, CarryRequest, CookieJar } from '../carry-runner.js'
import type { CookieToSet, OldCookie } from '../cookies.js'
import { carryGlobalName } from '../page-code.js'
import { fakePage, putAll, readAll, withDatabase } from './fake-page.js'
import type { FakePage } from './fake-page.js'

const ORIGIN = 'https://wiki.eth'
const NOW = 1_800_000_000

class FakeJar implements CookieJar {
  readonly sets: CookieToSet[] = []
  readonly removed: string[] = []
  hangOn: string | undefined
  constructor (private readonly held: OldCookie[] = []) {}
  async all (): Promise<readonly OldCookie[]> { return this.held }
  async set (cookie: CookieToSet): Promise<void> {
    if (cookie.name === this.hangOn) return await new Promise<void>(() => undefined)
    if (cookie.name === 'refused') throw new Error('the cookie was refused')
    this.sets.push(cookie)
  }

  async remove (_url: string, name: string): Promise<void> { this.removed.push(name) }
}

function logOf (): CarryLog & { lines: string[] } {
  const lines: string[] = []
  return { lines, info: (text) => { lines.push(text) }, warn: (text) => { lines.push(text) } }
}

const channels: MessageChannel[] = []
afterEach(() => { for (const channel of channels.splice(0)) { channel.port1.close(); channel.port2.close() } })

async function wipe (page: FakePage): Promise<void> {
  for (const info of await page.indexedDB.databases()) {
    await new Promise<void>((resolve, reject) => {
      const request = page.indexedDB.deleteDatabase(info.name ?? '')
      request.onsuccess = () => { resolve() }
      request.onerror = () => { reject(request.error ?? new Error('delete failed')) }
    })
  }
  page.localStorage.clear()
}

interface World {
  request: CarryRequest
  readonly log: ReturnType<typeof logOf>
  readonly oldPage: FakePage
  readonly newPage: FakePage
  readonly oldJar: FakeJar
  readonly newJar: FakeJar
  /** What happened, in order: pages opened, the target cleared, cookies set. */
  readonly events: string[]
  readonly controller: AbortController
}

interface WorldOptions {
  oldCookies?: OldCookie[]
  /** Wraps a page before the runner sees it. */
  wrapOld?: (page: FakePage) => CarryPage
  wrapNew?: (page: FakePage) => CarryPage
  clear?: (call: number) => Promise<void>
  cleanupMs?: number
}

function world (options: WorldOptions = {}): World {
  const oldPage = fakePage()
  const newPage = fakePage()
  const oldJar = new FakeJar(options.oldCookies ?? [])
  const newJar = new FakeJar()
  const events: string[] = []
  const controller = new AbortController()
  const log = logOf()
  let nonces = 0
  let clears = 0
  const side = (name: string, page: FakePage, jar: FakeJar, wrap: ((page: FakePage) => CarryPage) | undefined): CarryRequest['source'] => ({
    cookies: jar,
    open: async (nonce) => {
      page.nonce = nonce
      events.push(`open ${name}`)
      const seen = wrap === undefined ? page : wrap(page)
      return { run: seen.run, give: seen.give, close: () => { events.push(`close ${name}`); seen.close() } }
    }
  })
  const cookiesOf = (jar: FakeJar): CookieJar => ({ all: jar.all.bind(jar), set: async (cookie) => { events.push(`set ${cookie.name}`); await jar.set(cookie) }, remove: async (url, name) => { events.push(`remove ${name}`); await jar.remove(url, name) } })
  const source = side('old', oldPage, oldJar, options.wrapOld)
  const target = side('new', newPage, newJar, options.wrapNew)
  const request: CarryRequest = {
    origin: ORIGIN,
    source,
    target: { ...target, cookies: cookiesOf(newJar) },
    clearTarget: async () => {
      clears += 1
      events.push('clear')
      if (options.clear !== undefined) await options.clear(clears)
      await wipe(newPage)
    },
    channel: () => { const channel = new MessageChannel(); channels.push(channel); return { first: channel.port1, second: channel.port2 } },
    nonce: () => `n${String(++nonces)}`,
    signal: controller.signal,
    notCarried: [],
    nowSeconds: () => NOW,
    log,
    ...(options.cleanupMs === undefined ? {} : { cleanupMs: options.cleanupMs })
  }
  return { request, log, oldPage, newPage, oldJar, newJar, events, controller }
}

const cookie = (name: string, extra: Partial<OldCookie> = {}): OldCookie => ({ name, value: `secret-${name}`, domain: 'wiki.eth', hostOnly: true, path: '/', secure: true, httpOnly: false, session: false, expirationDate: NOW + 100, sameSite: 'lax', ...extra })

async function seedNotes (page: FakePage): Promise<void> {
  await withDatabase(page.indexedDB, 'notes', async (db) => {
    await putAll(db, 'pages', [[{ slug: 'home', secret: 'database-secret' }, undefined], [{ slug: 'about' }, undefined]])
  }, (db) => { db.createObjectStore('pages', { keyPath: 'slug' }) }, 3)
}

/** The page with `change` applied to what one call returns: a way to make a call fail where the fake page would not. */
function altered (page: FakePage, method: string, change: (answer: string) => string): CarryPage {
  return { give: page.give, close: page.close, run: async (code) => { const answer = await page.run(code); return code.includes(`.${method}(`) ? change(answer) : answer } }
}

/** The page that never answers a call to `method`. */
function stuck (page: FakePage, method: string): CarryPage {
  return { give: page.give, close: page.close, run: async (code) => code.includes(`.${method}(`) ? await new Promise<string>(() => undefined) : await page.run(code) }
}

describe('carrying one origin\'s storage', () => {
  it('carries cookies, local storage and databases, and says so in one line without a single value', async () => {
    const w = world({ oldCookies: [cookie('sid'), cookie('prefs', { domain: '.wiki.eth', hostOnly: false, path: '/w' })] })
    w.oldPage.localStorage.setItem('theme', 'dark')
    await seedNotes(w.oldPage)
    const outcome = await carryStorage(w.request)
    expect(outcome.status).toBe('carried')
    expect(outcome.report).toMatchObject({ cookies: { carried: 2 }, localStorage: { carried: 1 }, databases: { carried: 1 }, records: { carried: 2 }, problems: [] })
    expect(w.newJar.sets.map((set) => set.name)).toEqual(['sid', 'prefs'])
    expect(w.newPage.localStorage.getItem('theme')).toBe('dark')
    expect((await w.newPage.indexedDB.databases()).map((info) => [info.name, info.version])).toEqual([['notes', 3]])
    expect(w.log.lines.join('\n')).toContain(`[carry] ${ORIGIN}: carried 2 cookies, 1 local storage items, 1 databases, 2 database records`)
    expect(w.log.lines.join('\n')).not.toMatch(/secret/)
    expect(w.oldPage.closed && w.newPage.closed).toBe(true)
  })

  it('clears the target before it opens the page there, and sets the cookies last', async () => {
    const w = world({ oldCookies: [cookie('sid')] })
    w.oldPage.localStorage.setItem('theme', 'dark')
    await carryStorage(w.request)
    expect(w.events).toEqual(['open old', 'clear', 'open new', 'set sid', 'close old', 'close new'])
  })

  it('carries only the cookies of the app\'s own host: not an embed\'s, a tracker\'s or a sibling\'s, but a domain cookie of a parent', async () => {
    const w = world({ oldCookies: [cookie('sid'), cookie('ga', { domain: '.google.com', hostOnly: false }), cookie('tracker', { domain: 'ads.example' }), cookie('parent', { domain: '.eth', hostOnly: false }), cookie('child', { domain: 'app.wiki.eth' })] })
    const outcome = await carryStorage(w.request)
    expect(w.newJar.sets.map((set) => set.name)).toEqual(['sid', 'parent'])
    expect(outcome.report.cookies).toEqual({ carried: 2, skipped: 3, failed: 0, partial: 0 })
  })

  it('replaces what the website session holds for the origin: a database, a local storage item, and what the old partition lacks', async () => {
    const w = world()
    w.oldPage.localStorage.setItem('token', 'old')
    await seedNotes(w.oldPage)
    w.newPage.localStorage.setItem('token', 'website-era')
    w.newPage.localStorage.setItem('only-in-website', 'x')
    await withDatabase(w.newPage.indexedDB, 'notes', async (db) => { await putAll(db, 'own', [['website row', 'k']]) }, (db) => { db.createObjectStore('own') }, 1)
    await withDatabase(w.newPage.indexedDB, 'other', async () => undefined, (db) => { db.createObjectStore('s') }, 1)
    const outcome = await carryStorage(w.request)
    expect(outcome.status).toBe('carried')
    expect(w.newPage.localStorage.getItem('token')).toBe('old')
    expect(w.newPage.localStorage.getItem('only-in-website')).toBeNull()
    expect((await w.newPage.indexedDB.databases()).map((info) => [info.name, info.version])).toEqual([['notes', 3]])
    await withDatabase(w.newPage.indexedDB, 'notes', async (db) => {
      expect([...db.objectStoreNames]).toEqual(['pages'])
      expect((await readAll(db, 'pages')).map((row) => row.key)).toEqual(['about', 'home'])
    })
  })

  it('changes nothing when the old partition holds nothing for the origin', async () => {
    const w = world({ oldCookies: [cookie('ga', { domain: '.google.com', hostOnly: false })] })
    w.newPage.localStorage.setItem('website', 'kept')
    const outcome = await carryStorage(w.request)
    expect(outcome.status).toBe('carried')
    expect(w.events).toEqual(['open old', 'close old'])
    expect(w.newPage.localStorage.getItem('website')).toBe('kept')
    expect(w.newJar.sets).toEqual([])
    expect(w.log.lines.join('\n')).toContain('the old partition holds nothing for this origin')
  })

  it('makes the same website session when it runs again over what it carried', async () => {
    const w = world({ oldCookies: [cookie('sid')] })
    w.oldPage.localStorage.setItem('theme', 'dark')
    await seedNotes(w.oldPage)
    const first = await carryStorage(w.request)
    const again = await carryStorage(w.request)
    expect(again.status).toBe('carried')
    expect(again.report).toEqual(first.report)
    expect(w.newPage.localStorage.getItem('theme')).toBe('dark')
    expect((await w.newPage.indexedDB.databases()).map((info) => info.name)).toEqual(['notes'])
  })

  it('does not carry a cookie that has expired', async () => {
    const w = world({ oldCookies: [cookie('gone', { expirationDate: NOW - 5 }), cookie('kept')] })
    const outcome = await carryStorage(w.request)
    expect(outcome.report.cookies).toEqual({ carried: 1, skipped: 1, failed: 0, partial: 0 })
  })

  it('names a cookie the session refuses and carries the rest', async () => {
    const w = world({ oldCookies: [cookie('refused'), cookie('fine')] })
    const outcome = await carryStorage(w.request)
    expect(outcome.status).toBe('carried')
    expect(outcome.report.cookies).toEqual({ carried: 1, skipped: 0, failed: 1, partial: 0 })
    expect(outcome.report.problems).toEqual(['cookie "refused" of wiki.eth: the cookie was refused'])
    expect(w.log.lines).toContain(`[carry] ${ORIGIN}: could not carry cookie "refused" of wiki.eth: the cookie was refused`)
  })

  it('keeps the list of problems short and counts the rest', async () => {
    const w = world({ oldCookies: Array.from({ length: 60 }, (_unused, index) => cookie('refused', { path: `/p${String(index)}` })) })
    const outcome = await carryStorage(w.request)
    expect(outcome.report.problems).toHaveLength(25)
    expect(outcome.report.problemsLeftOut).toBe(35)
    expect(outcome.report.cookies.failed).toBe(60)
  })

  it('names what the old partition holds that it does not carry', async () => {
    const w = world({ oldCookies: [cookie('sid')] })
    const outcome = await carryStorage({ ...w.request, notCarried: ['service workers and Cache Storage'] })
    expect(outcome.report.notCarried).toEqual(['service workers and Cache Storage'])
    expect(w.log.lines).toContain(`[carry] ${ORIGIN}: not carried: service workers and Cache Storage; the app makes them again`)
  })
})

describe('what the databases keep', () => {
  it('carries a store of more records than one batch holds', async () => {
    const w = world()
    await withDatabase(w.oldPage.indexedDB, 'big', async (db) => {
      await putAll(db, 's', Array.from({ length: 430 }, (_unused, index) => [{ id: index, text: `row ${String(index)}` }, undefined] as const))
    }, (db) => { db.createObjectStore('s', { keyPath: 'id' }) })
    const outcome = await carryStorage(w.request)
    expect(outcome.report.records.carried).toBe(430)
    await withDatabase(w.newPage.indexedDB, 'big', async (db) => { expect(await readAll(db, 's')).toHaveLength(430) })
  })

  it('carries a key that is not extractable, usable on the other side, and a Blob from its bytes', async () => {
    const w = world()
    const key = await webcrypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    await withDatabase(w.oldPage.indexedDB, 'vault', async (db) => {
      await putAll(db, 's', [[{ key, picture: new Blob(['png'], { type: 'image/png' }), at: new Date(5) }, 'a']])
    }, (db) => { db.createObjectStore('s') })
    const outcome = await carryStorage(w.request)
    expect(outcome.report.records).toMatchObject({ carried: 1, failed: 0 })
    expect(outcome.report.databases).toMatchObject({ carried: 1, partial: 0 })
    await withDatabase(w.newPage.indexedDB, 'vault', async (db) => {
      const row = (await readAll(db, 's'))[0]?.value as { key: CryptoKey, picture: Blob, at: Date }
      expect([row.key.extractable, await row.picture.text(), row.picture.type, row.at.getTime()]).toEqual([false, 'png', 'image/png', 5])
      expect((await webcrypto.subtle.sign('HMAC', row.key, new Uint8Array([1]))).byteLength).toBe(32)
    })
  })

  it('marks a database partial, never carried, when a record could not be moved, and names the record', async () => {
    const w = world({ wrapOld: (page) => altered(page, 'sendBatch', (answer) => JSON.stringify({ ...(JSON.parse(answer) as object), skipped: ['record 2: the value could not be cloned'] })) })
    await seedNotes(w.oldPage)
    const outcome = await carryStorage(w.request)
    expect(outcome.status).toBe('carried')
    expect(outcome.report.databases).toMatchObject({ carried: 0, partial: 1, failed: 0 })
    expect(outcome.report.records.failed).toBe(1)
    expect(outcome.report.problems).toEqual(['database "notes" store "pages" record 2: the value could not be cloned', 'database "notes": partial, 1 records not carried'])
    expect(w.log.lines.join('\n')).toContain('0 databases (1 partial)')
  })

  it('fails and removes a database whose batch the target aborted, and goes on with the others', async () => {
    let batches = 0
    const w = world({ wrapNew: (page) => altered(page, 'writeBatch', (answer) => (++batches === 1 ? JSON.stringify({ written: 0, problems: [], aborted: 'QuotaExceededError' }) : answer)) })
    await seedNotes(w.oldPage)
    await withDatabase(w.oldPage.indexedDB, 'zzz', async (db) => { await putAll(db, 's', [['v', 'k']]) }, (db) => { db.createObjectStore('s') })
    const outcome = await carryStorage(w.request)
    expect(outcome.status).toBe('carried')
    expect(outcome.report.databases).toMatchObject({ failed: 1, carried: 1 })
    expect(outcome.report.problems[0]).toContain('database "notes": store "pages": a batch could not be stored (QuotaExceededError)')
    expect((await w.newPage.indexedDB.databases()).map((info) => info.name)).toEqual(['zzz'])
  })

  it('names a database that cannot be opened and carries the others', async () => {
    const w = world({ wrapOld: (page) => altered(page, 'readDatabases', (answer) => JSON.stringify([{ name: 'broken', version: 1, stores: [], error: 'it is corrupt' }, ...(JSON.parse(answer) as object[])])) })
    await seedNotes(w.oldPage)
    const outcome = await carryStorage(w.request)
    expect(outcome.report.databases).toMatchObject({ carried: 1, failed: 1 })
    expect(outcome.report.problems).toEqual(['database "broken": it could not be opened (it is corrupt)'])
  })
})

describe('a carry that cannot finish', () => {
  it('ends as failed with the reason, and writes nothing, when the old page cannot be opened', async () => {
    const w = world({ oldCookies: [cookie('sid')] })
    const outcome = await carryStorage({ ...w.request, source: { ...w.request.source, open: async () => { throw new Error('the empty document settled at chrome-error://chromewebdata') } } })
    expect(outcome.status).toBe('failed')
    expect(outcome.reason).toContain('chrome-error')
    expect(w.events).toEqual([])
    expect(w.newJar.sets).toEqual([])
  })

  it('clears the half copy and sets no cookie when the target page stops answering', async () => {
    let gone = false
    const w = world({ oldCookies: [cookie('sid')], wrapNew: (page) => ({ give: page.give, close: page.close, run: async (code) => { if (code.includes('.writeBatch(')) gone = true; if (gone) throw new Error('the hidden page did not answer'); return await page.run(code) } }) })
    w.oldPage.localStorage.setItem('theme', 'dark')
    await seedNotes(w.oldPage)
    const outcome = await carryStorage(w.request)
    expect(outcome.status).toBe('failed')
    expect(outcome.reason).toContain('a hidden page stopped answering (the hidden page did not answer)')
    expect(w.newJar.sets).toEqual([])
    expect(w.events.filter((event) => event === 'clear')).toHaveLength(2)
    expect(w.events.lastIndexOf('clear')).toBeGreaterThan(w.events.lastIndexOf('close new'))
    expect(w.newPage.localStorage.getItem('theme')).toBeNull()
    expect(await w.newPage.indexedDB.databases()).toEqual([])
    expect(w.oldPage.localStorage.getItem('theme')).toBe('dark')
  })

  it('stops at the deadline: closes the pages first, then clears, and says it did not finish in time', async () => {
    const w = world({ oldCookies: [cookie('sid')], wrapNew: (page) => stuck(page, 'writeSchema') })
    await seedNotes(w.oldPage)
    const running = carryStorage(w.request)
    await new Promise((resolve) => setTimeout(resolve, 30))
    w.controller.abort()
    const outcome = await running
    expect(outcome.status).toBe('failed')
    expect(outcome.reason).toBe('the carry did not finish in time')
    expect(w.events.indexOf('close new')).toBeLessThan(w.events.lastIndexOf('clear'))
    expect(w.events.filter((event) => event === 'clear')).toHaveLength(2)
    expect(w.newJar.sets).toEqual([])
  })

  it('removes the cookies it had set, and the one it was setting, when the deadline passes while it sets them', async () => {
    const w = world({ oldCookies: [cookie('a'), cookie('b')] })
    w.newJar.hangOn = 'b'
    const running = carryStorage(w.request)
    await new Promise((resolve) => setTimeout(resolve, 30))
    w.controller.abort()
    const outcome = await running
    expect(outcome.status).toBe('failed')
    expect(w.events).toEqual(expect.arrayContaining(['set a', 'set b', 'remove a', 'remove b']))
    expect(w.events.lastIndexOf('clear')).toBeGreaterThan(w.events.indexOf('set b'))
  })

  it('does not even start when the deadline has passed already', async () => {
    const w = world({ oldCookies: [cookie('sid')] })
    w.controller.abort()
    const outcome = await carryStorage(w.request)
    expect(outcome.status).toBe('failed')
    expect(w.newJar.sets).toEqual([])
  })

  it('says so when the half copy itself could not be cleared, and does not wait for it forever', async () => {
    const w = world({ cleanupMs: 20, clear: async (call) => { if (call === 2) await new Promise<void>(() => undefined) }, wrapNew: (page) => stuck(page, 'writeSchema') })
    await seedNotes(w.oldPage)
    const running = carryStorage(w.request)
    await new Promise((resolve) => setTimeout(resolve, 30))
    w.controller.abort()
    const outcome = await running
    expect(outcome.status).toBe('failed')
    expect(outcome.reason).toContain('the half copy could not be cleared (it took too long)')
  })

  it('refuses to run in a page that defined the carry\'s name before the script came', async () => {
    const w = world({ oldCookies: [cookie('sid')] })
    w.oldPage.predefine(carryGlobalName('n1'), { readLocalStorage: () => '[]', readDatabases: () => '[]' })
    const outcome = await carryStorage(w.request)
    expect(outcome.status).toBe('failed')
    expect(outcome.reason).toContain('already defines the name')
    expect(w.newJar.sets).toEqual([])
    expect(w.events).not.toContain('clear')
  })
})
