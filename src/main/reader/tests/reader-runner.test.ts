import { describe, expect, it, vi } from 'vitest'
import type { Article } from '../reader-blocks.js'
import { closeReader, placeBeside, readerTabId, toggleReader } from '../reader-runner.js'
import type { ReaderDeps, ReaderTabs } from '../reader-runner.js'
import { ReaderArticles } from '../reader-store.js'

interface FakeTab { id: string, url: string, internal?: string, splitWith?: string | null, isNewTab?: boolean, reader?: { source: string } | null, groupId?: string | null }

const ARTICLE: Article = { title: 'T', byline: '', site: '', url: 'https://example.com/a', lang: 'en', words: 3, blocks: [{ t: 'p', c: ['one two three'] }] }

function strip (initial: FakeTab[], active: string) {
  const tabs = initial.map((tab) => ({ ...tab }))
  let activeId: string | null = active
  const events: string[] = []
  const records = new Map(tabs.map((tab) => [tab.id, { internalPage: tab.internal ?? null, reader: tab.reader ?? null, groupId: tab.groupId ?? null }]))
  const api = {
    getState: () => ({
      activeTabId: activeId,
      tabs: tabs.map((tab) => ({ id: tab.id, url: tab.url, isNewTab: tab.isNewTab === true, isInternal: tab.internal !== undefined, splitWith: tab.splitWith ?? null }))
    }),
    ids: () => tabs.map((tab) => tab.id),
    record: (id: string) => records.get(id),
    liveWebContents: (id: string) => tabs.some((tab) => tab.id === id) ? ({ id } as never) : undefined,
    activateTab: (id: string) => { activeId = id; events.push(`activate ${id}`) },
    closeTab: (id: string) => {
      tabs.splice(tabs.findIndex((tab) => tab.id === id), 1)
      records.delete(id)
      events.push(`close ${id}`)
    },
    moveTab: (id: string, index: number) => {
      const from = tabs.findIndex((tab) => tab.id === id)
      const [tab] = tabs.splice(from, 1)
      tabs.splice(index, 0, tab as FakeTab)
      events.push(`move ${id} ${String(index)}`)
    },
    openInternal: (page: string) => {
      const existing = tabs.find((tab) => tab.internal === page)
      if (existing !== undefined) { activeId = existing.id; return }
      tabs.push({ id: page, url: `orivon://${page}/`, internal: page })
      records.set(page, { internalPage: page, reader: null, groupId: null })
      activeId = page
      events.push(`open ${page}`)
    }
  }
  return { tabs: api as unknown as ReaderTabs, events, order: () => tabs.map((tab) => tab.id), active: () => activeId, records }
}

function deps (article: Article | null = ARTICLE): ReaderDeps & { published: Array<[string, unknown]>, notified: string[] } {
  const published: Array<[string, unknown]> = []
  const notified: string[] = []
  return {
    articles: new ReaderArticles(),
    extract: vi.fn(async () => await Promise.resolve(article)),
    fetcher: () => async () => await Promise.resolve(new Response(null, { status: 404 })),
    publish: (topic, payload) => { published.push([topic, payload]) },
    notify: (code) => { notified.push(code) },
    published,
    notified
  }
}

const WINDOW = {}
const web = (id: string, extra: Partial<FakeTab> = {}): FakeTab => ({ id, url: `https://example.com/${id}`, ...extra })

