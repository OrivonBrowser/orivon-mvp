// `orivon.net`'s three entry points -- connect, udpBind, listen -- lifted out
// of ./index.ts once `listen` pushed that file past Rule 2's 500 lines
// (docs/development/code-guidelines.md). README.md's own design notes named
// this exact seam ahead of time: "lift connect/udpBind/authorisedSend into a
// net-capability file rather than shaving another helper off the top".
//
// SAME DEPENDENCY SHAPE AS ./index.ts ITSELF -- the HandleTable and
// GrantLedger it already built are passed in, `canonical` (the origin
// normalisation every Broker method shares) is passed in too rather than
// redefined here, and nothing below holds state of its own. This is a pure
// move: every test that exercised connect/udpBind/listen through
// `createBroker` keeps exercising the exact same functions, just imported
// from here instead of defined inline.

import type { HandleTable } from './handles/handles.js'
import type { FailableTcpServer, FailableTcpSocket, FailableUdpSocket, HandleEntry } from './handles/handle-contracts.js'
import type { GrantLedger } from './grants/grant-ledger.js'
import { fail } from './errors.js'
import { mapIoError, mapTlsError } from './io-errors.js'
import { checkBind } from './policy/bind.js'
import { checkConnect } from './policy/connect.js'
import { checkConnectSecure } from './policy/connect-secure.js'
import type { BoundUdpSocket, Broker, CreateBrokerOptions, DialedSocket, ListenedServer, SendOutcome } from './broker-contracts.js'
import type { Datagram } from '../contracts/index.js'

export interface NetCapabilityOptions {
  readonly deps: CreateBrokerOptions
  readonly handleTable: HandleTable
  readonly ledger: GrantLedger
  /** Origin normalisation plus the malformed-origin 'internal' throw -- ./index.ts's own `canonical`, shared rather than redefined here. */
  readonly canonical: (origin: string) => string
}

/** Builds `Broker['net']` -- see this file's header for why it takes the broker's own state rather than owning any of it. */
export function createNetCapability ({ deps, handleTable, ledger, canonical }: NetCapabilityOptions): Broker['net'] {
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
        socketLimit: ledger.socketAllowance(key)
      })

      return toFailableSocket(key, entry, socketFields)
    })
  }

  /**
   * `orivon.net.connectSecure` (ADR-0017). A SIBLING of `connect` above, not
   * a variant of it -- checked against `https.connect`, a SEPARATE grant
   * from `tcp.connect`, and dialled through `deps.dialSecure`
   * (../adapters/tls-adapter.ts) rather than `deps.dial`.
   *
   * THE ONE STRUCTURAL DIFFERENCE from `connect`, beyond which grant and
   * which dial function: `checkConnectSecure` is SYNCHRONOUS and takes the
   * hostname directly rather than a resolver -- see that function's own
   * header for why there is no resolve-then-check step here at all. Every
   * other shape -- the in-flight scope, the revoked-while-dialling race, the
   * handle acquisition -- is identical to `connect`'s on purpose (Rule 3:
   * this is the same idea, "authorise, dial, register, wrap", applied with a
   * different check and a different dialler).
   */
  async function connectSecure (origin: string, opts: { host: string, port: number }): Promise<FailableTcpSocket> {
    const key = canonical(origin)

    const current = ledger.currentGrant(key, 'https.connect')
    if (current === undefined) throw fail('denied', 'https.connect is not granted to this origin')

    return await handleTable.run(key, { on: 'grant', grantId: current.id }, async (signal) => {
      let dialed: DialedSocket
      try {
        const decision = checkConnectSecure(current.patterns, opts.host, opts.port)
        if (!decision.allowed) throw fail('denied', 'the secure connection was not authorised')
        // Same reasoning as `connect`'s own mid-check abort guard: without
        // this, a grant revoked between the (synchronous) policy check and
        // the handshake completing would still let `deps.dialSecure` run to
        // completion for a capability the app no longer holds.
        if (signal.aborted) throw fail('revoked', 'the grant authorising this connection was withdrawn')
        dialed = await deps.dialSecure(decision.host, opts.port, signal)
      } catch (error) {
        // mapTlsError, NOT mapIoError: a failed handshake or a certificate/
        // hostname mismatch is 'unreachable' with a real platformCode
        // (../../contracts/capability-api.ts's own doc on `connectSecure`),
        // and Node's TLS error codes are not POSIX errnos -- see
        // io-errors.ts's own doc on why that mapping is its own function.
        // An OrivonError already thrown above (the two `fail()` calls) passes
        // through mapTlsError unchanged, same as mapIoError does for `connect`.
        throw mapTlsError(error)
      }

      if (signal.aborted) {
        // Same reasoning as `connect`'s: `acquire` would refuse this, but its
        // cleanup releases with 'failed' -- silent, and wrong for a socket
        // that is actually connected and holding a live TLS session.
        await dialed.destroy('revoked')
        throw fail('revoked', 'the grant authorising this connection was withdrawn')
      }

      const { destroy, ...socketFields } = dialed
      const entry = handleTable.acquire({
        origin: key,
        kind: 'tcpSocket',
        authorisedBy: { by: 'grant', grantId: current.id },
        destroy,
        socketLimit: ledger.socketAllowance(key)
      })

      return toFailableSocket(key, entry, socketFields)
    })
  }

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
    // what the manifest declared. `udp.bind` and `udp.send` are separate
    // grants, and this one authorises only the bind -- an app that binds
    // successfully still sends nothing until `udp.send` is granted too.
    const current = ledger.currentGrant(key, 'udp.bind')
    if (current === undefined) throw fail('denied', 'udp.bind is not granted to this origin')

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
        socketLimit: ledger.socketAllowance(key)
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

    const current = ledger.currentGrant(key, 'tcp.listen')
    if (current === undefined) throw fail('denied', 'tcp.listen is not granted to this origin')

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
        socketLimit: ledger.socketAllowance(key)
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
              socketLimit: ledger.socketAllowance(key)
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

  return { connect, connectSecure, udpBind, listen }
}
