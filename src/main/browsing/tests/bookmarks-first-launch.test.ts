import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BookmarkStore } from '../bookmarks.js'
import { defaultBookmarks, DEFAULT_BOOKMARKS } from '../../default-profile/default-profile.js'
import { randomId } from '../bookmark-tree.js'

const REAL_DEFAULT_PROFILE = join(import.meta.dirname, '../../../../resources/default-profile')

let dir: string
let file: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bookmarks-first-launch-'))
  file = join(dir, 'bookmarks.json')
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const seed = [{ kind: 'url' as const, title: 'One', url: 'https://one.example/' }, { kind: 'url' as const, title: 'Two', url: 'https://two.example/' }]
const storeWith = (firstLaunch?: () => typeof seed): BookmarkStore => new BookmarkStore(file, randomId, Date.now, firstLaunch)

describe('the bookmarks a new profile starts with', () => {
  it('are put in the bar, in order, when there is no file, and are written down at once', async () => {
    const store = storeWith(() => seed)
    await store.load()
    expect(store.getAll().map((page) => page.title)).toEqual(['One', 'Two'])
    expect(store.children('bar').map((node) => node.title)).toEqual(['One', 'Two'])
    await store.flushPendingWrite()
    expect(await readFile(file, 'utf8')).toContain('two.example')
  })

  it('are not put back once the person removed them, even when nothing is left', async () => {
    const first = storeWith(() => seed)
    await first.load()
    first.remove(first.children('bar').map((node) => node.id))
    await first.flushPendingWrite()

    const second = storeWith(() => seed)
    await second.load()
    expect(second.getAll()).toEqual([])
  })

  it('are not added to a file that is there but cannot be read as bookmarks', async () => {
    await writeFile(file, '{ this is not json')
    const supplier = vi.fn(() => seed)
    const store = storeWith(supplier)
    await store.load()
    expect(supplier).not.toHaveBeenCalled()
    expect(store.getAll()).toEqual([])
  })

  it('leave a store with no supplier empty, as before', async () => {
    const store = storeWith()
    await store.load()
    expect(store.getAll()).toEqual([])
  })

  it('keep the five defaults, in order, each with an icon, through the store', async () => {
    const store = new BookmarkStore(file, randomId, Date.now, () => defaultBookmarks(REAL_DEFAULT_PROFILE))
    await store.load()
    const pages = store.getAll()
    expect(pages.map((page) => page.title)).toEqual(DEFAULT_BOOKMARKS.map((entry) => entry.title))
    // The store keeps an address in the form its page is served from: an ipfs:// name is the https:// origin of that name.
    expect(pages.map((page) => page.url)).toEqual([
      'https://app.uniswap.org/', 'https://jamescarnley.eth/', 'https://ensinterviews.eth/', 'https://web3compass.net/', 'https://vitalik.eth/'
    ])
    for (const page of pages) expect(page.favicon, page.title).toMatch(/^data:image\/png;base64,/)
  })
})
