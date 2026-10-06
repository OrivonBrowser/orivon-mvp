import { describe, expect, it } from 'vitest'
import { importNodes, exportNodes } from '../bookmark-import.js'
import {
  addNode, childrenOf, depthOf, emptyTree, fillFavicon, flattenUrls, folderList, MAX_DEPTH, MAX_NODES, MAX_TITLE,
  moveNodes, nodeCount, pathTo, removeNodes, searchUrls, updateNode
} from '../bookmark-tree.js'
import type { BookmarkTree, IdSource } from '../bookmark-tree.js'

const counter = (): IdSource => { let n = 0; return () => `n${String(n++)}` }

interface Built { tree: BookmarkTree, ids: Record<string, string> }

/** A tree from a compact spec: `name: [parent, 'url' | 'folder']`, added in order. */
function build (spec: Array<[name: string, parent: string, kind: 'url' | 'folder']>): Built {
  const newId = counter()
  let tree = emptyTree()
  const ids: Record<string, string> = { bar: 'bar', other: 'other', reading: 'reading' }
  for (const [name, parent, kind] of spec) {
    const added = addNode(tree, kind === 'url' ? { kind, title: name, url: `https://${name}.example/`, added: 1 } : { kind, title: name, added: 1 }, ids[parent] as string, undefined, newId)
    if (added === null) throw new Error(`could not add ${name}`)
    tree = added.tree
    ids[name] = added.node.id
  }
  return { tree, ids }
}

const titles = (tree: BookmarkTree, parent: string): string[] => childrenOf(tree, parent).map((node) => node.title)

describe('addNode', () => {
  it('files a node under its parent at the end, or at a clamped index', () => {
    const { tree, ids } = build([['a', 'bar', 'url'], ['b', 'bar', 'url']])
    const first = addNode(tree, { kind: 'url', title: 'c', url: 'https://c.example/', added: 2 }, 'bar', 0, counter())
    const past = addNode(first?.tree ?? tree, { kind: 'url', title: 'd', url: 'https://d.example/', added: 2 }, 'bar', 99, () => 'fresh')

    expect(titles(first?.tree ?? tree, 'bar')).toEqual(['c', 'a', 'b'])
    expect(titles(past?.tree ?? tree, 'bar')).toEqual(['c', 'a', 'b', 'd'])
    expect(ids['a']).toBeDefined()
  })

  it('never hands out a root name or an id already in use', () => {
    const { tree } = build([['a', 'bar', 'url']])
    const seq = ['bar', 'n0', 'free']
    const added = addNode(tree, { kind: 'url', title: 'x', url: 'https://x.example/', added: 1 }, 'bar', undefined, () => seq.shift() as string)

    expect(added?.node.id).toBe('free')
  })

  it('refuses a parent that is not a folder, and a folder in the reading list', () => {
    const { tree, ids } = build([['a', 'bar', 'url']])

    expect(addNode(tree, { kind: 'url', title: 'x', url: 'https://x.example/', added: 1 }, ids['a'] as string, undefined, counter())).toBeNull()
    expect(addNode(tree, { kind: 'url', title: 'x', url: 'https://x.example/', added: 1 }, 'missing', undefined, counter())).toBeNull()
    expect(addNode(tree, { kind: 'folder', title: 'f', added: 1 }, 'reading', undefined, counter())).toBeNull()
    expect(addNode(tree, { kind: 'url', title: 'page', url: 'https://p.example/', added: 1 }, 'reading', undefined, counter())).not.toBeNull()
  })

  it('cuts a title at the limit', () => {
    const added = addNode(emptyTree(), { kind: 'folder', title: 'x'.repeat(MAX_TITLE + 40), added: 1 }, 'bar', undefined, counter())

    expect(added?.node.title).toHaveLength(MAX_TITLE)
  })

  it('refuses a level past the depth limit', () => {
    let tree = emptyTree()
    let parent = 'bar'
    const newId = counter()
    for (let level = 1; level <= MAX_DEPTH; level += 1) {
      const added = addNode(tree, { kind: 'folder', title: `f${String(level)}`, added: 1 }, parent, undefined, newId)
      expect(added).not.toBeNull()
      tree = added?.tree ?? tree
      parent = added?.node.id ?? parent
    }

    expect(depthOf(tree, parent)).toBe(MAX_DEPTH)
    expect(addNode(tree, { kind: 'url', title: 'deep', url: 'https://d.example/', added: 1 }, parent, undefined, newId)).toBeNull()
  })

  it('refuses a node past the node limit', () => {
    const base = emptyTree()
    const filled: BookmarkTree = {
      nodes: new Map([...base.nodes, ...Array.from({ length: MAX_NODES }, (_, i): [string, never] => [`x${String(i)}`, { id: `x${String(i)}`, parent: 'bar', kind: 'url', title: '', added: 0 } as never])]),
      kids: base.kids
    }

    expect(nodeCount(filled)).toBe(MAX_NODES)
    expect(addNode(filled, { kind: 'url', title: 'one more', url: 'https://m.example/', added: 1 }, 'bar', undefined, counter())).toBeNull()
  })
})

