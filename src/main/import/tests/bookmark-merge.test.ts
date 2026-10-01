import { describe, expect, it } from 'vitest'
import { countPages, placeBookmarks, pruneKnown } from '../bookmark-merge.js'
import { folder, page, TreeSink } from './tree-sink.js'

describe('placeBookmarks into an empty store', () => {
  it('puts the source\'s bar on the bar and its other bookmarks in Other bookmarks, folders kept', () => {
    const sink = new TreeSink()
    const placed = placeBookmarks(sink, { bar: [page('A'), folder('News', page('B'))], other: [page('C')] }, 'Imported from Chrome')
    expect(placed).toEqual({ total: 3, imported: 3, known: 0, target: 'bar' })
    expect(sink.titles('bar')).toEqual(['A', 'News/'])
    expect(sink.titles('other')).toEqual(['C'])
  })

  it('counts a page the store refuses as not imported', () => {
    const sink = new TreeSink()
    const placed = placeBookmarks(sink, { bar: [page('A'), { kind: 'url', title: 'bad', url: 'javascript:alert(1)' }], other: [] }, 'x')
    expect(placed.total - placed.imported - placed.known).toBe(1)
    expect(sink.titles('bar')).toEqual(['A'])
  })
})

describe('placeBookmarks into a store that has bookmarks', () => {
  const filled = (): TreeSink => {
    const sink = new TreeSink()
    sink.importTree('bar', [page('Mine')])
    return sink
  }

  it('makes one folder on the bar, with sub-folders when both the bar and the rest have content', () => {
    const sink = filled()
    const placed = placeBookmarks(sink, { bar: [page('A')], other: [page('C')] }, 'Imported from Chrome')
    expect(placed).toMatchObject({ imported: 2, target: 'folder', folderTitle: 'Imported from Chrome' })
    expect(sink.titles('bar')).toEqual(['Mine', 'Imported from Chrome/'])
    const wrapper = sink.find('bar', 'Imported from Chrome')
    expect(sink.titles(wrapper?.id ?? '')).toEqual(['Bookmarks bar/', 'Other bookmarks/'])
  })

  it('makes the folder hold the pages directly when only one side has content', () => {
    const sink = filled()
    placeBookmarks(sink, { bar: [], other: [page('C'), folder('F', page('D'))] }, 'Imported from Edge')
    expect(sink.titles(sink.find('bar', 'Imported from Edge')?.id ?? '')).toEqual(['C', 'F/'])
  })

  it('adds nothing on a second run, whichever way the first one was placed', () => {
    const source = { bar: [page('A'), folder('News', page('B'))], other: [page('C')] }
    const first = new TreeSink()
    placeBookmarks(first, source, 'Imported from Chrome')
    const again = placeBookmarks(first, source, 'Imported from Chrome')
    expect(again.imported).toBe(0)
    expect(again.known).toBe(3)

    const second = filled()
    placeBookmarks(second, source, 'Imported from Chrome')
    const before = second.tree.nodes.size
    const repeat = placeBookmarks(second, source, 'Imported from Chrome')
    expect(repeat).toMatchObject({ imported: 0, known: 3 })
    expect(second.tree.nodes.size).toBe(before)
  })

  it('adds only the new pages to the same folder when the source has grown', () => {
    const sink = filled()
    placeBookmarks(sink, { bar: [page('A')], other: [] }, 'Imported from Chrome')
    const again = placeBookmarks(sink, { bar: [page('A'), page('New')], other: [] }, 'Imported from Chrome')
    expect(again).toMatchObject({ imported: 1, known: 1 })
    expect(sink.titles('bar')).toEqual(['Mine', 'Imported from Chrome/'])
    expect(sink.titles(sink.find('bar', 'Imported from Chrome')?.id ?? '')).toEqual(['A', 'New'])
  })

  it('does not add a page the person already has on the bar', () => {
    const sink = filled()
    const placed = placeBookmarks(sink, { bar: [page('Mine again', 'https://mine.test/')], other: [] }, 'x')
    expect(placed).toMatchObject({ imported: 0, known: 1 })
  })

  it('makes no folder when everything is known', () => {
    const sink = filled()
    placeBookmarks(sink, { bar: [page('Mine')], other: [] }, 'Imported from Chrome')
    expect(sink.titles('bar')).toEqual(['Mine'])
  })
})

describe('pruneKnown and countPages', () => {
  it('drops a folder whose pages were all known and keeps one that has news', () => {
    const sink = new TreeSink()
    sink.importTree('bar', [folder('F', page('A')), folder('G', page('B'))])
    const left = pruneKnown(sink, ['bar'], [folder('F', page('A')), folder('G', page('B'), page('New')), folder('Empty')])
    expect(left.map((node) => node.title)).toEqual(['G', 'Empty'])
    expect(countPages(left)).toBe(1)
  })
})
