// createRouteFor: a route for a key only while its proxy is set, one provider
// per key, rebuilt only when the proxy it points at changes.

import { describe, expect, it, vi } from 'vitest'
import { createRouteFor } from '../table.js'
import type { RouteTarget } from '../table.js'
import type { RouteProvider } from '../provider.js'

const provider = (): RouteProvider => ({ connect: async () => { throw new Error('unused') } })

describe('createRouteFor', () => {
  it('has no route for a key whose target is absent', () => {
    const routeFor = createRouteFor({ targetFor: () => undefined, providerFor: provider })

    expect(routeFor('https://one.example')).toBeUndefined()
  })

  it('builds one provider per key and reuses it while the target is unchanged', () => {
    const providerFor = vi.fn(provider)
    const routeFor = createRouteFor({ targetFor: () => ({ host: '127.0.0.1', port: 9050 }), providerFor })

    const first = routeFor('https://one.example')
    expect(routeFor('https://one.example')).toBe(first)
    expect(routeFor('https://two.example')).not.toBe(first)
    expect(providerFor).toHaveBeenCalledTimes(2)
    expect(providerFor).toHaveBeenCalledWith('https://one.example', { host: '127.0.0.1', port: 9050 })
  })

  it('reads the target on every call: a switched-off app has no route at once, and a changed proxy builds a new one', () => {
    let target: RouteTarget | undefined = { host: '127.0.0.1', port: 9050 }
    const routeFor = createRouteFor({ targetFor: () => target, providerFor: provider })
    const before = routeFor('https://one.example')

    target = undefined
    expect(routeFor('https://one.example')).toBeUndefined()

    target = { host: '127.0.0.1', port: 9150 }
    const after = routeFor('https://one.example')
    expect(after).toBeDefined()
    expect(after).not.toBe(before)
  })
})
