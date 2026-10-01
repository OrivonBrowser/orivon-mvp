import { describe, expect, it } from 'vitest'
import { BookmarkStore } from '../../../browsing/bookmarks.js'
import type { TabState } from '../../tab-types.js'
import { applyEdit, applyFolderEdit, applySaveAll, asEditCommand, editPayload, folderChoices, folderNameForToday, isFilingFolder, newestBookmarkOf, tabsToBookmark } from '../edit-model.js'

const tiny = 'data:image/png;base64,iVBORw0KGgo='

function store (): BookmarkStore {
  let n = 0
  let clock = 0
  return new BookmarkStore('/nowhere/bookmarks.json', () => `id${String(n++)}`, () => ++clock)
}

const tab = (id: string, extra: Partial<TabState> = {}): TabState => ({ id, url: `https://${id}.example/`, title: `Title ${id}`, isNewTab: false, isInternal: false, ...extra }) as TabState

describe('the bubble model', () => {
  it('describes a bookmark, with every folder of the bar and Other bookmarks in order and indented by depth', () => {
    const s = store()
    const work = s.addFolder({ title: 'Work', parent: 'bar' }) as { id: string }
    const deep = s.addFolder({ title: 'Deep', parent: work.id }) as { id: string }
    const page = s.addUrl({ url: 'https://a.example/', title: 'A', parent: deep.id }) as { id: string }
    const payload = editPayload(s, 'edit', page.id)
    expect(payload).toMatchObject({ mode: 'edit', id: page.id, title: 'A', parent: deep.id })
    expect(payload?.folders.map(({ title, depth }) => [title, depth])).toEqual([['Bookmarks bar', 0], ['Work', 1], ['Deep', 2], ['Other bookmarks', 0]])
    expect(folderChoices(s)).toEqual(payload?.folders)
  })

  it('answers nothing for a bookmark that is gone, and for a node the mode does not edit', () => {
    const s = store()
    const folder = s.addFolder({ title: 'Work', parent: 'bar' }) as { id: string }
    const page = s.addUrl({ url: 'https://a.example/', title: 'A' }) as { id: string }
    expect(editPayload(s, 'edit', 'nope')).toBeUndefined()
    expect(editPayload(s, 'edit', folder.id)).toBeUndefined()
    expect(editPayload(s, 'rename-folder', page.id)).toBeUndefined()
    expect(editPayload(s, 'rename-folder', 'bar')).toBeUndefined()
    expect(editPayload(s, 'new-folder', 'reading')).toBeUndefined()
  })

  it('describes a folder to rename, and the place a new folder goes', () => {
    const s = store()
    const folder = s.addFolder({ title: 'Work', parent: 'bar' }) as { id: string }
    expect(editPayload(s, 'rename-folder', folder.id)).toMatchObject({ mode: 'rename-folder', id: folder.id, title: 'Work' })
    expect(editPayload(s, 'new-folder', 'bar')).toMatchObject({ mode: 'new-folder', parent: 'bar', title: '' })
  })

  it('picks the newest of several bookmarks of one address', () => {
    const s = store()
    s.addUrl({ url: 'https://a.example/', title: 'first' })
    const second = s.addUrl({ url: 'https://a.example/', title: 'second', parent: 'other' }) as { id: string }
    expect(newestBookmarkOf(s, 'https://a.example/')?.id).toBe(second.id)
    expect(newestBookmarkOf(s, 'https://none.example/')).toBeUndefined()
  })

  it('files a bookmark only in the bar, Other bookmarks, or a folder under either', () => {
    const s = store()
    const folder = s.addFolder({ title: 'Work', parent: 'other' }) as { id: string }
    const page = s.addUrl({ url: 'https://a.example/', title: 'A' }) as { id: string }
    expect(['bar', 'other', folder.id].map((id) => isFilingFolder(s, id))).toEqual([true, true, true])
    expect(['reading', page.id, 'nope', ''].map((id) => isFilingFolder(s, id))).toEqual([false, false, false, false])
  })
})

