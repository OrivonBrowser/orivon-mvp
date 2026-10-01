import { describe, expect, it, vi } from 'vitest'
import type { Article } from '../reader-blocks.js'
import { linkTable } from '../reader-blocks.js'
import { READER_PREFS, readerDomain } from '../reader-domain.js'
import type { ReaderOwner } from '../reader-domain.js'
import { ReaderArticles } from '../reader-store.js'

const ARTICLE: Article = {
  title: 'T', byline: '', site: '', url: 'https://example.com/a', lang: 'en', words: 2,
  blocks: [{ t: 'p', c: [{ t: 'a', i: 0, href: 'https://one.test/', c: ['one'] }, ' ', { t: 'a', i: 1, href: 'https://two.test/', c: ['two'] }] }]
}

function setup () {
  const articles = new ReaderArticles()
  const window = {}
  const settings = { values: new Map<string, string>(), get: (key: string) => settings.values.get(key) ?? ({ 'reader.font': 'sans', 'reader.size': '18', 'reader.width': 'medium', 'reader.theme': 'auto' } as Record<string, string>)[key], set: vi.fn((key: string, value: unknown) => { settings.values.set(key, String(value)); return { ok: true } }) }
  const calls: string[] = []
  const owner: ReaderOwner = {
    key: window,
    tabId: 'reader',
    print: () => { calls.push('print') },
    tabs: {
      createTab: (url: string) => { calls.push(`open ${url}`); return 'new' },
      ids: () => ['a', 'reader', 'new'], getState: () => ({ tabs: [], activeTabId: null }), moveTab: (id: string, index: number) => { calls.push(`move ${id} ${String(index)}`) },
      record: () => ({ reader: { source: 'a' } }), activateTab: (id: string) => { calls.push(`activate ${id}`) }, closeTab: (id: string) => { calls.push(`close ${id}`) }, liveWebContents: () => undefined, openInternal: () => {}
    } as never
  }
  const domain = readerDomain({ articles, settings: settings as never, ownerOf: (contents) => (contents as unknown as { known?: boolean }).known === true ? owner : undefined })
  const ask = (command: unknown, known = true): unknown => domain.handle(command, { page: 'reader', contents: { known } as never })
  return { articles, window, settings, calls, ask }
}

describe('the reader domain', () => {
  it('is for the reader page only', () => {
    expect(setup().ask({ type: 'article' })).toBeDefined()
    expect(readerDomain({ articles: new ReaderArticles(), settings: {} as never, ownerOf: () => undefined }).pages).toEqual(['reader'])
  })

  it('hands over the window\'s article, its pictures and the four preferences', () => {
    const s = setup()
    expect(s.ask({ type: 'article' })).toEqual({ article: null, token: 0, images: {}, prefs: { font: 'sans', size: '18', width: 'medium', theme: 'auto' } })
    const entry = s.articles.set(s.window, ARTICLE, linkTable(ARTICLE), 'a')
    entry.images.set(3, 'data:image/png;base64,AAAA')
    expect(s.ask({ type: 'article' })).toMatchObject({ article: ARTICLE, token: entry.token, images: { 3: 'data:image/png;base64,AAAA' } })
    expect(s.ask({ type: 'article' }, false)).toMatchObject({ article: null })
  })

  it('changes the four reading keys, and no other', () => {
    const s = setup()
    for (const key of READER_PREFS) expect(s.ask({ type: 'pref', key, value: 'x' })).toEqual({ ok: true })
    expect(s.settings.set).toHaveBeenCalledTimes(4)
    s.settings.set.mockClear()
    for (const key of ['appearance.theme', 'reader', 'reader.', '__proto__', 'search.engine', 4, null]) {
      expect(s.ask({ type: 'pref', key, value: 'dark' })).toEqual({ ok: false })
    }
    expect(s.ask({ type: 'pref', key: 'reader.font', value: 4 })).toEqual({ ok: false })
    expect(s.settings.set).not.toHaveBeenCalled()
  })

  it('opens a link by its index, beside the reader, and by nothing else', () => {
    const s = setup()
    s.articles.set(s.window, ARTICLE, linkTable(ARTICLE), 'a')
    expect(s.ask({ type: 'open', index: 1 })).toEqual({ ok: true })
    expect(s.calls[0]).toBe('open https://two.test/')
    s.calls.length = 0
    for (const index of [2, -1, 1.5, NaN, '1', null, undefined, {}]) expect(s.ask({ type: 'open', index })).toEqual({ ok: false })
    expect(s.ask({ type: 'open', url: 'https://evil.test/' })).toEqual({ ok: false })
    expect(s.ask({ type: 'open', index: 0 }, false)).toEqual({ ok: false })
    expect(s.calls).toEqual([])
  })

  it('goes back and prints for its own window only', () => {
    const s = setup()
    expect(s.ask({ type: 'back' })).toEqual({ ok: true })
    expect(s.calls).toEqual(['activate a', 'close reader'])
    s.calls.length = 0
    expect(s.ask({ type: 'print' })).toEqual({ ok: true })
    expect(s.ask({ type: 'back' }, false)).toEqual({ ok: false })
    expect(s.ask({ type: 'print' }, false)).toEqual({ ok: false })
    expect(s.calls).toEqual(['print'])
  })

  it('ignores anything it does not know', () => {
    const s = setup()
    for (const command of [null, 'x', 4, {}, { type: 'delete' }, { type: 'pref' }]) expect(() => s.ask(command)).not.toThrow()
    expect(s.ask({ type: 'unknown' })).toBeUndefined()
  })
})
