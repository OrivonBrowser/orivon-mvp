import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { rejection } from '../handles/tests/handles.test-helpers.js'
import { APP, baseDeps, manifestWith, okListenedServer, okUdpSocket } from './index.test-helpers.js'
import { createBroker } from '../index.js'
import type { Bind, Broker, CreateBrokerOptions, Listen } from '../broker-contracts.js'
import type { BindScope, Capabilities, CapabilityKind } from '../../contracts/index.js'

type Calls = Mock<(ranges: readonly { lo: number, hi: number }[], scope: BindScope) => void>
type Destroy = Mock<() => void>

// ADR-0034 at the assembly layer, for both inbound families: the scope an app
// asks for picks which grants may authorise the call and which interface the
// adapter is told to open. Holding only a `.local` grant must never produce a
// socket the adapter is told to open on every interface, whatever the app
// passes. The real sockets are in adapters/tests/bind-scope.test.ts.

interface Family {
  readonly name: string
  readonly kind: 'tcp.listen' | 'udp.bind'
  readonly declared: (scopes: Readonly<Record<BindScope, readonly string[]>>) => Capabilities
  readonly open: (broker: Broker, opts: { port: number, scope?: unknown }) => Promise<{ readonly id: string, close: () => Promise<void> }>
  /** A deps override whose adapter records its calls and its teardown. */
  readonly stub: (calls: Calls, destroy: Destroy) => Partial<CreateBrokerOptions>
}

const FAMILIES: readonly Family[] = [
  {
    name: 'listen',
    kind: 'tcp.listen',
    declared: ({ local, network }) => ({ net: { tcp: { listen: { local, network } } } }),
    open: async (broker, opts) => await broker.net.listen(APP, opts as { port: number }),
    stub: (calls, destroy) => ({
      listen: (async (ranges: Parameters<Listen>[0], _signal: AbortSignal, scope: BindScope) => {
        calls(ranges, scope)
        return okListenedServer({ destroy, localAddress: scope === 'local' ? '127.0.0.1' : '0.0.0.0', localPort: ranges[0]?.lo ?? 0 })
      }) as Listen
    })
  },
  {
    name: 'udpBind',
    kind: 'udp.bind',
    declared: ({ local, network }) => ({ net: { udp: { bind: { local, network } } } }),
    open: async (broker, opts) => await broker.net.udpBind(APP, opts as { port: number }),
    stub: (calls, destroy) => ({
      bind: (async (ranges: Parameters<Bind>[0], _signal: AbortSignal, scope: BindScope) => {
        calls(ranges, scope)
        return okUdpSocket({ destroy, localAddress: scope === 'local' ? '127.0.0.1' : '0.0.0.0', localPort: ranges[0]?.lo ?? 0 })
      }) as Bind
    })
  }
]

const LOCAL = ['30000-30010']
const NETWORK = ['30005-30020']

/** A broker whose adapter is the family's stub, holding exactly the grants named (each over its own range). */
async function brokerHolding (family: Family, held: readonly ('local' | 'network')[], proxy = false): Promise<{
  broker: Broker
  calls: Calls
  destroy: Destroy
}> {
  const calls: Calls = vi.fn()
  const destroy: Destroy = vi.fn()
  const broker = createBroker(baseDeps({ ...family.stub(calls, destroy), proxyConfigured: async () => proxy }))
  broker.registerApp(APP, manifestWith(family.declared({ local: LOCAL, network: NETWORK })))
  for (const scope of held) await broker.grant(APP, `${family.kind}.${scope}` as CapabilityKind, scope === 'local' ? LOCAL : NETWORK)
  return { broker, calls, destroy }
}

