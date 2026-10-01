import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BookmarkStore } from '../../../browsing/bookmarks.js'
import { bookmarksApi, installBookmarks } from '../bookmarks-api.js'
import { createWriteQuota } from '../bookmarks-quota.js'
import { fakeContext, settled } from './api-fixtures.js'

let dir = ''
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'orivon-bm-api-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

async function setup (quota = createWriteQuota()) {
  let next = 0
  const store = new BookmarkStore(join(dir, 'bookmarks.json'), () => `n${String(++next)}`, () => 1000 + next)
  await store.load()
  const fake = fakeContext({ bookmarks: store })
  installBookmarks(fake.ctx, quota)
  await settled()
  return { store, ...fake }
}

const rejects = async (promise: Promise<unknown>, message: string): Promise<void> => {
  await expect(promise).rejects.toThrow(message)
}

describe('registration', () => {
  it('is the bookmarks module, gated on the bookmarks permission', () => {
    expect(bookmarksApi.name).toBe('bookmarks')
    expect(bookmarksApi.permission).toBe('bookmarks')
  })

  it('registers the eleven calls', async () => {
    const { handlers } = await setup()
    expect([...handlers.keys()].sort()).toEqual([
      'bookmarks.create', 'bookmarks.get', 'bookmarks.getChildren', 'bookmarks.getRecent', 'bookmarks.getSubTree',
      'bookmarks.getTree', 'bookmarks.move', 'bookmarks.remove', 'bookmarks.removeTree', 'bookmarks.search', 'bookmarks.update'
    ])
  })
})

