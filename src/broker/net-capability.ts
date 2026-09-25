// `orivon.net`'s entry points -- connect, connectSecure, udpBind, listen,
// lookup. Split from ./index.ts along Rule 2's seam (README.md's Design
// notes). SAME DEPENDENCY SHAPE AS ./index.ts ITSELF: the HandleTable,
// GrantLedger and `canonical` it already built are passed in, and nothing
// below holds state of its own.

import type { HandleTable } from './handles/handles.js'
import type { FailableTcpServer, FailableTcpSocket, FailableUdpSocket, HandleEntry } from './handles/handle-contracts.js'
import type { GrantLedger } from './grants/grant-ledger.js'
import { fail } from './errors.js'
import { mapIoError } from './io-errors.js'
import { checkBind } from './policy/bind.js'
import { checkConnect, connectStillAuthorised } from './policy/connect.js'
import { checkLookup } from './policy/lookup.js'
import { createConnectSecure } from './net-connect-secure.js'
import { assertSocketRoom } from './socket-room.js'
import { isPublicUnicast } from './policy/address.js'
import type { BoundUdpSocket, Broker, CreateBrokerOptions, DialedSocket, ListenedServer, SendOutcome } from './broker-contracts.js'
import type { CapabilityKind, Datagram, LookupAddress } from '../contracts/index.js'

/**
 * The two capabilities `orivon.net.lookup` reads a grant from (d-0030,
 * narrowed by d-0031 -- docs/open-questions.md A190/A193), checked in this
 * fixed order so that when both held grants would authorise the same
 * hostname, revocation always scopes to the same one (policy/lookup.ts's
 * own README note, A171). `tcp.listen`/`udp.bind` are excluded on purpose:
 * inbound capabilities name no destination host to match a lookup against.
 *
 * `https.connect` is NOT here, and this is the load-bearing line d-0031
 * decided: `checkConnectSecure` never resolves a hostname at all -- TLS
 * certificate verification stands in for the address check `checkConnect`
 * performs -- and connectSecure resolves only a name its own pattern
 * already matched (./net-connect-secure.ts), so holding only
 * `https.connect` never lets an app force the broker to resolve an
 * arbitrary name. Folding it into this union anyway handed an
 * `https.connect`-only app a DNS-reconnaissance oracle `https.connect`
 * itself never had (A190's own finding). `tcp.connect` and `udp.send` both
 * stay: `connect`'s own pre-resolve gate (`couldAnyPatternMatch`) lets a
 * granted pattern's host through to the real resolver before any address is
 * checked, and `authorisedSend` below reuses `checkConnect` verbatim, so
 * both already let a held pattern force that same resolution today --
 * `net.lookup` under either one hands back a mapping, never a new ability.
 */
const OUTBOUND_CAPABILITIES: readonly CapabilityKind[] = ['tcp.connect', 'udp.send']

export interface NetCapabilityOptions {
  readonly deps: CreateBrokerOptions
  readonly handleTable: HandleTable
  readonly ledger: GrantLedger
  /** Origin normalisation plus the malformed-origin 'internal' throw -- ./index.ts's own `canonical`, shared rather than redefined here. */
  readonly canonical: (origin: string) => string
  /** The origin's socket allowance. A restored app answers from its pinned manifest until it re-registers, which the ledger alone cannot see; defaults to `ledger.socketAllowance`. */
  readonly socketAllowance?: (origin: string) => number
}

