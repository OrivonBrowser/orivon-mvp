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

  it('leaves a registered app\'s pages out', async () => {
    const s = setup()
    visit(s, 'https://app.example/inbox', 'Inbox')
    visit(s, 'https://a.test/', 'A')
    expect((await s.call('history.search', { text: '' }) as Array<{ url: string }>).map((item) => item.url)).toEqual(['https://a.test/'])
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

  it('has none for a registered app\'s address', async () => {
    const s = setup()
    visit(s, 'https://app.example/inbox')
    expect(await s.call('history.getVisits', { url: 'https://app.example/inbox' })).toEqual([])
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

  it('refuses an address that is not a web page, and any address of a registered app', async () => {
    const s = setup()
    for (const url of ['javascript:1', 'ftp://x.test/', 'orivon://settings', 'junk', 'https://app.example/x']) {
      await expect(s.call('history.addUrl', { url })).rejects.toThrow('Invalid URL.')
      await expect(s.call('history.deleteUrl', { url })).rejects.toThrow('Invalid URL.')
    }
    await expect(s.call('history.addUrl', {})).rejects.toThrow('Invalid argument')
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

  it('keeps a registered app\'s pages through both', async () => {
    const s = setup()
    visit(s, 'https://app.example/inbox', 'Inbox', NOW - 2000)
    visit(s, 'https://a.test/', 'A', NOW - 1000)
    await s.call('history.deleteRange', { startTime: 0, endTime: NOW })
    expect(s.service.list().map((page) => page.url)).toEqual(['https://app.example/inbox'])
    visit(s, 'https://b.test/', 'B', NOW - 500)
    await s.call('history.deleteAll')
    expect(s.service.list().map((page) => page.url)).toEqual(['https://app.example/inbox'])
  })
})

describe('a delete over a very long history', () => {
  it('still finds a registered app\'s page beyond fifty thousand rows and keeps it', async () => {
    const total = 60_000
    const rows = Array.from({ length: total }, (_unused, index) => ({
      id: index + 1,
      url: index === total - 1 ? 'https://app.example/old' : `https://p${String(index)}.test/`,
      title: 'P',
      lastVisit: NOW - index,
      visitCount: 1
    }))
    const removeMany = vi.fn()
    const clear = vi.fn()
    const removeRange = vi.fn()
    const history = {
      list: ({ limit = 500, after }: { limit?: number, after?: { lastVisit: number, id: number } } = {}) => {
        const from = after === undefined || after.id === 0 ? 0 : rows.findIndex((row) => row.id === after.id) + 1
        return rows.slice(from, from + limit)
      },
      listOrdered: () => [], visit: vi.fn(), remove: vi.fn(), removeMany, removeRange, clear, onChange: () => () => {}
    }
    const fake = fakeContext({ history: history as never })
    installHistory(fake.ctx, () => NOW)
    await fake.call('history.deleteAll')
    expect(clear).not.toHaveBeenCalled()
    expect(removeRange).not.toHaveBeenCalled()
    expect(removeMany).toHaveBeenCalledTimes(1)
    const removed = removeMany.mock.calls[0]?.[0] as number[]
    expect(removed).toHaveLength(total - 1)
    expect(removed).not.toContain(total)
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

  it('sends nothing for a registered app\'s page', () => {
    const s = setup()
    s.service.visit('https://app.example/inbox', 'Inbox')
    expect(s.events).toEqual([])
  })
})
