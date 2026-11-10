import { webcrypto } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { IDBObjectStore } from 'fake-indexeddb'
import { fakePage, putAll, readAll, withDatabase } from './fake-page.js'
import type { FakePage } from './fake-page.js'
import { callCode, carryGlobalName, carryPageCode } from '../page-code.js'

const NONCE = 'ab'.repeat(16)
const channels: MessageChannel[] = []
afterEach(() => { for (const channel of channels.splice(0)) { channel.port1.close(); channel.port2.close() } })

const call = (name: string, args?: unknown): string => callCode(NONCE, name, args)
const json = async <T>(page: FakePage, name: string, args?: unknown): Promise<T> => JSON.parse(await page.run(call(name, args))) as T

async function installed (): Promise<FakePage> {
  const page = fakePage(NONCE)
  expect(await page.run(carryPageCode(NONCE))).toBe('ready')
  return page
}

/** Two pages with the script installed and one port between them, as the runner leaves them. */
async function connected (): Promise<{ from: FakePage, to: FakePage }> {
  const from = await installed()
  const to = await installed()
  const channel = new MessageChannel()
  channels.push(channel)
  await from.give(channel.port1)
  await to.give(channel.port2)
  expect(await from.run(call('connect'))).toBe('connected')
  expect(await to.run(call('connect'))).toBe('connected')
  return { from, to }
}

describe('installing the script', () => {
  it('puts it under a name that ends in the nonce, and says "taken" instead of replacing what is there', async () => {
    const page = await installed()
    expect(await page.run(carryPageCode(NONCE))).toBe('taken')
  })

  it('refuses to run when the page defined that name before the script came', async () => {
    const page = fakePage(NONCE)
    page.predefine(carryGlobalName(NONCE), { connect: () => 'a lie' })
    expect(await page.run(carryPageCode(NONCE))).toBe('taken')
  })

  it('passes arguments as data: a key named __proto__ sets no prototype', async () => {
    const page = await installed()
    const hostile = JSON.parse('{"__proto__": {"polluted": true}}') as unknown
    expect(callCode(NONCE, 'writeLocalStorage', hostile)).toContain('JSON.parse("')
    expect(callCode(NONCE, 'closeAll')).toBe(`${carryGlobalName(NONCE)}.closeAll()`)
    await page.run(callCode(NONCE, 'writeLocalStorage', [['__proto__', 'x']]))
    expect(page.localStorage.getItem('__proto__')).toBe('x')
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })
})

describe('the port between the pages', () => {
  it('is waited for until the shell hands it over', async () => {
    const page = await installed()
    const waiting = page.run(call('connect'))
    const channel = new MessageChannel()
    channels.push(channel)
    await page.give(channel.port1)
    expect(await waiting).toBe('connected')
  })
})

describe('local storage', () => {
  it('is read whole and written over what the target holds', async () => {
    const from = await installed()
    const to = await installed()
    from.localStorage.setItem('theme', 'dark')
    from.localStorage.setItem('token', 'old')
    to.localStorage.setItem('token', 'new')
    const entries = await json<Array<[string, string]>>(from, 'readLocalStorage')
    expect(entries).toEqual([['theme', 'dark'], ['token', 'old']])
    expect(await json(to, 'writeLocalStorage', entries)).toEqual({ carried: 2, problems: [] })
    expect([to.localStorage.getItem('theme'), to.localStorage.getItem('token')]).toEqual(['dark', 'old'])
  })

  it('names an item the page refuses and goes on with the rest', async () => {
    const to = await installed()
    const original = to.localStorage.setItem.bind(to.localStorage)
    to.localStorage.setItem = (name, value) => { if (name === 'big') throw new Error('quota exceeded'); original(name, value) }
    const result = await json<{ carried: number, problems: string[] }>(to, 'writeLocalStorage', [['big', 'x'], ['small', 'y']])
    expect(result.carried).toBe(1)
    expect(result.problems).toEqual(['item 1: quota exceeded'])
    expect(to.localStorage.getItem('small')).toBe('y')
  })
})

interface Shape { name: string, version: number, stores: Array<{ name: string }> }
interface Sent { read: number, done: boolean, skipped: string[] }
interface Written { written: number, problems: string[], aborted?: string }

