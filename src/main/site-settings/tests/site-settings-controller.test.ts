import { describe, expect, it, vi } from 'vitest'
import type { SiteKindDef, SiteValue } from '../kinds.js'
import { SITE_KINDS } from '../kinds.js'
import { createSiteSettingsController } from '../site-settings-controller.js'
import type { NotificationAnswers, SiteSettingsControllerDeps } from '../site-settings-controller.js'
import { SiteSettingsStore } from '../site-settings-store.js'
import type { SiteDecision } from '../site-settings-store.js'

const SHOP = 'https://shop.example'
const BLOG = 'https://blog.example'
const APP = 'https://app.example'

/** The notifications store as its class keeps it: answers by origin. */
function fakeNotifications (initial: Record<string, SiteDecision> = {}): NotificationAnswers & { map: Map<string, SiteDecision> } {
  const map = new Map(Object.entries(initial))
  const listeners = new Set<() => void>()
  const changed = (): void => { for (const listener of listeners) listener() }
  return {
    map,
    get: (origin) => map.get(origin),
    set: (origin, decision) => { map.set(origin, decision); changed() },
    forget: (origin) => { if (map.delete(origin)) changed() },
    clear: () => { map.clear(); changed() },
    entries: () => [...map].map(([origin, decision]) => ({ origin, decision })),
    onChange: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }
  }
}

function setup (overrides: Partial<SiteSettingsControllerDeps> & { defaults?: Partial<Record<string, SiteValue>> } = {}): { controller: ReturnType<typeof createSiteSettingsController>, store: SiteSettingsStore, notifications: ReturnType<typeof fakeNotifications> } {
  const store = new SiteSettingsStore(null)
  const notifications = fakeNotifications()
  const { defaults = {}, ...rest } = overrides
  const controller = createSiteSettingsController({
    store,
    notifications,
    defaultFor: (kind: SiteKindDef) => defaults[kind.id] ?? kind.values[0] ?? 'ask',
    isApp: (origin) => origin === APP,
    ...rest
  })
  return { controller, store, notifications }
}

const rowOf = (rows: ReturnType<ReturnType<typeof setup>['controller']['rowsFor']>, kind: string): ReturnType<ReturnType<typeof setup>['controller']['rowsFor']>[number] => {
  const row = rows.find((candidate) => candidate.kind === kind)
  if (row === undefined) throw new Error(`no ${kind} row`)
  return row
}

/** A table the content lane's kinds would join: a JavaScript kind that is available, a pop-up kind that is not. */
const WITH_CONTENT: readonly SiteKindDef[] = SITE_KINDS.map((kind) => kind.id === 'javascript' ? { ...kind, available: true } : kind)

