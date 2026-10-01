import { describe, expect, it } from 'vitest'
import { HistoryService } from '../../../history/history-service.js'
import { SqliteHistoryStore } from '../../../history/sqlite-history-store.js'
import { topSites, topSitesApi } from '../history-api.js'
import { fakeContext } from './api-fixtures.js'

function setup () {
  let now = 1_000_000
  const service = new HistoryService(new SqliteHistoryStore(':memory:'), { get: (() => true) as never, onChange: () => () => {} } as never, null, () => now)
  const fake = fakeContext({ history: service })
  const visit = (url: string, times = 1): void => { for (let each = 0; each < times; each++) { now += 10; service.visit(url, url) } }
  return { service, visit, ...fake }
}

describe('topSites.get', () => {
  it('is registered by a module of its own, gated on topSites', async () => {
    const s = setup()
    topSitesApi.install(s.ctx)
    expect(topSitesApi.permission).toBe('topSites')
    s.visit('https://a.test/', 2)
    expect(await s.call('topSites.get')).toEqual([{ url: 'https://a.test/', title: 'https://a.test/' }])
  })

  it('lists the most visited first, one address per site, at most ten', () => {
    const s = setup()
    s.visit('https://a.test/low', 1)
    s.visit('https://a.test/high', 5)
    for (let site = 0; site < 12; site++) s.visit(`https://site${String(site)}.test/`, 2)
    const sites = topSites(s.ctx)
    expect(sites).toHaveLength(10)
    expect(sites[0]?.url).toBe('https://a.test/high')
    expect(new Set(sites.map((site) => new URL(site.url).host)).size).toBe(10)
  })

  it('leaves out an app\'s pages and what is not a web address', () => {
    const s = setup()
    s.visit('https://app.example/inbox', 9)
    s.visit('ipfs://bafy/', 8)
    s.visit('https://a.test/', 1)
    expect(topSites(s.ctx).map((site) => site.url)).toEqual(['https://a.test/'])
  })

  it('answers an empty list for an empty history', () => {
    expect(topSites(setup().ctx)).toEqual([])
  })
})
