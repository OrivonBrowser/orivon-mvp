import { describe, expect, it } from 'vitest'
import { emptyText, howOpens, moveSelection, pieces, reconcile, selectableIds, treeKey, withDays } from '../overlay/side-panel/rows.js'
import type { PanelRow } from '../overlay/side-panel/rows.js'

const NOW = new Date(2026, 9, 1, 15, 0).getTime()
const at = (days: number, hour = 10): number => new Date(2026, 9, 1 - days, hour, 30).getTime()
const page = (id: string, when: number): PanelRow => ({ id, kind: 'item', title: id, at: when })
const folder = (id: string, level: number, expanded: boolean): PanelRow => ({ id, kind: 'folder', title: id, level, expanded })
const item = (id: string, level: number): PanelRow => ({ id, kind: 'item', title: id, level })

describe('pieces', () => {
  it('marks each place the query occurs, ignoring case', () => {
    expect(pieces('Loaf of bread, a loaf', 'loaf')).toEqual([
      { text: 'Loaf', hit: true }, { text: ' of bread, a ', hit: false }, { text: 'loaf', hit: true }
    ])
  })

  it('keeps the text as it was written', () => {
    expect(pieces('News', 'ews')).toEqual([{ text: 'N', hit: false }, { text: 'ews', hit: true }])
  })

  it('is one unmarked piece for a blank query or no match, and never empty', () => {
    expect(pieces('Alpha', '')).toEqual([{ text: 'Alpha', hit: false }])
    expect(pieces('Alpha', '  ')).toEqual([{ text: 'Alpha', hit: false }])
    expect(pieces('Alpha', 'zzz')).toEqual([{ text: 'Alpha', hit: false }])
    expect(pieces('', 'a')).toEqual([{ text: '', hit: false }])
  })

  it('treats the query as text, not as a pattern', () => {
    expect(pieces('a.b a+b', 'a+b')).toEqual([{ text: 'a.b ', hit: false }, { text: 'a+b', hit: true }])
  })
})

describe('withDays', () => {
  it('puts a heading above each run of rows of one day, newest first, and words the time', () => {
    const rows = withDays([page('a', at(0, 14)), page('b', at(0, 9)), page('c', at(1)), page('d', at(40))], NOW, 'en-GB')
    expect(rows.map((row) => row.kind === 'header' ? `# ${row.title}` : row.id)).toEqual(['# Today', 'a', 'b', '# Yesterday', 'c', expect.stringMatching(/^# /), 'd'])
    expect(rows.find((row) => row.id === 'a')?.meta).toBe('14:30')
  })

  it('passes rows with no time through unchanged, with no heading', () => {
    const plain: PanelRow[] = [{ id: 'x', kind: 'item', title: 'X' }, folder('f', 0, false)]
    expect(withDays(plain, NOW)).toEqual(plain)
  })
})

describe('selection', () => {
  const ids = ['a', 'b', 'c']

  it('lists the ids a key can land on, skipping headings', () => {
    expect(selectableIds([{ id: 'h', kind: 'header', title: 'Today' }, item('a', 0), item('b', 0)])).toEqual(['a', 'b'])
  })

  it('moves one row, to the ends, and holds at them', () => {
    expect(moveSelection(ids, 'a', 'down')).toBe('b')
    expect(moveSelection(ids, 'c', 'down')).toBe('c')
    expect(moveSelection(ids, 'a', 'up')).toBe('a')
    expect(moveSelection(ids, 'b', 'first')).toBe('a')
    expect(moveSelection(ids, 'b', 'last')).toBe('c')
  })

  it('lands on the first row when nothing is selected, and on nothing in an empty list', () => {
    expect(moveSelection(ids, null, 'down')).toBe('a')
    expect(moveSelection(ids, null, 'up')).toBe('a')
    expect(moveSelection([], null, 'down')).toBeNull()
  })

  it('keeps the same row selected, or the next one when it went, or the one above at the end', () => {
    expect(reconcile(ids, 'b', ['a', 'b', 'c'])).toBe('b')
    expect(reconcile(ids, 'b', ['a', 'c'])).toBe('c')
    expect(reconcile(ids, 'c', ['a', 'b'])).toBe('b')
    expect(reconcile(ids, 'b', [])).toBeNull()
    expect(reconcile(ids, null, ids)).toBeNull()
    expect(reconcile(ids, 'zz', ids)).toBeNull()
  })
})

describe('treeKey', () => {
  const rows: PanelRow[] = [folder('bar', 0, true), folder('recipes', 1, false), item('news', 1), folder('other', 0, false)]

  it('unfolds a closed folder on Right, then steps into it', () => {
    expect(treeKey(rows, 'recipes', 'ArrowRight')).toEqual({ action: 'expand', id: 'recipes' })
    expect(treeKey(rows, 'bar', 'ArrowRight')).toEqual({ action: 'select', id: 'recipes' })
  })

  it('does nothing on Right for a page, or for an open folder with nothing in it', () => {
    expect(treeKey(rows, 'news', 'ArrowRight')).toBeNull()
    expect(treeKey([folder('empty', 0, true), folder('next', 0, false)], 'empty', 'ArrowRight')).toBeNull()
  })

  it('folds an open folder on Left, then steps to the parent', () => {
    expect(treeKey(rows, 'bar', 'ArrowLeft')).toEqual({ action: 'collapse', id: 'bar' })
    expect(treeKey(rows, 'news', 'ArrowLeft')).toEqual({ action: 'select', id: 'bar' })
    expect(treeKey(rows, 'recipes', 'ArrowLeft')).toEqual({ action: 'select', id: 'bar' })
  })

  it('does nothing on Left at the top level, or with nothing selected', () => {
    expect(treeKey(rows, 'other', 'ArrowLeft')).toBeNull()
    expect(treeKey(rows, null, 'ArrowLeft')).toBeNull()
    expect(treeKey(rows, 'gone', 'ArrowRight')).toBeNull()
  })
})

describe('emptyText', () => {
  it('says what will appear while nothing is typed', () => {
    expect(emptyText('', 'bookmarks', 'Bookmarks you save appear here.')).toBe('Bookmarks you save appear here.')
    expect(emptyText('   ', 'bookmarks', 'Bookmarks you save appear here.')).toBe('Bookmarks you save appear here.')
  })

  it('names the query, in straight quotes, when it matched nothing', () => {
    expect(emptyText('loaf', 'bookmarks', 'x')).toBe('No bookmarks match "loaf".')
    expect(emptyText(' news ', 'pages', 'x')).toBe('No pages match "news".')
  })

  it('shortens a very long query', () => {
    const long = 'q'.repeat(60)
    expect(emptyText(long, 'pages', 'x')).toBe(`No pages match "${'q'.repeat(40)}…".`)
  })
})

describe('howOpens', () => {
  const press = (init: Partial<{ button: number, ctrlKey: boolean, metaKey: boolean, shiftKey: boolean }>) => howOpens({ button: 0, ctrlKey: false, metaKey: false, shiftKey: false, ...init })

  it('opens in the tab in front for a plain click', () => {
    expect(press({})).toBe('current')
  })

  it('opens a background tab for the middle button, Ctrl or Command', () => {
    expect(press({ button: 1 })).toBe('background')
    expect(press({ ctrlKey: true })).toBe('background')
    expect(press({ metaKey: true })).toBe('background')
  })

  it('opens a window for Shift', () => {
    expect(press({ shiftKey: true })).toBe('window')
  })
})
