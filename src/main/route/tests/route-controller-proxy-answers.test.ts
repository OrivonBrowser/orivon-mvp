// The answers a session gave about which proxy carries a URL stand only for the proxy the session had when it gave them:
// the controller forgets them on either side of every `setProxy`, whether or not that call succeeds. And a session whose
// proxy is being set, or was set by a call the controller stopped waiting for, is not one the controller can say is on a tunnel.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { proxyAnswerFor, proxyMayRunSystemCode, proxySetInFlight, proxySetOverran } from '../proxy-answers.js'
import { guardOfSession, verifierNameGuard } from '../verifier-name-guard.js'
import { createRouteController } from '../route-controller.js'
import type { RouteProxyConfig, RouteSession } from '../route-controller.js'
import { createRouteHub } from '../route-hub.js'
import type { RouteHub } from '../route-hub.js'
import { RouteStore } from '../route-store.js'
import { forgetSystemSettings, systemSettingsAre } from './mirror-status.test-helpers.js'

const APP = 'https://one.example'
const hubs: RouteHub[] = []
beforeEach(() => { systemSettingsAre() })
afterEach(async () => { for (const hub of hubs.splice(0)) await hub.dispose(); forgetSystemSettings() })

type FakeSession = RouteSession & { readonly resolveProxy: ReturnType<typeof vi.fn<(url: string) => Promise<string>>> }

/** A controller over one session whose `setProxy` runs `during` before it answers. */
function setup (during: (session: FakeSession) => Promise<void>, callTimeoutMs?: number, systemConfig?: () => RouteProxyConfig) {
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
    onLogin: () => {},
    ...(callTimeoutMs === undefined ? {} : { callTimeoutMs }),
    ...(systemConfig === undefined ? {} : { systemConfig })
  })
  return { controller, session, store, hub }
}

const NAME = 'https://name.eth/'

describe('the answers a session gave about which proxy carries a URL', () => {
  it('are not kept, so a request asks again even when nothing set the proxy', async () => {
    const { session } = setup(async () => {})
    await proxyAnswerFor(session, NAME)
    await proxyAnswerFor(session, NAME)
    expect(session.resolveProxy).toHaveBeenCalledTimes(2)
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

describe('a session that is leaving a tunnel', () => {
  const details = { url: NAME, resourceType: 'script' }

  it('is judged as one that follows the system while its proxy is being set, however long the controller waited, and is cancelled when that never ends', async () => {
    vi.useFakeTimers()
    try {
      let hang = false
      const releases: Array<() => void> = []
      const { controller, session, store } = setup(async () => { if (hang) await new Promise<void>((done) => { releases.push(done) }) }, 1_000)
      await controller.prepare(APP, session)
      expect(controller.tunnelOf(session)).toBe('socks5')

      // The hub tells the controller, which puts the session back on the system's proxy; the call does not return, and the controller gives up on it and on its retry.
      hang = true
      store.setEntry(APP, 'off')
      await vi.advanceTimersByTimeAsync(5_000)
      expect(controller.tunnelOf(session), 'the controller still records the tunnel').toBe('socks5')
      expect(proxySetInFlight(session)).toBe(true)

      session.resolveProxy.mockResolvedValue('PROXY 10.0.0.1:3128')
      const handler = verifierNameGuard(guardOfSession(session, controller.tunnelOf, () => false))
      const decided = handler(details, {})
      await vi.advanceTimersByTimeAsync(10_000)
      expect(await decided, 'a request there is held and then cancelled, not skipped as a tunnel\'s').toEqual({ cancel: true })
      expect(session.resolveProxy).not.toHaveBeenCalled()

      hang = false
      for (const release of releases) release()
      await vi.advanceTimersByTimeAsync(0)
      expect(proxySetInFlight(session)).toBe(false)
      expect(controller.tunnelOf(session), 'the controller was never told the call ended').toBe('socks5')
      expect(proxySetOverran(session)).toBe(true)
      expect(await verifierNameGuard(guardOfSession(session, controller.tunnelOf, () => false))(details, {}), 'and the proxy is asked about the name').toEqual({ cancel: true })
      expect(session.resolveProxy).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('is skipped as a tunnel\'s once a change of its proxy ended in time', async () => {
    const { controller, session } = setup(async () => {})
    await controller.prepare(APP, session)
    session.resolveProxy.mockResolvedValue('PROXY 127.0.0.1:9999')
    const handler = verifierNameGuard(guardOfSession(session, controller.tunnelOf, () => false))
    const current = { redirectURL: 'https://elsewhere.test/' }
    expect(await handler(details, current)).toBe(current)
    expect(session.resolveProxy).not.toHaveBeenCalled()
  })
})

describe('whether a session may hand a name to the system\'s own code', () => {
  const COPY: RouteProxyConfig = { mode: 'fixed_servers', proxyRules: 'http=proxy.test:3128', proxyBypassRules: '*.eth;*.eth.' }

  it('is no for a session pointed at a front or held shut, and yes again once the session is back on the system\'s config', async () => {
    const { controller, session, store } = setup(async () => {})
    expect(proxyMayRunSystemCode(session), 'a session nothing set').toBe(true)
    await controller.prepare(APP, session)
    expect(proxyMayRunSystemCode(session), 'on the app\'s front').toBe(false)
    store.setEntry(APP, 'off')
    await controller.settled()
    expect(proxyMayRunSystemCode(session), 'back on the system\'s').toBe(true)
  })

  it('is no for a session that took the mirror\'s copy, and yes when the mirror takes it back', async () => {
    let config: RouteProxyConfig = COPY
    const { controller, session } = setup(async () => {}, undefined, () => config)
    await controller.mirrorSystem(session)
    expect(proxyMayRunSystemCode(session), 'on the copy').toBe(false)
    config = { mode: 'system' }
    await controller.systemChanged()
    expect(proxyMayRunSystemCode(session), 'the copy withdrawn').toBe(true)
  })
})
