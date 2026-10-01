import { describe, expect, it } from 'vitest'
import { diffSnapshots, snapshotNode, takeSnapshot } from '../bookmarks-diff.js'
import type { BookmarkChange } from '../bookmarks-diff.js'
import type { NodeLike } from '../bookmarks-shape.js'

type Tree = Record<string, NodeLike[]>

const page = (id: string, parent: string, title = id, url = `https://${id}.test/`): NodeLike => ({ id, parent, kind: 'url', title, url, added: 1 })
const folder = (id: string, parent: string, title = id): NodeLike => ({ id, parent, kind: 'folder', title, added: 1 })
const snap = (tree: Tree) => takeSnapshot((parent) => tree[parent] ?? [])
const types = (changes: BookmarkChange[]): string[] => changes.map((change) => `${change.type}:${change.id}`)

describe('takeSnapshot', () => {
  it('walks both roots, every folder and each node\'s index', () => {
    const s = snap({ bar: [page('a', 'bar'), folder('f', 'bar')], f: [page('b', 'f')], other: [] })
    expect([...s.nodes.keys()]).toEqual(['a', 'f', 'b'])
    expect(s.nodes.get('f')?.index).toBe(1)
    expect(s.kids.get('f')).toEqual(['b'])
  })

  it('never visits the reading list', () => {
    const s = snap({ bar: [], other: [], reading: [page('r', 'reading')] })
    expect(s.nodes.size).toBe(0)
  })
})

describe('diffSnapshots', () => {
  const base: Tree = { bar: [page('a', 'bar'), page('b', 'bar'), page('c', 'bar')], other: [] }

  it('reports nothing when nothing changed', () => {
    expect(diffSnapshots(snap(base), snap(base))).toEqual([])
  })

  it('reports a new page as created, with the Chrome ids of its place', () => {
    const next = { ...base, other: [page('n', 'other')] }
    expect(diffSnapshots(snap(base), snap(next))).toEqual([{ type: 'created', id: 'n', node: { id: 'n', parentId: '2', index: 0, url: 'https://n.test/', title: 'n', dateAdded: 1 } }])
  })

  it('reports a removed page once, with where it was, and says nothing of the siblings that shifted', () => {
    const next = { ...base, bar: [page('a', 'bar'), page('c', 'bar')] }
    const changes = diffSnapshots(snap(base), snap(next))
    expect(types(changes)).toEqual(['removed:b'])
    expect(changes[0]).toMatchObject({ info: { parentId: '1', index: 1, node: { id: 'b', title: 'b' } } })
  })

  it('reports a removed folder once, its pages inside the removed node', () => {
    const before = { bar: [folder('f', 'bar')], f: [page('x', 'f'), folder('g', 'f')], g: [page('y', 'g')], other: [] }
    const changes = diffSnapshots(snap(before), snap({ bar: [], other: [] }))
    expect(types(changes)).toEqual(['removed:f'])
    const node = (changes[0] as Extract<BookmarkChange, { type: 'removed' }>).info.node
    expect(node.children?.map((child) => child.id)).toEqual(['x', 'g'])
    expect(node.children?.[1]?.children?.map((child) => child.id)).toEqual(['y'])
  })

  it('reports a new title, or a new address, as changed', () => {
    const next = { ...base, bar: [page('a', 'bar', 'A2'), page('b', 'bar', 'b', 'https://moved.test/'), page('c', 'bar')] }
    expect(diffSnapshots(snap(base), snap(next))).toEqual([
      { type: 'changed', id: 'a', info: { title: 'A2', url: 'https://a.test/' } },
      { type: 'changed', id: 'b', info: { title: 'b', url: 'https://moved.test/' } }
    ])
  })

  it('reports a retitled folder without an address', () => {
    const before = { bar: [folder('f', 'bar', 'Old')], other: [] }
    expect(diffSnapshots(snap(before), snap({ bar: [folder('f', 'bar', 'New')], other: [] }))).toEqual([{ type: 'changed', id: 'f', info: { title: 'New' } }])
  })

  it('reports a page taken to another folder as moved', () => {
    const next = { bar: [page('a', 'bar'), page('c', 'bar')], other: [page('b', 'other')] }
    expect(diffSnapshots(snap(base), snap(next))).toEqual([{ type: 'moved', id: 'b', info: { parentId: '2', index: 0, oldParentId: '1', oldIndex: 1 } }])
  })

  it('reports only the page that moved when it passes its siblings in one folder', () => {
    const next = { ...base, bar: [page('b', 'bar'), page('c', 'bar'), page('a', 'bar')] }
    expect(diffSnapshots(snap(base), snap(next))).toEqual([{ type: 'moved', id: 'a', info: { parentId: '1', index: 2, oldParentId: '1', oldIndex: 0 } }])
  })

  it('reports the page that went to the front, not the ones it pushed along', () => {
    const next = { ...base, bar: [page('c', 'bar'), page('a', 'bar'), page('b', 'bar')] }
    expect(types(diffSnapshots(snap(base), snap(next)))).toEqual(['moved:c'])
  })

  it('does not call a sibling moved because a page was added before it', () => {
    const next = { ...base, bar: [page('n', 'bar'), page('a', 'bar'), page('b', 'bar'), page('c', 'bar')] }
    expect(types(diffSnapshots(snap(base), snap(next)))).toEqual(['created:n'])
  })

  it('names the four kinds of change in one pass', () => {
    const next = { bar: [page('a', 'bar', 'A2'), page('n', 'bar')], other: [page('c', 'other')] }
    expect(types(diffSnapshots(snap(base), snap(next)))).toEqual(['removed:b', 'created:n', 'changed:a', 'moved:c'])
  })
})

describe('snapshotNode', () => {
  it('answers undefined for an id the snapshot does not hold', () => {
    expect(snapshotNode(snap({ bar: [], other: [] }), 'x', true)).toBeUndefined()
  })
})

describe('cost', () => {
  it('compares 20,000 nodes in under 20 ms', () => {
    const tree: Tree = { bar: [], other: [] }
    for (let folderAt = 0; folderAt < 100; folderAt++) {
      const id = `f${String(folderAt)}`
      tree.bar?.push(folder(id, 'bar'))
      tree[id] = Array.from({ length: 199 }, (_, at) => page(`${id}p${String(at)}`, id))
    }
    const before = snap(tree)
    const changed: Tree = { ...tree, f0: [page('new', 'f0'), ...(tree.f0 ?? []).slice(1)] }
    const after = snap(changed)
    diffSnapshots(before, after)
    const start = performance.now()
    const changes = diffSnapshots(before, after)
    const took = performance.now() - start
    expect(changes.map((change) => change.type)).toEqual(['removed', 'created'])
    expect(took).toBeLessThan(20)
  })
})
