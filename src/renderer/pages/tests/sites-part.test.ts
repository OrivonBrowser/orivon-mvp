import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrivonInternal } from '../shared/bridge.js'
import { ARM_MS, SitesPart } from '../settings/sites/sites-part.js'
import type { SiteKindRow, SiteSummary } from '../settings/sites/sites-model.js'

const SHOP: SiteSummary = { origin: 'https://shop.example', kinds: [{ kind: 'camera', label: 'Camera', value: 'block' }] }
const BLOG: SiteSummary = { origin: 'https://blog.example', kinds: [{ kind: 'location', label: 'Location', value: 'allow' }] }
const ROWS: SiteKindRow[] = [{ kind: 'camera', label: 'Camera', group: 'permission', value: 'block', defaultValue: 'ask', options: [{ value: 'default', label: 'Ask (default)' }, { value: 'allow', label: 'Allow' }, { value: 'block', label: 'Block' }] }]

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

function setup (sites: SiteSummary[] = [SHOP, BLOG]): { part: SitesPart, request: ReturnType<typeof vi.fn>, notify: ReturnType<typeof vi.fn>, draws: ReturnType<typeof vi.fn>, current: { sites: SiteSummary[] } } {
  const current = { sites }
  const request = vi.fn(async (_domain: string, command: { type: string }) => {
    await Promise.resolve()
    if (command.type === 'list') return { isPrivate: false, defaults: [], sites: current.sites }
    if (command.type === 'rows' || command.type === 'set') return { rows: ROWS }
    return { ok: true }
  })
  const notify = vi.fn()
  const part = new SitesPart({ request } as unknown as OrivonInternal, notify)
  const draws = vi.fn()
  part.subscribe(draws)
  return { part, request, notify, draws, current }
}

const calls = (request: ReturnType<typeof vi.fn>, type: string): unknown[] => request.mock.calls.filter(([, command]) => (command as { type: string }).type === type).map(([, command]) => command)

describe('SitesPart', () => {
  it('is not loaded until main has answered, and ignores an answer it does not recognise', async () => {
    const { part } = setup()
    expect(part.loaded).toBe(false)
    const odd = new SitesPart({ request: async () => await Promise.resolve({ sites: 'nope' }) } as unknown as OrivonInternal, () => {})
    await odd.load()
    expect(odd.loaded).toBe(false)
    await part.load()
    expect(part.loaded).toBe(true)
    expect(part.sites).toEqual([SHOP, BLOG])
  })

  it('narrows by search, drops the "show all" when the search changes, and counts the match', async () => {
    const { part, draws } = setup()
    await part.load()
    part.showEverything()
    part.setQuery('blog')
    expect(part.showAll).toBe(false)
    expect(part.page()).toMatchObject({ matching: 1, hidden: 0 })
    expect(part.page().shown).toEqual([BLOG])
    expect(draws).toHaveBeenCalledTimes(2)
  })

  it('opens a site to its own rows and closes it again', async () => {
    const { part, request } = setup()
    await part.load()
    await part.toggle(SHOP.origin)
    expect(part.open.has(SHOP.origin)).toBe(true)
    expect(part.rows.get(SHOP.origin)).toEqual(ROWS)
    expect(calls(request, 'rows')).toEqual([{ type: 'rows', origin: SHOP.origin }])
    await part.toggle(SHOP.origin)
    expect(part.open.has(SHOP.origin)).toBe(false)
    expect(part.rows.has(SHOP.origin)).toBe(false)
  })

  it('changes one answer in place and shows the rows main answers with', async () => {
    const { part, request } = setup()
    await part.load()
    await part.toggle(SHOP.origin)
    await part.choose(SHOP.origin, 'camera', 'default')
    expect(calls(request, 'set')).toEqual([{ type: 'set', origin: SHOP.origin, kind: 'camera', value: 'default' }])
  })

  it('reloads once for a burst of changes pushed from main, opened rows too, and only takes its own topic', async () => {
    const { part, request, notify } = setup()
    await part.load()
    await part.toggle(SHOP.origin)
    expect(part.handle('history.changed')).toBe(false)
    expect(part.handle('sites.changed')).toBe(true)
    expect(part.handle('sites.changed')).toBe(true)
    await vi.advanceTimersByTimeAsync(1100)
    expect(calls(request, 'list')).toHaveLength(2)
    expect(calls(request, 'rows')).toHaveLength(2)
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('notes a change to a default and leaves the page\'s own event to the page', async () => {
    const { part, request } = setup()
    await part.load()
    expect(part.handle('settings.changed', { key: 'sites.camera', value: 'block' })).toBe(false)
    expect(part.handle('settings.changed', { key: 'search.engine', value: 'x' })).toBe(false)
    await vi.advanceTimersByTimeAsync(1100)
    expect(calls(request, 'list')).toHaveLength(2)
  })

  it('closes a site that lost its last answer', async () => {
    const { part, current } = setup()
    await part.load()
    await part.toggle(SHOP.origin)
    current.sites = [BLOG]
    await part.load()
    expect(part.open.has(SHOP.origin)).toBe(false)
    expect(part.rows.has(SHOP.origin)).toBe(false)
  })

  describe('resetting', () => {
    it('takes two clicks on a site: the first arms, the second asks main and reloads', async () => {
      const { part, request, current } = setup()
      await part.load()
      await part.pressReset(SHOP.origin)
      expect(part.armedReset).toBe(SHOP.origin)
      expect(calls(request, 'resetSite')).toEqual([])
      current.sites = [BLOG]
      await part.pressReset(SHOP.origin)
      expect(part.armedReset).toBeNull()
      expect(calls(request, 'resetSite')).toEqual([{ type: 'resetSite', origin: SHOP.origin }])
      expect(part.sites).toEqual([BLOG])
    })

    it('starts over when the second click is slow, and when another site is pressed', async () => {
      const { part, request } = setup()
      await part.load()
      await part.pressReset(SHOP.origin)
      await vi.advanceTimersByTimeAsync(ARM_MS + 10)
      expect(part.armedReset).toBeNull()
      await part.pressReset(SHOP.origin)
      await part.pressReset(BLOG.origin)
      expect(part.armedReset).toBe(BLOG.origin)
      expect(calls(request, 'resetSite')).toEqual([])
    })

    it('takes two clicks to reset every site', async () => {
      const { part, request, current } = setup()
      await part.load()
      await part.pressResetAll()
      expect(part.armedResetAll).toBe(true)
      current.sites = []
      await part.pressResetAll()
      expect(part.armedResetAll).toBe(false)
      expect(calls(request, 'resetAll')).toHaveLength(1)
      expect(part.sites).toEqual([])
    })
  })
})
