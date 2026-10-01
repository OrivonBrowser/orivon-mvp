import { describe, expect, it } from 'vitest'
import type { InternalCaller } from '../../pages/internal-ipc.js'
import { createSiteSettingsController } from '../site-settings-controller.js'
import { SiteSettingsStore } from '../site-settings-store.js'
import { sitesDomain } from '../sites-domain.js'

const SHOP = 'https://shop.example'
const caller = { page: 'settings', contents: {} } as unknown as InternalCaller

function setup (isPrivate = false): { ask: (command: unknown) => unknown, store: SiteSettingsStore } {
  const store = new SiteSettingsStore(null)
  const notifications = new Map<string, 'allow' | 'block'>()
  const controller = createSiteSettingsController({
    store,
    notifications: {
      get: (origin) => notifications.get(origin),
      set: (origin, decision) => { notifications.set(origin, decision) },
      forget: (origin) => { notifications.delete(origin) },
      clear: () => { notifications.clear() },
      entries: () => [...notifications].map(([origin, decision]) => ({ origin, decision })),
      onChange: () => () => {}
    },
    defaultFor: (kind) => kind.values[0] ?? 'ask',
    isApp: (origin) => origin === 'https://app.example'
  })
  const domain = sitesDomain(controller, { isPrivate })
  return { ask: (command) => domain.handle(command, caller), store }
}

describe('the sites domain', () => {
  it('is for the Settings page alone', () => {
    expect(sitesDomain({} as never, { isPrivate: false }).pages).toEqual(['settings'])
  })

  it('lists the defaults and the sites with an answer, and says whether the window is private', () => {
    const { ask, store } = setup(true)
    store.set(SHOP, 'camera', 'block')
    const list = ask({ type: 'list' }) as { isPrivate: boolean, defaults: Array<{ kind: string }>, sites: unknown[] }
    expect(list.isPrivate).toBe(true)
    expect(list.defaults.map((row) => row.kind)).toContain('camera')
    expect(list.sites).toEqual([{ origin: SHOP, kinds: [{ kind: 'camera', label: 'Camera', value: 'block' }] }])
  })

  it('answers one site\'s rows, and changes one answer with the rows that follow', () => {
    const { ask, store } = setup()
    expect((ask({ type: 'rows', origin: SHOP }) as { rows: unknown[] }).rows.length).toBeGreaterThan(5)
    const reply = ask({ type: 'set', origin: SHOP, kind: 'microphone', value: 'allow' }) as { ok: boolean, rows: Array<{ kind: string, value: string }> }
    expect(reply.ok).toBe(true)
    expect(reply.rows.find((row) => row.kind === 'microphone')?.value).toBe('allow')
    expect(store.get(SHOP, 'microphone')).toBe('allow')
  })

  it('resets one site and then every site', () => {
    const { ask, store } = setup()
    store.set(SHOP, 'camera', 'allow')
    store.set('https://blog.example', 'camera', 'allow')
    expect(ask({ type: 'resetSite', origin: SHOP })).toEqual({ ok: true })
    expect(store.entries().map((entry) => entry.origin)).toEqual(['https://blog.example'])
    expect(ask({ type: 'resetAll' })).toEqual({ ok: true })
    expect(store.entries()).toEqual([])
  })

  it('refuses a request that is not shaped right, writing nothing', () => {
    const { ask, store } = setup()
    expect(ask(null)).toBeUndefined()
    expect(ask('list')).toBeUndefined()
    expect(ask({ type: 'nope' })).toBeUndefined()
    expect(ask({ type: 'rows', origin: 3 })).toBeUndefined()
    expect(ask({ type: 'set', origin: { toString: 1 }, kind: 'camera', value: 'allow' })).toBeUndefined()
    expect(ask({ type: 'resetSite', origin: ['a'] })).toBeUndefined()
    expect(ask({ type: 'set', origin: SHOP, kind: 'camera', value: 'ask' })).toMatchObject({ ok: false })
    expect(ask({ type: 'set', origin: SHOP, kind: 'popups', value: 'allow' })).toMatchObject({ ok: false })
    expect(ask({ type: 'set', origin: 'https://app.example', kind: 'camera', value: 'allow' })).toMatchObject({ ok: false, rows: [] })
    expect(store.entries()).toEqual([])
  })
})
