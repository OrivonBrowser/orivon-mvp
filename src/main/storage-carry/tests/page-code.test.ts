import { webcrypto } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { fakePage, putAll, readAll, withDatabase } from './fake-page.js'
import type { FakePage } from './fake-page.js'
import { CARRY_PAGE_CODE } from '../page-code.js'

async function prepared (): Promise<FakePage> {
  const page = fakePage()
  expect(await page.run(CARRY_PAGE_CODE)).toBe('ready')
  return page
}

/** A value through the codec as a record goes through it: encoded, written as JSON text, read back and decoded. */
async function roundTrip (page: FakePage, value: unknown): Promise<unknown> {
  const text = JSON.stringify(await page.codec.encode(value, new Set()))
  return await page.codec.decode(JSON.parse(text))
}

describe('the script', () => {
  it('can be run twice in a page without replacing what the first run set up', async () => {
    const page = await prepared()
    const first = page.codec
    expect(await page.run(CARRY_PAGE_CODE)).toBe('ready')
    expect(page.codec).toBe(first)
  })
})

describe('the encoding of a value', () => {
  it('keeps text, booleans, null and ordinary numbers as they are, in the JSON itself', async () => {
    const page = await prepared()
    for (const value of ['text', '', true, false, null, 0, 1.5, -7]) expect(await page.codec.encode(value, new Set())).toBe(value)
  })

  it('carries what JSON cannot say: NaN, the infinities, negative zero, undefined and big integers', async () => {
    const page = await prepared()
    expect(Number.isNaN(await roundTrip(page, NaN))).toBe(true)
    expect(await roundTrip(page, Infinity)).toBe(Infinity)
    expect(await roundTrip(page, -Infinity)).toBe(-Infinity)
    expect(Object.is(await roundTrip(page, -0), -0)).toBe(true)
    expect(await roundTrip(page, undefined)).toBeUndefined()
    expect(await roundTrip(page, 2n ** 80n + 5n)).toBe(2n ** 80n + 5n)
  })

  it('carries dates, including an invalid one, and regular expressions', async () => {
    const page = await prepared()
    expect(await roundTrip(page, new Date(1_700_000_000_123))).toEqual(new Date(1_700_000_000_123))
    expect(Number.isNaN((await roundTrip(page, new Date(NaN)) as Date).getTime())).toBe(true)
    const pattern = await roundTrip(page, /a+b/gi) as RegExp
    expect([pattern.source, pattern.flags]).toEqual(['a+b', 'gi'])
  })

  it('carries buffers and views exactly: the bytes of a view, not the buffer it looks into', async () => {
    const page = await prepared()
    const buffer = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer
    expect(new Uint8Array(await roundTrip(page, buffer) as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))
    const window = new Uint8Array(buffer, 2, 3)
    const back = await roundTrip(page, window) as Uint8Array
    expect([back.constructor.name, [...back], back.byteOffset]).toEqual(['Uint8Array', [3, 4, 5], 0])
    const floats = await roundTrip(page, new Float64Array([1.5, -2.25])) as Float64Array
    expect([floats.constructor.name, [...floats]]).toEqual(['Float64Array', [1.5, -2.25]])
    const view = await roundTrip(page, new DataView(new Uint8Array([0, 0, 1, 0]).buffer)) as DataView
    expect(view.getUint16(2)).toBe(256)
  })

  it('carries a Blob and a File with their bytes, type, name and date', async () => {
    const page = await prepared()
    const blob = await roundTrip(page, new Blob(['hello', ' world'], { type: 'text/plain' })) as Blob
    expect([blob.constructor.name, blob.type, await blob.text()]).toEqual(['Blob', 'text/plain', 'hello world'])
    const file = await roundTrip(page, new File([new Uint8Array([9, 8, 7])], 'photo.bin', { type: 'application/octet-stream', lastModified: 1_650_000_000_000 })) as File
    expect([file.constructor.name, file.name, file.type, file.lastModified, [...new Uint8Array(await file.arrayBuffer())]]).toEqual(['File', 'photo.bin', 'application/octet-stream', 1_650_000_000_000, [9, 8, 7]])
  })

  it('carries maps, sets, arrays and objects nested in each other', async () => {
    const page = await prepared()
    const value = { list: [1, 'two', [3, { four: new Date(4) }]], map: new Map<unknown, unknown>([['k', new Set([1, 2])], [new Date(5), { n: null }]]), nested: { deep: { deeper: [true] } } }
    expect(await roundTrip(page, value)).toEqual(value)
  })

  it('does not confuse an object that has a key of its own named $t, or __proto__, with a tagged value', async () => {
    const page = await prepared()
    const marked = { $t: 'date', v: 5 }
    expect(await roundTrip(page, marked)).toEqual(marked)
    const hostile = JSON.parse('{"__proto__": {"polluted": true}, "plain": 1}') as Record<string, unknown>
    const back = await roundTrip(page, hostile) as Record<string, unknown>
    expect(Object.keys(back).sort()).toEqual(['__proto__', 'plain'])
    expect(Object.getPrototypeOf(back)).toBe(Object.prototype)
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })

  it('carries an error by its kind and message', async () => {
    const page = await prepared()
    const back = await roundTrip(page, new RangeError('too far')) as RangeError
    expect([back.name, back.message, back instanceof RangeError]).toEqual(['RangeError', 'too far', true])
  })

  it('carries a key that can be extracted, as the key it was', async () => {
    const page = await prepared()
    const key = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
    const back = await roundTrip(page, key) as CryptoKey
    expect([back.type, back.algorithm.name, back.extractable, [...back.usages].sort()]).toEqual(['secret', 'AES-GCM', true, ['decrypt', 'encrypt']])
    expect(await webcrypto.subtle.exportKey('jwk', back)).toEqual(await webcrypto.subtle.exportKey('jwk', key))
  })

  it.each([
    ['a function', () => 1, /function cannot be stored/],
    ['a symbol', Symbol('x'), /symbol cannot be stored/]
  ])('refuses %s, naming why', async (_what, value, why) => {
    const page = await prepared()
    await expect(page.codec.encode(value, new Set())).rejects.toThrow(why)
  })

  it('refuses a value that contains itself, and an object of a class it does not know', async () => {
    const page = await prepared()
    const loop: Record<string, unknown> = {}
    loop['self'] = loop
    await expect(page.codec.encode(loop, new Set())).rejects.toThrow('contains itself')
    await expect(page.codec.encode(new (class Custom { x = 1 })(), new Set())).rejects.toThrow('unsupported')
  })

  it('refuses a key that cannot be extracted, and a decode of a kind it does not know', async () => {
    const page = await prepared()
    const sealed = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt'])
    await expect(page.codec.encode(sealed, new Set())).rejects.toThrow('not extractable')
    await expect(page.codec.decode({ $t: 'mystery' })).rejects.toThrow('unknown kind')
  })
})

