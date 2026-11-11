// The session a lookup about a routed origin is made through.

import { describe, expect, it } from 'vitest'
import { createFetchSessions } from '../fetch-sessions.js'
import { SHARED_ORIGIN } from '../route-hub.js'
import type { RouteHub } from '../route-hub.js'

function rig (options: { routed?: boolean, app?: boolean, profile?: string, shared?: boolean } = {}) {
  const prepared: string[] = []
  const hub = {
    isRouted: (origin: string) => origin === SHARED_ORIGIN ? options.shared === true : options.routed !== false,
    profileFor: () => options.profile
  } as unknown as RouteHub
  const made: string[] = []
  const fetches = createFetchSessions<{ partition: string }>({
    hub,
    isApp: () => options.app !== false,
    sessionFor: (partition) => { made.push(partition); return { partition } },
    defaultSession: () => ({ partition: 'default' }),
    prepare: async (origin) => { prepared.push(origin) }
  })
  return { fetches, prepared, made }
}

describe('the session a lookup about an origin goes through', () => {
  it('is none for an origin that is not routed', async () => {
    expect(await rig({ routed: false }).fetches.forOrigin('https://a.test')).toBeUndefined()
  })

  it('is one of the app\'s own, pointed at its front, made once and made anew after the app is forgotten', async () => {
    const r = rig()
    const first = await r.fetches.forOrigin('https://app.test')
    expect(await r.fetches.forOrigin('https://app.test')).toBe(first)
    expect(r.made).toHaveLength(1)
    expect(r.prepared).toEqual(['https://app.test', 'https://app.test'])
    r.fetches.forget('https://app.test')
    expect(await r.fetches.forOrigin('https://app.test')).not.toBe(first)
    expect(r.made).toHaveLength(2)
  })

  it('is the default session for a website on the whole-browser tunnel, with nothing prepared', async () => {
    const r = rig({ app: false, shared: true })
    expect(await r.fetches.forOrigin('https://site.test')).toEqual({ partition: 'default' })
    expect(r.prepared).toEqual([])
  })

  it('is one of the website\'s own for a website whose entry is the direct profile', async () => {
    const r = rig({ app: false, profile: 'direct', shared: false })
    expect((await r.fetches.forOrigin('https://site.test'))?.partition).toMatch(/^orivon-route-fetch-/)
  })
})
