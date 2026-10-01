import { describe, expect, it } from 'vitest'
import {
  chromeRoot, isChromeRoot, matchesWords, queryWords, toChromeId, toChromeNode, toChromeParentId, toStoreId
} from '../bookmarks-shape.js'

describe('ids', () => {
  it('maps Chrome\'s two roots to the store\'s and every other id to itself', () => {
    expect(toStoreId('1')).toBe('bar')
    expect(toStoreId('2')).toBe('other')
    expect(toStoreId('abc123')).toBe('abc123')
    expect(toChromeId('bar')).toBe('1')
    expect(toChromeId('other')).toBe('2')
    expect(toChromeId('abc123')).toBe('abc123')
  })

  it('knows no id for the nameless root, a store root name or the reading list', () => {
    for (const id of ['0', 'bar', 'other', 'reading']) expect(toStoreId(id)).toBeUndefined()
  })

  it('puts the two roots under "0" and gives the reading list no parent at all', () => {
    expect(toChromeParentId('')).toBe('0')
    expect(toChromeParentId('bar')).toBe('1')
    expect(toChromeParentId('f1')).toBe('f1')
    expect(toChromeParentId('reading')).toBeUndefined()
  })

  it('calls "0", "1" and "2" the roots', () => {
    expect(['0', '1', '2', '3'].map(isChromeRoot)).toEqual([true, true, true, false])
  })
})

describe('toChromeNode', () => {
  it('shapes a page with its index and dates', () => {
    expect(toChromeNode({ id: 'p', parent: 'bar', kind: 'url', title: 'T', url: 'https://e.test/', added: 5 }, 3)).toEqual({
      id: 'p', parentId: '1', index: 3, url: 'https://e.test/', title: 'T', dateAdded: 5
    })
  })

  it('shapes a folder with its group date and children when given', () => {
    const child = toChromeNode({ id: 'p', parent: 'f', kind: 'url', title: 'T', url: 'https://e.test/', added: 5 }, 0)
    const folder = toChromeNode({ id: 'f', parent: 'other', kind: 'folder', title: 'F', added: 9 }, 1, [child])
    expect(folder).toEqual({ id: 'f', parentId: '2', index: 1, title: 'F', dateAdded: 9, dateGroupModified: 9, children: [child] })
  })

  it('leaves a root without a date and under the nameless root', () => {
    expect(toChromeNode({ id: 'bar', parent: '', kind: 'folder', title: 'Bookmarks bar', added: 0 }, 0)).toEqual({ id: '1', parentId: '0', index: 0, title: 'Bookmarks bar' })
  })

  it('has no children key on a page, and none on a folder unless asked', () => {
    expect('children' in toChromeNode({ id: 'f', parent: 'bar', kind: 'folder', title: 'F', added: 0 }, 0)).toBe(false)
    expect(chromeRoot([])).toEqual({ id: '0', title: '', children: [] })
  })
})

describe('search words', () => {
  it('splits on spaces and keeps a quoted phrase whole', () => {
    expect(queryWords('Foo  "bar baz" Qux')).toEqual(['foo', 'bar baz', 'qux'])
    expect(queryWords('   ')).toEqual([])
  })

  it('matches when every word is in the title or the address', () => {
    const node = { title: 'Orivon Docs', url: 'https://orivon.example/guide' }
    expect(matchesWords(node, ['orivon', 'guide'])).toBe(true)
    expect(matchesWords(node, ['orivon', 'missing'])).toBe(false)
    expect(matchesWords(node, [])).toBe(true)
  })
})
