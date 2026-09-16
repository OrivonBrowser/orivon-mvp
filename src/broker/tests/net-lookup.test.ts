// orivon.net.lookup at the assembly layer (d-0030) -- the same job
// index.test.ts does for connect: proving createBroker wires the GRANTED
// set (never the manifest's declared one) into ../policy/lookup.ts's own
// decision, then runs the real resolve under the per-origin in-flight
// budget and revocation cascade every other capability already gets.
// ../policy/tests/lookup.test.ts already proves checkLookup's own pattern
// matching in isolation; this file proves createBroker assembles it
// correctly, against a real GrantLedger and HandleTable.

import { describe, expect, it } from 'vitest'
import { never, outcomeNow, rejection } from '../handles/tests/handles.test-helpers.js'
import { APP, baseDeps, manifestWith } from './index.test-helpers.js'
import { createBroker } from '../index.js'
import type { LookupAddress } from '../../contracts/index.js'
import { LIMITS } from '../../contracts/index.js'

describe("orivon.net.lookup is bounded by the app's own held network grant (d-0030)", () => {
  it('denies when the app holds no network grant at all', async () => {
    const broker = createBroker(baseDeps())
    broker.registerApp(APP, manifestWith({}))

    const error = await rejection(broker.net.lookup(APP, { hostname: 'api.example.com' }))

    expect(error.code).toBe('denied')
    // A denial never says why (contracts/errors.ts) -- a platformCode here
    // would leak whether it was the missing grant or the hostname itself.
    expect(error.platformCode).toBeUndefined()
  })

  it('never hands back a private address, so a resolver cannot enumerate the internal network', async () => {
    // The attack this closes: an app holding an ordinary grant asks for a name
    // that resolves inside the user's LAN. `connect` would refuse the result,
    // but an unfiltered lookup still REPORTS it -- the router, the NAS, the
    // intranet host, discoverable by name and carried out over a granted host.
    const broker = createBroker(baseDeps({
      resolveLookup: async () => [{ address: '192.168.1.1', family: 'IPv4' } as const]
    }))
    broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['*:*'] } } }))
    await broker.grant(APP, 'tcp.connect', ['*:*'])

    const error = await rejection(broker.net.lookup(APP, { hostname: 'router.example.com' }))

    // 'unreachable', not 'denied' -- an app must not be able to tell an
    // existing internal name from a non-existent one, one probe at a time.
    expect(error.code).toBe('unreachable')
  })

  it('keeps the public answers when a name resolves to both public and private addresses', async () => {
    // The filter must not turn a legitimate multi-homed answer into a failure.
    const broker = createBroker(baseDeps({
      resolveLookup: async () => [
        { address: '10.0.0.5', family: 'IPv4' } as const,
        { address: '93.184.216.34', family: 'IPv4' } as const
      ]
    }))
    broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['*:*'] } } }))
    await broker.grant(APP, 'tcp.connect', ['*:*'])

    const addresses = await broker.net.lookup(APP, { hostname: 'split.example.com' })

    expect(addresses).toEqual([{ address: '93.184.216.34', family: 'IPv4' }])
  })

  it('resolves a hostname the held tcp.connect grant names, in resolver order (never re-sorted)', async () => {
    const answers: readonly LookupAddress[] = [
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 'IPv6' },
      { address: '93.184.216.34', family: 'IPv4' }
    ]
    const broker = createBroker(baseDeps({ resolveLookup: async () => answers }))
    broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } } }))
    await broker.grant(APP, 'tcp.connect', ['api.example.com:443'])

    const addresses = await broker.net.lookup(APP, { hostname: 'api.example.com' })

    expect(addresses).toEqual(answers)
  })

  it('denies an unrelated hostname a narrow grant does not name -- the exfiltration case', async () => {
    let resolveLookupCalled = false
    const broker = createBroker(baseDeps({
      resolveLookup: async () => { resolveLookupCalled = true; return [{ address: '10.0.0.1', family: 'IPv4' }] }
    }))
    broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } } }))
    await broker.grant(APP, 'tcp.connect', ['api.example.com:443'])

    const error = await rejection(broker.net.lookup(APP, { hostname: 'what-i-stole.attacker.example' }))

    expect(error.code).toBe('denied')
    expect(error.platformCode).toBeUndefined()
    // The exfiltration channel this lane exists to close: the real resolver
    // is never even reached for a name outside the grant -- a DNS query for
    // an attacker-chosen name would itself carry data out, so the refusal
    // has to happen before resolveLookup runs, not merely before the result
    // is returned.
    expect(resolveLookupCalled).toBe(false)
  })

  // d-0031 (docs/open-questions.md A190/A193): checkConnectSecure never
  // resolves a hostname at all -- TLS certificate verification stands in
  // for the address check checkConnect performs -- so unlike tcp.connect
  // and udp.send below, an https.connect-only app never had a broker-
  // exposed way to force a name resolved before net.lookup existed.
  // OUTBOUND_CAPABILITIES (../net-capability.ts) excludes it for exactly
  // that reason. THIS is the test that would have failed before that fix:
  // the union used to include https.connect and this call used to resolve.
  it('denies a lookup under an https.connect-only grant -- https.connect is not a raw-connection capability (d-0031)', async () => {
    let resolveLookupCalled = false
    const broker = createBroker(baseDeps({
      resolveLookup: async () => { resolveLookupCalled = true; return [{ address: '93.184.216.34', family: 'IPv4' }] }
    }))
    broker.registerApp(APP, manifestWith({ net: { https: { connect: ['api.example.com:443'] } } }))
    await broker.grant(APP, 'https.connect', ['api.example.com:443'])

    const error = await rejection(broker.net.lookup(APP, { hostname: 'api.example.com' }))

    expect(error.code).toBe('denied')
    expect(error.platformCode).toBeUndefined()
    expect(resolveLookupCalled).toBe(false)
  })

  it('resolves when the app holds https.connect AND tcp.connect -- narrowing must not refuse an app that also holds a raw-connection grant', async () => {
    const broker = createBroker(baseDeps({ resolveLookup: async () => [{ address: '93.184.216.34', family: 'IPv4' }] }))
    broker.registerApp(APP, manifestWith({
      net: { https: { connect: ['api.example.com:443'] }, tcp: { connect: ['api.example.com:443'] } }
    }))
    await broker.grant(APP, 'https.connect', ['api.example.com:443'])
    await broker.grant(APP, 'tcp.connect', ['api.example.com:443'])

    const addresses = await broker.net.lookup(APP, { hostname: 'api.example.com' })

    expect(addresses).toEqual([{ address: '93.184.216.34', family: 'IPv4' }])
  })

  it('resolves under a udp.send-only grant', async () => {
    const broker = createBroker(baseDeps({ resolveLookup: async () => [{ address: '93.184.216.34', family: 'IPv4' }] }))
    broker.registerApp(APP, manifestWith({ net: { udp: { send: ['tracker.example.com:6881'] } } }))
    await broker.grant(APP, 'udp.send', ['tracker.example.com:6881'])

    const addresses = await broker.net.lookup(APP, { hostname: 'tracker.example.com' })

    expect(addresses).toEqual([{ address: '93.184.216.34', family: 'IPv4' }])
  })

  it('resolves any hostname under an unlimited "*:*" grant', async () => {
    const broker = createBroker(baseDeps({ resolveLookup: async () => [{ address: '93.184.216.34', family: 'IPv4' }] }))
    broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['*:*'] } } }))
    await broker.grant(APP, 'tcp.connect', ['*:*'])

    const addresses = await broker.net.lookup(APP, { hostname: 'anything.example.org' })

    expect(addresses).toEqual([{ address: '93.184.216.34', family: 'IPv4' }])
  })

  // A82's port question, this lane's reading (policy/README.md's design
  // note): a lookup has no port, so a hostname granted only on a port
  // reserved for connect (reserved-ports.ts) still authorises its own
  // lookup -- the app can already force that exact name resolved by
  // replaying the same host:port through net.connect.
  it('resolves a hostname granted only on a reserved connect port', async () => {
    const broker = createBroker(baseDeps({ resolveLookup: async () => [{ address: '93.184.216.34', family: 'IPv4' }] }))
    broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['mail.example.com:25'] } } }))
    await broker.grant(APP, 'tcp.connect', ['mail.example.com:25'])

    const addresses = await broker.net.lookup(APP, { hostname: 'mail.example.com' })

    expect(addresses).toEqual([{ address: '93.184.216.34', family: 'IPv4' }])
  })

  it('rejects unreachable, with a real platformCode, for a permitted name that does not resolve', async () => {
    const broker = createBroker(baseDeps({
      resolveLookup: async () => { throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' }) }
    }))
    broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } } }))
    await broker.grant(APP, 'tcp.connect', ['api.example.com:443'])

    const error = await rejection(broker.net.lookup(APP, { hostname: 'api.example.com' }))

    expect(error.code).toBe('unreachable')
    expect(error.platformCode).toBe('ENOTFOUND')
  })

  it('revoking the authorising grant mid-lookup rejects the pending call with revoked', async () => {
    const broker = createBroker(baseDeps({ resolveLookup: async () => await never<readonly LookupAddress[]>() }))
    broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } } }))
    const g = await broker.grant(APP, 'tcp.connect', ['api.example.com:443'])

    const pending = broker.net.lookup(APP, { hostname: 'api.example.com' })
    await broker.revoke(APP, g.id)

    // outcomeNow, not rejection: an unfixed broker calling deps.resolveLookup
    // outside handleTable.run would otherwise hang this test forever on the
    // never-settling stub, the same reasoning index.test.ts's own fs-budget
    // suite uses for the identical shape of bug.
    const outcome = await outcomeNow(pending)
    expect(outcome.state).toBe('rejected')
    expect(outcome.state === 'rejected' ? outcome.error.code : null).toBe('revoked')
  })

  it('is not cancelled by revoking a DIFFERENT held grant than the one that authorised it', async () => {
    let settle!: (value: readonly LookupAddress[]) => void
    const gate = new Promise<readonly LookupAddress[]>((resolve) => { settle = resolve })
    const broker = createBroker(baseDeps({ resolveLookup: async () => await gate }))
    broker.registerApp(APP, manifestWith({
      net: { tcp: { connect: ['api.example.com:443'] }, udp: { send: ['other.example.com:6881'] } }
    }))
    await broker.grant(APP, 'tcp.connect', ['api.example.com:443'])
    const udpGrant = await broker.grant(APP, 'udp.send', ['other.example.com:6881'])

    // Authorised via tcp.connect (checked first -- net-capability.ts's own
    // OUTBOUND_CAPABILITIES order); revoking the UNRELATED udp.send grant
    // this origin also holds must not touch it, even though udp.send is
    // still part of the same union.
    const pending = broker.net.lookup(APP, { hostname: 'api.example.com' })
    await broker.revoke(APP, udpGrant.id)
    settle([{ address: '93.184.216.34', family: 'IPv4' }])

    await expect(pending).resolves.toEqual([{ address: '93.184.216.34', family: 'IPv4' }])
  })

  it('shares the per-origin in-flight budget with every other capability (T11b)', async () => {
    const broker = createBroker(baseDeps({ resolveLookup: async () => await never<readonly LookupAddress[]>() }))
    broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } } }))
    await broker.grant(APP, 'tcp.connect', ['api.example.com:443'])

    for (let i = 0; i < LIMITS.inFlightOperations; i += 1) {
      void broker.net.lookup(APP, { hostname: 'api.example.com' }).catch(() => {})
    }

    const outcome = await outcomeNow(broker.net.lookup(APP, { hostname: 'api.example.com' }))
    expect(outcome.state).toBe('rejected')
    expect(outcome.state === 'rejected' ? outcome.error.code : null).toBe('limit')
  })
})
