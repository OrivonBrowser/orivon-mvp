// The WebRTC policy of the pages on the name relay: given when the relay has the session, taken back when it does not, and never
// taken from a page an app's route confined.

import { describe, expect, it } from 'vitest'
import { createRelayConfinement } from '../relay-confinement.js'
import type { ConfinablePage } from '../relay-confinement.js'

interface Page extends ConfinablePage { policy: string, destroyed: boolean }

function rig () {
  const session = {}
  const other = {}
  const pages: Page[] = []
  const state = { relayed: new Set<object>([session]) }
  const confinedByRoute = new WeakSet<Page>()
  const make = (on: object = session): Page => {
    const page: Page = { session: on, policy: 'default', destroyed: false, isDestroyed: () => page.destroyed, setWebRTCIPHandlingPolicy: (policy) => { page.policy = policy } }
    pages.push(page)
    return page
  }
  const confinement = createRelayConfinement<Page>({ allContents: () => pages, onRelay: (on) => state.relayed.has(on), confinedByRoute, policy: 'disable_non_proxied_udp' })
  return { session, other, pages, state, confinedByRoute, make, confinement }
}

describe('the pages of a session on the relay', () => {
  it('are confined when they are made, and the pages of any other session are not', () => {
    const r = rig()
    const relayed = r.make()
    const elsewhere = r.make(r.other)
    r.confinement.created(relayed)
    r.confinement.created(elsewhere)
    expect(relayed.policy).toBe('disable_non_proxied_udp')
    expect(elsewhere.policy).toBe('default')
  })

  it('take the policy when the relay starts and lose it when it stops', () => {
    const r = rig()
    const page = r.make()
    r.state.relayed.clear()
    r.confinement.sync()
    expect(page.policy).toBe('default')
    r.state.relayed.add(r.session)
    r.confinement.sync()
    expect(page.policy).toBe('disable_non_proxied_udp')
    r.state.relayed.clear()
    r.confinement.sync()
    expect(page.policy).toBe('default')
  })

  it('are left alone when an app\'s route confined them, whether or not the relay has the session', () => {
    const r = rig()
    const page = r.make()
    page.policy = 'disable_non_proxied_udp'
    r.confinedByRoute.add(page)
    r.confinement.sync()
    r.state.relayed.clear()
    r.confinement.sync()
    expect(page.policy).toBe('disable_non_proxied_udp')
  })

  it('are no longer the relay\'s once a route took them, so the relay stopping does not undo the route\'s policy', () => {
    const r = rig()
    const page = r.make()
    r.confinement.sync()
    r.confinedByRoute.add(page)
    r.confinement.routed(page)
    r.state.relayed.clear()
    r.confinement.sync()
    expect(page.policy).toBe('disable_non_proxied_udp')
  })

  it('are skipped once destroyed', () => {
    const r = rig()
    const page = r.make()
    page.destroyed = true
    r.confinement.sync()
    expect(page.policy).toBe('default')
  })
})
