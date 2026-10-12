import { describe, expect, it } from 'vitest'
import { isFromHost } from '../host-messages.js'

describe('isFromHost name-scheme', () => {
  it.each([
    ['swarm.eth', 'bzz'],
    ['sub.name.eth', 'ipfs']
  ])('accepts %s under %s', (host, scheme) => {
    expect(isFromHost({ type: 'name-scheme', host, scheme })).toBe(true)
  })

  it.each([
    ['not a .eth name', { host: 'example.com', scheme: 'bzz' }],
    ['an address host', { host: 'bafy.bzz.orivon', scheme: 'bzz' }],
    ['a name spelled in capitals', { host: 'Swarm.eth', scheme: 'bzz' }],
    ['a trailing dot', { host: 'swarm.eth.', scheme: 'bzz' }],
    ['a scheme no protocol serves', { host: 'swarm.eth', scheme: 'gopher' }],
    ['a scheme with its separator', { host: 'swarm.eth', scheme: 'bzz://' }],
    ['no scheme', { host: 'swarm.eth' }],
    ['a host that is not a string', { host: 5, scheme: 'bzz' }]
  ])('refuses %s', (_what, fields) => {
    expect(isFromHost({ type: 'name-scheme', ...fields })).toBe(false)
  })
})
