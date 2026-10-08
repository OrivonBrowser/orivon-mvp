// `orivon.net`'s entry points -- connect, connectSecure, udpBind, listen,
// lookup; udpBind and listen live in ./net-udp.ts and ./net-listen.ts. Split
// from ../index.ts along Rule 2's seam (README.md's Design notes). SAME
// DEPENDENCY SHAPE AS ../index.ts ITSELF: the HandleTable, GrantLedger and
// `canonical` it already built are passed in, and nothing below holds state
// of its own.

import type { HandleTable } from '../handles/handles.js'
import type { FailableTcpSocket, HandleEntry } from '../handles/handle-contracts.js'
import type { GrantLedger } from '../grants/grant-ledger.js'
import { fail } from '../errors.js'
import { mapIoError } from '../io-errors.js'
import { checkConnect, connectStillAuthorised } from '../policy/connect.js'
import { checkLookup } from '../policy/lookup.js'
import { createConnectSecure } from './net-connect-secure.js'
import { createListen } from './net-listen.js'
import { createUdpBind } from './net-udp.js'
import type { ListenerRegistry } from './listener-registry.js'
import { assertSocketRoom } from './socket-room.js'
import { isPublicUnicast } from '../policy/address.js'
import { proxyProbeUrl } from '../policy/proxy-guard.js'
import type { Broker, CreateBrokerOptions, DialedSocket } from '../broker-contracts.js'
import type { CapabilityKind, ConnectOptions, LookupAddress } from '../../contracts/index.js'

/**
 * The two capabilities `orivon.net.lookup` reads a grant from (d-0030,
 * narrowed by d-0031 -- docs/open-questions.md A190/A193), checked in this
 * fixed order so that when both held grants would authorise the same
 * hostname, revocation always scopes to the same one (policy/lookup.ts's
 * own README note, A171). `tcp.listen.*`/`udp.bind.*` are excluded on purpose:
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
  /** Origin normalisation plus the malformed-origin 'internal' throw -- ../index.ts's own `canonical`, shared rather than redefined here. */
  readonly canonical: (origin: string) => string
  /** The origin's socket allowance. A restored app answers from its pinned manifest until it re-registers, which the ledger alone cannot see; defaults to `ledger.socketAllowance`. */
  readonly socketAllowance?: (origin: string) => number
  /** Where each successful `listen` is recorded for `web.embed`'s local pattern (ADR-0047). */
  readonly listeners: ListenerRegistry
}

/** Builds `Broker['net']` -- see this file's header for why it takes the broker's own state rather than owning any of it. */
export function createNetCapability ({ deps, handleTable, ledger, canonical, listeners, socketAllowance = (origin) => ledger.socketAllowance(origin) }: NetCapabilityOptions): Broker['net'] {
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

  async function connect (origin: string, opts: ConnectOptions): Promise<FailableTcpSocket> {
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
        // Checked BEFORE `checkConnect`, which resolves the host through
        // real Node DNS -- a query no proxy sees. Waiting until after
        // `checkConnect` would let that lookup go around a configured
        // proxy even on the path that then denies the connect itself (T20).
        if (await deps.proxyConfigured(proxyProbeUrl(opts.host, opts.port))) {
          throw fail('denied', 'a system proxy is configured; tcp.connect refuses to bypass it')
        }
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
        // do (../handles/handles.ts).
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
    }, opts.signal)
  }

  /** `orivon.net.connectSecure` (ADR-0017) -- ./net-connect-secure.ts, sharing this file's state and `toFailableSocket`. */
  const connectSecure = createConnectSecure({ deps, handleTable, ledger, canonical, socketAllowance, toFailableSocket })

  /** `orivon.net.udpBind` -- ./net-udp.ts, sharing this file's state. */
  const udpBind = createUdpBind({ deps, handleTable, ledger, canonical, socketAllowance })

  /** `orivon.net.listen` -- ./net-listen.ts, sharing this file's state and `toFailableSocket`. */
  const listen = createListen({ deps, handleTable, ledger, canonical, socketAllowance, listeners, toFailableSocket })

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
      // T20 covers resolution too ("Same for DNS resolution",
      // security-model.md): checked before the real DNS call below, which
      // no proxy sees.
      if (await deps.proxyConfigured(proxyProbeUrl(authorisedHostname))) {
        throw fail('denied', 'a system proxy is configured; net.lookup refuses to bypass it')
      }
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
