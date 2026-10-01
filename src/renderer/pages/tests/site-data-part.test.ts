import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ARM_MS, SiteDataPart } from '../settings/site-data/site-data-part.js'
import type { OrivonInternal } from '../shared/bridge.js'

const SITES = [
  { domain: 'shop.example', hosts: ['shop.example', 'www.shop.example'], cookies: 2, kinds: ['IndexedDB'], bytes: 900 },
  { domain: 'news.example', hosts: ['news.example'], cookies: 1, kinds: [], bytes: null }
]
const HOSTS = [{ host: 'shop.example', cookies: [{ key: '0000000000000001', name: 'a', domain: '.shop.example', path: '/', secure: false, httpOnly: false, session: true, expires: null }] }]

function setup (sites: unknown[] = SITES): { part: SiteDataPart, request: ReturnType<typeof vi.fn>, notify: ReturnType<typeof vi.fn> } {
  const request = vi.fn(async (domain: string, command: { type: string }) => {
    if (domain === 'privacy') return { ok: true, failed: [] }
    switch (command.type) {
      case 'list': return { sites }
      case 'total': return { bytes: 4096 }
      case 'cookies': return { hosts: HOSTS }
      default: return { ok: true }
    }
  })
  const notify = vi.fn()
  return { part: new SiteDataPart({ request } as unknown as OrivonInternal, notify), request, notify }
}

const settled = async (): Promise<void> => { for (let turn = 0; turn < 10; turn++) await Promise.resolve() }

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('the sites list state', () => {
  it('is empty and unmeasured until main answers, then holds the sites and the total', async () => {
    const { part } = setup()
    expect(part.sites).toBeNull()
    expect(part.total).toBeNull()
    await part.load()
    await settled()
    expect(part.sites).toHaveLength(2)
    expect(part.total).toBe(4096)
    expect(part.sort).toBe('size')
  })

  it('does not hold the page up while main measures', async () => {
    const request = vi.fn(() => new Promise(() => {}))
    const part = new SiteDataPart({ request } as unknown as OrivonInternal, () => {})
    await expect(part.load()).resolves.toBeUndefined()
  })

  it('keeps a sort the person chose when the list is read again', async () => {
    const { part } = setup()
    await part.load()
    await settled()
    part.setSort('name')
    await part.reload()
    expect(part.sort).toBe('name')
  })

  it('searches, and starts the page of rows over', async () => {
    const { part } = setup()
    await part.load()
    await settled()
    part.showEverything()
    part.setQuery('news')
    expect(part.rows().shown.map((site) => site.domain)).toEqual(['news.example'])
    expect(part.showAll).toBe(false)
  })

  it('reads a site\'s cookies once, the first time it opens', async () => {
    const { part, request } = setup()
    await part.load()
    await settled()
    await part.toggle('shop.example')
    expect(part.open.has('shop.example')).toBe(true)
    expect(part.hosts.get('shop.example')).toHaveLength(1)
    await part.toggle('shop.example')
    await part.toggle('shop.example')
    expect(request.mock.calls.filter(([, command]) => (command as { type: string }).type === 'cookies')).toHaveLength(1)
  })
})

describe('deleting', () => {
  it('asks twice for a site, and only the second press deletes', async () => {
    const { part, request } = setup()
    await part.load()
    await settled()
    await part.pressDeleteSite('shop.example')
    expect(part.isArmed({ kind: 'site', domain: 'shop.example' })).toBe(true)
    expect(part.isArmed({ kind: 'site', domain: 'news.example' })).toBe(false)
    expect(request.mock.calls.some(([, command]) => (command as { type: string }).type === 'removeSite')).toBe(false)
    await part.pressDeleteSite('shop.example')
    expect(request).toHaveBeenCalledWith('siteData', { type: 'removeSite', domain: 'shop.example' })
    expect(part.armed).toBeNull()
  })

  it('forgets the first press after a while', async () => {
    const { part, request } = setup()
    await part.load()
    await settled()
    await part.pressDeleteSite('shop.example')
    vi.advanceTimersByTime(ARM_MS + 1)
    expect(part.armed).toBeNull()
    await part.pressDeleteSite('shop.example')
    expect(request.mock.calls.some(([, command]) => (command as { type: string }).type === 'removeSite')).toBe(false)
  })

  it('arming one button disarms another', async () => {
    const { part } = setup()
    await part.load()
    await settled()
    await part.pressDeleteSite('shop.example')
    await part.pressDeleteAll()
    expect(part.isArmed({ kind: 'site', domain: 'shop.example' })).toBe(false)
    expect(part.isArmed({ kind: 'all' })).toBe(true)
  })

  it('deletes all site data through Clear browsing data with only site data chosen', async () => {
    const { part, request } = setup()
    await part.load()
    await settled()
    await part.pressDeleteAll()
    await part.pressDeleteAll()
    expect(request).toHaveBeenCalledWith('privacy', { type: 'clear', request: { history: 'none', siteData: true, cache: false, zoomLevels: false, appData: false } })
  })

  it('deletes a cookie at once by its key and reads the list again', async () => {
    const { part, request } = setup()
    await part.load()
    await settled()
    await part.toggle('shop.example')
    request.mockClear()
    await part.removeCookie('shop.example', '0000000000000001')
    expect(request.mock.calls[0]).toEqual(['siteData', { type: 'removeCookie', key: '0000000000000001' }])
    expect(request.mock.calls.some(([, command]) => (command as { type: string }).type === 'list')).toBe(true)
    expect(part.failed).toBe(false)
  })

  it('says so when main could not delete', async () => {
    const { part, request } = setup()
    await part.load()
    await settled()
    request.mockImplementation(async (_domain: string, command: { type: string }) => command.type === 'list' ? { sites: SITES } : command.type === 'total' ? { bytes: 1 } : { ok: false })
    await part.removeCookie('shop.example', '0000000000000001')
    expect(part.failed).toBe(true)
  })
})