describe('local storage', () => {
  it('is read whole and written without replacing an item the target has', async () => {
    const from = await prepared()
    const to = await prepared()
    from.localStorage.setItem('theme', 'dark')
    from.localStorage.setItem('token', 'old')
    to.localStorage.setItem('token', 'new')
    const entries = JSON.parse(await from.run('__orivonCarry.readLocalStorage()')) as Array<[string, string]>
    expect(entries).toEqual([['theme', 'dark'], ['token', 'old']])
    expect(JSON.parse(await to.run(`__orivonCarry.writeLocalStorage(${JSON.stringify(entries)})`))).toEqual({ carried: 1, skipped: 1, problems: [] })
    expect([to.localStorage.getItem('theme'), to.localStorage.getItem('token')]).toEqual(['dark', 'new'])
  })

  it('names an item the page refuses and goes on with the rest', async () => {
    const to = await prepared()
    const original = to.localStorage.setItem.bind(to.localStorage)
    to.localStorage.setItem = (name, value) => { if (name === 'big') throw new Error('quota exceeded'); original(name, value) }
    const result = JSON.parse(await to.run(`__orivonCarry.writeLocalStorage(${JSON.stringify([['big', 'x'], ['small', 'y']])})`)) as { carried: number, problems: string[] }
    expect(result.carried).toBe(1)
    expect(result.problems).toEqual(['item 1: quota exceeded'])
    expect(to.localStorage.getItem('small')).toBe('y')
  })
})

