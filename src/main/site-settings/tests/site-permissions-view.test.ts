import { describe, expect, it } from 'vitest'
import { createSiteSettingsController } from '../site-settings-controller.js'
import { sitePermissions } from '../site-permissions-view.js'
import { SiteSettingsStore } from '../site-settings-store.js'
import type { SiteKind } from '../kinds.js'

const SHOP = 'https://shop.example'

function setup (requested: SiteKind[] = [], isPrivate = false): { access: ReturnType<typeof sitePermissions>, store: SiteSettingsStore } {
  const store = new SiteSettingsStore(null)
  const controller = createSiteSettingsController({
    store,
    notifications: { get: () => undefined, set: () => {}, forget: () => {}, clear: () => {}, entries: () => [], onChange: () => () => {} },
    defaultFor: (kind) => kind.values[0] ?? 'ask',
    isApp: (origin) => origin === 'https://app.example'
  })
  return { access: sitePermissions({ controller, requested: () => requested, isPrivate }), store }
}

describe('the popover\'s permissions', () => {
  it('lists nothing at first for a site that was never asked and has no answer', () => {
    const view = setup().access.view(SHOP)
    expect(view?.shown).toEqual([])
    expect(view?.rows.length).toBeGreaterThan(5)
    expect(view?.isPrivate).toBe(false)
  })

  it('lists the kinds the page asked about and the kinds with an answer, in the table\'s order', () => {
    const { access, store } = setup(['location'])
    store.set(SHOP, 'camera', 'block')
    expect(access.view(SHOP)?.shown).toEqual(['camera', 'location'])
  })

  it('says a private window forgets its answers', () => {
    expect(setup([], true).access.view(SHOP)?.isPrivate).toBe(true)
  })

  it('has no view for an app or an address that is not a website', () => {
    const { access } = setup()
    expect(access.view('https://app.example')).toBeNull()
    expect(access.view('ipfs://bafy')).toBeNull()
  })

  it('changes one answer and returns the view that follows, listing the kind', () => {
    const { access, store } = setup()
    const view = access.set(SHOP, 'microphone', 'block')
    expect(store.get(SHOP, 'microphone')).toBe('block')
    expect(view?.shown).toEqual(['microphone'])
    expect(view?.rows.find((row) => row.kind === 'microphone')?.value).toBe('block')
  })

  it('answers null for a change it refused, so the popover does not claim one', () => {
    const { access, store } = setup()
    expect(access.set(SHOP, 'devices', 'allow')).toBeNull()
    expect(access.set(SHOP, 'camera', 'sometimes')).toBeNull()
    expect(access.set('https://app.example', 'camera', 'allow')).toBeNull()
    expect(store.entries()).toEqual([])
  })
})
