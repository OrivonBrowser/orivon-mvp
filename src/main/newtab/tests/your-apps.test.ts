import { describe, expect, it } from 'vitest'
import { AppUseStore } from '../app-use-store.js'
import { createYourApps, yourAppsTiles, YOUR_APPS_TILES, type GrantedApp } from '../your-apps.js'

const app = (host: string, name = host): GrantedApp => ({ origin: `https://${host}`, name })

describe('yourAppsTiles', () => {
  it('lists the most recently used first', () => {
    const use = { 'https://a.example': { usedAt: 100, icon: null }, 'https://b.example': { usedAt: 300, icon: null }, 'https://c.example': { usedAt: 200, icon: null } }
    expect(yourAppsTiles([app('a.example'), app('b.example'), app('c.example')], use).map((tile) => tile.origin))
      .toEqual(['https://b.example', 'https://c.example', 'https://a.example'])
  })

  it('puts an app never used after the ones used, by name', () => {
    const use = { 'https://z.example': { usedAt: 1, icon: null } }
    expect(yourAppsTiles([app('m.example', 'Moon'), app('z.example', 'Zed'), app('b.example', 'Bee')], use).map((tile) => tile.name))
      .toEqual(['Zed', 'Bee', 'Moon'])
  })

  it('shows at most one row of tiles', () => {
    const many = Array.from({ length: YOUR_APPS_TILES + 4 }, (_, i) => app(`app${i}.example`))
    expect(yourAppsTiles(many, {})).toHaveLength(YOUR_APPS_TILES)
  })

  it('is empty when no app holds a grant', () => {
    expect(yourAppsTiles([], { 'https://a.example': { usedAt: 1, icon: null } })).toEqual([])
  })

  it('names an app by its manifest name, else by its host, and carries the icon of its last use', () => {
    const use = { 'https://a.example:8443': { usedAt: 1, icon: 'data:image/png;base64,AAAA' } }
    const tiles = yourAppsTiles([{ origin: 'https://a.example:8443', name: 'https://a.example:8443' }, app('b.example', 'Bee')], use)
    expect(tiles).toEqual([
      { origin: 'https://a.example:8443', name: 'a.example:8443', icon: 'data:image/png;base64,AAAA' },
      { origin: 'https://b.example', name: 'Bee', icon: null }
    ])
  })

  it('lists an origin once', () => {
    expect(yourAppsTiles([app('a.example'), app('a.example')], {})).toHaveLength(1)
  })
})

describe('createYourApps', () => {
  const granted = [app('a.example', 'Alpha'), app('b.example', 'Beta')]
  function make (opts: { isPrivate?: boolean, grants?: () => Promise<readonly GrantedApp[]> } = {}): { store: AppUseStore, apps: ReturnType<typeof createYourApps>, clock: { at: number } } {
    const store = new AppUseStore(null)
    const clock = { at: 1000 }
    const apps = createYourApps({ store, granted: opts.grants ?? (async () => granted), holdsGrant: (url) => url.startsWith('https://a.example') || url.startsWith('https://b.example'), isPrivate: opts.isPrivate ?? false, now: () => clock.at })
    return { store, apps, clock }
  }

  it('moves an app to the front when a tab on it is in front', async () => {
    const { apps, clock } = make()
    apps.noteInFront({ url: 'https://a.example/x', favicon: null })
    clock.at = 5000
    apps.noteInFront({ url: 'https://b.example/', favicon: null })
    expect((await apps.list()).apps.map((tile) => tile.name)).toEqual(['Beta', 'Alpha'])
  })

  it('notes nothing for a page whose origin holds no grant, so a visited site is never recorded', () => {
    const { apps, store } = make()
    apps.noteInFront({ url: 'https://news.example/', favicon: null })
    apps.noteInFront({ url: 'about:blank', favicon: null })
    expect(store.get()).toEqual({})
  })

  it('says whether the window is private, and lists nothing when the broker fails', async () => {
    const { apps } = make({ isPrivate: true, grants: async () => { throw new Error('no broker') } })
    const quiet = console.error
    console.error = () => {}
    try {
      expect(await apps.list()).toEqual({ apps: [], isPrivate: true })
    } finally {
      console.error = quiet
    }
  })
})