describe('reads', () => {
  it('shapes the tree as Chrome does: a nameless root over the bar ("1") and other bookmarks ("2")', async () => {
    const { call } = await setup()
    const [root] = await call('bookmarks.getTree') as Array<{ id: string, title: string, children: Array<{ id: string, title: string, parentId: string, index: number }> }>
    expect(root).toMatchObject({ id: '0', title: '' })
    expect(root?.children.map(({ id, title, parentId, index }) => ({ id, title, parentId, index }))).toEqual([
      { id: '1', title: 'Bookmarks bar', parentId: '0', index: 0 },
      { id: '2', title: 'Other bookmarks', parentId: '0', index: 1 }
    ])
  })

  it('never shows the reading list', async () => {
    const { store, call } = await setup()
    store.addUrl({ url: 'https://read.test/', title: 'Later', parent: 'reading' })
    const [root] = await call('bookmarks.getTree') as Array<{ children: unknown[] }>
    expect(root?.children).toHaveLength(2)
    expect(JSON.stringify(await call('bookmarks.search', 'Later'))).toBe('[]')
    await rejects(call('bookmarks.get', 'reading'), "Can't find bookmark for id.")
    await rejects(call('bookmarks.getChildren', 'reading'), "Can't find bookmark for id.")
  })

  it('answers get with a list for one id or many, and rejects an unknown id', async () => {
    const { store, call } = await setup()
    const a = store.addUrl({ url: 'https://a.test/', title: 'A', parent: 'bar' })
    expect(await call('bookmarks.get', a?.id)).toMatchObject([{ id: a?.id, title: 'A', parentId: '1', index: 0, url: 'https://a.test/' }])
    expect(await call('bookmarks.get', ['1', '0'])).toMatchObject([{ id: '1' }, { id: '0' }])
    await rejects(call('bookmarks.get', 'nope'), "Can't find bookmark for id.")
    await rejects(call('bookmarks.get', 7), 'Invalid argument')
    await rejects(call('bookmarks.get', []), 'Invalid argument')
  })

  it('lists children with their indexes, the roots under "0", and nothing under a page', async () => {
    const { store, call } = await setup()
    const f = store.addFolder({ title: 'F', parent: 'other' })
    store.addUrl({ url: 'https://a.test/', title: 'A', parent: f?.id ?? '' })
    store.addUrl({ url: 'https://b.test/', title: 'B', parent: f?.id ?? '' })
    expect(await call('bookmarks.getChildren', f?.id)).toMatchObject([{ title: 'A', index: 0, parentId: f?.id }, { title: 'B', index: 1 }])
    expect(await call('bookmarks.getChildren', '0')).toMatchObject([{ id: '1' }, { id: '2' }])
    const page = store.children(f?.id ?? '')[0]
    expect(await call('bookmarks.getChildren', page?.id)).toEqual([])
  })

  it('gives a subtree with its children, and getRecent newest first, pages only, clamped', async () => {
    const { store, call } = await setup()
    const f = store.addFolder({ title: 'F', parent: 'bar' })
    store.addUrl({ url: 'https://a.test/', title: 'A', parent: f?.id ?? '' })
    store.addUrl({ url: 'https://b.test/', title: 'B', parent: 'other' })
    const [sub] = await call('bookmarks.getSubTree', f?.id) as Array<{ children: Array<{ title: string }> }>
    expect(sub?.children.map((child) => child.title)).toEqual(['A'])
    expect((await call('bookmarks.getRecent', 1) as Array<{ title: string }>).map((node) => node.title)).toEqual(['B'])
    expect((await call('bookmarks.getRecent', 500) as unknown[])).toHaveLength(2)
    expect((await call('bookmarks.getRecent', 0) as unknown[])).toHaveLength(1)
    await rejects(call('bookmarks.getRecent', 'x'), 'Invalid argument')
  })

  it('searches a string by every word, folders by title too, and an object by exact url and title', async () => {
    const { store, call } = await setup()
    store.addUrl({ url: 'https://docs.test/guide', title: 'Orivon guide', parent: 'bar' })
    store.addUrl({ url: 'https://other.test/', title: 'Orivon blog', parent: 'bar' })
    store.addFolder({ title: 'Orivon notes', parent: 'other' })
    const titles = async (query: unknown): Promise<string[]> => (await call('bookmarks.search', query) as Array<{ title: string }>).map((node) => node.title)
    expect(await titles('orivon')).toEqual(['Orivon guide', 'Orivon blog', 'Orivon notes'])
    expect(await titles('orivon guide')).toEqual(['Orivon guide'])
    expect(await titles({ query: 'orivon', title: 'Orivon blog' })).toEqual(['Orivon blog'])
    expect(await titles({ url: 'https://docs.test/guide' })).toEqual(['Orivon guide'])
    expect(await titles({ url: 'https://docs.test/' })).toEqual([])
    await rejects(call('bookmarks.search', 5), 'Invalid argument')
  })
})

describe('create', () => {
  it('files a page in Other bookmarks by default and answers its node', async () => {
    const { store, call } = await setup()
    const node = await call('bookmarks.create', { title: 'T', url: 'https://example.test/' })
    expect(node).toMatchObject({ title: 'T', url: 'https://example.test/', parentId: '2', index: 0 })
    expect(store.children('other').map((child) => child.title)).toEqual(['T'])
  })

  it('creates a folder when there is no url, in the named parent at the named index', async () => {
    const { store, call } = await setup()
    store.addUrl({ url: 'https://a.test/', title: 'A', parent: 'bar' })
    const node = await call('bookmarks.create', { parentId: '1', index: 0, title: 'Folder' }) as { id: string, url?: string }
    expect(node.url).toBeUndefined()
    expect(store.children('bar').map((child) => child.title)).toEqual(['Folder', 'A'])
  })

  it('refuses the nameless root, an unknown parent, a page as parent and a bad index', async () => {
    const { store, call } = await setup()
    const page = store.addUrl({ url: 'https://a.test/', title: 'A', parent: 'bar' })
    await rejects(call('bookmarks.create', { parentId: '0', title: 'x' }), "Can't modify the root bookmark folders.")
    await rejects(call('bookmarks.create', { parentId: 'zzz', title: 'x' }), "Can't find parent bookmark for id.")
    await rejects(call('bookmarks.create', { parentId: page?.id, title: 'x' }), 'Parent node is not a folder.')
    await rejects(call('bookmarks.create', { parentId: '1', index: 9, title: 'x' }), 'Index out of bounds.')
    await rejects(call('bookmarks.create', { parentId: '1', index: -1, title: 'x' }), 'Index out of bounds.')
  })

  it('refuses an address a bookmark cannot hold, a bookmarklet above all', async () => {
    const { store, call } = await setup()
    for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'not a url', '']) {
      await rejects(call('bookmarks.create', { title: 'x', url }), 'Invalid URL.')
    }
    expect(store.count()).toBe(0)
  })

  it('refuses a call whose argument is not an object', async () => {
    const { call } = await setup()
    await rejects(call('bookmarks.create', 'x'), 'Invalid argument')
    await rejects(call('bookmarks.create', { title: 5 }), 'Invalid argument')
  })
})

