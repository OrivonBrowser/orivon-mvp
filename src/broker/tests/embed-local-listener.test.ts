// ADR-0047: a local pattern in `web.embed.origins` reaches only a listener
// the embedding app itself holds. `broker.embed.holdsListenerSync` is the
// synchronous question the shell's embed guard asks, answered from what
// `orivon.net.listen` registered: any scope counts, another origin's
// listener never does, and the answer follows the handle's whole life.

import { describe, expect, it } from 'vitest'
import { createBroker } from '../index.js'
import type { Broker } from '../broker-contracts.js'
import { APP, baseDeps, manifestWith, okListenedServer } from './index.test-helpers.js'

const OTHER_APP = 'https://other.example'
const DECLARED = {
  net: { tcp: { listen: { network: ['30000-30010'] } } },
  web: { embed: { origins: ['http://*.localhost:30005'] } }
}

async function brokerListeningOn (ports: readonly number[]): Promise<Broker> {
  const queue = [...ports]
  const broker = createBroker(baseDeps({ listen: async () => okListenedServer({ localPort: queue.shift() ?? 0 }) }))
  broker.registerApp(APP, manifestWith(DECLARED))
  broker.registerApp(OTHER_APP, manifestWith(DECLARED))
  await broker.grant(APP, 'tcp.listen.network', ['30000-30010'])
  await broker.grant(OTHER_APP, 'tcp.listen.network', ['30000-30010'])
  return broker
}

describe('broker.embed.holdsListenerSync', () => {
  it('is false before the app listens', async () => {
    const broker = await brokerListeningOn([30005])
    expect(broker.embed.holdsListenerSync(APP, 30005)).toBe(false)
  })

  it('is true for the port the app listens on, and only that port', async () => {
    const broker = await brokerListeningOn([30005])
    await broker.net.listen(APP, { port: 30005 })
    expect(broker.embed.holdsListenerSync(APP, 30005)).toBe(true)
    expect(broker.embed.holdsListenerSync(APP, 30006)).toBe(false)
  })

  it('records the port the operating system picked for port 0, never the one asked for', async () => {
    const broker = await brokerListeningOn([30007])
    await broker.net.listen(APP, { port: 0 })
    expect(broker.embed.holdsListenerSync(APP, 30007)).toBe(true)
    expect(broker.embed.holdsListenerSync(APP, 0)).toBe(false)
  })

  it('is false for another origin, whichever app holds the port', async () => {
    const broker = await brokerListeningOn([30005])
    await broker.net.listen(OTHER_APP, { port: 30005 })
    expect(broker.embed.holdsListenerSync(OTHER_APP, 30005)).toBe(true)
    expect(broker.embed.holdsListenerSync(APP, 30005)).toBe(false)
  })

  it('answers through the canonical origin, and false for an origin that does not parse', async () => {
    const broker = await brokerListeningOn([30005])
    await broker.net.listen(APP, { port: 30005 })
    expect(broker.embed.holdsListenerSync(`${APP}/some/path`, 30005)).toBe(true)
    expect(broker.embed.holdsListenerSync('not an origin', 30005)).toBe(false)
  })

  it('is false as soon as the app closes the listener', async () => {
    const broker = await brokerListeningOn([30005])
    const server = await broker.net.listen(APP, { port: 30005 })
    await server.close()
    expect(broker.embed.holdsListenerSync(APP, 30005)).toBe(false)
  })

  it('keeps counting the listeners still open when another closes', async () => {
    const broker = await brokerListeningOn([30005, 30006])
    const first = await broker.net.listen(APP, { port: 30005 })
    await broker.net.listen(APP, { port: 30006 })
    await first.close()
    expect(broker.embed.holdsListenerSync(APP, 30005)).toBe(false)
    expect(broker.embed.holdsListenerSync(APP, 30006)).toBe(true)
  })

  it('is false once the grant that authorised the listener is revoked', async () => {
    const broker = await brokerListeningOn([30005])
    await broker.net.listen(APP, { port: 30005 })
    const grant = (await broker.app.grants(APP)).find((g) => g.capability === 'tcp.listen.network')
    await broker.revoke(APP, grant!.id)
    expect(broker.embed.holdsListenerSync(APP, 30005)).toBe(false)
  })

  it('is false when the listener failed on its own', async () => {
    const broker = await brokerListeningOn([30005])
    const server = await broker.net.listen(APP, { port: 30005 })
    server.fail('failed')
    expect(broker.embed.holdsListenerSync(APP, 30005)).toBe(false)
  })
})
