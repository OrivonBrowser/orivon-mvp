import { describe, expect, it, vi } from 'vitest'
import { groupLabelFor, NAV_ICON } from '../settings/nav.js'
import { sectionsFor } from '../settings/sections/index.js'
import { addresses } from '../settings/sections/addresses.js'
import { privacySiteDataRows } from '../settings/sections/privacy-site-data.js'
import type { SitesPart } from '../settings/sites/sites-part.js'
import type { SettingsPart, SettingsPartDef } from '../settings/settings-parts.js'
import { SettingsState } from '../settings/state.js'
import type { OrivonInternal } from '../shared/bridge.js'

const REPLIES: Record<string, unknown> = {
  settings: { descriptions: [], values: {} },
  about: { version: '1.0.0', electron: '1', chromium: '1', node: '1', platform: 'linux', userAgent: 'x', developerMode: false },
  shortcuts: { platform: 'linux', rows: [] },
  privacy: { history: { remembering: true, problem: null, count: 0 }, zoomSites: 0 },
  web3: { view: { state: 'off' }, enabled: false, enabledAtStart: false, forcedOff: false },
  profiles: { profiles: [{ id: 'default', name: 'Default', current: true }], isPrivate: false },
  apps: { apps: [], identity: 'not-started' },
  telemetry: { private: false, consent: 'undecided' },
  sites: { answer: 42 }
}

function setup (defs: readonly SettingsPartDef[]): { state: SettingsState, fire: (topic: string, payload?: unknown) => void, request: ReturnType<typeof vi.fn> } {
  let handler: ((topic: string, payload: unknown) => void) | undefined
  const request = vi.fn(async (domain: string, _command: unknown) => await Promise.resolve(REPLIES[domain]))
  const bridge = { request, onEvent: (listener: (topic: string, payload: unknown) => void) => { handler = listener; return () => {} } } as unknown as OrivonInternal
  return { state: new SettingsState(bridge, defs), fire: (topic, payload) => { handler?.(topic, payload) }, request }
}

describe('Settings parts', () => {
  it('builds each part with the bridge and a way to redraw, and hands it back by name', () => {
    const create = vi.fn((): SettingsPart & { tag: string } => ({ tag: 'mine' }))
    const { state } = setup([{ name: 'sites', create }])
    expect(state.part<SettingsPart & { tag: string }>('sites').tag).toBe('mine')
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ request: expect.any(Function) }), expect.any(Function))
  })

  it('refuses a part nobody registered', () => {
    expect(() => setup([]).state.part('sites')).toThrow('sites')
  })

  it('loads each part once, after the settings', async () => {
    const order: string[] = []
    const load = vi.fn(async () => { order.push('part'); await Promise.resolve() })
    const { state, request } = setup([{ name: 'sites', create: () => ({ load }) }])
    request.mockImplementation(async (domain: string) => { order.push(domain); return await Promise.resolve(REPLIES[domain]) })
    await state.load()
    expect(load).toHaveBeenCalledOnce()
    expect(order.indexOf('part')).toBeGreaterThan(order.indexOf('settings'))
  })

  it('gives an event to the parts until one takes it, and leaves it there', async () => {
    const first = vi.fn((topic: string) => topic === 'sites.changed')
    const second = vi.fn(() => false)
    const { state, fire } = setup([{ name: 'a', create: () => ({ handle: first }) }, { name: 'b', create: () => ({ handle: second }) }])
    await state.load()
    fire('sites.changed', { n: 1 })
    expect(first).toHaveBeenCalledWith('sites.changed', { n: 1 })
    expect(second).not.toHaveBeenCalled()
    fire('other.changed')
    expect(second).toHaveBeenCalledWith('other.changed', undefined)
  })

  it('lets a part redraw the page', () => {
    let redraw: () => void = () => {}
    const { state } = setup([{ name: 'sites', create: (_bridge, notify) => { redraw = notify; return {} } }])
    let redrawn = 0
    state.onChange(() => { redrawn += 1 })
    redraw()
    expect(redrawn).toBe(1)
  })

  it('has no part registered for a feature that has not added one', () => {
    const state = new SettingsState({ request: async () => undefined, onEvent: () => () => {} } as unknown as OrivonInternal)
    expect(() => state.part('addresses')).toThrow()
  })
})

describe('SettingsState.request', () => {
  it('sends a command to a main domain and returns its answer', async () => {
    const { state, request } = setup([])
    await expect(state.request('sites', { type: 'list' })).resolves.toEqual({ answer: 42 })
    expect(request).toHaveBeenCalledWith('sites', { type: 'list' })
  })
})

describe('the sections a feature fills', () => {
  it('starts with the Addresses section empty, and lists it nowhere', async () => {
    expect(addresses).toMatchObject({ id: 'addresses', title: 'Addresses', rows: [] })
    const { state } = setup([{ name: 'sites', create: () => ({ defaults: [] }) as unknown as SitesPart }])
    await state.load()
    const listed = sectionsFor(state).map((section) => section.id)
    expect(listed).not.toContain('addresses')
    expect(listed.slice(0, 3)).toEqual(['appearance', 'search', 'startup'])
  })

  it('has an icon and the Privacy and accounts group for each', () => {
    for (const id of ['sites', 'passwords', 'addresses']) {
      expect(NAV_ICON[id]).toBeTypeOf('function')
      expect(groupLabelFor({ id, title: id, rows: [] }, { id: 'privacy', title: 'Privacy', rows: [] })).toBeNull()
    }
  })

  it('has row lists that add nothing to the sections they join', () => {
    expect(privacySiteDataRows).toEqual([])
  })
})
