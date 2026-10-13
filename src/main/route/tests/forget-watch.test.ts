import { describe, expect, it, vi } from 'vitest'
import { forgetRoutesOfGoneApps } from '../forget-watch.js'

const APP = 'https://one.example'

function setup (state: { routed: boolean, registered: boolean, persisted: boolean }) {
  let listener: ((origin: string) => void) | undefined
  const forget = vi.fn()
  const off = vi.fn()
  const stop = forgetRoutesOfGoneApps({
    onGrantsChanged: (next) => { listener = next; return off },
    app: { isRegisteredSync: () => state.registered, persistedAppsSync: () => state.persisted ? [{ origin: APP }] as never : [] }
  }, { forget, hub: { isRouted: () => state.routed } as never })
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