describe('moveNodes', () => {
  it('reorders within a folder, the index being a position in the list as it stands', () => {
    const { tree, ids } = build([['a', 'bar', 'url'], ['b', 'bar', 'url'], ['c', 'bar', 'url'], ['d', 'bar', 'url']])

    // "Before d": a goes after c although it sat before it.
    expect(titles(moveNodes(tree, [ids['a'] as string], 'bar', 3) as BookmarkTree, 'bar')).toEqual(['b', 'c', 'a', 'd'])
    // "Before a": d goes first.
    expect(titles(moveNodes(tree, [ids['d'] as string], 'bar', 0) as BookmarkTree, 'bar')).toEqual(['d', 'a', 'b', 'c'])
    // Next to where it is: nothing changes.
    expect(titles(moveNodes(tree, [ids['b'] as string], 'bar', 2) as BookmarkTree, 'bar')).toEqual(['a', 'b', 'c', 'd'])
  })

  it('moves across folders and sets the new parent', () => {
    const { tree, ids } = build([['f', 'bar', 'folder'], ['a', 'bar', 'url'], ['b', 'f', 'url']])
    const moved = moveNodes(tree, [ids['a'] as string], ids['f'] as string, 0) as BookmarkTree

    expect(titles(moved, 'bar')).toEqual(['f'])
    expect(titles(moved, ids['f'] as string)).toEqual(['a', 'b'])
    expect(moved.nodes.get(ids['a'] as string)?.parent).toBe(ids['f'])
  })

  it('moves several in the order given, and a node whose folder moves too goes along with it', () => {
    const { tree, ids } = build([['f', 'bar', 'folder'], ['in', 'f', 'url'], ['a', 'bar', 'url'], ['b', 'bar', 'url']])
    const moved = moveNodes(tree, [ids['b'] as string, ids['a'] as string, ids['in'] as string, ids['f'] as string], 'other') as BookmarkTree

    expect(titles(moved, 'other')).toEqual(['b', 'a', 'f'])
    expect(titles(moved, ids['f'] as string)).toEqual(['in'])
  })

  it('refuses a folder into itself or a descendant, a root, an unknown id and a dead parent', () => {
    const { tree, ids } = build([['f', 'bar', 'folder'], ['g', 'f', 'folder'], ['a', 'g', 'url']])

    expect(moveNodes(tree, [ids['f'] as string], ids['f'] as string)).toBeNull()
    expect(moveNodes(tree, [ids['f'] as string], ids['g'] as string)).toBeNull()
    expect(moveNodes(tree, [ids['f'] as string], ids['a'] as string)).toBeNull()
    expect(moveNodes(tree, ['bar'], 'other')).toBeNull()
    expect(moveNodes(tree, ['nope'], 'other')).toBeNull()
    expect(moveNodes(tree, [ids['a'] as string], 'nope')).toBeNull()
    expect(moveNodes(tree, [], 'other')).toBeNull()
  })

  it('refuses a move that would pass the depth limit', () => {
    const { tree, ids } = build([['deep', 'bar', 'folder'], ['leaf', 'deep', 'url']])
    let chain = tree
    let parent = 'other'
    const newId = counter()
    for (let level = 1; level < MAX_DEPTH; level += 1) {
      const added = addNode(chain, { kind: 'folder', title: 'f', added: 1 }, parent, undefined, newId) as NonNullable<ReturnType<typeof addNode>>
      chain = added.tree
      parent = added.node.id
    }

    expect(moveNodes(chain, [ids['deep'] as string], parent)).toBeNull()
    expect(moveNodes(chain, [ids['leaf'] as string], parent)).not.toBeNull()
  })

  it('keeps folders out of the reading list', () => {
    const { tree, ids } = build([['f', 'bar', 'folder'], ['a', 'bar', 'url']])

    expect(moveNodes(tree, [ids['f'] as string], 'reading')).toBeNull()
    expect(moveNodes(tree, [ids['a'] as string], 'reading')).not.toBeNull()
  })
})

