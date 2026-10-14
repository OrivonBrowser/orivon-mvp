import { describe, expect, it, vi } from 'vitest'
import type { RouteService } from '../../route/route-service.js'
import { nymSourceFor } from '../nym-watch.js'

// The routes are published by a subsystem, so a read or a subscription can come before them. Neither may end
// as a subscription that nothing will ever call.

function fakeRoutes () {
  const listeners = new Set<() => void>()
  const routes = {
    nym: {
      state: () => ({ state: 'ready' }),
      tunnels: () => ({ connecting: 1, ready: 2 }),
      processInfo: () => undefined,
      onChange: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
    }
  } as unknown as RouteService
  return { routes, fire: () => { for (const listener of [...listeners]) listener() }, count: () => listeners.size }
}

describe('the Nym source of the networks popup', () => {
  it('says off, with nothing running, while there are no routes', () => {
    const source = nymSourceFor({ routes: undefined })
    expect(source.state()).toEqual({ state: 'off' })
    expect(source.tunnels()).toEqual({ connecting: 0, ready: 0 })
    expect(source.processInfo()).toBeUndefined()
  })

  it('passes a change on when the routes were there at the subscription', () => {
    const fake = fakeRoutes()
    const listener = vi.fn()
    nymSourceFor({ routes: fake.routes }).onChange(listener)
    fake.fire()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('subscribes when the routes appear after the subscription, at the next read, and tells the listener once', () => {
    const fake = fakeRoutes()
    const ctx: { routes: RouteService | undefined } = { routes: undefined }
    const source = nymSourceFor(ctx)
    const listener = vi.fn()
    source.onChange(listener)
    expect(fake.count()).toBe(0)
    ctx.routes = fake.routes
    expect(source.state()).toEqual({ state: 'ready' })
    expect(fake.count()).toBe(1)
    expect(listener).toHaveBeenCalledTimes(1)
    source.state()
    source.tunnels()
    expect(fake.count()).toBe(1)
    fake.fire()
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('stops listening, at the routes too, when the last listener goes', () => {
    const fake = fakeRoutes()
    const source = nymSourceFor({ routes: fake.routes })
    const stop = source.onChange(() => {})
    const stopOther = source.onChange(() => {})
    expect(fake.count()).toBe(1)
    stop()
    expect(fake.count()).toBe(1)
    stopOther()
    expect(fake.count()).toBe(0)
  })
})