describe('rows for one site', () => {
  it('lists every available kind and no other, each following the default until the site has an answer', () => {
    const { controller } = setup()
    const rows = controller.rowsFor(SHOP)
    expect(rows.map((row) => row.kind)).toEqual(SITE_KINDS.filter((kind) => kind.available).map((kind) => kind.id))
    expect(rows.map((row) => row.kind)).not.toContain('devices')
    expect(rows.every((row) => row.value === 'default')).toBe(true)
    expect(rowOf(rows, 'camera')).toMatchObject({ label: 'Camera', defaultValue: 'ask' })
  })

  it('offers the default, Allow and Block for a kind that asks, naming the default', () => {
    const { controller } = setup()
    expect(rowOf(controller.rowsFor(SHOP), 'camera').options).toEqual([
      { value: 'default', label: 'Use default (Ask)' }, { value: 'allow', label: 'Allow' }, { value: 'block', label: 'Block' }
    ])
  })

  it('names a blocking default and leaves out the choice that says the same thing', () => {
    const { controller } = setup({ defaults: { camera: 'block' } })
    expect(rowOf(controller.rowsFor(SHOP), 'camera').options).toEqual([{ value: 'default', label: 'Use default (Block)' }, { value: 'allow', label: 'Allow' }])
  })

  it('keeps a stored answer that equals the default offered, so the select can show it', () => {
    const { controller, store } = setup({ defaults: { camera: 'block' } })
    store.set(SHOP, 'camera', 'block')
    const row = rowOf(controller.rowsFor(SHOP), 'camera')
    expect(row.value).toBe('block')
    expect(row.options.map((option) => option.value)).toEqual(['default', 'allow', 'block'])
  })

  it('reads the content kinds the same way: Use default (Allow) and Block', () => {
    const { controller } = setup({ kinds: WITH_CONTENT })
    expect(rowOf(controller.rowsFor(SHOP), 'javascript')).toMatchObject({ group: 'content', defaultValue: 'allow', options: [{ value: 'default', label: 'Use default (Allow)' }, { value: 'block', label: 'Block' }] })
  })

  it('holds a default the kind does not offer to the kind\'s first choice', () => {
    const { controller } = setup({ defaults: { camera: 'allow' } })
    expect(rowOf(controller.rowsFor(SHOP), 'camera').defaultValue).toBe('ask')
  })

  it('reads notifications from their own store', () => {
    const { controller, notifications } = setup()
    notifications.map.set(SHOP, 'block')
    expect(rowOf(controller.rowsFor(SHOP), 'notifications').value).toBe('block')
  })

  it.each([['an app', APP], ['a page that is not a website', 'ipfs://bafy'], ['an extension', 'chrome-extension://abc'], ['text', 'not an origin'], ['a path, not an origin', 'https://shop.example/page']])('has no rows for %s', (_name, origin) => {
    expect(setup().controller.rowsFor(origin)).toEqual([])
  })
})

describe('changing an answer', () => {
  it('stores Allow and Block per kind and shows them back', () => {
    const { controller, store } = setup()
    expect(controller.set(SHOP, 'camera', 'allow')).toBe(true)
    expect(controller.set(SHOP, 'location', 'block')).toBe(true)
    expect(store.get(SHOP, 'camera')).toBe('allow')
    expect(store.get(SHOP, 'location')).toBe('block')
    expect(rowOf(controller.rowsFor(SHOP), 'camera').value).toBe('allow')
  })

  it('forgets the answer when the choice is the default', () => {
    const { controller, store } = setup()
    controller.set(SHOP, 'camera', 'allow')
    expect(controller.set(SHOP, 'camera', 'default')).toBe(true)
    expect(store.get(SHOP, 'camera')).toBeUndefined()
    expect(store.size).toBe(0)
  })

  it('writes notifications to the notifications store and never the site store', () => {
    const { controller, store, notifications } = setup()
    controller.set(SHOP, 'notifications', 'allow')
    expect(notifications.map.get(SHOP)).toBe('allow')
    expect(store.entries()).toEqual([])
    controller.set(SHOP, 'notifications', 'default')
    expect(notifications.map.has(SHOP)).toBe(false)
  })

  it.each([
    ['a kind that is not available', SHOP, 'devices', 'block'],
    ['an unknown kind', SHOP, 'teleport', 'allow'],
    ['a kind that is not text', SHOP, 3, 'allow'],
    ['a prototype key', SHOP, 'toString', 'allow'],
    ['a value that is not a choice', SHOP, 'camera', 'ask'],
    ['a value that is not text', SHOP, 'camera', { toString: 1 }],
    ['an app', APP, 'camera', 'allow'],
    ['an origin that is not a website', 'ipfs://bafy', 'camera', 'allow'],
    ['a url that is not an origin', 'https://shop.example/page', 'camera', 'allow']
  ])('refuses %s and writes nothing', (_name, origin, kind, value) => {
    const { controller, store, notifications } = setup()
    expect(controller.set(origin, kind, value)).toBe(false)
    expect(store.entries()).toEqual([])
    expect(notifications.map.size).toBe(0)
  })
})

