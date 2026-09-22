import { describe, expect, it, vi } from 'vitest'
import { outcomeNow, rejection } from '../handles/tests/handles.test-helpers.js'
import { APP, baseDeps, manifestWith, okSocket, stubFs } from './index.test-helpers.js'
import { createBroker } from '../index.js'
import type { Broker } from '../broker-contracts.js'
import type { CloseReason } from '../handles/handle-contracts.js'

// Re-granting a capability (app.requestGrant for a wider set, or install
// consent after an update) replaces the grant. Live handles the new grant
// still covers must keep running; only the ones it no longer covers are
// revoked.

const ADDRESSES: Record<string, string> = { 'a.example': '93.184.216.34', 'b.example': '93.184.216.35' }

function netBroker (destroyed: CloseReason[][]): Broker {
  return createBroker(baseDeps({
    resolve: async (host) => [ADDRESSES[host] ?? '203.0.113.9'],
    dial: async (addresses) => {
      const reasons: CloseReason[] = []
      destroyed.push(reasons)
      return okSocket({ remoteAddress: addresses[0] ?? '', destroy: vi.fn((reason: CloseReason) => { reasons.push(reason) }) })
    }
  }))
}

async function connectedTo (hosts: readonly string[], granted: readonly string[]): Promise<{ broker: Broker, destroyed: CloseReason[][] }> {
  const destroyed: CloseReason[][] = []
  const broker = netBroker(destroyed)
  await broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['*:*'] } } }))
  await broker.grant(APP, 'tcp.connect', granted)
  for (const host of hosts) await broker.net.connect(APP, { host, port: 443 })
  return { broker, destroyed }
}

describe('replacing a tcp.connect grant', () => {
  it('a wider grant leaves every live socket running', async () => {
    const { broker, destroyed } = await connectedTo(['a.example'], ['a.example:443'])

    await broker.grant(APP, 'tcp.connect', ['a.example:443', 'b.example:443'])

    expect(destroyed).toEqual([[]])
  })

  it('a socket kept across a widening is revoked by revoking the NEW grant', async () => {
    const { broker, destroyed } = await connectedTo(['a.example'], ['a.example:443'])
    const wider = await broker.grant(APP, 'tcp.connect', ['*:*'])

    await broker.revoke(APP, wider.id)

    expect(destroyed).toEqual([['revoked']])
  })

  it('only the sockets the new grant no longer covers are revoked', async () => {
    const { broker, destroyed } = await connectedTo(['a.example', 'b.example'], ['a.example:443', 'b.example:443'])

    await broker.grant(APP, 'tcp.connect', ['b.example:443', 'c.example:443'])

    expect(destroyed).toEqual([['revoked'], []])
  })
})

describe('replacing an fs grant', () => {
  it('leaves an open file usable', async () => {
    const broker = createBroker(baseDeps({ fs: stubFs({ files: new Map([['/apps/app/a.bin', new Uint8Array([7])]]) }) }))
    await broker.registerApp(APP, manifestWith({ fs: {} }))
    await broker.grant(APP, 'fs', [])
    const file = await broker.fs.open(APP, 'a.bin', 'r')

    await broker.grant(APP, 'fs', [])

    expect(await file.read({ position: 0, length: 1 })).toEqual(new Uint8Array([7]))
    expect((await outcomeNow(file.closed)).state).toBe('pending')
  })
})

describe('narrowing a grant still revokes', () => {
  it('a socket the replacement does not cover rejects closed with revoked', async () => {
    const destroyed: CloseReason[][] = []
    const broker = netBroker(destroyed)
    await broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['*:*'] } } }))
    await broker.grant(APP, 'tcp.connect', ['a.example:443'])
    const socket = await broker.net.connect(APP, { host: 'a.example', port: 443 })

    await broker.grant(APP, 'tcp.connect', ['b.example:443'])

    expect((await rejection(socket.closed)).code).toBe('revoked')
  })
})
