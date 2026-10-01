import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseProfilesIni, readFirefoxBookmarks, readFirefoxHistory } from '../firefox-places.js'
import { withDatabaseCopy } from '../sqlite-copy.js'
import { makeFirefoxPlaces } from './databases.js'
import type { FirefoxBookmark } from './databases.js'

let dir = ''
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'orivon-places-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const NOW = Date.UTC(2026, 8, 30)
const path = (): string => join(dir, 'places.sqlite')

describe('parseProfilesIni', () => {
  it('reads Name, Path and IsRelative of each profile section, and nothing of the other sections', () => {
    const text = '[General]\nStartWithLastProfile=1\n\n[Profile0]\nName=default\nIsRelative=1\nPath=a.default\nDefault=1\n\n[Profile1]\nName=away\nIsRelative=0\nPath=/data/away\n\n[Install123]\nDefault=a.default\nLocked=1\n'
    expect(parseProfilesIni(text)).toEqual([
      { name: 'default', path: 'a.default', isRelative: true },
      { name: 'away', path: '/data/away', isRelative: false }
    ])
  })

  it('takes CRLF files, treats a missing IsRelative as relative, and drops a profile with no path', () => {
    expect(parseProfilesIni('[Profile0]\r\nName=x\r\nPath=p\r\n[Profile1]\r\nName=nopath\r\n')).toEqual([{ name: 'x', path: 'p', isRelative: true }])
    expect(parseProfilesIni('')).toEqual([])
  })
})

const TREE: FirefoxBookmark[] = [
  { id: 1, type: 2, parent: 0, position: 0, title: '', guid: 'root________' },
  { id: 2, type: 2, parent: 1, position: 0, title: 'menu', guid: 'menu________' },
  { id: 3, type: 2, parent: 1, position: 1, title: 'Bookmarks Toolbar', guid: 'toolbar_____' },
  { id: 4, type: 2, parent: 1, position: 2, title: 'Tags', guid: 'tags________' },
  { id: 5, type: 2, parent: 1, position: 3, title: 'Other Bookmarks', guid: 'unfiled_____' },
  { id: 6, type: 2, parent: 1, position: 4, title: 'mobile', guid: 'mobile______' },
  { id: 10, type: 1, parent: 3, position: 1, title: 'Second', guid: 'g10', url: 'https://second.test/' },
  { id: 11, type: 1, parent: 3, position: 0, title: 'First', guid: 'g11', url: 'https://first.test/', addedMs: 1_600_000_000_000 },
  { id: 12, type: 2, parent: 3, position: 2, title: 'Folder', guid: 'g12' },
  { id: 13, type: 1, parent: 12, position: 0, title: 'Inside', guid: 'g13', url: 'https://inside.test/' },
  { id: 14, type: 1, parent: 2, position: 0, title: 'Menu page', guid: 'g14', url: 'https://menu.test/' },
  { id: 15, type: 1, parent: 5, position: 0, title: 'Loose', guid: 'g15', url: 'https://loose.test/' },
  { id: 16, type: 1, parent: 6, position: 0, title: 'Phone', guid: 'g16', url: 'https://phone.test/' },
  { id: 17, type: 1, parent: 4, position: 0, title: 'Tagged', guid: 'g17', url: 'https://tagged.test/' },
  { id: 18, type: 1, parent: 5, position: 1, title: 'Query', guid: 'g18', url: 'place:sort=8' }
]

describe('readFirefoxBookmarks', () => {
  it('puts the toolbar on the bar in position order, and the menu, the unfiled items and the mobile ones in Other bookmarks', async () => {
    makeFirefoxPlaces(path(), [], TREE).close()
    const { bar, other } = await withDatabaseCopy(path(), readFirefoxBookmarks)
    expect(bar.map((node) => node.title)).toEqual(['First', 'Second', 'Folder'])
    expect(bar[0]?.added).toBe(1_600_000_000_000)
    expect(bar[2]?.children?.map((node) => node.url)).toEqual(['https://inside.test/'])
    expect(other.map((node) => node.title)).toEqual(['Menu page', 'Loose', 'Mobile bookmarks'])
    expect(other[2]?.children?.[0]?.url).toBe('https://phone.test/')
  })

  it('leaves out tags and saved queries', async () => {
    makeFirefoxPlaces(path(), [], TREE).close()
    const { bar, other } = await withDatabaseCopy(path(), readFirefoxBookmarks)
    const urls = JSON.stringify([bar, other])
    expect(urls).not.toContain('tagged.test')
    expect(urls).not.toContain('place:')
  })

  it('reads from a live database whose rows are in the write-ahead log', async () => {
    const live = makeFirefoxPlaces(path(), [], TREE)
    try {
      expect((await withDatabaseCopy(path(), readFirefoxBookmarks)).bar).toHaveLength(3)
    } finally {
      live.close()
    }
  })

  it('reports a database with no bookmarks table as unreadable', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(path())
    db.exec('CREATE TABLE x (y)')
    db.close()
    await expect(withDatabaseCopy(path(), readFirefoxBookmarks)).rejects.toThrowError(expect.objectContaining({ reason: 'unreadable' }))
  })
})

describe('readFirefoxHistory', () => {
  it('reads the pages that were visited, newest first, within the limit and the time', async () => {
    makeFirefoxPlaces(path(), [
      { url: 'https://a.test/', title: 'A', visits: 4, at: NOW - 3000 },
      { url: 'https://b.test/', title: 'B', visits: 1, at: NOW - 1000 },
      { url: 'https://never.test/', title: 'Never', visits: 0, at: null },
      { url: 'https://c.test/', title: 'C', visits: 2, at: NOW - 2000 }
    ]).close()
    const read = async (limit: number, sinceMs = 0) => await withDatabaseCopy(path(), (db) => readFirefoxHistory(db, { limit, sinceMs }))
    expect((await read(10)).map((row) => [row.url, row.lastVisit, row.visitCount])).toEqual([
      ['https://b.test/', NOW - 1000, 1], ['https://c.test/', NOW - 2000, 2], ['https://a.test/', NOW - 3000, 4]
    ])
    expect(await read(1)).toHaveLength(1)
    expect((await read(10, NOW - 2500)).map((row) => row.url)).toEqual(['https://b.test/', 'https://c.test/'])
  })
})
