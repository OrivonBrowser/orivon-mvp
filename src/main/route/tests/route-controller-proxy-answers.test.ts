// The answers a session gave about which proxy carries a URL stand only for the proxy the session had when it gave them:
// the controller forgets them on either side of every `setProxy`, whether or not that call succeeds.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { proxyAnswerFor } from '../proxy-answers.js'
import { createRouteController } from '../route-controller.js'
import type { RouteSession } from '../route-controller.js'
import { createRouteHub } from '../route-hub.js'
import type { RouteHub } from '../route-hub.js'
import { RouteStore } from '../route-store.js'

const APP = 'https://one.example'
const hubs: RouteHub[] = []
afterEach(async () => { for (const hub of hubs.splice(0)) await hub.dispose() })

type FakeSession = RouteSession & { readonly resolveProxy: ReturnType<typeof vi.fn<(url: string) => Promise<string>>> }

/** A controller over one session whose `setProxy` runs `during` before it answers. */
function setup (during: (session: FakeSession) => Promise<void>) {
  const store = new RouteStore(null)
  store.setEntry(APP, 'socks5')
  const hub = createRouteHub({ store, targetOf: () => ({ host: '127.0.0.1', port: 9050 }), defaultKind: () => 'socks5', everywhere: () => false, providerFor: () => ({ connect: async () => { throw new Error('unused') } }) })
  hubs.push(hub)
  const session: FakeSession = { setProxy: async () => { await during(session) }, closeAllConnections: async () => {}, resolveProxy: vi.fn(async () => 'DIRECT') }
  const controller = createRouteController({
    hub,
    broker: () => ({ dropOrigin: async () => {} }),
    sessionFor: () => session,
    embedPartition: (origin) => `embed:${origin}`,
    allContents: () => [],
    onContentsCreated: () => {},
    onLogin: () => {}
  })
  return { controller, session }
}

const NAME = 'https://name.eth/'

describe('the answers a session gave about which proxy carries a URL', () => {
  it('are kept while nothing sets the proxy', async () => {
    const { session } = setup(async () => {})
    await proxyAnswerFor(session, NAME)
    await proxyAnswerFor(session, NAME)
    expect(session.resolveProxy).toHaveBeenCalledTimes(1)
  })

  it('are not used by a request made while the proxy is being set', async () => {
    const { controller, session } = setup(async (one) => { await proxyAnswerFor(one, NAME) })
    await proxyAnswerFor(session, NAME)

    await controller.prepare(APP, session)

    expect(session.resolveProxy).toHaveBeenCalledTimes(2)
  })

  it('are forgotten once the proxy is set, including an answer asked for while it was being set', async () => {
    const { controller, session } = setup(async (one) => { await proxyAnswerFor(one, NAME) })

    await controller.prepare(APP, session)
    expect(session.resolveProxy).toHaveBeenCalledTimes(1)
    await proxyAnswerFor(session, NAME)

    expect(session.resolveProxy).toHaveBeenCalledTimes(2)
  })

  it('are forgotten too when setting the proxy fails', async () => {
    const { controller, session } = setup(async (one) => { await proxyAnswerFor(one, NAME); throw new Error('no proxy for you') })

    await expect(controller.prepare(APP, session)).rejects.toThrow('no proxy for you')
    await proxyAnswerFor(session, NAME)

    expect(session.resolveProxy).toHaveBeenCalledTimes(2)
  })
})
