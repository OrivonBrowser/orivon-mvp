import { describe, expect, it, vi } from 'vitest'
import { forgetRoutesOfGoneApps } from '../forget-watch.js'

const APP = 'https://one.example'

function setup (state: { routed: boolean, registered: boolean, persisted: boolean, apart?: boolean, unreadable?: boolean }) {
  let listener: ((origin: string) => void) | undefined
  const forget = vi.fn()
  const off = vi.fn()
  const stop = forgetRoutesOfGoneApps({
    onGrantsChanged: (next) => { listener = next; return off },
    app: { isRegisteredSync: () => state.registered, persistedAppsSync: () => state.persisted ? [{ origin: APP }] as never : [] }
  }, { forget, hub: { unreadable: () => state.unreadable === true } as never, store: { stateOf: () => state.routed ? 'nym' : undefined, isApartAnywhere: () => state.apart === true } as never })
  return { change: (origin: string) => { listener?.(origin) }, forget, stop, off }
}

describe('forgetting the route of an app that is gone', () => {
  it('clears the route of a routed app once the broker no longer knows it, live or on disk', () => {
    const { change, forget } = setup({ routed: true, registered: false, persisted: false })
    change(APP)
    expect(forget).toHaveBeenCalledWith(APP)
  })

  it('keeps the route of an app that is still registered, or still has its grants on disk', () => {
    const live = setup({ routed: true, registered: true, persisted: false })
    live.change(APP)
    const stored = setup({ routed: true, registered: false, persisted: true })
    stored.change(APP)
    expect(live.forget).not.toHaveBeenCalled()
    expect(stored.forget).not.toHaveBeenCalled()
  })

  it('keeps the route of a website with storage of its own, which was never an app', () => {
    const { change, forget } = setup({ routed: true, registered: false, persisted: false, apart: true })
    change(APP)
    expect(forget).not.toHaveBeenCalled()
  })

  it('forgets nothing while the list of tunnel settings cannot be read, when every origin counts as routed', () => {
    const { change, forget } = setup({ routed: true, registered: false, persisted: false, unreadable: true })
    change('https://an-ordinary-website.example')
    expect(forget).not.toHaveBeenCalled()
  })

  it('leaves an origin with no entry of its own alone, even while the whole browser is on the tunnel and every origin is routed', () => {
    const { change, forget } = setup({ routed: false, registered: false, persisted: false })
    change('https://an-ordinary-website.example')
    expect(forget).not.toHaveBeenCalled()
  })

  it('leaves an app that is not routed alone', () => {
    const { change, forget } = setup({ routed: false, registered: false, persisted: false })
    change(APP)
    expect(forget).not.toHaveBeenCalled()
  })

  it('returns the broker\'s unsubscribe', () => {
    const { stop, off } = setup({ routed: false, registered: false, persisted: false })
    stop()
    expect(stop).toBe(off)
  })
})
