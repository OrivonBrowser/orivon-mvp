// Nym cannot reach a hidden service, and its tunnel looks names up at a public resolver: an onion name must be refused before the
// provider asks for the tunnel, with the reason in words.

import { describe, expect, it, vi } from 'vitest'
import { ONION_NEEDS_TOR } from '../../../broker/route/onion.js'
import type { RoutedUdp } from '../../../broker/route/provider.js'

const sent: string[] = []
const inner: RoutedUdp = {
  send: async (datagram) => { sent.push(datagram.host) },
  onDatagram: () => {},
  onClose: () => {},
  close: async () => {}
}
vi.mock('../../../broker/route/socks5.js', () => ({
  createSocks5Provider: () => ({
    connect: async () => { throw new Error('the tunnel was asked for a connection') },
    udp: async () => inner
  })
}))
const { createNymProvider } = await import('../nym-provider.js')

const signal = new AbortController().signal

describe('an onion name asked of Nym', () => {
  it('is refused as unreachable, in words, before the tunnel is asked for', async () => {
    let ensured = 0
    const provider = createNymProvider({ ensure: async () => { ensured += 1; return { port: 1, secret: 's' } } }, 'user')
    for (const host of ['abc.onion', 'ABC.Onion.']) {
      await expect(provider.connect(host, 80, signal), host).rejects.toMatchObject({ code: 'unreachable', message: ONION_NEEDS_TOR })
    }
    expect(ensured).toBe(0)
  })

  it('is refused in a datagram too, and every other datagram is sent', async () => {
    const provider = createNymProvider({ ensure: async () => ({ port: 1, secret: 's' }) }, 'user')
    const udp = await (provider.udp as NonNullable<typeof provider.udp>)(signal)
    await expect(udp.send({ host: 'abc.onion', port: 53, data: new Uint8Array(1) })).rejects.toMatchObject({ code: 'unreachable', message: ONION_NEEDS_TOR })
    await udp.send({ host: 'example.com', port: 53, data: new Uint8Array(1) })
    await udp.send({ host: '93.184.216.34', port: 53, data: new Uint8Array(1) })
    expect(sent).toEqual(['example.com', '93.184.216.34'])
  })

  it('still reaches a name that is not one', async () => {
    const provider = createNymProvider({ ensure: async () => ({ port: 1, secret: 's' }) }, 'user')
    await expect(provider.connect('example.com', 443, signal)).rejects.toThrow('the tunnel was asked for a connection')
  })
})
