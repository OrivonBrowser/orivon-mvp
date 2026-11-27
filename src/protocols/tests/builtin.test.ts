import { describe, expect, it } from 'vitest'
import { BUILTIN_ADDRESSES, BUILTIN_PROTOCOLS } from '../builtin.js'

describe('the built-in protocols', () => {
  it('serve .eth and .og, each its own top-level domain, and keep every id once', () => {
    expect(BUILTIN_PROTOCOLS.map((p) => p.id)).toEqual(['ens', 'og', 'ipfs', 'swarm'])
    expect(BUILTIN_PROTOCOLS.flatMap((p) => p.topLevelDomains)).toEqual(['eth', 'og'])
  })
})

describe('a .og name is routed, shown and canonicalised from the descriptors alone', () => {
  it('is its own origin, served by the verifier, as a .eth name is', () => {
    expect(BUILTIN_ADDRESSES.routedSuffixes()).toEqual(expect.arrayContaining(['eth', 'og']))
    expect(BUILTIN_ADDRESSES.servedName('app.linagee.og')).toEqual({ namespace: '.og', name: 'app.linagee.og' })
    expect(BUILTIN_ADDRESSES.routesToVerifier('linagee.og')).toBe(true)
    expect(BUILTIN_ADDRESSES.nameOrigin('linagee.og')).toBe('https://linagee.og')
  })

  it('is refused in every spelling that would reach DNS, the root-dot one included', () => {
    for (const host of ['linagee.og.', 'linagee.og..', 'LINAGEE.OG']) expect(BUILTIN_ADDRESSES.namesServedHost(host), host).toBe(true)
    expect(BUILTIN_ADDRESSES.routesToVerifier('linagee.og.')).toBe(false)
    expect(BUILTIN_ADDRESSES.routesToVerifier('og')).toBe(false)
    expect(BUILTIN_ADDRESSES.routesToVerifier('linagee.og.example')).toBe(false)
  })

  it('opens from an ipfs:// address typed with it, and is shown as its plain origin until a network is learned', () => {
    expect(BUILTIN_ADDRESSES.servedUrl('ipfs://linagee.og/docs')).toBe('https://linagee.og/docs')
    expect(BUILTIN_ADDRESSES.displayUrl('https://linagee.og/docs')).toBe('https://linagee.og/docs')
    expect(BUILTIN_ADDRESSES.loadingScreenFor('https://linagee.og/')?.title).toBe('Loading')
  })
})
