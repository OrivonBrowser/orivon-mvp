import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readChromiumHistory } from '../chromium-history.js'
import { withDatabaseCopy } from '../sqlite-copy.js'
import { makeChromeHistory } from './databases.js'

let dir = ''
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'orivon-chrome-history-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const NOW = Date.UTC(2026, 8, 30)
const read = async (limit: number, sinceMs = 0) => await withDatabaseCopy(join(dir, 'History'), (db) => readChromiumHistory(db, { limit, sinceMs }))

describe('readChromiumHistory', () => {
  it('converts Chromium time to Unix milliseconds and reads newest first, from a file whose rows are in the write-ahead log', async () => {
    const live = makeChromeHistory(join(dir, 'History'), [
      { url: 'https://old.test/', title: 'Old', visits: 3, at: NOW - 3000 },
      { url: 'https://new.test/', title: 'New', visits: 1, at: NOW - 1000 },
      { url: 'https://mid.test/', title: '', visits: 0, at: NOW - 2000 }
    ])
    try {
      expect(await read(10)).toEqual([
        { url: 'https://new.test/', title: 'New', lastVisit: NOW - 1000, visitCount: 1 },
        { url: 'https://mid.test/', title: '', lastVisit: NOW - 2000, visitCount: 1 },
        { url: 'https://old.test/', title: 'Old', lastVisit: NOW - 3000, visitCount: 3 }
      ])
    } finally {
      live.close()
    }
  })

  it('reads at most the limit, newest first', async () => {
    makeChromeHistory(join(dir, 'History'), Array.from({ length: 50 }, (_, index) => ({ url: `https://p${String(index)}.test/`, title: 'p', visits: 1, at: NOW - index * 1000 })), { wal: false }).close()
    const rows = await read(5)
    expect(rows.map((row) => row.url)).toEqual([0, 1, 2, 3, 4].map((index) => `https://p${String(index)}.test/`))
  })

  it('leaves out the pages Chromium hides from its own history: those only ever loaded in a frame', async () => {
    makeChromeHistory(join(dir, 'History'), [{ url: 'https://seen.test/', title: 'Seen', visits: 2, at: NOW - 2000 }, { url: 'https://ads.test/frame', title: '', visits: 0, at: NOW - 1000, hidden: true }], { wal: false }).close()
    expect((await read(10)).map((row) => row.url)).toEqual(['https://seen.test/'])
  })

  it('leaves out what was visited before the given time', async () => {
    makeChromeHistory(join(dir, 'History'), [{ url: 'https://a.test/', title: 'a', visits: 1, at: NOW - 10_000 }, { url: 'https://b.test/', title: 'b', visits: 1, at: NOW - 1000 }], { wal: false }).close()
    expect((await read(10, NOW - 5000)).map((row) => row.url)).toEqual(['https://b.test/'])
  })

  it('reports a file with no urls table as unreadable', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(dir, 'History'))
    db.exec('CREATE TABLE other (x INTEGER)')
    db.close()
    await expect(read(10)).rejects.toThrowError(expect.objectContaining({ reason: 'unreadable' }))
  })

  it('reports a urls table missing a column as unreadable', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(dir, 'History'))
    db.exec('CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT)')
    db.close()
    await expect(read(10)).rejects.toThrowError(expect.objectContaining({ reason: 'unreadable' }))
  })
})
