import { describe, expect, it, vi } from 'vitest'
import { clearBrowsingData, parseClearRequest } from '../clear-data.js'
import type { ClearRequest } from '../clear-data.js'

const NOTHING: ClearRequest = { history: 'none', siteData: false, cache: false, zoomLevels: false, appData: false, siteSettings: false }
const NOW = 10_000_000

function setup (): { deps: Parameters<typeof clearBrowsingData>[1], history: Record<'clear' | 'removeRange', ReturnType<typeof vi.fn>>, zoom: { clear: ReturnType<typeof vi.fn> }, siteSettings: { resetAll: ReturnType<typeof vi.fn> }, websites: { clearData: ReturnType<typeof vi.fn>, clearStorageData: ReturnType<typeof vi.fn> }, app: { clearData: ReturnType<typeof vi.fn> } } {
  const history = { clear: vi.fn(), removeRange: vi.fn() }
  const zoom = { clear: vi.fn() }
  const siteSettings = { resetAll: vi.fn() }
  const websites = { clearData: vi.fn(async () => {}), clearStorageData: vi.fn(async () => {}) }
  const app = { clearData: vi.fn(async () => {}) }
  return { deps: { history, zoom, siteSettings, websites, appSessions: async () => [app, app], now: () => NOW } as never, history, zoom, siteSettings, websites, app }
}