describe('update, move and remove', () => {
  it('renames and re-addresses a page and answers the node', async () => {
    const { store, call } = await setup()
    const a = store.addUrl({ url: 'https://a.test/', title: 'A', parent: 'bar' })
    expect(await call('bookmarks.update', a?.id, { title: 'B', url: 'https://b.test/' })).toMatchObject({ title: 'B', url: 'https://b.test/' })
    await rejects(call('bookmarks.update', a?.id, { url: 'javascript:1' }), 'Invalid URL.')
    await rejects(call('bookmarks.update', 'nope', { title: 'x' }), "Can't find bookmark for id.")
  })

  it('refuses an address on a folder', async () => {
    const { store, call } = await setup()
    const f = store.addFolder({ title: 'F', parent: 'bar' })
    await rejects(call('bookmarks.update', f?.id, { url: 'https://a.test/' }), "Can't set a URL on a folder.")
  })

  it('moves a page to another folder and index', async () => {
    const { store, call } = await setup()
    const a = store.addUrl({ url: 'https://a.test/', title: 'A', parent: 'bar' })
    store.addUrl({ url: 'https://b.test/', title: 'B', parent: 'other' })
    expect(await call('bookmarks.move', a?.id, { parentId: '2', index: 0 })).toMatchObject({ parentId: '2', index: 0 })
    expect(store.children('other').map((child) => child.title)).toEqual(['A', 'B'])
    expect(await call('bookmarks.move', a?.id, { index: 2 })).toMatchObject({ parentId: '2', index: 1 })
  })

  it('refuses to move a folder into itself, or anything into the roots\' parent', async () => {
    const { store, call } = await setup()
    const f = store.addFolder({ title: 'F', parent: 'bar' })
    const g = store.addFolder({ title: 'G', parent: f?.id ?? '' })
    await rejects(call('bookmarks.move', f?.id, { parentId: g?.id }), 'descendants')
    await rejects(call('bookmarks.move', f?.id, { parentId: '0' }), "Can't modify the root bookmark folders.")
  })

  it('protects the three roots from every write', async () => {
    const { call } = await setup()
    for (const id of ['0', '1', '2']) {
      await rejects(call('bookmarks.update', id, { title: 'x' }), "Can't modify the root bookmark folders.")
      await rejects(call('bookmarks.move', id, { parentId: '2' }), "Can't modify the root bookmark folders.")
      await rejects(call('bookmarks.remove', id), "Can't modify the root bookmark folders.")
      await rejects(call('bookmarks.removeTree', id), "Can't modify the root bookmark folders.")
    }
  })

  it('removes a page, refuses a non-empty folder, and removeTree takes it whole', async () => {
    const { store, call } = await setup()
    const a = store.addUrl({ url: 'https://a.test/', title: 'A', parent: 'bar' })
    const f = store.addFolder({ title: 'F', parent: 'bar' })
    store.addUrl({ url: 'https://b.test/', title: 'B', parent: f?.id ?? '' })
    expect(await call('bookmarks.remove', a?.id)).toBeUndefined()
    await rejects(call('bookmarks.remove', f?.id), "Can't remove non-empty folder (use recursive to force).")
    expect(await call('bookmarks.removeTree', f?.id)).toBeUndefined()
    expect(store.count()).toBe(0)
  })

  it('removes an empty folder with remove', async () => {
    const { store, call } = await setup()
    const f = store.addFolder({ title: 'F', parent: 'bar' })
    await call('bookmarks.remove', f?.id)
    expect(store.count()).toBe(0)
  })
})

