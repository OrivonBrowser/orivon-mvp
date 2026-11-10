import { afterEach, describe, expect, it, vi } from 'vitest'
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

// A name the verifier serves is never put to the session that stays on the system's own config: its script could resolve it or send it anywhere.
describe('the question T20 asks about a name the verifier serves', () => {
  const NAME = 'https://fixture.eth/'

  it('goes to the session that holds the copy of the system\'s settings, and never to the one that only follows the system', async () => {
    const ordinary = vi.fn(async () => 'PROXY corp.example:3128')
    const routed = vi.fn(async () => 'DIRECT')
    setSystemProxyProbe(ordinary, routed)
    const probe = cachingProxyProbe(async (url) => await systemProxyFor(url))
    expect(await probe(NAME)).toBe(false)
    expect(await probe('https://sub.name.ipfs.orivon:443/')).toBe(false)
    expect(await probe('https://FIXTURE.ETH./')).toBe(false)
    expect(ordinary).not.toHaveBeenCalled()
    expect(routed).toHaveBeenCalledTimes(3)
    expect(await probe('https://peer.example/')).toBe(true)
    expect(ordinary).toHaveBeenCalledExactlyOnceWith('https://peer.example/')
  })

  it('says "a proxy applies" when the copy\'s session cannot answer for the name, without having been asked', async () => {
    const ordinary = vi.fn(async () => 'DIRECT')
    setSystemProxyProbe(ordinary, async () => { throw new Error('the session would hand the name to the system\'s script') })
    const probe = cachingProxyProbe(async (url) => await systemProxyFor(url))
    expect(await probe(NAME)).toBe(true)
    expect(ordinary).not.toHaveBeenCalled()
  })

  it('fails closed before the copy\'s session exists, though the ordinary question can already be asked', async () => {
    const ordinary = vi.fn(async () => 'DIRECT')
    setSystemProxyProbe(ordinary)
    const probe = cachingProxyProbe(async (url) => await systemProxyFor(url))
    expect(await probe(NAME)).toBe(true)
    expect(await probe('https://peer.example/')).toBe(false)
    expect(ordinary).toHaveBeenCalledExactlyOnceWith('https://peer.example/')
  })
})