/** Moves every batch of `store` of database `db` from `from` to `to`, as the runner does, and returns what each side said. */
async function moveStore (from: FakePage, to: FakePage, db: string, store: string): Promise<{ batches: Sent[], wrote: Written[] }> {
  const batches: Sent[] = []
  const wrote: Written[] = []
  let offset = 0
  for (let id = 1; ; id++) {
    const sent = await json<Sent>(from, 'sendBatch', { db, store, id, offset, restart: offset === 0 })
    batches.push(sent)
    wrote.push(await json<Written>(to, 'writeBatch', { db, store, id, offset }))
    offset += sent.read
    if (sent.done || sent.read === 0) return { batches, wrote }
  }
}

async function seeded (): Promise<FakePage> {
  const page = await installed()
  await withDatabase(page.indexedDB, 'notes', async (db) => {
    await putAll(db, 'pages', [
      [{ slug: 'home', body: 'Home', tags: ['a', 'b'], at: new Date(10) }, undefined],
      [{ slug: 'about', body: 'About', tags: ['b'], at: new Date(20) }, undefined]
    ])
    await putAll(db, 'blobs', [[new Blob(['png-bytes'], { type: 'image/png' }), 'logo'], [new Uint8Array([1, 2]), 'raw']])
    await putAll(db, 'log', [['first', undefined], ['second', undefined]])
  }, (db) => {
    const pages = db.createObjectStore('pages', { keyPath: 'slug' })
    pages.createIndex('by-tag', 'tags', { multiEntry: true })
    pages.createIndex('by-body', 'body', { unique: true })
    db.createObjectStore('blobs')
    db.createObjectStore('log', { autoIncrement: true })
  }, 7)
  return page
}

