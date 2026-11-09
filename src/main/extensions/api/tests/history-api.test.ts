import { describe, expect, it, vi } from 'vitest'
import { HistoryService } from '../../../history/history-service.js'
import { SqliteHistoryStore } from '../../../history/sqlite-history-store.js'
import { historyApi, installHistory, topSitesApi } from '../history-api.js'
import { DAY_MS } from '../history-shape.js'
import { fakeContext } from './api-fixtures.js'

const NOW = 1000 * DAY_MS

function setup (remember = true) {
  const settings: Record<string, boolean | string> = { 'history.remember': remember, 'history.retentionDays': 'forever' }
  const clock = { now: NOW }
  const service = new HistoryService(new SqliteHistoryStore(':memory:'), {
    get: ((key: string) => settings[key]) as never,
    onChange: () => () => {}
  } as never, null, () => clock.now)
  const fake = fakeContext({ history: service })
  installHistory(fake.ctx, () => clock.now)
  fake.ctx.handle('topSites.get', () => undefined)
  return { service, clock, settings, ...fake }
}

const visit = (s: ReturnType<typeof setup>, url: string, title = url, at = s.clock.now): void => {
  const saved = s.clock.now
  s.clock.now = at
  s.service.visit(url, title)
  s.clock.now = saved
}

describe('registration', () => {
  it('is the history module, gated on the history permission', () => {
    expect(historyApi).toMatchObject({ name: 'history', permission: 'history' })
    expect(topSitesApi).toMatchObject({ name: 'topSites', permission: 'topSites' })
  })

  it('registers the six calls', () => {
    const { handlers } = setup()
    expect([...handlers.keys()].filter((name) => name.startsWith('history.')).sort()).toEqual([
      'history.addUrl', 'history.deleteAll', 'history.deleteRange', 'history.deleteUrl', 'history.getVisits', 'history.search'
    ])
  })
})

describe('search', () => {
  it('looks at the last 24 hours unless told otherwise, newest first', async () => {
    const s = setup()
    visit(s, 'https://old.test/', 'Old', NOW - 2 * DAY_MS)
    visit(s, 'https://a.test/', 'A', NOW - 1000)
    visit(s, 'https://b.test/', 'B', NOW - 500)
    const items = await s.call('history.search', { text: '' }) as Array<{ url: string, id: string }>
    expect(items.map((item) => item.url)).toEqual(['https://b.test/', 'https://a.test/'])
    expect(items[0]).toMatchObject({ title: 'B', visitCount: 1, typedCount: 0, lastVisitTime: NOW - 500 })
    expect((await s.call('history.search', { text: '', startTime: 0 }) as unknown[])).toHaveLength(3)
  })

  it('matches text in the title or the address and honours an end time', async () => {
    const s = setup()
    visit(s, 'https://a.test/x', 'Alpha', NOW - 3000)
    visit(s, 'https://b.test/', 'Beta', NOW - 2000)
    visit(s, 'https://c.test/', 'Gamma alpha', NOW - 1000)
    const urls = async (query: object): Promise<string[]> => (await s.call('history.search', query) as Array<{ url: string }>).map((item) => item.url)
    expect(await urls({ text: 'alpha' })).toEqual(['https://c.test/', 'https://a.test/x'])
    expect(await urls({ text: 'alpha', endTime: NOW - 1500 })).toEqual(['https://a.test/x'])
    expect(await urls({ text: '', startTime: NOW - 2500, endTime: NOW - 1500 })).toEqual(['https://b.test/'])
  })

  it('clamps maxResults and rejects a bad query', async () => {
    const s = setup()
    for (let at = 0; at < 5; at++) visit(s, `https://p${String(at)}.test/`, 'P', NOW - at)
    expect(await s.call('history.search', { text: '', maxResults: 2 }) as unknown[]).toHaveLength(2)
    expect(await s.call('history.search', { text: '', maxResults: 0 }) as unknown[]).toHaveLength(1)
    await expect(s.call('history.search', 'x')).rejects.toThrow('Invalid argument')
  })

  it('pages through more rows than one read gives', async () => {
    const s = setup()
    for (let at = 0; at < 620; at++) visit(s, `https://p${String(at)}.test/`, 'P', NOW - at)
    expect(await s.call('history.search', { text: '', maxResults: 1000 }) as unknown[]).toHaveLength(620)
  })

  it('lists the pages of a site that holds Orivon permissions like any other', async () => {
    const s = setup()
    visit(s, 'https://granted.example/inbox', 'Inbox', NOW - 2000)
    visit(s, 'https://a.test/', 'A', NOW - 1000)
    expect((await s.call('history.search', { text: '' }) as Array<{ url: string }>).map((item) => item.url)).toEqual(['https://a.test/', 'https://granted.example/inbox'])
    expect((await s.call('history.search', { text: 'Inbox' }) as Array<{ url: string }>).map((item) => item.url)).toEqual(['https://granted.example/inbox'])
  })

  it('returns what is stored while history is off, and addUrl then does nothing', async () => {
    const s = setup()
    visit(s, 'https://a.test/', 'A')
    s.settings['history.remember'] = false
    expect(await s.call('history.addUrl', { url: 'https://b.test/' })).toBeUndefined()
    expect((await s.call('history.search', { text: '' }) as Array<{ url: string }>).map((item) => item.url)).toEqual(['https://a.test/'])
  })
})