describe('databases', () => {
  async function seeded (): Promise<FakePage> {
    const page = await prepared()
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

  it('lists every database with its version and each store with its key, counter, indexes and size', async () => {
    const page = await seeded()
    const [shape] = JSON.parse(await page.run('__orivonCarry.readDatabases()')) as Array<Record<string, unknown>>
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

  it('reads a store in batches that continue where the last ended, and cuts them by count', async () => {
    const page = await prepared()
    await withDatabase(page.indexedDB, 'many', async (db) => {
      await putAll(db, 's', Array.from({ length: 450 }, (_unused, index) => [{ n: index }, index] as const))
    }, (db) => { db.createObjectStore('s') })
    const seen: number[] = []
    let after: unknown
    let batches = 0
    for (;;) {
      const batch = JSON.parse(await page.run(`__orivonCarry.readBatch(${JSON.stringify({ db: 'many', store: 's', after, offset: seen.length })})`)) as { records: Array<{ k: number }>, read: number, next?: unknown, done: boolean }
      batches += 1
      seen.push(...batch.records.map((record) => record.k))
      if (batch.done) break
      after = batch.next
    }
    expect(batches).toBe(3)
    expect(seen).toEqual(Array.from({ length: 450 }, (_unused, index) => index))
  })

  it('cuts a batch by weight, so a few large records do not make one huge script', async () => {
    const page = await prepared()
    await withDatabase(page.indexedDB, 'heavy', async (db) => {
      await putAll(db, 's', [1, 2, 3, 4].map((id) => [{ id, text: 'x'.repeat(1_000_000) }, undefined] as const))
    }, (db) => { db.createObjectStore('s', { keyPath: 'id' }) })
    const first = JSON.parse(await page.run(`__orivonCarry.readBatch(${JSON.stringify({ db: 'heavy', store: 's', offset: 0 })})`)) as { read: number, done: boolean }
    expect(first.read).toBe(2)
    expect(first.done).toBe(false)
  })

  it('names a record it cannot encode, by its position, and carries the others', async () => {
    const page = await prepared()
    await withDatabase(page.indexedDB, 'odd', async (db) => {
      await putAll(db, 's', [[{ ok: 1 }, 'a'], [new Map([[1, 2]]), 'b']])
      await putAll(db, 's', [[await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 128 }, false, ['encrypt']), 'c']])
    }, (db) => { db.createObjectStore('s') })
    const batch = JSON.parse(await page.run(`__orivonCarry.readBatch(${JSON.stringify({ db: 'odd', store: 's', offset: 10 })})`)) as { records: unknown[], read: number, problems: string[] }
    expect([batch.records.length, batch.read]).toEqual([2, 3])
    expect(batch.problems).toEqual(['record 13: a key that is not extractable cannot be read'])
  })

  it('makes a database as it was and fills it, so that the indexes answer and the values are what they were', async () => {
    const from = await seeded()
    const to = await prepared()
    const [shape] = JSON.parse(await from.run('__orivonCarry.readDatabases()')) as Array<{ name: string, version: number, stores: Array<{ name: string }> }>
    expect(JSON.parse(await to.run(`__orivonCarry.writeSchema(${JSON.stringify(shape)})`))).toEqual({ status: 'created' })
    for (const store of shape?.stores ?? []) {
      const batch = JSON.parse(await from.run(`__orivonCarry.readBatch(${JSON.stringify({ db: 'notes', store: store.name, offset: 0 })})`)) as { records: unknown[] }
      expect(JSON.parse(await to.run(`__orivonCarry.writeBatch(${JSON.stringify({ db: 'notes', store: store.name, records: batch.records, offset: 0 })})`))).toEqual({ written: batch.records.length, problems: [] })
    }
    await to.run('__orivonCarry.closeAll()')
    await withDatabase(to.indexedDB, 'notes', async (db) => {
      expect(db.version).toBe(7)
      expect((await readAll(db, 'pages')).map((row) => row.key)).toEqual(['about', 'home'])
      expect((await readAll(db, 'log')).map((row) => [row.key, row.value])).toEqual([[1, 'first'], [2, 'second']])
      const blobs = await readAll(db, 'blobs')
      expect(blobs.map((row) => row.key)).toEqual(['logo', 'raw'])
      const logo = blobs[0]?.value as Blob
      expect([logo.type, await logo.text()]).toEqual(['image/png', 'png-bytes'])
      expect(blobs[1]?.value).toEqual(new Uint8Array([1, 2]))
      const byTag = await new Promise<unknown[]>((resolve, reject) => {
        const request = db.transaction('pages').objectStore('pages').index('by-tag').getAll('b')
        request.onsuccess = () => { resolve(request.result as unknown[]) }
        request.onerror = () => { reject(request.error ?? new Error('index read failed')) }
      })
      expect(byTag).toHaveLength(2)
      const store = db.transaction('pages').objectStore('pages')
      expect([store.index('by-body').unique, store.index('by-tag').multiEntry, store.keyPath]).toEqual([true, true, 'slug'])
    })
  })

  it('leaves a database alone when the target already has one of that name', async () => {
    const from = await seeded()
    const to = await prepared()
    await withDatabase(to.indexedDB, 'notes', async () => undefined, (db) => { db.createObjectStore('own') }, 1)
    const [shape] = JSON.parse(await from.run('__orivonCarry.readDatabases()')) as unknown[]
    expect(JSON.parse(await to.run(`__orivonCarry.writeSchema(${JSON.stringify(shape)})`))).toEqual({ status: 'exists' })
    await withDatabase(to.indexedDB, 'notes', async (db) => { expect([...db.objectStoreNames]).toEqual(['own']) })
  })

  it('names the record a store refuses and stores the rest', async () => {
    const to = await prepared()
    const shape = { name: 'unique', version: 1, stores: [{ name: 's', keyPath: 'id', autoIncrement: false, indexes: [{ name: 'by-name', keyPath: 'name', unique: true, multiEntry: false }] }] }
    await to.run(`__orivonCarry.writeSchema(${JSON.stringify(shape)})`)
    const records = [{ k: 1, v: { id: 1, name: 'a' } }, { k: 2, v: { id: 2, name: 'a' } }, { k: 3, v: { id: 3, name: 'c' } }]
    const result = JSON.parse(await to.run(`__orivonCarry.writeBatch(${JSON.stringify({ db: 'unique', store: 's', records, offset: 4 })})`)) as { written: number, problems: string[] }
    expect(result.written).toBe(2)
    expect(result.problems).toHaveLength(1)
    expect(result.problems[0]).toMatch(/^record 6: /)
  })

  it('removes a database it made, for a carry that stopped half way', async () => {
    const to = await prepared()
    await to.run(`__orivonCarry.writeSchema(${JSON.stringify({ name: 'half', version: 1, stores: [] })})`)
    expect(await to.run('__orivonCarry.dropDatabase("half")')).toBe('dropped')
    expect((await to.indexedDB.databases()).map((info) => info.name)).toEqual([])
  })
})