describe('removeNodes', () => {
  it('removes a folder with its subtree and counts the ids asked for', () => {
    const { tree, ids } = build([['f', 'bar', 'folder'], ['a', 'f', 'url'], ['g', 'f', 'folder'], ['b', 'g', 'url'], ['c', 'bar', 'url']])
    const { tree: after, removed } = removeNodes(tree, [ids['f'] as string, ids['a'] as string])

    expect(removed).toBe(2)
    expect(titles(after, 'bar')).toEqual(['c'])
    expect(nodeCount(after)).toBe(1)
    expect(after.nodes.has(ids['b'] as string)).toBe(false)
    expect(after.kids.has(ids['g'] as string)).toBe(false)
  })

  it('refuses roots and ignores unknown ids, leaving the tree as it was', () => {
    const { tree } = build([['a', 'bar', 'url']])
    const result = removeNodes(tree, ['bar', 'other', 'reading', 'nope'])

    expect(result.removed).toBe(0)
    expect(result.tree).toBe(tree)
  })
})

describe('updateNode', () => {
  it('renames, changes a page address, and marks read', () => {
    const { tree, ids } = build([['a', 'reading', 'url']])
    const id = ids['a'] as string
    const next = updateNode(updateNode(updateNode(tree, id, { title: 'New' }) as BookmarkTree, id, { url: 'https://b.example/x' }) as BookmarkTree, id, { read: true }) as BookmarkTree

    expect(next.nodes.get(id)).toMatchObject({ title: 'New', url: 'https://b.example/x', read: true })
  })

  it('refuses a root, an unknown id, an address that is not openable, and a page field on a folder', () => {
    const { tree, ids } = build([['f', 'bar', 'folder'], ['a', 'bar', 'url']])

    expect(updateNode(tree, 'bar', { title: 'x' })).toBeNull()
    expect(updateNode(tree, 'nope', { title: 'x' })).toBeNull()
    expect(updateNode(tree, ids['a'] as string, { url: 'javascript:alert(1)' })).toBeNull()
    expect(updateNode(tree, ids['f'] as string, { url: 'https://x.example/' })).toBeNull()
    expect(updateNode(tree, ids['f'] as string, { read: true })).toBeNull()
  })
})

describe('reading the tree', () => {
  const spec: Array<[string, string, 'url' | 'folder']> = [['a', 'bar', 'url'], ['f', 'bar', 'folder'], ['b', 'f', 'url'], ['c', 'other', 'url'], ['r', 'reading', 'url']]

  it('lists pages depth first, the bar then Other bookmarks, and leaves the reading list out', () => {
    const { tree } = build(spec)

    expect(flattenUrls(tree).map((node) => node.title)).toEqual(['a', 'b', 'c'])
    expect(flattenUrls(tree, ['reading']).map((node) => node.title)).toEqual(['r'])
  })

  it('finds the path from the root down, and the depth', () => {
    const { tree, ids } = build(spec)

    expect(pathTo(tree, ids['b'] as string).map((node) => node.title)).toEqual(['Bookmarks bar', 'f', 'b'])
    expect(depthOf(tree, ids['b'] as string)).toBe(2)
    expect(depthOf(tree, 'bar')).toBe(0)
    expect(pathTo(tree, 'nope')).toEqual([])
  })

  it('searches titles and addresses, case-insensitively, in the bar and Other bookmarks only', () => {
    const { tree } = build(spec)

    expect(searchUrls(tree, 'A.EXAMPLE', 10).map((node) => node.title)).toEqual(['a'])
    expect(searchUrls(tree, 'EXAMPLE', 2).map((node) => node.title)).toEqual(['a', 'b'])
    expect(searchUrls(tree, 'r.example', 10)).toEqual([])
    expect(searchUrls(tree, '   ', 10)).toEqual([])
    expect(searchUrls(tree, 'a', 0)).toEqual([])
  })

  it('lists the folders for a picker: each root at depth 0, the reading list not among them', () => {
    const { tree } = build([...spec, ['g', 'f', 'folder']])

    expect(folderList(tree).map(({ node, depth }) => `${String(depth)}:${node.title}`)).toEqual(['0:Bookmarks bar', '1:f', '2:g', '0:Other bookmarks'])
  })

  it('fills the icon of every page of an address that has none, and says when nothing changed', () => {
    const { tree, ids } = build([['a', 'bar', 'url'], ['f', 'bar', 'folder']])
    const inFolder = addNode(tree, { kind: 'url', title: 'a again', url: 'https://a.example/', favicon: 'data:image/png;base64,keep', added: 1 }, ids['f'] as string, undefined, counter()) as NonNullable<ReturnType<typeof addNode>>
    const filled = fillFavicon(inFolder.tree, 'https://a.example/', 'data:image/png;base64,new') as BookmarkTree

    expect(filled.nodes.get(ids['a'] as string)?.favicon).toBe('data:image/png;base64,new')
    expect(filled.nodes.get(inFolder.node.id)?.favicon).toBe('data:image/png;base64,keep')
    expect(fillFavicon(filled, 'https://a.example/', 'data:image/png;base64,other')).toBeNull()
  })
})