describe('getVisits', () => {
  it('gives one visit for a stored address and none for another', async () => {
    const s = setup()
    visit(s, 'https://a.test/', 'A')
    expect(await s.call('history.getVisits', { url: 'https://a.test/' })).toEqual([expect.objectContaining({ transition: 'link', isLocal: true, visitTime: NOW })])
    expect(await s.call('history.getVisits', { url: 'https://zzz.test/' })).toEqual([])
  })

  it('gives the visit of a granted site\'s address like any other', async () => {
    const s = setup()
    visit(s, 'https://granted.example/inbox')
    expect(await s.call('history.getVisits', { url: 'https://granted.example/inbox' })).toEqual([expect.objectContaining({ transition: 'link', visitTime: NOW })])
  })
})

describe('addUrl and deleteUrl', () => {
  it('adds a visit with the title and removes a page by address', async () => {
    const s = setup()
    await s.call('history.addUrl', { url: 'https://a.test/', title: 'Added' })
    expect(await s.call('history.search', { text: 'Added' }) as unknown[]).toHaveLength(1)
    await s.call('history.deleteUrl', { url: 'https://a.test/' })
    expect(await s.call('history.search', { text: '' }) as unknown[]).toHaveLength(0)
    await expect(s.call('history.deleteUrl', { url: 'https://never.test/' })).resolves.toBeUndefined()
  })

  it('refuses an address that is not a web page', async () => {
    const s = setup()
    for (const url of ['javascript:1', 'ftp://x.test/', 'orivon://settings', 'junk']) {
      await expect(s.call('history.addUrl', { url })).rejects.toThrow('Invalid URL.')
      await expect(s.call('history.deleteUrl', { url })).rejects.toThrow('Invalid URL.')
    }
    await expect(s.call('history.addUrl', {})).rejects.toThrow('Invalid argument')
  })

  it('adds and removes the address of a granted site like any other', async () => {
    const s = setup()
    await s.call('history.addUrl', { url: 'https://granted.example/x', title: 'Granted' })
    expect((await s.call('history.search', { text: 'Granted' }) as Array<{ url: string }>).map((item) => item.url)).toEqual(['https://granted.example/x'])
    await s.call('history.deleteUrl', { url: 'https://granted.example/x' })
    expect(await s.call('history.search', { text: 'Granted' }) as unknown[]).toHaveLength(0)
  })
})

