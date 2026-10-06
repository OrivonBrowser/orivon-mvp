import { describe, expect, it } from 'vitest'
import { parseBookmarksFile, serializeBookmarksFile } from '../bookmark-file.js'
import { folderFromPath } from '../../../renderer/pages/bookmarks/router.js'
import { ID_PATTERN, childrenOf, flattenUrls } from '../bookmark-tree.js'
import type { IdSource } from '../bookmark-tree.js'

const counter = (): IdSource => { let n = 0; return () => `id${String(n++)}` }
const tiny = 'data:image/png;base64,iVBORw0KGgo='
const opts = (): { legacyAdded: number, newId: IdSource } => ({ legacyAdded: 1234, newId: counter() })

describe('the legacy array', () => {
  it('migrates in order to the bar, with fresh ids and the file date as the added time', () => {
    const raw = JSON.stringify([
      { url: 'https://a.example/', title: 'A', favicon: tiny },
      { url: 'https://b.example/', title: 'B', favicon: null },
      { url: 'https://c.example/', title: 'C' }
    ])
    const { tree, state } = parseBookmarksFile(raw, opts())

    expect(state).toBe('legacy')
    expect(childrenOf(tree, 'bar').map(({ id, title, url, favicon, added, parent }) => ({ id, title, url, favicon, added, parent }))).toEqual([
      { id: 'id0', title: 'A', url: 'https://a.example/', favicon: tiny, added: 1234, parent: 'bar' },
      { id: 'id1', title: 'B', url: 'https://b.example/', favicon: null, added: 1234, parent: 'bar' },
      { id: 'id2', title: 'C', url: 'https://c.example/', favicon: null, added: 1234, parent: 'bar' }
    ])
  })

  it('drops entries that are malformed or not openable, and a bad icon but not its bookmark', () => {
    const raw = JSON.stringify([
      { url: 'javascript:alert(1)', title: 'evil' },
      { url: 'https://b.example/' },
      { title: 'no url' },
      { url: 123, title: 'wrong type' },
      'text',
      null,
      { url: 'https://ok.example/', title: 'fine', favicon: 'data:text/html,<script>' }
    ])
    const { tree } = parseBookmarksFile(raw, opts())

    expect(flattenUrls(tree).map(({ title, favicon }) => ({ title, favicon }))).toEqual([{ title: 'fine', favicon: null }])
  })

  it('reads an empty array as a legacy file with nothing in it', () => {
    expect(parseBookmarksFile('[]', opts()).state).toBe('legacy')
  })
})

