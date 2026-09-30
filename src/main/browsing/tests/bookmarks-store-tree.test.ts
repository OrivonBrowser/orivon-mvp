import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BookmarkStore } from '../bookmarks.js'
import type { IdSource } from '../bookmark-tree.js'

const tiny = 'data:image/png;base64,iVBORw0KGgo='
const counter = (): IdSource => { let n = 0; return () => `n${String(n++)}` }

describe('BookmarkStore as a tree', () => {
  let dir: string
  let file: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orivon-bookmark-tree-'))
    file = join(dir, 'bookmarks.json')
  })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  const store = (): BookmarkStore => new BookmarkStore(file, counter(), () => 1000)
  const onDisk = async (): Promise<unknown> => JSON.parse(await readFile(file, 'utf8'))

  it('files pages and folders under the bar by default, and answers the tree questions', () => {
    const s = store()
    const folder = s.addFolder({ title: 'Work', parent: 'bar' }) as NonNullable<ReturnType<typeof s.addFolder>>
    const inside = s.addUrl({ url: 'https://in.example/', title: 'Inside', parent: folder.id }) as NonNullable<ReturnType<typeof s.addUrl>>
    const top = s.addUrl({ url: 'https://top.example/', title: 'Top', favicon: tiny }) as NonNullable<ReturnType<typeof s.addUrl>>

    expect(s.children('bar').map((node) => node.id)).toEqual([folder.id, top.id])
    expect(s.node(inside.id)).toMatchObject({ parent: folder.id, added: 1000 })
    expect(s.path(inside.id).map((node) => node.title)).toEqual(['Bookmarks bar', 'Work', 'Inside'])
    expect(s.findByUrl('https://in.example/').map((node) => node.id)).toEqual([inside.id])
    expect(s.has('https://top.example/')).toBe(true)
    expect(s.has('https://nowhere.example/')).toBe(false)
    expect(s.search('inside', 5).map((node) => node.id)).toEqual([inside.id])
    expect(s.count()).toBe(3)
    expect(s.folders().map(({ node, depth }) => `${String(depth)}:${node.title}`)).toEqual(['0:Bookmarks bar', '1:Work', '0:Other bookmarks'])
    expect(s.getAll().map((bookmark) => bookmark.url)).toEqual(['https://in.example/', 'https://top.example/'])
  })

  it('refuses what cannot be filed: an address that is not openable, a bad parent, a folder in the reading list', () => {
    const s = store()

    expect(s.addUrl({ url: 'javascript:alert(1)', title: 'x' })).toBeNull()
    expect(s.addUrl({ url: 'https://a.example/', title: 'x', parent: 'missing' })).toBeNull()
    expect(s.addFolder({ title: 'f', parent: 'reading' })).toBeNull()
    expect(s.count()).toBe(0)
  })

  it('counts a page in Other bookmarks as bookmarked, and one in the reading list as not', () => {
    const s = store()
    s.addUrl({ url: 'https://o.example/', title: 'O', parent: 'other' })
    s.addUrl({ url: 'https://r.example/', title: 'R', parent: 'reading' })

    expect(s.has('https://o.example/')).toBe(true)
    expect(s.has('https://r.example/')).toBe(false)
  })

  it('removes by id with a subtree, and by address every page of it; the has() answer follows', () => {
    const s = store()
    const folder = s.addFolder({ title: 'F', parent: 'bar' }) as NonNullable<ReturnType<typeof s.addFolder>>
    s.addUrl({ url: 'https://dup.example/', title: 'one' })
    s.addUrl({ url: 'https://dup.example/', title: 'two', parent: folder.id })
    s.addUrl({ url: 'https://keep.example/', title: 'keep', parent: 'other' })

    expect(s.has('https://dup.example/')).toBe(true)
    expect(s.remove('https://dup.example/')).toBe(2)
    expect(s.has('https://dup.example/')).toBe(false)
    expect(s.remove([folder.id, 'bar', 'nope'])).toBe(1)
    expect(s.children('bar')).toEqual([])
    expect(s.has('https://keep.example/')).toBe(true)
  })

  it('moves and updates through the store and tells its listeners once per change', () => {
    const s = store()
    const listener = vi.fn()
    const a = s.addUrl({ url: 'https://a.example/', title: 'A' }) as NonNullable<ReturnType<typeof s.addUrl>>
    const folder = s.addFolder({ title: 'F', parent: 'other' }) as NonNullable<ReturnType<typeof s.addFolder>>
    s.onChange(listener)

    expect(s.move([a.id], folder.id, 0)).toBe(true)
    expect(s.move([folder.id], folder.id)).toBe(false)
    expect(s.update(a.id, { title: 'Renamed', url: 'https://b.example/' })).toBe(true)
    expect(s.update(a.id, { url: 'javascript:1' })).toBe(false)
    expect(s.update('nope', { title: 'x' })).toBe(false)

    expect(listener).toHaveBeenCalledTimes(2)
    expect(s.node(a.id)).toMatchObject({ title: 'Renamed', url: 'https://b.example/', parent: folder.id })
  })

  it('imports a whole tree in one write and one change event', async () => {
    const s = store()
    const listener = vi.fn()
    s.onChange(listener)

    const added = s.importTree('other', [
      { kind: 'folder', title: 'Imported', children: [{ kind: 'url', title: 'A', url: 'https://a.example/' }, { kind: 'url', title: 'Bad', url: 'javascript:1' }] },
      { kind: 'url', title: 'B', url: 'https://b.example/' }
    ])
    await s.flushPendingWrite()

    expect(added).toBe(2)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(s.exportTree().other.map((entry) => entry.title)).toEqual(['Imported', 'B'])
    expect(s.importTree('bar', [{ kind: 'url', title: 'x', url: 'javascript:1' }])).toBe(0)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(s.importTree('nowhere', [{ kind: 'url', title: 'x', url: 'https://x.example/' }])).toBe(0)
  })

  it('fills a missing icon on every saved page of an address, silently, and persists it', async () => {
    const s = store()
    const folder = s.addFolder({ title: 'F', parent: 'bar' }) as NonNullable<ReturnType<typeof s.addFolder>>
    const one = s.addUrl({ url: 'https://a.example/', title: 'one' }) as NonNullable<ReturnType<typeof s.addUrl>>
    const two = s.addUrl({ url: 'https://a.example/', title: 'two', parent: folder.id }) as NonNullable<ReturnType<typeof s.addUrl>>
    await s.flushPendingWrite()
    const listener = vi.fn()
    s.onChange(listener)

    expect(s.fillMissingFavicon('https://a.example/', tiny)).toBe(true)
    expect(listener).not.toHaveBeenCalled()
    expect(s.node(one.id)?.favicon).toBe(tiny)
    expect(s.node(two.id)?.favicon).toBe(tiny)
    expect(s.fillMissingFavicon('https://a.example/', tiny)).toBe(false)
    await s.flushPendingWrite()
    expect(JSON.stringify(await onDisk())).toContain(tiny)
  })

  it('add() keeps its old behaviour for the bar: an address already at the top keeps its place and takes the new title', () => {
    const s = store()
    s.add({ url: 'https://a.example/', title: 'A' })
    s.add({ url: 'https://b.example/', title: 'B' })
    s.add({ url: 'https://a.example/', title: 'A renamed', favicon: tiny })

    expect(s.getAll()).toEqual([
      { url: 'https://a.example/', title: 'A renamed', favicon: tiny },
      { url: 'https://b.example/', title: 'B', favicon: null }
    ])
  })

  describe('the file', () => {
    it('writes format 2 with roots and ids on the first change', async () => {
      const s = store()
      s.addUrl({ url: 'https://a.example/', title: 'A' })
      await s.flushPendingWrite()

      expect(await onDisk()).toEqual({ version: 2, roots: { bar: [{ id: 'n0', kind: 'url', title: 'A', url: 'https://a.example/', added: 1000 }], other: [], reading: [] } })
    })

    it('migrates a legacy array without loss, rewrites it in format 2 on load, keeps the old file as .bak, and keeps the ids across a reload', async () => {
      const legacy = JSON.stringify([
        { url: 'https://a.example/', title: 'A', favicon: tiny },
        { url: 'https://b.example/', title: 'B', favicon: null },
        { url: 'https://c.example/', title: 'C', favicon: null }
      ])
      await writeFile(file, legacy)
      await utimes(file, new Date(5_000_000), new Date(5_000_000))
      const first = store()
      await first.load()
      await first.flushPendingWrite()

      const after = await onDisk() as { version: number, roots: { bar: Array<{ id: string, title: string, added: number }> } }
      expect(after.version).toBe(2)
      expect(after.roots.bar.map((node) => node.title)).toEqual(['A', 'B', 'C'])
      expect(after.roots.bar.map((node) => node.added)).toEqual([5_000_000, 5_000_000, 5_000_000])
      expect(await readFile(`${file}.bak`, 'utf8')).toBe(legacy)

      const second = new BookmarkStore(file, counter(), () => 1000)
      await second.load()
      expect(second.children('bar').map((node) => node.id)).toEqual(after.roots.bar.map((node) => node.id))
      expect(second.getAll()).toHaveLength(3)
    })

    it('leaves an unknown version untouched until the person changes something, then keeps it as .bak', async () => {
      const future = JSON.stringify({ version: 9, roots: { bar: [{ from: 'the future' }] } })
      await writeFile(file, future)
      const s = store()
      await s.load()
      await s.flushPendingWrite()

      expect(s.count()).toBe(0)
      expect(await readFile(file, 'utf8')).toBe(future)
      expect((await readdir(dir)).sort()).toEqual(['bookmarks.json'])

      s.addUrl({ url: 'https://a.example/', title: 'A' })
      await s.flushPendingWrite()
      expect(await readFile(`${file}.bak`, 'utf8')).toBe(future)
      expect(await onDisk()).toMatchObject({ version: 2 })
    })

    it('writes nothing at all for a profile that has no file and no bookmarks', async () => {
      const s = store()
      await s.load()
      await s.flushPendingWrite()

      expect(await readdir(dir)).toEqual([])
    })

    it('starts empty from a corrupt file and keeps the damaged text as .bak once it writes', async () => {
      await mkdir(dir, { recursive: true })
      await writeFile(file, '{"version":2,"roots":{"bar":[{"kind":"url"')
      const s = store()
      await s.load()
      s.addUrl({ url: 'https://a.example/', title: 'A' })
      await s.flushPendingWrite()

      expect(await readFile(`${file}.bak`, 'utf8')).toContain('"kind":"url"')
    })
  })
})