describe.each(FAMILIES)('$name -- scope picks the grant and the interface', (family) => {
  describe('holding only the .local grant', () => {
    it('opens a local socket when scope is omitted', async () => {
      const { broker, calls } = await brokerHolding(family, ['local'])
      const socket = await family.open(broker, { port: 30003 })
      expect(socket.id).toEqual(expect.any(String))
      expect(calls).toHaveBeenCalledWith([{ lo: 30003, hi: 30003 }], 'local')
    })

    it('opens a local socket when scope is local, and reports the loopback address it bound', async () => {
      const { broker, calls } = await brokerHolding(family, ['local'])
      const socket = await family.open(broker, { port: 30003, scope: 'local' }) as unknown as { localAddress: string }
      expect(calls).toHaveBeenCalledWith([{ lo: 30003, hi: 30003 }], 'local')
      expect(socket.localAddress).toBe('127.0.0.1')
    })

    it('refuses scope network, without reaching the adapter', async () => {
      const { broker, calls } = await brokerHolding(family, ['local'])
      const error = await rejection(family.open(broker, { port: 30003, scope: 'network' }))
      expect(error.code).toBe('denied')
      expect(error.platformCode).toBeUndefined()
      expect(calls).not.toHaveBeenCalled()
    })

    it('refuses a port outside the .local ranges even at scope local', async () => {
      const { broker, calls } = await brokerHolding(family, ['local'])
      expect((await rejection(family.open(broker, { port: 30015 }))).code).toBe('denied')
      expect(calls).not.toHaveBeenCalled()
    })

    it('port 0 asks the adapter to pick inside the .local ranges', async () => {
      const { broker, calls } = await brokerHolding(family, ['local'])
      await family.open(broker, { port: 0 })
      expect(calls).toHaveBeenCalledWith([{ lo: 30000, hi: 30010 }], 'local')
    })
  })

  describe('holding only the .network grant', () => {
    it('serves scope network on every interface', async () => {
      const { broker, calls } = await brokerHolding(family, ['network'])
      await family.open(broker, { port: 30006, scope: 'network' })
      expect(calls).toHaveBeenCalledWith([{ lo: 30006, hi: 30006 }], 'network')
    })

    it('serves scope local from it, still loopback only, because network covers local', async () => {
      const { broker, calls } = await brokerHolding(family, ['network'])
      await family.open(broker, { port: 30006 })
      await family.open(broker, { port: 30007, scope: 'local' })
      expect(calls.mock.calls).toEqual([[[{ lo: 30006, hi: 30006 }], 'local'], [[{ lo: 30007, hi: 30007 }], 'local']])
    })

    it('checks the port against the .network ranges', async () => {
      const { broker } = await brokerHolding(family, ['network'])
      expect((await rejection(family.open(broker, { port: 30001 }))).code).toBe('denied')
      expect((await rejection(family.open(broker, { port: 30001, scope: 'network' }))).code).toBe('denied')
    })
  })

  describe('holding both grants', () => {
    it('a network socket is authorised by the .network grant alone, so revoking .local leaves it open', async () => {
      const { broker, destroy } = await brokerHolding(family, ['local', 'network'])
      await family.open(broker, { port: 30006, scope: 'network' })
      const local = (await broker.app.grants(APP)).find((grant) => grant.capability === `${family.kind}.local`)
      await broker.revoke(APP, local!.id)
      expect(destroy).not.toHaveBeenCalled()
    })

    it('a local socket on a port both cover is tied to the .local grant', async () => {
      const { broker, destroy } = await brokerHolding(family, ['local', 'network'])
      await family.open(broker, { port: 30006 })
      const grants = await broker.app.grants(APP)
      await broker.revoke(APP, grants.find((grant) => grant.capability === `${family.kind}.network`)!.id)
      expect(destroy).not.toHaveBeenCalled()
      await broker.revoke(APP, grants.find((grant) => grant.capability === `${family.kind}.local`)!.id)
      expect(destroy).toHaveBeenCalledWith('revoked')
    })

    it('a local socket on a port only .network covers is tied to it: revoking .network closes it', async () => {
      const { broker, calls, destroy } = await brokerHolding(family, ['local', 'network'])
      await family.open(broker, { port: 30015 })
      expect(calls).toHaveBeenCalledWith([{ lo: 30015, hi: 30015 }], 'local')
      const grants = await broker.app.grants(APP)
      await broker.revoke(APP, grants.find((grant) => grant.capability === `${family.kind}.local`)!.id)
      expect(destroy).not.toHaveBeenCalled()
      await broker.revoke(APP, grants.find((grant) => grant.capability === `${family.kind}.network`)!.id)
      expect(destroy).toHaveBeenCalledWith('revoked')
    })

    it('port 0 at scope local lands in the .local ranges only, never the union', async () => {
      const { broker, calls } = await brokerHolding(family, ['local', 'network'])
      await family.open(broker, { port: 0 })
      expect(calls).toHaveBeenCalledWith([{ lo: 30000, hi: 30010 }], 'local')
    })
  })

  describe('holding neither', () => {
    it('refuses every scope', async () => {
      const { broker, calls } = await brokerHolding(family, [])
      for (const scope of [undefined, 'local', 'network']) {
        expect((await rejection(family.open(broker, { port: 30006, scope }))).code).toBe('denied')
      }
      expect(calls).not.toHaveBeenCalled()
    })
  })

  describe('a scope that is neither local nor network', () => {
    it.each(['lan', 'LOCAL', 'Network', '', ' local', null, 0, 1, true, {}, ['network'], { toString: () => 'network' }])(
      'is invalid, never coerced to either, even holding both grants: %j',
      async (scope) => {
        const { broker, calls } = await brokerHolding(family, ['local', 'network'])
        expect((await rejection(family.open(broker, { port: 30006, scope }))).code).toBe('invalid')
        expect(calls).not.toHaveBeenCalled()
      }
    )
  })

  describe('a configured system proxy (T20)', () => {
    it('refuses a local bind too', async () => {
      const { broker, calls } = await brokerHolding(family, ['local'], true)
      expect((await rejection(family.open(broker, { port: 30006 }))).code).toBe('denied')
      expect(calls).not.toHaveBeenCalled()
    })
  })
})

describe('listen -- the listener registry counts both scopes', () => {
  it('records a local listener for the embedding app, and forgets it on close', async () => {
    const { broker } = await brokerHolding(FAMILIES[0]!, ['local'])
    const server = await broker.net.listen(APP, { port: 30006 })
    expect(broker.embed.holdsListenerSync(APP, 30006)).toBe(true)
    await server.close()
    expect(broker.embed.holdsListenerSync(APP, 30006)).toBe(false)
  })

  it('records a network listener too', async () => {
    const { broker } = await brokerHolding(FAMILIES[0]!, ['network'])
    await broker.net.listen(APP, { port: 30006, scope: 'network' })
    expect(broker.embed.holdsListenerSync(APP, 30006)).toBe(true)
  })
})