describe('format 2', () => {
  it('round-trips a tree, folders and ids included', () => {
    const raw = JSON.stringify({ version: 2, roots: {
      bar: [{ id: 'aaaaaaaaaaaa', kind: 'folder', title: 'Work', added: 7, children: [{ id: 'bbbbbbbbbbbb', kind: 'url', title: 'B', url: 'https://b.example/', favicon: tiny, added: 8 }] }, { id: 'cccccccccccc', kind: 'url', title: 'C', url: 'https://c.example/', added: 9 }],
      other: [],
      reading: [{ id: 'dddddddddddd', kind: 'url', title: 'D', url: 'https://d.example/', added: 10, read: true }]
    } })
    const parsed = parseBookmarksFile(raw, opts())

    expect(parsed.state).toBe('current')
    expect(JSON.parse(serializeBookmarksFile(parsed.tree))).toEqual(JSON.parse(raw))
    expect(parsed.tree.nodes.get('bbbbbbbbbbbb')).toMatchObject({ parent: 'aaaaaaaaaaaa', kind: 'url' })
  })

  it('gives a duplicate, missing or root-named id a new one and keeps the node', () => {
    const raw = JSON.stringify({ version: 2, roots: {
      bar: [
        { id: 'same', kind: 'url', title: 'one', url: 'https://one.example/', added: 1 },
        { id: 'same', kind: 'url', title: 'two', url: 'https://two.example/', added: 1 },
        { kind: 'url', title: 'three', url: 'https://three.example/', added: 1 },
        { id: 'other', kind: 'url', title: 'four', url: 'https://four.example/', added: 1 }
      ], other: [], reading: []
    } })
    const ids = childrenOf(parseBookmarksFile(raw, opts()).tree, 'bar').map((node) => node.id)

    expect(ids).toHaveLength(4)
    expect(new Set(ids).size).toBe(4)
    expect(ids[0]).toBe('same')
    expect(ids).not.toContain('other')
  })

  it('gives an id the manager page could not name a new one, so every row can be opened, edited and moved', () => {
    const raw = JSON.stringify({ version: 2, roots: {
      bar: [
        { id: 'a/b', kind: 'url', title: 'slash', url: 'https://one.example/', added: 1 },
        { id: 'x'.repeat(40), kind: 'url', title: 'long', url: 'https://two.example/', added: 1 },
        { id: 'sp ace', kind: 'folder', title: 'space', added: 1, children: [] },
        { id: 'fine_id-1', kind: 'url', title: 'fine', url: 'https://three.example/', added: 1 }
      ], other: [], reading: []
    } })
    const ids = childrenOf(parseBookmarksFile(raw, opts()).tree, 'bar').map((node) => node.id)
    expect(ids[3]).toBe('fine_id-1')
    for (const id of ids) expect(ID_PATTERN.test(id)).toBe(true)
    expect(new Set(ids).size).toBe(4)
  })

  it('keeps the same pattern as the page that names a folder in its address', () => {
    for (const id of ['bar', 'n0', 'a1_-B', 'x'.repeat(32), 'x'.repeat(33), 'a/b', '', 'a b', 'é']) {
      expect(folderFromPath(`/folder/${id}`) !== null).toBe(ID_PATTERN.test(id))
    }
  })

  it('drops malformed nodes and addresses that must never open, and keeps the rest', () => {
    const raw = JSON.stringify({ version: 2, roots: {
      bar: [
        { id: 'a', kind: 'url', title: 'js', url: 'javascript:alert(1)', added: 1 },
        { id: 'b', kind: 'url', title: 'data', url: 'data:text/html,hi', added: 1 },
        { id: 'c', kind: 'url', title: 'file', url: 'file://nas/share/passwd', added: 1 },
        { id: 'd', kind: 'mystery', title: 'x' },
        { id: 'e', kind: 'url', url: 'https://notitle.example/' },
        { id: 'f', kind: 'folder', title: 'F', added: 'soon', children: [{ id: 'g', kind: 'url', title: 'in', url: 'https://in.example/', added: 2 }, 5] },
        7
      ], other: 'nope', reading: []
    } })
    const { tree } = parseBookmarksFile(raw, opts())

    expect(flattenUrls(tree).map((node) => node.title)).toEqual(['in'])
    expect(tree.nodes.get('f')?.added).toBe(0)
  })

  it('keeps the reading list flat', () => {
    const raw = JSON.stringify({ version: 2, roots: { bar: [], other: [], reading: [{ id: 'f', kind: 'folder', title: 'F', added: 1, children: [] }, { id: 'p', kind: 'url', title: 'P', url: 'https://p.example/', added: 1 }] } })

    expect(childrenOf(parseBookmarksFile(raw, opts()).tree, 'reading').map((node) => node.title)).toEqual(['P'])
  })

  it('drops a level past the depth limit', () => {
    let node: Record<string, unknown> = { id: 'leaf', kind: 'url', title: 'leaf', url: 'https://leaf.example/', added: 1 }
    for (let level = 0; level < 14; level += 1) node = { id: `f${String(level)}`, kind: 'folder', title: `f${String(level)}`, added: 1, children: [node] }
    const { tree } = parseBookmarksFile(JSON.stringify({ version: 2, roots: { bar: [node], other: [], reading: [] } }), opts())

    expect(tree.nodes.has('leaf')).toBe(false)
    expect(tree.nodes.has('f13')).toBe(true)
    expect(tree.nodes.has('f0')).toBe(false)
  })
})

describe('what cannot be read', () => {
  it.each([
    ['not JSON', '{not json'],
    ['an object with no version', '{"roots":{}}'],
    ['a version this build does not know', '{"version":3,"roots":{"bar":[]}}'],
    ['a version with no roots', '{"version":2}'],
    ['a bare string', '"hello"']
  ])('%s loads empty and is marked unreadable, so the file is kept before it is replaced', (_label, raw) => {
    const { tree, state } = parseBookmarksFile(raw, opts())

    expect(state).toBe('unreadable')
    expect(flattenUrls(tree)).toEqual([])
  })
})
