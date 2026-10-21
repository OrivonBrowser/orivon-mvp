import { describe, expect, it } from 'vitest'
import type { Route } from '../../../broker/route/provider.js'
import { reachRouteOf, setReachRoute } from '../reach-route.js'

describe('the route of an app\'s third-party reach', () => {
  it('is none until main supplies routes, and then follows them request by request', () => {
    const provider = { connect: async () => { throw new Error('unused') } }
    expect(reachRouteOf('https://one.example')()).toBeUndefined()

    let route: Route | undefined
    setReachRoute((key) => key === 'https://one.example' ? route : undefined)
    const read = reachRouteOf('https://one.example')

    expect(read()).toBeUndefined()
    route = { provider }
    expect(read()).toBe(provider)
    expect(reachRouteOf('https://two.example')()).toBeUndefined()
  })
})