describe('applying a bookmark edit', () => {
  it('renames a bookmark and moves it to another folder', () => {
    const s = store()
    const work = s.addFolder({ title: 'Work', parent: 'bar' }) as { id: string }
    const page = s.addUrl({ url: 'https://a.example/', title: 'A' }) as { id: string }
    expect(applyEdit(s, { type: 'save', id: page.id, title: 'Renamed', parent: work.id })).toEqual({ ok: true })
    expect(s.node(page.id)).toMatchObject({ title: 'Renamed', parent: work.id })
    expect(s.children('bar').map((node) => node.id)).toEqual([work.id])
  })

  it('keeps an empty name, and cuts one over 512 characters', () => {
    const s = store()
    const page = s.addUrl({ url: 'https://a.example/', title: 'A' }) as { id: string }
    applyEdit(s, { type: 'save', id: page.id, title: '', parent: 'bar' })
    expect(s.node(page.id)?.title).toBe('')
    applyEdit(s, { type: 'save', id: page.id, title: 'x'.repeat(600), parent: 'bar' })
    expect(s.node(page.id)?.title).toHaveLength(512)
  })

  it('makes a new folder under the chosen one and files the bookmark in it', () => {
    const s = store()
    const work = s.addFolder({ title: 'Work', parent: 'bar' }) as { id: string }
    const page = s.addUrl({ url: 'https://a.example/', title: 'A' }) as { id: string }
    const outcome = applyEdit(s, { type: 'save', id: page.id, title: 'A', parent: work.id, newFolder: 'Reading' })
    expect(outcome.ok).toBe(true)
    const made = s.node(outcome.folder as string)
    expect(made).toMatchObject({ kind: 'folder', title: 'Reading', parent: work.id })
    expect(s.node(page.id)?.parent).toBe(made?.id)
  })

  it('ignores a blank new-folder name and files the bookmark where it was chosen', () => {
    const s = store()
    const page = s.addUrl({ url: 'https://a.example/', title: 'A' }) as { id: string }
    expect(applyEdit(s, { type: 'save', id: page.id, title: 'A', parent: 'other', newFolder: '   ' })).toEqual({ ok: true })
    expect(s.node(page.id)?.parent).toBe('other')
  })

  it('refuses the reading list, a page as a folder, and a missing bookmark or folder', () => {
    const s = store()
    const page = s.addUrl({ url: 'https://a.example/', title: 'A' }) as { id: string }
    expect(applyEdit(s, { type: 'save', id: page.id, title: 'B', parent: 'reading' }).ok).toBe(false)
    expect(applyEdit(s, { type: 'save', id: page.id, title: 'B', parent: page.id }).ok).toBe(false)
    expect(applyEdit(s, { type: 'save', id: 'nope', title: 'B', parent: 'bar' }).ok).toBe(false)
    expect(applyEdit(s, { type: 'remove', id: 'nope' }).ok).toBe(false)
    expect(s.node(page.id)?.title).toBe('A')
  })

  it('removes only the bookmark it was opened for when several share an address', () => {
    const s = store()
    const first = s.addUrl({ url: 'https://a.example/', title: 'first' }) as { id: string }
    const second = s.addUrl({ url: 'https://a.example/', title: 'second' }) as { id: string }
    expect(applyEdit(s, { type: 'remove', id: second.id }).ok).toBe(true)
    expect(s.findByUrl('https://a.example/').map((node) => node.id)).toEqual([first.id])
  })
})

describe('applying a folder edit', () => {
  it('renames a folder and makes a new one in the bar, and refuses the roots and a page', () => {
    const s = store()
    const work = s.addFolder({ title: 'Work', parent: 'bar' }) as { id: string }
    const page = s.addUrl({ url: 'https://a.example/', title: 'A' }) as { id: string }
    expect(applyFolderEdit(s, { type: 'saveFolder', id: work.id, title: 'Jobs' }).ok).toBe(true)
    expect(s.node(work.id)?.title).toBe('Jobs')
    const made = applyFolderEdit(s, { type: 'saveFolder', title: 'New' })
    expect(s.node(made.folder as string)).toMatchObject({ title: 'New', parent: 'bar' })
    expect(applyFolderEdit(s, { type: 'saveFolder', id: 'bar', title: 'X' }).ok).toBe(false)
    expect(applyFolderEdit(s, { type: 'saveFolder', id: page.id, title: 'X' }).ok).toBe(false)
    expect(applyFolderEdit(s, { type: 'saveFolder', parent: 'reading', title: 'X' }).ok).toBe(false)
  })
})

