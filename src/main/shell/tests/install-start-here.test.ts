import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { FeaturedStore } from '../../newtab/featured-store.js'
import { installStartHere } from '../install-start-here.js'
import { appTabViews } from '../tab-partition.js'

interface Listener { tabCreated?: (contents: unknown) => void, viewReplaced?: (old: unknown, contents: unknown) => void }

function page (url: string): EventEmitter & { getURL: () => string, isDestroyed: () => boolean } {
  return Object.assign(new EventEmitter(), { getURL: () => url, isDestroyed: () => false })
}

function install (over: { isPrivate?: boolean, granted?: string[], appView?: object } = {}): { featured: FeaturedStore, listener: Listener } {
  const featured = new FeaturedStore(null)
  const listener: Listener = {}
  const services = {
    kiosk: false,
    featured,
    tabLifecycle: { subscribe: (added: Listener) => { Object.assign(listener, added) } },
    windows: { findTab: () => over.appView === undefined ? null : { tabId: 't', window: { tabs: { record: () => ({ view: over.appView }) } } } }
  }
  const ctx = { broker: { app: { hasGrantsSync: (origin: string) => (over.granted ?? []).includes(origin) } } }
  installStartHere.install({} as never, services as never, ctx as never, { isPrivate: over.isPrivate === true } as never)
  return { featured, listener }
}

describe('installStartHere', () => {
  it('ticks the second step when a tab finishes loading a .eth name', () => {
    const { featured, listener } = install()
    const tab = page('https://vitalik.eth/')
    listener.tabCreated?.(tab)
    tab.emit('did-finish-load')
    expect(featured.get().start.done).toEqual(['eth'])
  })

  it('ticks nothing for a page that is not a .eth name or an app', () => {
    const { featured, listener } = install()
    const tab = page('https://example.com/')
    listener.tabCreated?.(tab)
    tab.emit('did-finish-load')
    expect(featured.get().start.done).toEqual([])
  })

  it('ticks the first step for a tab of a registered app and for a page of an origin holding a grant', () => {
    const view = {}
    appTabViews.add(view as never)
    const registered = install({ appView: view })
    const first = page('https://app.example/')
    registered.listener.tabCreated?.(first)
    first.emit('did-finish-load')
    expect(registered.featured.get().start.done).toEqual(['app'])

    const granted = install({ granted: ['https://granted.example'] })
    const second = page('https://granted.example/index.html')
    granted.listener.viewReplaced?.(null, second)
    second.emit('did-finish-load')
    expect(granted.featured.get().start.done).toEqual(['app'])
  })

  it('watches nothing in a private session', () => {
    const { featured, listener } = install({ isPrivate: true })
    expect(listener.tabCreated).toBeUndefined()
    expect(featured.get().start.done).toEqual([])
  })

  it('counts a page handed over twice once', () => {
    const { featured, listener } = install()
    const tab = page('https://vitalik.eth/')
    listener.tabCreated?.(tab)
    listener.viewReplaced?.(null, tab)
    expect(tab.listenerCount('did-finish-load')).toBe(2)
    tab.emit('did-finish-load')
    expect(featured.get().start.done).toEqual(['eth'])
  })
})
