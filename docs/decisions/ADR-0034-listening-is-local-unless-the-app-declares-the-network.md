# ADR-0034: Listening is local unless the app declares the network

- **Status:** accepted
- **Date:** 2026-09-25
- **Type:** security
- **Decided by:** owner

## Decision

`TcpCapability.listen` and `UdpCapability.bind` (`src/contracts/manifest.ts`) each change from a
bare port-range list to `BindScopes`, a pair of separately declared and separately granted lists:
`local` (reachable only by other programs on this same computer) and `network` (reachable from
every device on the local network, and the internet if the port is forwarded). `network` also
covers `local` -- an app that genuinely needs to be reached from the network never needs to
declare both to get the wider reach. `CapabilityKind` gains `tcp.listen.local`,
`tcp.listen.network`, `udp.bind.local` and `udp.bind.network` in place of the old, single
`tcp.listen`/`udp.bind`. `orivon.net.listen`/`udpBind` gain an optional `scope: 'local' | 'network'`
argument; omitted means `'local'`.

A ported Node dependency that calls `server.listen(port)` with no host -- Node's own default binds
every interface -- and holds only the `local` grant is not refused: the shim binds loopback
instead. The app keeps working on this machine, `server.address()` reports the real, narrower
address it actually got, and no other device can reach it, which is what was declared.

## Context

`net.listen`/`udpBind` bind `0.0.0.0` unconditionally (`src/broker/adapters/node-adapters.ts`,
`udp-adapter.ts`) -- the whole local network, and the internet if the port is forwarded, for a
grant a person may have approved thinking of a single local service (an OAuth redirect catcher, a
local RPC port). `docs/architecture/security-model.md`'s T12 already states the requirement --
"`net.listen` must declare its bind interface... the prompt must distinguish 'reachable from the
internet' from 'reachable from your local network'" -- and open question A225 records that nothing
implements it. This ADR is that implementation, chosen over a single `host` parameter (A225's own
suggestion) because the two claims are different enough in severity that they belong in the
manifest and the grant prompt as two capabilities, not one call's optional argument a person could
overlook.

## Alternatives considered

**A single `host` parameter on `listen`/`udpBind`, limited to loopback or every interface**
(A225's own text). Rejected: a parameter is invisible at grant time unless the manifest also
carries it, and folding "which network can reach this" into the same capability as "how many
ports" undersells exactly the distinction T12 exists to preserve -- the two claims read as one
grant with a footnote, not two decisions a person can make separately.

**Keep one capability, add a boolean flag for network reach.** Same objection: a flag on an
existing grant is not a separate, revocable permission, and the settings panel would still show
one row for two different risk levels.

**Refuse to bind at all when a ported app asks for every interface under a local-only grant,**
matching how the TCP shim already refuses a loopback host it cannot honour today
(`node-net-server.ts`'s `ANY_INTERFACE_HOSTS` check runs the other way). Rejected for this specific
case: Node's own default (no host argument) is not a deliberate ask for network reach, it is what
every `http.createServer().listen(port)` call already looks like, and refusing it would throw
every ported app with a local dev server or an OAuth catcher before it ever renders -- the same
"a call this permitted becomes absent" failure `capability-api.ts`'s own header warns against for
a narrowed synchronous exception. Binding loopback instead is narrower than the grant, never wider,
so nothing this ADR is protecting against is weakened by it.

## Reasoning

`network` covering `local` rather than the two being siblings keeps the common case -- a P2P app
that is honestly asking to be reachable from anywhere -- a single grant, the same shape
`tcp.connect`'s `"*:*"` already has relative to a narrower host pattern. The `BindScopes` interface
being new rather than widening `Pattern` itself keeps every other pattern list in the manifest
(`tcp.connect`, `https.connect`, `udp.send`) untouched: this is a property of an inbound capability
specifically, not a general pattern-grammar change.

## Consequences

- A manifest declares `listen`/`bind` as `{ local?, network? }`, with at least one of the two
  present; the loader validates each list under the same port-range grammar the field always
  used. The grant ledger, the install/update consent flow and the settings permissions list treat
  `tcp.listen.local`, `tcp.listen.network`, `udp.bind.local` and `udp.bind.network` as four
  ordinary, independently revocable capability kinds, each with its own prompt wording -- the
  `.network` pair keeps the wording the single, undifferentiated capability always had, and gets
  the same merged single-row treatment `tcp.connect`/`https.connect` already receive when both
  are declared together; `.local` reads as the narrower, this-device-only claim it is.
- `orivon.net.listen`/`udpBind` still bind every interface regardless of which grant authorised
  the call: `net-capability.ts` checks the `.network` grant only, and neither the transport nor
  the shim reads the `scope` argument the contract now accepts. Holding only a `.local` grant is
  therefore never enough to open a real socket today -- every call still needs `.network`, which
  is a narrower, fail-closed gap rather than the reverse.
- A manifest written against the old flat `listen`/`bind` shape (a bare array, not an object) is
  refused as a malformed field, not silently misparsed: `readBindScopes` requires an object.

## Reversibility

- **Cost to reverse:** cheap. No app has shipped against either shape yet, and the manifest field
  is versionless (`orivonApiVersion: 0`).
- **What would make us revisit:** a ported app whose local-only service genuinely cannot tolerate
  binding loopback instead of the interface it asked for (A225's own hand-off case, an OAuth
  redirect catcher, does not hit this -- loopback is what it needs).
