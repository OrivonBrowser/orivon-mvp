// `orivon.net.udpBind`, split out of ./net.ts along Rule 2's seam: a UDP
// socket is one handle that reads and writes, unlike `listen`'s stream of
// further handles (./net-listen.ts), so the two share only the grant choice
// (./net-bind-grant.ts). Takes the broker's own state, like ./net.ts, and
// holds none.

import type { BindScope, Datagram } from '../../contracts/index.js'
import type { HandleTable } from '../handles/handles.js'
import type { FailableUdpSocket } from '../handles/handle-contracts.js'
import type { GrantLedger } from '../grants/grant-ledger.js'
import { fail } from '../errors.js'
import { mapIoError } from '../io-errors.js'
import { checkBind } from '../policy/bind.js'
import { checkConnect } from '../policy/connect.js'
import { GENERIC_PROXY_PROBE_URL, proxyProbeUrl } from '../policy/proxy-guard.js'
import { bindGrantFor, requestedScope } from './net-bind-grant.js'
import type { BoundUdpSocket, CreateBrokerOptions, SendOutcome } from '../broker-contracts.js'

export interface UdpBindOptions {
  readonly deps: CreateBrokerOptions
  readonly handleTable: HandleTable
  readonly ledger: GrantLedger
  readonly canonical: (origin: string) => string
  readonly socketAllowance: (origin: string) => number
}

export function createUdpBind ({ deps, handleTable, ledger, canonical, socketAllowance }: UdpBindOptions): (origin: string, opts: { port: number, scope?: BindScope }) => Promise<FailableUdpSocket> {
  /**
   * Authorises ONE outbound datagram, then sends it.
   *
   * READ LIVE, NOT CAPTURED AT BIND. A UDP socket has no fixed peer, so unlike
   * `connect` there is no single acquisition-time destination to check once --
   * the check has to happen per datagram, and once it does, reading the grant
   * fresh each time is what makes a revoke stop the NEXT DATAGRAM rather than
   * only the next bind. That is the lesson A70 recorded for net.close, applied
   * before it could recur here.
   *
   * `ledger.parsedPatternsFor(grant)` -- not `grant.patterns` a second time --
   * is what stops checkConnect's own `patterns.map(parsePattern)` running once
   * per PACKET: ordinary DHT/tracker traffic calls this hundreds of times a
   * second, which made that parse real, avoidable work on the broker's single
   * UI thread. Safe to reuse across calls for exactly as long as `grant`
   * itself is: see GrantLedger's own doc on why a revoke or a re-grant always
   * hands back a DIFFERENT Grant object, never this same one mutated.
   *
   * NEVER REJECTS, on any path. Its caller's only way to report a rejection is
   * to error the app's WritableStream, which errors it permanently, and a
   * denied destination is ordinary traffic for a P2P app (A87). A resolver
   * failure is 'unreachable' and a denial is 'denied', both as values.
   */
  async function authorisedSend (
    key: string,
    rawSend: BoundUdpSocket['send'],
    datagram: Datagram
  ): Promise<SendOutcome> {
    const grant = ledger.currentGrant(key, 'udp.send')
    if (grant === undefined) return { sent: false, code: 'denied' }

    let decision: Awaited<ReturnType<typeof checkConnect>>
    try {
      // Same T20 ordering as `connect`'s: before `checkConnect` resolves
      // anything, not after.
      if (await deps.proxyConfigured(proxyProbeUrl(datagram.address, datagram.port))) {
        return { sent: false, code: 'denied' }
      }
      decision = await checkConnect(grant.patterns, datagram.address, datagram.port, deps.resolve, ledger.parsedPatternsFor(grant))
    } catch (error) {
      const mapped = mapIoError(error, 'net')
      // The key is omitted, not set to undefined: exactOptionalPropertyTypes
      // is on, and the two are different values across structured clone.
      return mapped.platformCode === undefined
        ? { sent: false, code: mapped.code }
        : { sent: false, code: mapped.code, platformCode: mapped.platformCode }
    }
    if (!decision.allowed) return { sent: false, code: 'denied' }

    // The FIRST checked literal, not the address the app named. checkConnect
    // requires EVERY answer to pass, so any of them is safe to use, and
    // sending to the name a second time would be a second resolution that
    // could answer differently from the one just checked (policy/connect.ts's
    // header -- the same T12 rule dial() follows).
    const [address] = decision.addresses
    if (address === undefined) return { sent: false, code: 'denied' }
    return await rawSend({ ...datagram, address })
  }

  return async function udpBind (origin, opts) {
    const key = canonical(origin)

    // The narrowing, exactly as `connect` does it: what the user GRANTED, never
    // what the manifest declared. `udp.bind.*` and `udp.send` are separate
    // grants, and this one authorises only the bind -- an app that binds
    // successfully still sends nothing until `udp.send` is granted too.
    //
    // The scope picks which grants may authorise the call and which interface
    // `deps.bind` opens (./net-bind-grant.ts).
    const scope = requestedScope(opts.scope, 'net.udpBind')
    const { grant: current, ranges } = bindGrantFor(ledger, key, 'udp.bind', scope, opts.port)

    return await handleTable.run(key, { on: 'grant', grantId: current.id }, async (signal) => {
      let bound: BoundUdpSocket
      try {
        // A bind names no destination to probe (../policy/proxy-guard.ts's
        // own doc on GENERIC_PROXY_PROBE_URL) -- T20 still applies: a raw
        // listening socket is reachable however the person's traffic is
        // routed, proxy or not.
        if (await deps.proxyConfigured(GENERIC_PROXY_PROBE_URL)) {
          throw fail('denied', 'a system proxy is configured; udp.bind refuses to bypass it')
        }
        if (signal.aborted) throw fail('revoked', 'the grant authorising this bind was withdrawn')
        bound = await deps.bind(ranges, signal, scope)
      } catch (error) {
        throw mapIoError(error, 'net')
      }

      if (signal.aborted) {
        // Same reasoning as `connect`'s: `acquire` would refuse this, but its
        // cleanup releases with 'failed' -- silent, and wrong for a socket
        // that is actually bound and holding a port.
        await bound.destroy('revoked')
        throw fail('revoked', 'the grant authorising this bind was withdrawn')
      }

      const entry = handleTable.acquire({
        origin: key,
        kind: 'udpSocket',
        authorisedBy: { by: 'grant', grantId: current.id },
        destroy: bound.destroy,
        socketLimit: socketAllowance(key),
        stillCovered: (patterns) => checkBind(patterns, bound.localPort).allowed
      })

      // BUILT FIELD BY FIELD, NOT SPREAD, unlike `connect`'s socketFields.
      // `droppedInbound` is a GETTER on the adapter's object, and spreading
      // copies its value at spread time -- which is zero, forever. The app
      // would read a counter that never moves and conclude it had lost
      // nothing.
      return {
        readable: bound.readable,
        localAddress: bound.localAddress,
        localPort: bound.localPort,
        get droppedInbound () { return bound.droppedInbound },
        send: async (datagram: Datagram) => await authorisedSend(key, bound.send, datagram),
        id: entry.id,
        closed: entry.closed,
        close: async (): Promise<void> => { await handleTable.release(key, entry.id) },
        fail: (code, platformCode) => { handleTable.fail(key, entry.id, code, platformCode) },
        abort: () => { handleTable.abort(key, entry.id) },
        onUnlink: (listener) => { handleTable.onUnlink(key, entry.id, listener) }
      }
    })
  }
}