describe('bookmarking all tabs', () => {
  it('keeps the tabs with a site, in strip order, and skips the new-tab page and the shell pages', () => {
    const tabs = [tab('a'), tab('n', { isNewTab: true }), tab('b', { title: '' }), tab('s', { isInternal: true }), tab('c')]
    expect(tabsToBookmark(tabs, (id) => id === 'c' ? tiny : null)).toEqual([
      { url: 'https://a.example/', title: 'Title a', favicon: null },
      { url: 'https://b.example/', title: 'https://b.example/', favicon: null },
      { url: 'https://c.example/', title: 'Title c', favicon: tiny }
    ])
  })

  it('names the folder with the long date of the day, in the locale asked', () => {
    const day = new Date(2026, 8, 30, 12)
    expect(folderNameForToday(day, 'en-GB')).toBe('Tabs from 30 September 2026')
    expect(folderNameForToday(day, 'en-US')).toBe('Tabs from September 30, 2026')
  })

  it('creates the folder and its pages in one change, with the icons', () => {
    const s = store()
    let changes = 0
    s.onChange(() => { changes += 1 })
    const tabs = tabsToBookmark([tab('a'), tab('b')], (id) => id === 'a' ? tiny : null)
    expect(applySaveAll(s, { type: 'saveAll', title: 'My tabs', parent: 'bar' }, tabs, 'Fallback')).toBe(2)
    expect(changes).toBe(1)
    const folder = s.children('bar')[0]
    expect(folder).toMatchObject({ kind: 'folder', title: 'My tabs' })
    const pages = s.children(folder?.id as string)
    expect(pages.map((node) => node.url)).toEqual(['https://a.example/', 'https://b.example/'])
    expect(pages[0]?.favicon).not.toBeNull()
    expect(pages[1]?.favicon).toBeNull()
  })

  it('falls back to the dated name for a blank one, and refuses the reading list and an empty list', () => {
    const s = store()
    const tabs = tabsToBookmark([tab('a')], () => null)
    expect(applySaveAll(s, { type: 'saveAll', title: '  ', parent: 'other' }, tabs, 'Fallback')).toBe(1)
    expect(s.children('other')[0]?.title).toBe('Fallback')
    expect(applySaveAll(s, { type: 'saveAll', title: 'x', parent: 'reading' }, tabs, 'F')).toBe(0)
    expect(applySaveAll(s, { type: 'saveAll', title: 'x', parent: 'bar' }, [], 'F')).toBe(0)
    expect(s.children('reading')).toEqual([])
  })
})

describe('reading a command from a page', () => {
  it('accepts each command with its fields', () => {
    expect(asEditCommand({ type: 'save', id: 'a', title: 't', parent: 'bar' })).toEqual({ type: 'save', id: 'a', title: 't', parent: 'bar' })
    expect(asEditCommand({ type: 'save', id: 'a', title: 't', parent: 'bar', newFolder: 'n' })).toMatchObject({ newFolder: 'n' })
    expect(asEditCommand({ type: 'remove', id: 'a' })).toEqual({ type: 'remove', id: 'a' })
    expect(asEditCommand({ type: 'saveFolder', title: 't' })).toEqual({ type: 'saveFolder', title: 't' })
    expect(asEditCommand({ type: 'saveFolder', id: 'a', title: 't' })).toEqual({ type: 'saveFolder', id: 'a', title: 't' })
    expect(asEditCommand({ type: 'saveAll', title: 't', parent: 'bar' })).toEqual({ type: 'saveAll', title: 't', parent: 'bar' })
  })

  it('refuses a wrong shape, an extra field, a wrong type, and a name that is on the prototype', () => {
    for (const bad of [undefined, null, 'save', 3, [], {}, { type: 'nope' }, { type: 'constructor' }, { type: '__proto__' }, { type: 'toString' },
      { type: 'save', id: 'a', title: 't' }, { type: 'save', id: 1, title: 't', parent: 'bar' }, { type: 'save', id: 'a', title: 't', parent: 'bar', newFolder: 2 },
      { type: 'save', id: 'a', title: 't', parent: 'bar', url: 'https://x.example/' }, { type: 'remove' }, { type: 'remove', id: 'a', extra: 1 },
      { type: 'saveFolder', title: 1 }, { type: 'saveFolder', id: 3, title: 't' }, { type: 'saveAll', title: 't' }]) {
      expect(asEditCommand(bad), JSON.stringify(bad)).toBeUndefined()
    }
  })
})
