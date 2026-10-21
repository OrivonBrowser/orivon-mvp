import { afterEach, describe, expect, it } from 'vitest'
import { startSocks5Fixture } from '../../../broker/route/tests/socks5-fixture.test-helpers.js'
import type { Socks5Fixture } from '../../../broker/route/tests/socks5-fixture.test-helpers.js'
import { createParentRouteSource } from '../route-source.js'
import type { ParentChannel } from '../route-source.js'
import type { FromNode, ToNode } from '../protocol.js'

const fixtures: Socks5Fixture[] = []
afterEach(async () => {
  while (fixtures.length > 0) await fixtures.pop()?.close()
})

function channel (): ParentChannel & { asked: FromNode[], send: (message: ToNode) => void } {
  const asked: FromNode[] = []
  let listener: ((message: ToNode) => void) | undefined
  return { asked, post: (message) => { asked.push(message) }, listen: (next) => { listener = next }, send: (message) => { listener?.(message) } }
}

describe('where the node\'s process finds its tunnel', () => {
  it('asks main once, signs in with what main answered, and keeps the answer for the next connection', async () => {
    const proxy = await startSocks5Fixture({ preferAuth: true, names: { 'peer.test:1': { host: '127.0.0.1', port: 9 } } })
    fixtures.push(proxy)
    const c = channel()
    const source = createParentRouteSource(c)
    const first = source()
    expect(c.asked).toEqual([{ type: 'route-ask', id: 1 }])
    c.send({ type: 'route', id: 1, endpoint: { host: proxy.host, port: proxy.port, userId: 'orivon-node-x', password: 'pw' } })
    const provider = await first
    expect(await source()).toBe(provider)
    expect(c.asked).toHaveLength(1)
    await provider.connect('peer.test', 1, new AbortController().signal).then((socket) => { socket.destroy() }, () => {})
    expect(proxy.requests[0]).toMatchObject({ userId: 'orivon-node-x', password: 'pw' })
  })

  it('shares one ask among connections made at once', async () => {
    const c = channel()
    const source = createParentRouteSource(c)
    const a = source()
    const b = source()
    expect(c.asked).toHaveLength(1)
    c.send({ type: 'route', id: 1, endpoint: { host: '127.0.0.1', port: 1, userId: 'u', password: 'p' } })
    expect(await a).toBe(await b)
  })

  it('rejects with main\'s reason when there is no tunnel, and asks again next time', async () => {
    const c = channel()
    const source = createParentRouteSource(c)
    const first = source()
    c.send({ type: 'route', id: 1, refusal: 'Nym is switched off' })
    await expect(first).rejects.toThrow('Nym is switched off')
    const second = source()
    expect(c.asked).toHaveLength(2)
    c.send({ type: 'route', id: 2, endpoint: { host: '127.0.0.1', port: 1, userId: 'u', password: 'p' } })
    await second
  })

  it('forgets the address when main says the tunnel moved', async () => {
    const c = channel()
    const source = createParentRouteSource(c)
    const first = source()
    c.send({ type: 'route', id: 1, endpoint: { host: '127.0.0.1', port: 1, userId: 'u', password: 'p' } })
    await first
    c.send({ type: 'route-reset' })
    const next = source()
    expect(c.asked).toHaveLength(2)
    c.send({ type: 'route', id: 2, endpoint: { host: '127.0.0.1', port: 2, userId: 'u', password: 'p' } })
    expect(await next).not.toBe(await first)
  })

  it('gives up when main does not answer, and keeps nothing', async () => {
    const c = channel()
    const source = createParentRouteSource(c, 20)
    await expect(source()).rejects.toThrow('did not answer')
    void source().catch(() => {})
    expect(c.asked).toHaveLength(2)
  })

  it('forgets an address nobody listens on, so the next connection asks again', async () => {
    const c = channel()
    const source = createParentRouteSource(c)
    const first = source()
    c.send({ type: 'route', id: 1, endpoint: { host: '127.0.0.1', port: 1, userId: 'u', password: 'p' } })
    const provider = await first
    await expect(provider.connect('peer.test', 1, new AbortController().signal)).rejects.toBeDefined()
    void source().catch(() => {})
    expect(c.asked).toHaveLength(2)
  })
})
