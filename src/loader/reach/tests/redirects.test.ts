import { describe, expect, it } from 'vitest'
import { createRedirectChains, redirectTarget } from '../redirects.js'

describe('redirectTarget', () => {
  it('resolves a relative Location against the request, without its fragment', () => {
    const response = new Response(null, { status: 302, headers: { location: '/next?x=1#frag' } })
    expect(redirectTarget(response, 'https://a.example/start')).toBe('https://a.example/next?x=1')
  })

  it('is undefined for a non-redirect status, a 3xx the loader does not follow, or no Location', () => {
    expect(redirectTarget(new Response('ok', { headers: { location: '/x' } }), 'https://a.example/')).toBeUndefined()
    expect(redirectTarget(new Response(null, { status: 304, headers: { location: '/x' } }), 'https://a.example/')).toBeUndefined()
    expect(redirectTarget(new Response(null, { status: 302 }), 'https://a.example/')).toBeUndefined()
  })

  it('covers every status the Fetch standard follows', () => {
    for (const status of [301, 302, 303, 307, 308]) {
      expect(redirectTarget(new Response(null, { status, headers: { location: 'https://b.example/' } }), 'https://a.example/')).toBe('https://b.example/')
    }
  })
})

describe('createRedirectChains', () => {
  it('counts hops along one chain and forgets a URL once its chain ends', () => {
    const chains = createRedirectChains()
    expect(chains.depthOf('https://a.example/1')).toBe(0)
    chains.record('https://a.example/2', 1)
    expect(chains.depthOf('https://a.example/2')).toBe(1)
    chains.forget('https://a.example/2')
    expect(chains.depthOf('https://a.example/2')).toBe(0)
  })

  it('a hop nobody followed expires, so a later unrelated request for that URL starts at 0', () => {
    let clock = 0
    const chains = createRedirectChains(() => clock)
    chains.record('https://a.example/2', 5)
    clock = 61_000
    expect(chains.depthOf('https://a.example/2')).toBe(0)
  })

  it('stays bounded: past its size the oldest hop is dropped', () => {
    const chains = createRedirectChains()
    for (let i = 0; i <= 1024; i++) chains.record(`https://a.example/${String(i)}`, 1)
    expect(chains.depthOf('https://a.example/0')).toBe(0)
    expect(chains.depthOf('https://a.example/1024')).toBe(1)
  })
})