describe('clearing browsing data', () => {
  it('does nothing when nothing is chosen', async () => {
    const { deps, history, zoom, siteSettings, websites, app } = setup()
    expect(await clearBrowsingData(NOTHING, deps)).toEqual({ ok: true, failed: [] })
    expect(siteSettings.resetAll).not.toHaveBeenCalled()
    expect(history.clear).not.toHaveBeenCalled()
    expect(history.removeRange).not.toHaveBeenCalled()
    expect(zoom.clear).not.toHaveBeenCalled()
    expect(websites.clearData).not.toHaveBeenCalled()
    expect(app.clearData).not.toHaveBeenCalled()
  })

  it('forgets history back as far as chosen', async () => {
    const { deps, history } = setup()
    await clearBrowsingData({ ...NOTHING, history: 'hour' }, deps)
    await clearBrowsingData({ ...NOTHING, history: 'day' }, deps)
    await clearBrowsingData({ ...NOTHING, history: 'week' }, deps)
    expect(history.removeRange.mock.calls).toEqual([[NOW - 3_600_000, NOW], [NOW - 86_400_000, NOW], [NOW - 604_800_000, NOW]])
    await clearBrowsingData({ ...NOTHING, history: 'all' }, deps)
    expect(history.clear).toHaveBeenCalledTimes(1)
  })

  it('clears site data and the cache of ordinary websites only, and each on its own', async () => {
    const { deps, websites, app } = setup()
    await clearBrowsingData({ ...NOTHING, siteData: true }, deps)
    expect(websites.clearData).toHaveBeenCalledTimes(1)
    expect(websites.clearData.mock.calls[0]?.[0]).toEqual({ dataTypes: expect.arrayContaining(['cookies', 'localStorage', 'indexedDB']) })
    expect(websites.clearData.mock.calls[0]?.[0].dataTypes).not.toContain('cache')
    // What sites keep through the Cache API goes with them; the HTTP cache stays its own choice.
    expect(websites.clearStorageData).toHaveBeenCalledWith({ storages: ['cachestorage'] })

    await clearBrowsingData({ ...NOTHING, cache: true }, deps)
    expect(websites.clearData).toHaveBeenLastCalledWith({ dataTypes: ['cache'] })
    expect(app.clearData).not.toHaveBeenCalled()
  })

  it('clears every local-files session with site data and with the cache, and not otherwise', async () => {
    const { deps } = setup()
    const shared = { clearData: vi.fn(async () => {}), clearStorageData: vi.fn(async () => {}) }
    const own = { clearData: vi.fn(async () => {}), clearStorageData: vi.fn(async () => {}) }
    const withLocal = { ...deps, localFiles: () => [shared, own] }

    await clearBrowsingData({ ...NOTHING, history: 'all', zoomLevels: true }, withLocal)
    expect(shared.clearData).not.toHaveBeenCalled()

    await clearBrowsingData({ ...NOTHING, siteData: true }, withLocal)
    for (const local of [shared, own]) {
      expect((local.clearData.mock.calls as unknown[][])[0]?.[0]).toEqual({ dataTypes: expect.arrayContaining(['cookies', 'localStorage', 'indexedDB']) })
      expect(local.clearStorageData).toHaveBeenCalledWith({ storages: ['cachestorage'] })
    }

    await clearBrowsingData({ ...NOTHING, cache: true }, withLocal)
    for (const local of [shared, own]) expect(local.clearData).toHaveBeenLastCalledWith({ dataTypes: ['cache'] })
  })

  it('clears an app\'s storage only when asked for by name', async () => {
    const { deps, app, websites } = setup()
    await clearBrowsingData({ ...NOTHING, appData: true }, deps)
    expect(app.clearData).toHaveBeenCalledTimes(2)
    expect(websites.clearData).not.toHaveBeenCalled()
  })

  it('forgets the saved zoom levels', async () => {
    const { deps, zoom } = setup()
    await clearBrowsingData({ ...NOTHING, zoomLevels: true }, deps)
    expect(zoom.clear).toHaveBeenCalledTimes(1)
  })

  it('forgets what each site was allowed or blocked, and only when asked', async () => {
    const { deps, siteSettings, websites } = setup()
    await clearBrowsingData({ ...NOTHING, siteSettings: true }, deps)
    expect(siteSettings.resetAll).toHaveBeenCalledTimes(1)
    expect(websites.clearData).not.toHaveBeenCalled()
  })

  it('says siteSettings failed when forgetting threw, and still clears the rest', async () => {
    const { deps, siteSettings, zoom } = setup()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    siteSettings.resetAll.mockImplementation(() => { throw new Error('disk') })
    const result = await clearBrowsingData({ ...NOTHING, siteSettings: true, zoomLevels: true }, deps)
    error.mockRestore()
    expect(result).toEqual({ ok: false, failed: ['siteSettings'] })
    expect(zoom.clear).toHaveBeenCalledTimes(1)
  })

  it('goes on after one part fails, and says which did', async () => {
    const { deps, websites, history } = setup()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    websites.clearData.mockRejectedValueOnce(new Error('disk'))

    const result = await clearBrowsingData({ ...NOTHING, history: 'all', siteData: true, cache: true }, deps)

    error.mockRestore()
    expect(result).toEqual({ ok: false, failed: ['siteData'] })
    expect(history.clear).toHaveBeenCalledTimes(1)
    expect(websites.clearData).toHaveBeenCalledTimes(2)
  })
})

describe('parseClearRequest', () => {
  it('reads a well-formed request', () => {
    expect(parseClearRequest({ ...NOTHING, history: 'week', cache: true })).toEqual({ ...NOTHING, history: 'week', cache: true })
  })

  it('refuses anything else, and drops fields it does not know', () => {
    expect(parseClearRequest(null)).toBeNull()
    expect(parseClearRequest('all')).toBeNull()
    expect(parseClearRequest({ ...NOTHING, history: 'year' })).toBeNull()
    expect(parseClearRequest({ ...NOTHING, cache: 'yes' })).toBeNull()
    const { appData: _dropped, ...missing } = NOTHING
    expect(parseClearRequest(missing)).toBeNull()
    const { siteSettings: _dropped2, ...noSiteSettings } = NOTHING
    expect(parseClearRequest(noSiteSettings)).toBeNull()
    expect(parseClearRequest({ ...NOTHING, everything: true })).toEqual(NOTHING)
  })
})