describe('the write quota', () => {
  it('refuses writes past Chrome\'s per-minute limit with its text, and reads stay free', async () => {
    const { call } = await setup()
    for (let write = 0; write < 100; write++) await call('bookmarks.create', { title: String(write), url: `https://e${String(write)}.test/` })
    await rejects(call('bookmarks.create', { title: 'x', url: 'https://x.test/' }), 'MAX_SUSTAINED_WRITE_OPERATIONS_PER_MINUTE')
    expect(await call('bookmarks.getTree')).toBeDefined()
  })
})

describe('events from the store\'s changes', () => {
  it('sends onCreated for a page created by anyone, with the Chrome node', async () => {
    const { store, events } = await setup()
    store.addUrl({ url: 'https://a.test/', title: 'A', parent: 'bar' })
    await settled()
    expect(events).toEqual([{ name: 'bookmarks.onCreated', args: [expect.any(String), expect.objectContaining({ title: 'A', parentId: '1', index: 0 })] }])
  })

  it('sends onChanged, onMoved and onRemoved', async () => {
    const { store, events } = await setup()
    const a = store.addUrl({ url: 'https://a.test/', title: 'A', parent: 'bar' })
    await settled()
    events.length = 0
    store.update(a?.id ?? '', { title: 'A2' })
    await settled()
    store.move([a?.id ?? ''], 'other', 0)
    await settled()
    store.remove([a?.id ?? ''])
    await settled()
    expect(events.map((event) => event.name)).toEqual(['bookmarks.onChanged', 'bookmarks.onMoved', 'bookmarks.onRemoved'])
    expect(events[0]?.args[1]).toEqual({ title: 'A2', url: 'https://a.test/' })
    expect(events[1]?.args[1]).toEqual({ parentId: '2', index: 0, oldParentId: '1', oldIndex: 0 })
    expect(events[2]?.args[1]).toMatchObject({ parentId: '2', index: 0, node: { title: 'A2' } })
  })

  it('folds several writes of one turn into one comparison', async () => {
    const { store, events } = await setup()
    store.addUrl({ url: 'https://a.test/', title: 'A', parent: 'bar' })
    store.addUrl({ url: 'https://b.test/', title: 'B', parent: 'bar' })
    await settled()
    expect(events.map((event) => event.name)).toEqual(['bookmarks.onCreated', 'bookmarks.onCreated'])
  })

  it('sends an event for an extension\'s own write too, as for any other', async () => {
    const { events, call } = await setup()
    await call('bookmarks.create', { title: 'T', url: 'https://example.test/' })
    await settled()
    expect(events.map((event) => event.name)).toEqual(['bookmarks.onCreated'])
  })

  it('reports nothing for what the file already held when the shell attached', async () => {
    let next = 0
    const first = new BookmarkStore(join(dir, 'old.json'), () => `o${String(++next)}`)
    await first.load()
    first.addUrl({ url: 'https://old.test/', title: 'Old', parent: 'bar' })
    await first.flushPendingWrite()
    const second = new BookmarkStore(join(dir, 'old.json'))
    const fake = fakeContext({ bookmarks: second })
    installBookmarks(fake.ctx)
    await settled()
    second.addUrl({ url: 'https://new.test/', title: 'New', parent: 'bar' })
    await settled()
    expect(fake.events.map((event) => event.name)).toEqual(['bookmarks.onCreated'])
  })
})
