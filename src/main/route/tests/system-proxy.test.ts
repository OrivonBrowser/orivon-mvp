import { afterEach, describe, expect, it } from 'vitest'
import { cachingProxyProbe } from '../../../broker/transport/proxy-probe.js'
import { setSystemProxyProbe, systemProxyFor } from '../system-proxy.js'

afterEach(() => { setSystemProxyProbe(undefined) })

// T20 asks the system's proxy through this, never the default session, which is the tunnel's while the whole browser is on it.
describe('the question T20 asks', () => {
  it('is answered by the session that only follows the system, so a tunnel on the default session does not refuse every unrouted app', async () => {
    setSystemProxyProbe(async () => 'DIRECT')
    const probe = cachingProxyProbe(async (url) => await systemProxyFor(url))
    expect(await probe('https://peer.example/')).toBe(false)
  })

  it('still says "a proxy applies" when the system has one', async () => {
    setSystemProxyProbe(async () => 'PROXY corp.example:3128')
    const probe = cachingProxyProbe(async (url) => await systemProxyFor(url))
    expect(await probe('https://peer.example/')).toBe(true)
  })

  it('fails closed before the session exists: a question that cannot be asked counts as a proxy', async () => {
    const probe = cachingProxyProbe(async (url) => await systemProxyFor(url))
    expect(await probe('https://peer.example/')).toBe(true)
  })
})