describe('importNodes and exportNodes', () => {
  const input = [
    { kind: 'url' as const, title: 'One', url: 'https://one.example/', added: 5 },
    { kind: 'folder' as const, title: 'Dir', children: [{ kind: 'url' as const, title: 'Two', url: 'https://two.example/' }, { kind: 'url' as const, title: 'Bad', url: 'javascript:alert(1)' }] },
    { kind: 'url' as const, title: 'Also bad', url: 'file://nas/share/passwd' }
  ]

  it('adds the tree in one go, counts pages, and drops what cannot be opened', () => {
    const result = importNodes(emptyTree(), 'other', input, undefined, counter(), 99)

    expect(result?.added).toBe(2)
    expect(result?.nodes).toBe(3)
    const tree = (result as NonNullable<typeof result>).tree
    expect(flattenUrls(tree).map((node) => node.title)).toEqual(['One', 'Two'])
    expect(childrenOf(tree, 'other').map((node) => node.added)).toEqual([5, 99])
  })

  it('places the tree at an index and leaves the tree alone when nothing in it is usable', () => {
    const { tree } = build([['a', 'bar', 'url'], ['b', 'bar', 'url']])
    const at = importNodes(tree, 'bar', [{ kind: 'url', title: 'x', url: 'https://x.example/' }], 1, counter(), 1) as NonNullable<ReturnType<typeof importNodes>>
    const none = importNodes(tree, 'bar', [{ kind: 'url', title: 'x', url: 'javascript:1' }], undefined, counter(), 1) as NonNullable<ReturnType<typeof importNodes>>

    expect(titles(at.tree, 'bar')).toEqual(['a', 'x', 'b'])
    expect(none.tree).toBe(tree)
    expect(none.added).toBe(0)
  })

  it('refuses a parent that is not a folder, and keeps folders out of the reading list', () => {
    const { tree, ids } = build([['a', 'bar', 'url']])

    expect(importNodes(tree, ids['a'] as string, input, undefined, counter(), 1)).toBeNull()
    expect(importNodes(tree, 'nope', input, undefined, counter(), 1)).toBeNull()
    expect(flattenUrls((importNodes(tree, 'reading', input, undefined, counter(), 1) as NonNullable<ReturnType<typeof importNodes>>).tree, ['reading']).map((node) => node.title)).toEqual(['One'])
  })

  it('drops what is nested past the depth limit and stops at the node cap', () => {
    let deep: { kind: 'folder', title: string, children: unknown[] } = { kind: 'folder', title: 'leaf', children: [{ kind: 'url', title: 'page', url: 'https://p.example/' }] }
    for (let level = 0; level < MAX_DEPTH + 2; level += 1) deep = { kind: 'folder', title: `f${String(level)}`, children: [deep] }
    const result = importNodes(emptyTree(), 'bar', [deep as never], undefined, counter(), 1) as NonNullable<ReturnType<typeof importNodes>>

    expect(result.added).toBe(0)
    expect(Math.max(...[...result.tree.nodes.keys()].map((id) => depthOf(result.tree, id)))).toBe(MAX_DEPTH)

    const many = Array.from({ length: MAX_NODES + 50 }, (_, i) => ({ kind: 'url' as const, title: String(i), url: `https://h${String(i)}.example/` }))
    const capped = importNodes(emptyTree(), 'bar', many, undefined, counter(), 1) as NonNullable<ReturnType<typeof importNodes>>
    expect(capped.added).toBe(MAX_NODES)
    expect(nodeCount(capped.tree)).toBe(MAX_NODES)
  })

  it('exports the bar and Other bookmarks as nested inputs without ids', () => {
    const { tree } = build([['f', 'bar', 'folder'], ['a', 'f', 'url'], ['c', 'other', 'url'], ['r', 'reading', 'url']])

    expect(exportNodes(tree)).toEqual({
      bar: [{ kind: 'folder', title: 'f', added: 1, children: [{ kind: 'url', title: 'a', url: 'https://a.example/', added: 1 }] }],
      other: [{ kind: 'url', title: 'c', url: 'https://c.example/', added: 1 }]
    })
  })
})