describe('databases', () => {
  it('lists every database with its version and each store with its key, counter, indexes and size', async () => {
    const page = await seeded()
    const [shape] = await json<Array<Record<string, unknown>>>(page, 'readDatabases')
    expect(shape).toEqual({
      name: 'notes',
      version: 7,
      stores: [
        { name: 'blobs', keyPath: null, autoIncrement: false, indexes: [], count: 2 },
        { name: 'log', keyPath: null, autoIncrement: true, indexes: [], count: 2 },
        { name: 'pages', keyPath: 'slug', autoIncrement: false, indexes: [{ name: 'by-body', keyPath: 'body', unique: true, multiEntry: false }, { name: 'by-tag', keyPath: 'tags', unique: false, multiEntry: true }], count: 2 }
      ]
    })
  })

  it('makes a database as it was and fills it, so that the indexes answer and the values are what they were', async () => {
    const { from, to } = await connected()
    await withDatabase(from.indexedDB, 'notes', async (db) => {
      await putAll(db, 'pages', [[{ slug: 'home', body: 'Home', tags: ['a', 'b'], at: new Date(10) }, undefined], [{ slug: 'about', body: 'About', tags: ['b'], at: new Date(20) }, undefined]])
      await putAll(db, 'blobs', [[new Blob(['png-bytes'], { type: 'image/png' }), 'logo'], [new Uint8Array([1, 2]), 'raw']])
      await putAll(db, 'log', [['first', undefined], ['second', undefined]])
    }, (db) => {
      const pages = db.createObjectStore('pages', { keyPath: 'slug' })
      pages.createIndex('by-tag', 'tags', { multiEntry: true })
      pages.createIndex('by-body', 'body', { unique: true })
      db.createObjectStore('blobs')
      db.createObjectStore('log', { autoIncrement: true })
    }, 7)
    const [shape] = await json<Shape[]>(from, 'readDatabases')
    expect(await json(to, 'writeSchema', shape)).toEqual({ status: 'created' })
    for (const store of shape?.stores ?? []) {
      const moved = await moveStore(from, to, 'notes', store.name)
      expect(moved.wrote.every((batch) => batch.problems.length === 0 && batch.aborted === undefined)).toBe(true)
    }
    await to.run(call('closeAll'))
    await withDatabase(to.indexedDB, 'notes', async (db) => {
      expect(db.version).toBe(7)
      expect((await readAll(db, 'pages')).map((row) => row.key)).toEqual(['about', 'home'])
      expect((await readAll(db, 'pages')).map((row) => (row.value as { at: Date }).at.getTime())).toEqual([20, 10])
      expect((await readAll(db, 'log')).map((row) => [row.key, row.value])).toEqual([[1, 'first'], [2, 'second']])
      const blobs = await readAll(db, 'blobs')
      expect(blobs.map((row) => row.key)).toEqual(['logo', 'raw'])
      const logo = blobs[0]?.value as Blob
      expect([logo.type, await logo.text()]).toEqual(['image/png', 'png-bytes'])
      expect(blobs[1]?.value).toEqual(new Uint8Array([1, 2]))
      const store = db.transaction('pages').objectStore('pages')
      expect([store.index('by-body').unique, store.index('by-tag').multiEntry, store.keyPath]).toEqual([true, true, 'slug'])
    })
  })

  it('replaces a database of that name the target holds, instead of leaving it or merging into it', async () => {
    const { from, to } = await connected()
    await withDatabase(from.indexedDB, 'notes', async (db) => { await putAll(db, 'pages', [[{ id: 1, from: 'old' }, undefined]]) }, (db) => { db.createObjectStore('pages', { keyPath: 'id' }) }, 3)
    await withDatabase(to.indexedDB, 'notes', async (db) => { await putAll(db, 'leftover', [['first visit', 'k']]) }, (db) => { db.createObjectStore('leftover') }, 1)
    const [shape] = await json<Shape[]>(from, 'readDatabases')
    expect(await json(to, 'writeSchema', shape)).toEqual({ status: 'created' })
    await moveStore(from, to, 'notes', 'pages')
    await to.run(call('closeAll'))
    await withDatabase(to.indexedDB, 'notes', async (db) => {
      expect([db.version, [...db.objectStoreNames]]).toEqual([3, ['pages']])
      expect((await readAll(db, 'pages')).map((row) => row.value)).toEqual([{ id: 1, from: 'old' }])
    })
  })

  it('moves a store in batches that continue where the last ended, cut by count', async () => {
    const { from, to } = await connected()
    await withDatabase(from.indexedDB, 'many', async (db) => {
      await putAll(db, 's', Array.from({ length: 450 }, (_unused, index) => [{ n: index }, index] as const))
    }, (db) => { db.createObjectStore('s') })
    await to.run(call('writeSchema', { name: 'many', version: 1, stores: [{ name: 's', keyPath: null, autoIncrement: false, indexes: [] }] }))
    const moved = await moveStore(from, to, 'many', 's')
    expect(moved.batches.map((batch) => batch.read)).toEqual([200, 200, 50])
    expect(moved.wrote.map((batch) => batch.written)).toEqual([200, 200, 50])
    await to.run(call('closeAll'))
    await withDatabase(to.indexedDB, 'many', async (db) => {
      expect((await readAll(db, 's')).map((row) => row.key)).toEqual(Array.from({ length: 450 }, (_unused, index) => index))
    })
  })

  it('cuts a batch by weight, so a few large records do not make one huge message', async () => {
    const { from } = await connected()
    await withDatabase(from.indexedDB, 'heavy', async (db) => {
      await putAll(db, 's', [1, 2, 3, 4].map((id) => [{ id, text: 'x'.repeat(1_000_000) }, undefined] as const))
    }, (db) => { db.createObjectStore('s', { keyPath: 'id' }) })
    const first = await json<Sent>(from, 'sendBatch', { db: 'heavy', store: 's', id: 1, offset: 0, restart: true })
    expect(first.read).toBe(2)
    expect(first.done).toBe(false)
  })

  it('names a value that is too large to carry, by its position, and carries the others', async () => {
    const { from, to } = await connected()
    await withDatabase(from.indexedDB, 'big', async (db) => {
      await putAll(db, 's', [[{ ok: 1 }, 'a'], [new Uint8Array(97 * 1024 * 1024), 'b'], [{ ok: 3 }, 'c']])
    }, (db) => { db.createObjectStore('s') })
    await to.run(call('writeSchema', { name: 'big', version: 1, stores: [{ name: 's', keyPath: null, autoIncrement: false, indexes: [] }] }))
    const moved = await moveStore(from, to, 'big', 's')
    expect(moved.batches.flatMap((batch) => batch.skipped)).toEqual(['record 2: a value of 101711872 bytes is too large to carry'])
    expect(moved.wrote.reduce((sum, batch) => sum + batch.written, 0)).toBe(2)
  })

  it('names the record that cannot be cloned and sends the rest', async () => {
    const from = await installed()
    const to = await installed()
    const channel = new MessageChannel()
    channels.push(channel)
    from.predefine('structuredClone', (row: { value: { poison?: boolean } }) => {
      if (row.value.poison === true) throw new DOMException('the value could not be cloned', 'DataCloneError')
      return structuredClone(row)
    })
    const real = channel.port1
    const refusing = { postMessage: (message: { records: Array<{ value: { poison?: boolean } }> }) => { if (message.records.some((row) => row.value.poison === true)) throw new DOMException('the value could not be cloned', 'DataCloneError'); real.postMessage(message) }, close: () => { real.close() }, set onmessage (handler: unknown) { (real as unknown as { onmessage: unknown }).onmessage = handler } }
    await from.give(refusing)
    await to.give(channel.port2)
    await withDatabase(from.indexedDB, 'odd', async (db) => {
      await putAll(db, 's', [[{ ok: 1 }, 'a'], [{ poison: true }, 'b'], [{ ok: 3 }, 'c']])
    }, (db) => { db.createObjectStore('s') })
    await to.run(call('writeSchema', { name: 'odd', version: 1, stores: [{ name: 's', keyPath: null, autoIncrement: false, indexes: [] }] }))
    const sent = await json<Sent>(from, 'sendBatch', { db: 'odd', store: 's', id: 1, offset: 10, restart: true })
    expect([sent.read, sent.skipped]).toEqual([3, ['record 12: the value could not be cloned']])
    expect((await json<Written>(to, 'writeBatch', { db: 'odd', store: 's', id: 1, offset: 10 })).written).toBe(2)
  })

  it('names the record a store refuses and stores the rest, without aborting the batch', async () => {
    const { from, to } = await connected()
    await withDatabase(from.indexedDB, 'unique', async (db) => {
      await putAll(db, 's', [[{ id: 1, name: 'a' }, undefined], [{ id: 2, name: 'a' }, undefined], [{ id: 3, name: 'c' }, undefined]])
    }, (db) => { db.createObjectStore('s', { keyPath: 'id' }) })
    // The target's schema has a unique index the source's lacks, so the second record clashes with the first.
    const shape = { name: 'unique', version: 1, stores: [{ name: 's', keyPath: 'id', autoIncrement: false, indexes: [{ name: 'by-name', keyPath: 'name', unique: true, multiEntry: false }] }] }
    expect(await json(to, 'writeSchema', shape)).toEqual({ status: 'created' })
    const moved = await moveStore(from, to, 'unique', 's')
    expect(moved.wrote).toHaveLength(1)
    expect(moved.wrote[0]?.written).toBe(2)
    expect(moved.wrote[0]?.aborted).toBeUndefined()
    expect(moved.wrote[0]?.problems).toHaveLength(1)
    expect(moved.wrote[0]?.problems[0]).toMatch(/^record 2: /)
    await to.run(call('closeAll'))
    await withDatabase(to.indexedDB, 'unique', async (db) => {
      expect((await readAll(db, 's')).map((row) => row.key)).toEqual([1, 3])
    })
  })
})