describe('toggleReader', () => {
  it('opens a reader tab right of the article and remembers where it came from', async () => {
    const s = strip([web('a'), web('b'), web('c')], 'b')
    const d = deps()
    await toggleReader(s.tabs, WINDOW, d)
    expect(s.order()).toEqual(['a', 'b', 'reader', 'c'])
    expect(s.active()).toBe('reader')
    expect(s.records.get('reader')?.reader).toEqual({ source: 'b' })
    expect(d.articles.get(WINDOW)?.source).toBe('b')
    expect(d.articles.get(WINDOW)?.article).toBe(ARTICLE)
  })

  it('puts the reader tab in the group of the article it was made from', async () => {
    const s = strip([web('a'), web('b', { groupId: 'g-1' }), web('c')], 'b')
    await toggleReader(s.tabs, WINDOW, deps())
    expect(s.records.get('reader')?.groupId).toBe('g-1')
    const plain = strip([web('a'), web('b')], 'b')
    await toggleReader(plain.tabs, WINDOW, deps())
    expect(plain.records.get('reader')?.groupId).toBeNull()
  })

  it('closes the reader tab and goes back to the article on the next press', async () => {
    const s = strip([web('a'), web('b')], 'b')
    const d = deps()
    await toggleReader(s.tabs, WINDOW, d)
    await toggleReader(s.tabs, WINDOW, d)
    expect(s.order()).toEqual(['a', 'b'])
    expect(s.active()).toBe('b')
  })

  it('reuses the one reader tab for another article and moves it beside the new source', async () => {
    const s = strip([web('a'), web('b'), web('c')], 'a')
    const d = deps()
    await toggleReader(s.tabs, WINDOW, d)
    expect(s.order()).toEqual(['a', 'reader', 'b', 'c'])
    s.tabs.activateTab('c')
    await toggleReader(s.tabs, WINDOW, d)
    expect(s.order()).toEqual(['a', 'b', 'c', 'reader'])
    expect(s.records.get('reader')?.reader).toEqual({ source: 'c' })
    expect(d.published.map(([topic]) => topic)).toContain('reader.changed')
    expect(s.order().filter((id) => id === 'reader')).toHaveLength(1)
  })

  it('says so, and opens nothing, for a page that is not an article', async () => {
    const s = strip([web('a')], 'a')
    const d = deps(null)
    await toggleReader(s.tabs, WINDOW, d)
    expect(s.order()).toEqual(['a'])
    expect(d.notified).toEqual(['notReadable'])
  })

  it('does not even ask a shell page, the new-tab page or a non-web address', async () => {
    for (const tab of [{ id: 's', url: 'orivon://settings/', internal: 'settings' }, { id: 'n', url: 'about:blank', isNewTab: true }, { id: 'f', url: 'file:///x.html' }, { id: 'v', url: 'view-source:https://a.test/' }] as FakeTab[]) {
      const s = strip([tab], tab.id)
      const d = deps()
      await toggleReader(s.tabs, WINDOW, d)
      expect(d.extract).not.toHaveBeenCalled()
      expect(d.notified).toEqual(['notReadable'])
    }
  })

  it('does nothing when the source tab closed while the article was read', async () => {
    const s = strip([web('a'), web('b')], 'b')
    const d = deps()
    ;(d as { extract: ReaderDeps['extract'] }).extract = async () => { s.tabs.closeTab('b'); return await Promise.resolve(ARTICLE) }
    await toggleReader(s.tabs, WINDOW, d)
    expect(s.order()).toEqual(['a'])
    expect(d.articles.get(WINDOW)).toBeUndefined()
  })

  it('tells reader pages when a picture is copied, tagged with the showing it belongs to', async () => {
    const withImage: Article = { ...ARTICLE, blocks: [{ t: 'img', src: 'https://img.test/a.png', alt: '' }] }
    const s = strip([web('a')], 'a')
    const d = deps(withImage)
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1])
    ;(d as { fetcher: ReaderDeps['fetcher'] }).fetcher = () => async () => await Promise.resolve(new Response(png, { headers: { 'content-type': 'image/png' } }))
    await toggleReader(s.tabs, WINDOW, d)
    await vi.waitFor(() => { expect(d.articles.get(WINDOW)?.images.size).toBe(1) })
    const entry = d.articles.get(WINDOW)
    expect(d.published).toContainEqual(['reader.image', { token: entry?.token, at: 0, src: expect.stringMatching(/^data:image\/png;base64,/) }])
  })
})

describe('closeReader and placeBeside', () => {
  it('goes back to the source only when it is still open', () => {
    const open = strip([web('a'), { id: 'reader', url: 'orivon://reader/', internal: 'reader', reader: { source: 'a' } }], 'reader')
    closeReader(open.tabs, 'reader')
    expect(open.events).toEqual(['activate a', 'close reader'])
    const gone = strip([web('b'), { id: 'reader', url: 'orivon://reader/', internal: 'reader', reader: { source: 'a' } }], 'reader')
    closeReader(gone.tabs, 'reader')
    expect(gone.events).toEqual(['close reader'])
  })

  it('puts the tab after the source and after the tab it is joined to', () => {
    const s = strip([web('a', { splitWith: 'b' }), web('b', { splitWith: 'a' }), web('c'), web('r')], 'a')
    placeBeside(s.tabs, 'r', 'a')
    expect(s.order()).toEqual(['a', 'b', 'r', 'c'])
  })

  it('finds the reader tab', () => {
    expect(readerTabId(strip([web('a'), { id: 'r', url: 'orivon://reader/', internal: 'reader' }], 'a').tabs)).toBe('r')
    expect(readerTabId(strip([web('a')], 'a').tabs)).toBeUndefined()
  })
})