/** Builds `Broker['net']` -- see this file's header for why it takes the broker's own state rather than owning any of it. */
export function createNetCapability ({ deps, handleTable, ledger, canonical, socketAllowance = (origin) => ledger.socketAllowance(origin) }: NetCapabilityOptions): Broker['net'] {
  /**
   * Builds a `FailableTcpSocket` over an already-registered handle entry --
   * shared by `connect`'s own direct acquisition and `listen`'s
   * per-accepted-connection one (code-guidelines.md Rule 3: the wrapping is
   * the same idea in both places -- attach the handle-table escape hatches
   * to a live socket's fields -- only how the entry was acquired differs).
   */
  function toFailableSocket (
    key: string,
    entry: HandleEntry,
    socketFields: Omit<DialedSocket, 'destroy'>
  ): FailableTcpSocket {
    return {
      ...socketFields,
      id: entry.id,
      closed: entry.closed,
      close: async (): Promise<void> => { await handleTable.release(key, entry.id) },
      fail: (code, platformCode) => { handleTable.fail(key, entry.id, code, platformCode) },
      abort: () => { handleTable.abort(key, entry.id) },
      onUnlink: (listener) => { handleTable.onUnlink(key, entry.id, listener) }
    }
  }

  async function connect (origin: string, opts: { host: string, port: number }): Promise<FailableTcpSocket> {
    const key = canonical(origin)

    // THE NARROWING. `current.patterns` is what the user granted; nothing
    // below ever reads `manifest.capabilities.net.tcp.connect`, which is what
    // the app DECLARED and may be far wider (open-questions.md A18). An empty
    // grant answers exactly like no grant at all -- checkConnect's own
    // `patterns.length === 0` case -- so there is nothing else to special-case
    // here for "never granted".
    const current = ledger.currentGrant(key, 'tcp.connect')
    if (current === undefined) throw fail('denied', 'tcp.connect is not granted to this origin')

    return await handleTable.run(key, { on: 'grant', grantId: current.id }, async (signal) => {
      // `checkConnect` calls `deps.resolve` internally and does not catch
      // its rejection (policy/connect.ts is pure, and mapping I/O errors is
      // not its job), so a raw DNS failure reaches here unmapped. `deps.dial`
      // rejects raw too. Both need mapIoError; nothing else in this
      // callback throws anything but an OrivonError already, and mapIoError
      // passes those through unchanged.
      let decision: Awaited<ReturnType<typeof checkConnect>>
      let dialed: DialedSocket
      try {
        decision = await checkConnect(current.patterns, opts.host, opts.port, deps.resolve)
        if (!decision.allowed) throw fail('denied', 'the connection was not authorised')
        // Checked here too, not only after `dial` resolves below: without
        // this, a grant revoked while resolve was still pending would still
        // reach `deps.dial`, and correctness would depend entirely on the
        // INJECTED dial implementation independently honouring an
        // already-aborted signal rather than on the broker itself.
        if (signal.aborted) throw fail('revoked', 'the grant authorising this connection was withdrawn')
        assertSocketRoom(handleTable, key, socketAllowance(key))
        dialed = await deps.dial(decision.addresses, opts.port, signal)
      } catch (error) {
        throw mapIoError(error, 'net')
      }

      if (signal.aborted) {
        // The grant was withdrawn while `dial` was in flight. `acquire`
        // below would still refuse to register this socket, but its own
        // cleanup path releases it with reason 'failed' -- silent fd
        // release, the right answer for a registration that never got a
        // resource, and the WRONG one here: `dialed` is a live, connected
        // socket that needs a proper revoked-style teardown, not silence.
        // Handling it here rather than leaning on `acquire`'s refusal is
        // exactly what HandleTable.run's own note asks the connect path to
        // do (./handles/handles.ts).
        await dialed.destroy('revoked')
        throw fail('revoked', 'the grant authorising this connection was withdrawn')
      }

      const { destroy, ...socketFields } = dialed
      const entry = handleTable.acquire({
        origin: key,
        kind: 'tcpSocket',
        authorisedBy: { by: 'grant', grantId: current.id },
        destroy,
        socketLimit: socketAllowance(key),
        stillCovered: (patterns) => connectStillAuthorised(patterns, opts.host, socketFields.remoteAddress, opts.port)
      })

      return toFailableSocket(key, entry, socketFields)
    })
  }

  /** `orivon.net.connectSecure` (ADR-0017) -- ./net-connect-secure.ts, sharing this file's state and `toFailableSocket`. */
  const connectSecure = createConnectSecure({ deps, handleTable, ledger, canonical, socketAllowance, toFailableSocket })

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

  async function udpBind (origin: string, opts: { port: number }): Promise<FailableUdpSocket> {
    const key = canonical(origin)

    // The narrowing, exactly as `connect` does it: what the user GRANTED, never
    // what the manifest declared. `udp.bind.network` and `udp.send` are
    // separate grants, and this one authorises only the bind -- an app that
    // binds successfully still sends nothing until `udp.send` is granted too.
    //
    // ONLY `.network` IS CHECKED HERE (ADR-0034): `opts` carries no `scope`
    // parameter, and `deps.bind` binds every interface regardless of which
    // grant authorised the call, so checking `.network` is what matches the
    // adapter's actual reach. A `udp.bind.local` grant is not consulted by
    // this function and authorises nothing through it.
    const current = ledger.currentGrant(key, 'udp.bind.network')
    if (current === undefined) throw fail('denied', 'udp.bind.network is not granted to this origin')

    return await handleTable.run(key, { on: 'grant', grantId: current.id }, async (signal) => {
      let bound: BoundUdpSocket
      try {
        const decision = checkBind(current.patterns, opts.port)
        if (!decision.allowed) throw fail('denied', 'the bind was not authorised')
        if (signal.aborted) throw fail('revoked', 'the grant authorising this bind was withdrawn')
        bound = await deps.bind(decision.ranges, signal)
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

  /**
   * `checkBind` is shared with `udpBind` above -- its own header has always
   * anticipated a second caller (policy/bind.ts). What differs from `udpBind`
   * is everything downstream of the check: a listener produces a STREAM of
   * further handles rather than being one itself.
   */
  async function listen (origin: string, opts: { port: number }): Promise<FailableTcpServer> {
    const key = canonical(origin)

    // ONLY `.network` IS CHECKED HERE (ADR-0034): see `udpBind`'s own note
    // above, which applies unchanged -- `deps.listen` binds every interface
    // regardless of which grant authorised the call.
    const current = ledger.currentGrant(key, 'tcp.listen.network')
    if (current === undefined) throw fail('denied', 'tcp.listen.network is not granted to this origin')

    return await handleTable.run(key, { on: 'grant', grantId: current.id }, async (signal) => {
      let listened: ListenedServer
      try {
        const decision = checkBind(current.patterns, opts.port)
        if (!decision.allowed) throw fail('denied', 'the listen was not authorised')
        if (signal.aborted) throw fail('revoked', 'the grant authorising this listen was withdrawn')
        listened = await deps.listen(decision.ranges, signal)
      } catch (error) {
        throw mapIoError(error, 'net')
      }

      if (signal.aborted) {
        // Same reasoning as `connect`'s and `udpBind`'s: `acquire` would
        // refuse this, but its cleanup releases with 'failed' -- silent, and
        // wrong for a listener that is actually bound and holding a port.
        await listened.destroy('revoked')
        throw fail('revoked', 'the grant authorising this listen was withdrawn')
      }

      const entry = handleTable.acquire({
        origin: key,
        kind: 'tcpServer',
        authorisedBy: { by: 'grant', grantId: current.id },
        destroy: listened.destroy,
        socketLimit: socketAllowance(key),
        stillCovered: (patterns) => checkBind(patterns, listened.localPort).allowed
      })

      // `highWaterMark: 0`: handle-contracts.md's "TcpServer" section --
      // "the broker never pre-accepts a connection the app has not asked for
      // by reading. Each read accepts exactly one pending connection." WHATWG
      // streams call `pull()` on demand once a reader's `read()` finds the
      // internal queue empty, which is exactly once per app read at hwm 0 --
      // no explicit queuing strategy needed for a one-item-per-pull stream.
      const connections = new ReadableStream<FailableTcpSocket>({
        async pull (controller) {
          let accepted: DialedSocket | null
          try {
            accepted = await listened.accept()
          } catch (error) {
            // ListenedServer.accept's own doc: rejects for an ABRUPT close
            // reason, which is exactly this stream's revoked/failed case.
            controller.error(mapIoError(error, 'net'))
            return
          }
          if (accepted === null) {
            // A graceful close ('closed'/'sessionEnded') -- ListenedServer's
            // own contract for what null means.
            controller.close()
            return
          }

          const { destroy, ...socketFields } = accepted
          try {
            const childEntry = handleTable.acquireDerived({
              origin: key,
              kind: 'tcpSocket',
              parentId: entry.id,
              destroy,
              socketLimit: socketAllowance(key)
            })
            controller.enqueue(toFailableSocket(key, childEntry, socketFields))
          } catch {
            // The server's own grant was revoked, or this origin's socket
            // budget is exhausted, in the window between accept() resolving
            // and registration. Discarding this one connection rather than
            // erroring the whole stream matches `authorisedSend`'s own
            // reasoning for udp.send (A87): one rejected item is not the
            // same failure as the capability itself being gone, and the app
            // can simply read again for the next connection.
            await destroy('failed')
          }
        }
      }, { highWaterMark: 0 })

      return {
        connections,
        localAddress: listened.localAddress,
        localPort: listened.localPort,
        id: entry.id,
        closed: entry.closed,
        close: async (): Promise<void> => { await handleTable.release(key, entry.id) },
        fail: (code, platformCode) => { handleTable.fail(key, entry.id, code, platformCode) },
        onUnlink: (listener) => { handleTable.onUnlink(key, entry.id, listener) }
      }
    })
  }

  /**
   * `orivon.net.lookup` (d-0030, narrowed by d-0031). Reads across
   * OUTBOUND_CAPABILITIES above -- unlike `connect`/`connectSecure`/
   * `udpBind`, there is no single capability this rides, because holding
   * EITHER of the two already lets `hostname` be force-resolved today
   * (policy/lookup.ts's own header, and policy/README.md's design note on
   * why that makes a host-only check safe). `connectSecure`'s own
   * `https.connect` grant is deliberately absent from that list -- see
   * OUTBOUND_CAPABILITIES's own doc for why.
   *
   * THE FIRST MATCHING GRANT, not every one that would match: `checkLookup`
   * is cheap and pure, so checking each held grant in turn costs nothing,
   * and picking one fixes which grant's revocation cancels this call below --
   * see OUTBOUND_CAPABILITIES's own doc for why a fixed order matters.
   *
   * NO HANDLE IS ACQUIRED. Unlike every other method in this file, `lookup`
   * produces no live resource to revoke or close later -- it resolves once
   * and hands back plain data -- so `handleTable.run` is used only for its
   * other two jobs: the per-origin in-flight budget (T11b) and cancelling a
   * slow resolution the instant the authorising grant is revoked, the same
   * guarantee `connect`'s own mid-dial abort gives a socket that never
   * finished connecting.
   */
  async function lookup (origin: string, opts: { hostname: string }): Promise<readonly LookupAddress[]> {
    const key = canonical(origin)

    let grantId: string | undefined
    let hostname: string | undefined
    let answers: readonly LookupAddress[] | undefined
    for (const capability of OUTBOUND_CAPABILITIES) {
      const grant = ledger.currentGrant(key, capability)
      if (grant === undefined) continue
      const decision = checkLookup(grant.patterns, opts.hostname)
      if (decision.allowed) { grantId = grant.id; hostname = decision.hostname; answers = decision.answers; break }
    }
    if (grantId === undefined || hostname === undefined) {
      throw fail('denied', 'the hostname was not authorised by any held network grant')
    }
    // `localhost` under a pattern naming it: the answer is a constant, so
    // there is nothing to resolve (policy/lookup.ts).
    if (answers !== undefined) return answers
    const authorisedHostname = hostname

    return await handleTable.run(key, { on: 'grant', grantId }, async (signal) => {
      // Same reasoning as every other method's mid-check guard: without
      // this, a grant revoked in the window between the loop above and
      // `run` actually starting `deps.resolveLookup` would still let the
      // real DNS call go ahead for a capability the app no longer holds.
      if (signal.aborted) throw fail('revoked', 'the grant authorising this lookup was withdrawn')
      let resolved: readonly LookupAddress[]
      try {
        resolved = await deps.resolveLookup(authorisedHostname)
      } catch (error) {
        throw mapIoError(error, 'net')
      }

      // A RESOLVER IS A NETWORK SCANNER IF ITS ANSWERS ARE NOT FILTERED, and
      // `checkLookup` cannot catch this because it decides on the NAME, before
      // any address exists. `connect` refuses a private, loopback or
      // link-local result for both pattern kinds that authorise a lookup
      // (policy/connect-patterns.ts: `any-public-unicast` and `hostname` both
      // end in `isPublicUnicast(address)`), so returning one here would hand an
      // app the internal addresses of a network it can never reach -- the
      // user's router, NAS and intranet hosts, enumerated by name and carried
      // out over a granted host. d-0030 bounds a lookup by the network grant
      // the app already holds; an address that grant could never connect to is
      // outside that bound, so the same rule decides both.
      const reachable = resolved.filter((entry) => isPublicUnicast(entry.address))

      // 'unreachable', NOT 'denied', and not an empty array: an app must not be
      // able to tell "this internal name exists" from "this name does not
      // resolve", which a distinguishable answer here would leak one probe at a
      // time. It is also the honest code -- nothing resolvable is reachable.
      if (reachable.length === 0) throw fail('unreachable', 'the hostname resolved to no address this app can reach')

      return reachable
    })
  }

  return { connect, connectSecure, udpBind, listen, lookup }
}
