import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { IdSource } from '../bookmark-tree.js'
import { BookmarkStore } from '../bookmarks.js'
import { restore, snapshot, topLevel } from '../bookmarks-undo.js'

const counter = (): IdSource => { let n = 0; return () => `n${String(n++)}` }

describe('undoing a delete', () => {
  let dir: string
  let store: BookmarkStore

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orivon-bookmarks-undo-'))
    store = new BookmarkStore(join(dir, 'bookmarks.json'), counter(), () => 1000)
  })
  afterEach(async () => {
    await store.flushPendingWrite()
    await rm(dir, { recursive: true, force: true })
  })

  const page = (title: string, parent = 'bar') => store.addUrl({ url: `https://${title}.example/`, title, parent }) as NonNullable<ReturnType<typeof store.addUrl>>
  const folder = (title: string, parent = 'bar') => store.addFolder({ title, parent }) as NonNullable<ReturnType<typeof store.addFolder>>

  it('keeps only the rows that are not inside another chosen row', () => {
    const work = folder('work')
    const inside = page('inside', work.id)
    const free = page('free')

    expect(topLevel(store, [inside.id, work.id, free.id])).toEqual([work.id, free.id])
    expect(topLevel(store, [inside.id])).toEqual([inside.id])
  })

  it('records where each row was and how many nodes are in all', () => {
    page('a')
    const work = folder('work')
    page('in1', work.id)
    folder('in2', work.id)

    const kept = snapshot(store, [work.id])

    expect(kept.nodes).toBe(3)
    expect(kept.items).toHaveLength(1)
    expect(kept.items[0]).toMatchObject({ parent: 'bar', index: 1 })
  })

  it('puts rows back in their old order even when several came from one folder', () => {
    const a = page('a')
    const b = page('b')
    const c = page('c')
    const d = page('d')
    const kept = snapshot(store, [b.id, d.id])
    store.remove([b.id, d.id])

    const back = restore(store, kept.items)

    expect(store.children('bar').map((node) => node.title)).toEqual(['a', 'b', 'c', 'd'])
    expect(back).toEqual([store.children('bar')[1]?.id, store.children('bar')[3]?.id])
    expect([a.id, c.id].every((id) => store.node(id) !== undefined)).toBe(true)
  })

  it('files a row in Other bookmarks when its folder is gone', () => {
    const work = folder('work')
    const inside = page('inside', work.id)
    const kept = snapshot(store, [inside.id])
    store.remove([work.id])

    restore(store, kept.items)

    expect(store.children('other').map((node) => node.title)).toEqual(['inside'])
  })
})
