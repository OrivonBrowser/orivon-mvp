import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  addBookmark,
  BookmarkStore,
  hasBookmark,
  parseBookmarksFile,
  removeBookmark,
  serializeBookmarksFile,
  WRITE_DEBOUNCE_MS,
  type Bookmark
} from './bookmarks.js'

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('addBookmark', () => {
  it('appends a new entry', () => {
    const result = addBookmark([], { url: 'https://a.example/', title: 'A' })
    expect(result).toEqual([{ url: 'https://a.example/', title: 'A' }])
  })

  it('replaces an existing entry for the same URL, moving it to the end', () => {
    const list: Bookmark[] = [
      { url: 'https://a.example/', title: 'A' },
      { url: 'https://b.example/', title: 'B' }
    ]
    const result = addBookmark(list, { url: 'https://a.example/', title: 'A renamed' })
    expect(result).toEqual([
      { url: 'https://b.example/', title: 'B' },
      { url: 'https://a.example/', title: 'A renamed' }
    ])
  })
})

describe('removeBookmark', () => {
  it('drops the matching URL and leaves the rest', () => {
    const list: Bookmark[] = [
      { url: 'https://a.example/', title: 'A' },
      { url: 'https://b.example/', title: 'B' }
    ]
    expect(removeBookmark(list, 'https://a.example/')).toEqual([{ url: 'https://b.example/', title: 'B' }])
  })

  it('is a no-op when the URL is not bookmarked', () => {
    const list: Bookmark[] = [{ url: 'https://a.example/', title: 'A' }]
    expect(removeBookmark(list, 'https://nowhere.example/')).toEqual(list)
  })
})

describe('hasBookmark', () => {
  it('reports true only for a URL present in the list', () => {
    const list: Bookmark[] = [{ url: 'https://a.example/', title: 'A' }]
    expect(hasBookmark(list, 'https://a.example/')).toBe(true)
    expect(hasBookmark(list, 'https://b.example/')).toBe(false)
  })
})

describe('parseBookmarksFile', () => {
  it('round-trips what serializeBookmarksFile writes', () => {
    const list: Bookmark[] = [{ url: 'https://a.example/', title: 'A' }]
    expect(parseBookmarksFile(serializeBookmarksFile(list))).toEqual(list)
  })

  it('yields an empty list for invalid JSON', () => {
    expect(parseBookmarksFile('{not json')).toEqual([])
  })

  it('yields an empty list when the JSON is not an array', () => {
    expect(parseBookmarksFile('{"url":"https://a.example/"}')).toEqual([])
  })

  it('drops entries missing a url or title', () => {
    const raw = JSON.stringify([
      { url: 'https://a.example/', title: 'A' },
      { url: 'https://b.example/' },
      { title: 'no url' },
      { url: 123, title: 'wrong type' }
    ])
    expect(parseBookmarksFile(raw)).toEqual([{ url: 'https://a.example/', title: 'A' }])
  })

  // Security-critical: the file is user-writable, and a stored
  // javascript:/data:/file: URL would be persisted XSS into this
  // privileged chrome view the moment the bar renders it.
  it('rejects entries with a dangerous scheme, same rule as the omnibox', () => {
    const raw = JSON.stringify([
      { url: 'javascript:alert(1)', title: 'evil' },
      { url: 'https://a.example/', title: 'fine' }
    ])
    expect(parseBookmarksFile(raw)).toEqual([{ url: 'https://a.example/', title: 'fine' }])
  })
})

describe('BookmarkStore', () => {
  let dir: string
  let filePath: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orivon-bookmarks-'))
    filePath = join(dir, 'nested', 'bookmarks.json')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('starts empty when the file does not exist yet (first launch)', async () => {
    const store = new BookmarkStore(filePath)
    await store.load()
    expect(store.getAll()).toEqual([])
  })

  it('starts empty rather than throwing when the file is corrupt', async () => {
    await mkdirAndWrite(filePath, 'not json at all')
    const store = new BookmarkStore(filePath)
    await expect(store.load()).resolves.toBeUndefined()
    expect(store.getAll()).toEqual([])
  })

  it('add() is rejected for a dangerous scheme and does not change the list', () => {
    const store = new BookmarkStore(filePath)
    store.add({ url: 'javascript:alert(1)', title: 'evil' })
    expect(store.getAll()).toEqual([])
  })

  it('add() then remove() round-trips through has()', () => {
    const store = new BookmarkStore(filePath)
    expect(store.has('https://a.example/')).toBe(false)
    store.add({ url: 'https://a.example/', title: 'A' })
    expect(store.has('https://a.example/')).toBe(true)
    store.remove('https://a.example/')
    expect(store.has('https://a.example/')).toBe(false)
  })

  it('debounces writes and persists the final state to disk, creating parent directories', async () => {
    const store = new BookmarkStore(filePath)
    store.add({ url: 'https://a.example/', title: 'A' })
    store.add({ url: 'https://b.example/', title: 'B' })
    // Nothing written yet -- still inside the debounce window.
    await expect(readFile(filePath, 'utf8')).rejects.toThrow()

    await delay(WRITE_DEBOUNCE_MS + 200)

    const onDisk = parseBookmarksFile(await readFile(filePath, 'utf8'))
    expect(onDisk).toEqual([
      { url: 'https://a.example/', title: 'A' },
      { url: 'https://b.example/', title: 'B' }
    ])
  })

  it('notifies onChange listeners on add and remove', () => {
    const store = new BookmarkStore(filePath)
    const calls: number[] = []
    store.onChange(() => calls.push(calls.length))
    store.add({ url: 'https://a.example/', title: 'A' })
    store.remove('https://a.example/')
    expect(calls).toEqual([0, 1])
  })
})

async function mkdirAndWrite (path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents, 'utf8')
}