describe('what a record keeps on its way', () => {
  async function through (value: unknown): Promise<unknown> {
    const { from, to } = await connected()
    await withDatabase(from.indexedDB, 'v', async (db) => { await putAll(db, 's', [[value, 'k']]) }, (db) => { db.createObjectStore('s') })
    await to.run(call('writeSchema', { name: 'v', version: 1, stores: [{ name: 's', keyPath: null, autoIncrement: false, indexes: [] }] }))
    const moved = await moveStore(from, to, 'v', 's')
    expect(moved.wrote.map((batch) => batch.problems)).toEqual([[]])
    await to.run(call('closeAll'))
    return await withDatabase(to.indexedDB, 'v', async (db) => (await readAll(db, 's'))[0]?.value)
  }

  it('keeps dates, undefined, NaN, negative zero, big integers, maps, sets and typed arrays', async () => {
    const value = { when: new Date(1_700_000_000_123), none: undefined, nan: NaN, zero: -0, big: 2n ** 80n + 5n, map: new Map<unknown, unknown>([['k', new Set([1, 2])], [new Date(5), { n: null }]]), bytes: new Float64Array([1.5, -2.25]) }
    const back = await through(value) as typeof value
    expect(back.when).toEqual(value.when)
    expect(back.none).toBeUndefined()
    expect(Number.isNaN(back.nan)).toBe(true)
    expect(Object.is(back.zero, -0)).toBe(true)
    expect(back.big).toBe(value.big)
    expect(back.map).toEqual(value.map)
    expect([...back.bytes]).toEqual([1.5, -2.25])
  })

  it('keeps an object that several places point to as one object', async () => {
    const shared = { n: 1 }
    const back = await through({ a: shared, b: shared, list: [shared] }) as { a: object, b: object, list: object[] }
    expect(back.a).toBe(back.b)
    expect(back.list[0]).toBe(back.a)
  })

  it('keeps a value that contains itself', async () => {
    const loop: Record<string, unknown> = { name: 'loop' }
    loop['self'] = loop
    const back = await through(loop) as Record<string, unknown>
    expect(back['self']).toBe(back)
  })

  it('rebuilds a Blob inside a nested value from its bytes, type included, once for a Blob that is shared', async () => {
    const blob = new Blob(['hello', ' world'], { type: 'text/plain' })
    const back = await through({ deep: { list: [blob, { again: blob }] }, map: new Map([['b', blob]]) }) as { deep: { list: [Blob, { again: Blob }] }, map: Map<string, Blob> }
    const first = back.deep.list[0]
    expect([first.type, await first.text()]).toEqual(['text/plain', 'hello world'])
    expect(back.deep.list[1].again).toBe(first)
    expect(back.map.get('b')).toBe(first)
  })

  it('does not let a key named __proto__ in a value set a prototype', async () => {
    const hostile = JSON.parse('{"__proto__": {"polluted": true, "blob": 1}, "plain": 1}') as Record<string, unknown>
    const back = await through(hostile) as Record<string, unknown>
    expect(Object.keys(back).sort()).toEqual(['__proto__', 'plain'])
    expect(Object.getPrototypeOf(back)).toBe(Object.prototype)
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })

  it('keeps a key that is not extractable usable', async () => {
    const key = await webcrypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    let cloneable = true
    try { structuredClone(key) } catch { cloneable = false }
    if (!cloneable) return
    const back = await through({ key }) as { key: CryptoKey }
    expect([back.key.extractable, back.key.type]).toEqual([false, 'secret'])
    expect((await webcrypto.subtle.sign('HMAC', back.key, new Uint8Array([1]))).byteLength).toBe(32)
  })
})

