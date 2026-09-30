# `src/broker/capabilities/`: the `orivon.*` entry points

**What lives here.** The entry points `createBroker` ([`../index.ts`](../index.ts)) returns, one
file per capability (`net`, `fs`, `user-selected`, `id`, `secrets`, `web`, and `embed` for
`web.embed`'s broker half, `ADR-0039`), plus the helpers they share.
[`listener-registry.ts`](listener-registry.ts) is one of them: which ports each origin holds a
listener on, written by `net-listen.ts`'s `listen` and read by `embed.ts`, because `web.embed`'s local
pattern (`ADR-0047`) loads only while the embedding app holds its port. `createBroker` builds it
once and hands the same object to both.
[`declined-consent.ts`](declined-consent.ts) is not an `orivon.*` capability: it is the advisory
decline-tracking surface (A145) `createBroker` returns directly, split out here for the same
"no state of its own, only `GrantLedger` and `canonical` taken as constructed dependencies" shape
as `id.ts`.

**What it depends on.** [`../broker-contracts.ts`](../broker-contracts.ts),
[`../errors.ts`](../errors.ts), [`../io-errors.ts`](../io-errors.ts), [`../grants/`](../grants/),
[`../handles/`](../handles/) and [`../policy/`](../policy/).

**What it must never import.** [`../../shim/`](../../shim/), [`../../loader/`](../../loader/), or
any renderer code -- see the parent README's "What it must never import".

**Tied to Electron?** No. `web.ts` reaches Electron only through the injected `webContextHost`.

**Owner stream.** `broker`.

## Design notes

**Each file is split from `../index.ts`, not a new owner of state.** It takes `HandleTable`,
`GrantLedger` and `canonical` from `createBroker` as constructed dependencies and builds none of
its own, so `createBroker`'s fixed dependency shape and its stub tests do not change when a
capability moves here
([`ADR-0035`](../../../docs/decisions/ADR-0035-src-source-directories-are-organised-by-job.md)).

### `net-connect-secure.ts`: an option that unbinds the name adds the address check

The grant is matched against the name the app asked for, because default certificate
verification binds that name to whoever answers. `rejectUnauthorized: false`, the app's own `ca`
and a `servername` other than the host each remove that binding: each is honoured, and adds
`checkConnect`'s resolve-once address check, dialling only the checked literal with SNI and
verification still on the name. An option therefore only narrows what a grant reaches. The
threat and the cost (a self-signed LAN node needs a grant naming its address): T12 in
[`security-model.md`](../../../docs/architecture/security-model.md) and
[`A248`](../../../docs/open-questions.md).

### `net-listen.ts` and `net-udp.ts`: the scope picks the grant and the interface

`listen` and `udpBind` take an optional `scope` (`ADR-0034`); omitted is `'local'`. A `'local'`
call is authorised by a live `.local` grant, or by a live `.network` grant, since `network`
covers `local`, and binds `127.0.0.1` only. A `'network'` call needs the `.network` grant and
binds every interface, and a `.local` grant never reaches it. When both grants are live and the
scope is `'local'`, `net-bind-grant.ts` takes the first whose ports cover the port, `.local`
first: the handle is tied to that grant, so revoking it closes the socket, and `port: 0` lands
inside that grant's ranges alone, never the union. The interface is chosen by the adapter from
`scope` (`../policy/bind-scope.ts`), and only `'network'` widens. The listener registry records
both scopes, because `web.embed`'s local pattern is served from a loopback listener.

### `net.ts`: the accept-queue bound is not the specification's backpressure

`listen`'s (`net-listen.ts`) `LISTEN_ACCEPT_QUEUE_LIMIT` (`../adapters/node-adapters.ts`) resets new connections
once too many sit unclaimed, which bounds main-process memory (T11b). It is not the OS-backlog
pressure `handle-contracts.md` item 7 describes, which Node cannot provide, and its number is
provisional ([`A106`](../../../docs/open-questions.md)).

### `fs.ts`'s `open` (A184)

Confinement runs once, at open; `read`, `write` and the streams address the open descriptor and
re-check only handle ownership (T11c), as `net.connect` does. A chunk that exceeds the quota
**errors** the `writable()` stream instead of being dropped as a denied `udp.send` datagram is,
because a dropped file byte is corruption; positional `write()` and `writable()` share one
counter. Why `FailableFileHandle` has no `abort`, why its `destroy` has no drain deadline, and
why `readable()`/`writable()` are not yet on `window.orivon`:
[`A184`](../../../docs/open-questions.md). The premature-close escapes `writable()` guards
against: `../adapters/node-fs-adapter.ts`.

### `fs.ts`: the quota counts what the files occupy

`fs.quotaBytes` is checked against the bytes the origin's files occupy, not every byte ever
written: a database that rewrites its file on each load (nedb, as FreeTube uses it) would
exhaust any count of writes within a session. The first call that can change usage in a session adds `BrokerFs.diskUsage(root)` to
the count (`ensureMeasured`), so nothing is persisted and nothing drifts across a restart.
`writeFile` charges only growth; `rm` and `rename` give bytes back.

- **Over-counts, towards `'limit'`, never past it.** Handle writes (`write`, `writable()`)
  charge every byte, so a rewrite in place is charged again; concurrent `writeFile`s to one
  path each charge their own growth.
- **Under-counts, bounded.** A removed or replaced file still open through a handle keeps its
  bytes on disk after they are given back, bounded by `LIMITS.concurrentFileHandles` and ending
  when the handles close.
- Files picked with `fs.userSelected` charge the same count but are outside the measurement.

### `web.ts`: why a timed-out `evaluate` makes `closed` reject

[`ADR-0019`](../../../docs/decisions/ADR-0019-an-app-may-run-code-at-an-origin-the-user-named.md)
names two `closed` outcomes: reject `'revoked'`, resolve on an idle close. A timed-out
`evaluate` is the broker killing a script that overran its budget, so `closed` rejects
`'timeout'`, the code `evaluate` itself rejects with. Resolving would file the one signal that a
script needs to be faster under routine recycling. A caller's shorter `timeoutMs` closes the
context the same way.