describe('deleteRange and deleteAll', () => {
  it('forgets the visits in a range', async () => {
    const s = setup()
    visit(s, 'https://a.test/', 'A', NOW - 3000)
    visit(s, 'https://b.test/', 'B', NOW - 2000)
    visit(s, 'https://c.test/', 'C', NOW - 1000)
    await s.call('history.deleteRange', { startTime: NOW - 2500, endTime: NOW - 1500 })
    expect((await s.call('history.search', { text: '', startTime: 0 }) as Array<{ url: string }>).map((item) => item.url)).toEqual(['https://c.test/', 'https://a.test/'])
    await expect(s.call('history.deleteRange', { startTime: 1 })).rejects.toThrow('Invalid argument')
  })

  it('forgets everything', async () => {
    const s = setup()
    visit(s, 'https://a.test/')
    visit(s, 'https://b.test/')
    await s.call('history.deleteAll')
    expect(await s.call('history.search', { text: '', startTime: 0 }) as unknown[]).toHaveLength(0)
  })

  it('forgets the pages of a granted site with the rest, through both', async () => {
    const s = setup()
    visit(s, 'https://granted.example/inbox', 'Inbox', NOW - 2000)
    visit(s, 'https://a.test/', 'A', NOW - 1000)
    await s.call('history.deleteRange', { startTime: 0, endTime: NOW })
    expect(s.service.list()).toEqual([])
    visit(s, 'https://granted.example/inbox', 'Inbox', NOW - 500)
    visit(s, 'https://b.test/', 'B', NOW - 400)
    await s.call('history.deleteAll')
    expect(s.service.list()).toEqual([])
  })
})

describe('a delete over a very long history', () => {
  it('is one call to the store and reads no page', async () => {
    const list = vi.fn(() => [])
    const clear = vi.fn()
    const removeRange = vi.fn()
    const history = { list, listOrdered: () => [], visit: vi.fn(), remove: vi.fn(), removeRange, clear, onChange: () => () => {} }
    const fake = fakeContext({ history: history as never })
    installHistory(fake.ctx, () => NOW)
    list.mockClear()
    await fake.call('history.deleteAll')
    expect(clear).toHaveBeenCalledTimes(1)
    await fake.call('history.deleteRange', { startTime: 5, endTime: 9 })
    expect(removeRange).toHaveBeenCalledWith(5, 9)
    expect(list).not.toHaveBeenCalled()
  })
})

describe('events', () => {
  it('sends onVisited for a visit, and nothing for a title that arrives later', () => {
    const s = setup()
    s.service.visit('https://a.test/', 'A')
    s.service.titled('https://a.test/', 'A later')
    expect(s.events).toEqual([{ name: 'history.onVisited', args: [expect.objectContaining({ url: 'https://a.test/', visitCount: 1 })] }])
  })

  it('sends onVisited again for a page visited again', () => {
    const s = setup()
    s.service.visit('https://a.test/', 'A')
    s.clock.now += 5
    s.service.visit('https://a.test/', 'A')
    expect(s.events.map((event) => (event.args[0] as { visitCount: number }).visitCount)).toEqual([1, 2])
  })

  it('sends onVisitRemoved with the address for a page forgotten, and allHistory for a clear', async () => {
    const s = setup()
    s.service.visit('https://a.test/', 'A')
    s.service.visit('https://b.test/', 'B')
    s.events.length = 0
    await s.call('history.deleteUrl', { url: 'https://a.test/' })
    s.service.clear()
    expect(s.events).toEqual([
      { name: 'history.onVisitRemoved', args: [{ allHistory: false, urls: ['https://a.test/'] }] },
      { name: 'history.onVisitRemoved', args: [{ allHistory: true, urls: [] }] }
    ])
  })

  it('sends onVisited and onVisitRemoved for a granted site\'s page like any other', async () => {
    const s = setup()
    s.service.visit('https://a.test/', 'A')
    s.service.visit('https://granted.example/inbox', 'Inbox')
    expect(s.events.at(-1)).toEqual({ name: 'history.onVisited', args: [expect.objectContaining({ url: 'https://granted.example/inbox' })] })
    s.events.length = 0
    await s.call('history.deleteUrl', { url: 'https://granted.example/inbox' })
    expect(s.events).toEqual([{ name: 'history.onVisitRemoved', args: [{ allHistory: false, urls: ['https://granted.example/inbox'] }] }])
  })
})