describe('what counts as written', () => {
  it('is a record whose transaction completed: a batch that aborts after some records were accepted counts none, and says why', async () => {
    const { from, to } = await connected()
    await withDatabase(from.indexedDB, 'abort', async (db) => { await putAll(db, 's', [[{ id: 1 }, undefined], [{ id: 2 }, undefined], [{ id: 3 }, undefined]]) }, (db) => { db.createObjectStore('s', { keyPath: 'id' }) })
    await to.run(call('writeSchema', { name: 'abort', version: 1, stores: [{ name: 's', keyPath: 'id', autoIncrement: false, indexes: [] }] }))
    await json<Sent>(from, 'sendBatch', { db: 'abort', store: 's', id: 1, offset: 0, restart: true })
    const put = IDBObjectStore.prototype.put
    let first = true
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
      const request = put.apply(this, args)
      const transaction = this.transaction
      request.addEventListener('success', () => { if (first) { first = false; queueMicrotask(() => { transaction.abort() }) } })
      return request
    }
    try {
      const result = await json<Written>(to, 'writeBatch', { db: 'abort', store: 's', id: 1, offset: 0 })
      expect(result.written).toBe(0)
      expect(result.aborted).toBeDefined()
    } finally {
      IDBObjectStore.prototype.put = put
    }
  })
})