describe('resetting', () => {
  it('forgets every answer of one site, notifications included, and leaves the others', () => {
    const { controller, store, notifications } = setup()
    controller.set(SHOP, 'camera', 'allow')
    controller.set(SHOP, 'notifications', 'block')
    controller.set(BLOG, 'camera', 'block')
    expect(controller.resetSite(SHOP)).toBe(true)
    expect(store.entries()).toEqual([{ origin: BLOG, kind: 'camera', value: 'block' }])
    expect(notifications.map.size).toBe(0)
  })

  it('refuses an origin that is not a website', () => {
    expect(setup().controller.resetSite('javascript:alert(1)')).toBe(false)
  })

  it('forgets everything', () => {
    const { controller, store, notifications } = setup()
    controller.set(SHOP, 'camera', 'allow')
    controller.set(BLOG, 'notifications', 'allow')
    controller.resetAll()
    expect(store.entries()).toEqual([])
    expect(notifications.map.size).toBe(0)
  })
})

describe('the sites with answers of their own', () => {
  it('lists each site once with its answers in the table\'s order, sorted by site', () => {
    const { controller } = setup()
    controller.set(SHOP, 'location', 'block')
    controller.set('https://alpha.example', 'camera', 'allow')
    controller.set(SHOP, 'camera', 'allow')
    controller.set('https://alpha.example', 'notifications', 'block')
    expect(controller.sites()).toEqual([
      { origin: 'https://alpha.example', kinds: [{ kind: 'camera', label: 'Camera', value: 'allow' }, { kind: 'notifications', label: 'Notifications', value: 'block' }] },
      { origin: SHOP, kinds: [{ kind: 'camera', label: 'Camera', value: 'allow' }, { kind: 'location', label: 'Location', value: 'block' }] }
    ])
  })

  it('sorts a plain http site by its host, ignoring the scheme', () => {
    const { controller } = setup()
    controller.set('http://127.0.0.1:8080', 'camera', 'allow')
    controller.set('https://zeta.example', 'camera', 'allow')
    controller.set('http://beta.example', 'camera', 'allow')
    expect(controller.sites().map((site) => site.origin)).toEqual(['http://127.0.0.1:8080', 'http://beta.example', 'https://zeta.example'])
  })

  it('hides a kind that is not available, an app, and anything stored that is not a website', () => {
    const { controller, store, notifications } = setup()
    store.set(SHOP, 'devices', 'block')
    store.set(APP, 'camera', 'allow')
    notifications.map.set(APP, 'allow')
    notifications.map.set('ipfs://bafy', 'allow')
    expect(controller.sites()).toEqual([])
    store.set(SHOP, 'camera', 'block')
    expect(controller.sites().map((site) => site.kinds.map((answer) => answer.kind))).toEqual([['camera']])
  })

  it('shows a kind once it becomes available', () => {
    const { controller, store } = setup({ kinds: WITH_CONTENT })
    store.set(SHOP, 'javascript', 'block')
    expect(controller.sites()).toEqual([{ origin: SHOP, kinds: [{ kind: 'javascript', label: 'JavaScript', value: 'block' }] }])
  })
})

describe('the defaults', () => {
  it('lists the available kinds with the setting that holds each, and a state-or-rule word for each choice', () => {
    const { controller } = setup({ kinds: WITH_CONTENT })
    const defaults = controller.defaults()
    expect(defaults.map((row) => row.kind)).toContain('javascript')
    expect(defaults.map((row) => row.kind)).not.toContain('devices')
    expect(defaults.find((row) => row.kind === 'camera')).toMatchObject({ settingKey: 'sites.camera', group: 'permission', options: [{ value: 'ask', label: 'Ask' }, { value: 'block', label: 'Block' }] })
    expect(defaults.find((row) => row.kind === 'javascript')).toMatchObject({ options: [{ value: 'allow', label: 'Allow' }, { value: 'block', label: 'Block' }] })
  })
})

describe('changes', () => {
  it('tells a listener when either store changed, and stops after the removal', () => {
    const { controller } = setup()
    const listener = vi.fn()
    const off = controller.onChange(listener)
    controller.set(SHOP, 'camera', 'allow')
    controller.set(SHOP, 'notifications', 'allow')
    expect(listener.mock.calls).toEqual([[SHOP], [null]])
    off()
    controller.set(SHOP, 'location', 'allow')
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
