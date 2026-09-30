// `orivon.net.listen`, split out of ./net.ts along Rule 2's seam: a listener
// produces a STREAM of further handles rather than being one socket itself,
// unlike `udpBind` (./net-udp.ts). The grant choice they share is in
// ./net-bind-grant.ts. Takes the broker's own state, like ./net.ts, and holds
// none.

import type { BindScope } from '../../contracts/index.js'
import type { HandleTable } from '../handles/handles.js'
import type { FailableTcpServer, FailableTcpSocket, HandleEntry } from '../handles/handle-contracts.js'
import type { GrantLedger } from '../grants/grant-ledger.js'
import { fail } from '../errors.js'
import { mapIoError } from '../io-errors.js'
import { checkBind } from '../policy/bind.js'
import { GENERIC_PROXY_PROBE_URL } from '../policy/proxy-guard.js'
import { bindGrantFor, requestedScope } from './net-bind-grant.js'
import type { ListenerRegistry } from './listener-registry.js'
import type { CreateBrokerOptions, DialedSocket, ListenedServer } from '../broker-contracts.js'

export interface ListenOptions {
  readonly deps: CreateBrokerOptions
  readonly handleTable: HandleTable
  readonly ledger: GrantLedger
  readonly canonical: (origin: string) => string
  readonly socketAllowance: (origin: string) => number
  /** Where each successful `listen` is recorded for `web.embed`'s local pattern (ADR-0047), at either scope. */
  readonly listeners: ListenerRegistry
  /** ./net.ts's own wrapper, shared so an accepted connection gets the same handle-table escape hatches a dialled one does (Rule 3). */
  readonly toFailableSocket: (key: string, entry: HandleEntry, socketFields: Omit<DialedSocket, 'destroy'>) => FailableTcpSocket
}

export function createListen ({ deps, handleTable, ledger, canonical, socketAllowance, listeners, toFailableSocket }: ListenOptions): (origin: string, opts: { port: number, scope?: BindScope }) => Promise<FailableTcpServer> {
  /**
   * `checkBind` is shared with `udpBind` (./net-udp.ts) -- its own header has
   * always anticipated a second caller (policy/bind.ts). What differs from
   * `udpBind` is everything downstream of the check: a listener produces a
   * STREAM of further handles rather than being one itself.
   */
  return async function listen (origin, opts) {
    const key = canonical(origin)

    // `scope` picks the grants that may authorise the call (./net-bind-grant.ts)
    // and the interface `deps.listen` opens: `'local'` is loopback only, and
    // only `'network'` reaches other devices.
    const scope = requestedScope(opts.scope, 'net.listen')
    const { grant: current, ranges } = bindGrantFor(ledger, key, 'tcp.listen', scope, opts.port)

    return await handleTable.run(key, { on: 'grant', grantId: current.id }, async (signal) => {
      let listened: ListenedServer
      try {
        // T20, as `udpBind`'s own check (./net-udp.ts).
        if (await deps.proxyConfigured(GENERIC_PROXY_PROBE_URL)) {
          throw fail('denied', 'a system proxy is configured; tcp.listen refuses to bypass it')
        }
        if (signal.aborted) throw fail('revoked', 'the grant authorising this listen was withdrawn')
        listened = await deps.listen(ranges, signal, scope)
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

      // Forgotten from the resource's own teardown, which every close path
      // reaches (`close`, a revoked or narrowed grant, `fail`), so no path
      // can leave a port registered that nothing holds.
      let forgetPort = (): void => {}
      const entry = handleTable.acquire({
        origin: key,
        kind: 'tcpServer',
        authorisedBy: { by: 'grant', grantId: current.id },
        destroy: async (reason) => {
          forgetPort()
          await listened.destroy(reason)
        },
        socketLimit: socketAllowance(key),
        stillCovered: (patterns) => checkBind(patterns, listened.localPort).allowed
      })
      forgetPort = listeners.add(key, listened.localPort)

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
}
