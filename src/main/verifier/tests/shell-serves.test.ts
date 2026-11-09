import { describe, expect, it } from 'vitest'
import type { Session } from 'electron'
import { registerAppOrigin, retireAppOrigin } from '../../../loader/electron/app-partitions.js'
import { isRelayable, relayHandlerFor, relayableOrigins } from '../shell-serves.js'

// Which of the origins the shell serves the verifier's server may hand over: the hosts it answers, on its one port.

function fakeSession (): Session {
  const handled = new Set<string>()
  return { protocol: { isProtocolHandled: (scheme: string) => handled.has(scheme), unhandle: (scheme: string) => { handled.delete(scheme) }, handle: (scheme: string) => { handled.add(scheme) } } } as unknown as Session
}

describe('isRelayable', () => {
  it.each([
    'https://kept.eth',
    'https://sub.kept.eth',
    'https://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi.ipfs.orivon'
  ])('accepts %s', (origin) => {
    expect(isRelayable(origin)).toBe(true)
  })

  it.each([
    ['an ordinary website', 'https://example.com'],
    ['a plain http name', 'http://kept.eth'],
    ['a name on another port, which is another origin the server does not answer', 'https://kept.eth:8443'],
    ['something that is not an origin', 'kept.eth']
  ])('refuses %s', (_what, origin) => {
    expect(isRelayable(origin)).toBe(false)
  })
})

describe('what the host is told and asked for', () => {
  it('is the origins the shell serves that the server answers, and the handler of each', async () => {
    const session = fakeSession()
    const handler = async (): Promise<Response> => new Response('kept')
    registerAppOrigin(session, 'https://relayed.eth', handler)
    registerAppOrigin(session, 'https://ordinary.example', async () => new Response('other'))
    expect(relayableOrigins()).toContain('https://relayed.eth')
    expect(relayableOrigins()).not.toContain('https://ordinary.example')
    expect(relayHandlerFor('https://relayed.eth')).toBe(handler)
    expect(relayHandlerFor('https://ordinary.example')).toBeUndefined()
    retireAppOrigin(session, 'https://relayed.eth')
    retireAppOrigin(session, 'https://ordinary.example')
    expect(relayableOrigins()).not.toContain('https://relayed.eth')
    expect(relayHandlerFor('https://relayed.eth')).toBeUndefined()
  })
})
