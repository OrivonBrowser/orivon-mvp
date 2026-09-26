# `src/broker/`: the capability broker

**What lives here.** Manifest parsing, the grant model, per-origin enforcement, grant prompts,
per-app `session` partitions, and the handle tables. **This is the product**: everything else
in the repository exists so that this can be reached from a web page
([`ADR-0002`](../../docs/decisions/ADR-0002-capability-api-is-the-durable-asset.md)).

**What it depends on.** [`src/contracts/`](../contracts/) and `electron`.

**What it must never import.** [`src/shim/`](../shim/), [`src/loader/`](../loader/), or any
renderer code. The broker is the authority; importing one of its consumers inverts the trust
direction and makes the boundary meaningless.

**Owner stream.** `broker`, build step 2, and the critical path.

**Settle the origin definition here.** It keys storage, session partitions, grants and derived
identity keys. Changing it after the first grant is persisted orphans every app's data
([`ADR-0003`](../../docs/decisions/ADR-0003-local-first-storage.md)).

**The three threats most likely to be got wrong** ([`security-model.md`](../../docs/architecture/security-model.md)):
T1/T10 path traversal, T3 origin spoofing via `senderFrame`, and **T12 DNS rebinding**, the
subtlest, because a correct glob matcher fed a *hostname* is still completely defeated by it.
Patterns are checked against **resolved addresses**, always.

## The layout

Six directories, one per job. The name of the directory is the question it answers.

| Directory | Job | Holds state? | Touches I/O? |
|---|---|---|---|
| [`policy/`](policy/) | **Decide**: may this origin do this? | no, pure functions | **never** |
| [`grants/`](grants/) | **Remember**: what did the user approve? | yes, per origin | disk, for persistence |
| [`handles/`](handles/) | **Hold**: what is this origin holding, and can I take it back? | yes, per origin | **never**, `destroy` is injected |
| [`adapters/`](adapters/) | **Do**: dial the address, open the file | no | **this is the only place** |
| [`transport/`](transport/) | **Speak**: reach the page, move the bytes | connection registry | Electron IPC and ports |
| [`capabilities/`](capabilities/) | **Expose**: `index.ts`'s own job (the `orivon.*` entry points), split out purely for line count -- not a seventh job, see its own README | no | via the other five |

The eight files that stay at the top level belong to no single directory:

- [`index.ts`](index.ts): `createBroker` and the capability entry points that consult all six
- [`broker-contracts.ts`](broker-contracts.ts): the `Broker` interface and its fixed dependency
  shape, and the hub the other four `*-contracts.ts` files below re-export from
- [`errors.ts`](errors.ts): `OrivonError` construction, used by every directory above
- [`io-errors.ts`](io-errors.ts): the other half of that, translating a raw errno from an
  injected dependency into the closed enum. Split out of `index.ts` on 2026-09-07 when
  `udpBind` pushed it past 500 lines. A fourth top-level file where
  [`ADR-0015`](../../docs/decisions/ADR-0015-the-broker-is-organised-by-job.md) records three;
  same test as the other three: it belongs to no single directory. Kept apart from `errors.ts`
  because that file *constructs* and this one *translates*, and because merging them would
  quietly settle [`A39`](../../docs/open-questions.md), which is a behavioural question nobody
  has answered yet
- [`fs-contracts.ts`](fs-contracts.ts): `RawFileStat`, `OpenedFile`, `BrokerFs` and
  `BrokerFsMethods`, split out of `broker-contracts.ts` on 2026-09-15 (A184) when `open`'s own
  types pushed that file past 500 lines, re-exported from there, so no existing import site
  had to change
- [`secrets-contracts.ts`](secrets-contracts.ts): the extended `Keychain` (`getSeed` plus the new
  optional `isPersistent`) and `BrokerSecretsMethods`, split out of `broker-contracts.ts` and
  re-exported from there, as `fs-contracts.ts` and `web-context-contracts.ts` already are
- [`secure-dial-contracts.ts`](secure-dial-contracts.ts): `DialSecure` and the rest of
  `connectSecure`'s vocabulary, split out of `broker-contracts.ts` and re-exported from there,
  as `fs-contracts.ts` is
- [`web-context-contracts.ts`](web-context-contracts.ts): `WebContextHost` and the rest of
  `orivon.web`'s vocabulary, re-exported from `broker-contracts.ts` the same way

See [`capabilities/README.md`](capabilities/README.md) for `net.ts`, `fs.ts`, `id.ts`,
`secrets.ts`, `web.ts`, `net-connect-secure.ts`, `fs-handle-wrapper.ts` and `socket-room.ts`, and
[`transport/README.md`](transport/README.md) for `dispatch/` and `relay/`.

The decomposition and the import boundaries are recorded in
[`ADR-0015`](../../docs/decisions/ADR-0015-the-broker-is-organised-by-job.md), including the two
alternatives that lost and the one file that makes the "I/O lives in `adapters/`" row need a
footnote. **Those boundaries are prose, enforced by nothing**; that gap is
[`A85`](../../docs/open-questions.md), deliberately left open rather than closed with a guard
written the same hour as the rule.

**Tests live in a `tests/` folder inside the directory they cover**, so what you scroll past when
reading a directory is that directory's code.

**Reading order, cold:** [`src/contracts/`](../contracts/) first (it is the product, and it is
types only), then [`policy/connect.ts`](policy/connect.ts)'s header for how security is reasoned
about here, then [`index.ts`](index.ts)'s `connect()` for one call end to end.


## Design notes

Rationale that explains why a file has the shape it has. It lives here rather than in source
headers ([`code-guidelines.md`](../../docs/development/code-guidelines.md)'s destination test),
so the 25-line comment budget measures a file's traps, not its history.

### `policy/reserved-ports.ts`: what a blanket grant does not reach

A grant of `*:*` is
legitimate, since a P2P app such as a torrent client declares one because DHT and peer
exchange reach arbitrary hosts, but it made every granted origin a general outbound traffic
generator from the user's own IP address, on any port. The ports with a real
abuse history and no legitimate use from a page's network grant are excluded
from any BLANKET grant, and reachable only when a pattern names the exact port.

**A range is not a naming.** `20-30` covers port 25 without anyone having read
the number, so it is treated as the blanket `*` is. Requiring `lo === hi ===
port` means a reserved port is reachable only when an app author typed it and a
person approved that exact line, which is the property that makes it worth
showing in a prompt at all.

**The host half is deliberately not consulted.** `namesPortExactly` answers
"did anyone name this port", nothing more; `hostMatches` still runs unchanged
afterwards. Folding the two together would let a pattern naming `:25` for one
host quietly open `:25` everywhere.

**Checked after parsing, before resolving.** Before, so a reserved port never
becomes a name-existence oracle, the same discipline `couldAnyPatternMatch`
already follows. After, because the answer depends on what the patterns say.

**Not a substitute for the address rules, and narrower than it looks.**
`policy/address.ts` already denies every private, loopback, link-local and
metadata address outright, so the remote-access ports in the set only matter
against a PUBLIC host.

**Scope: `tcp.connect` only.** `udp.send` shares the pattern grammar and would
want the same rule, but it has no implementation yet; wiring it is part of
whoever builds `udp.send`, not of this.
### The socket allowance: a declared number, not a hidden one

An origin's simultaneous-socket budget is the app's own declared
`net.concurrentSockets`, clamped to the `LIMITS.concurrentSockets` ceiling (512),
with `LIMITS.defaultConcurrentSockets` (64) for an app that declares nothing
(A80). It has to be a declared number a person sees, because it is the largest
resource commitment in the system: every open socket pins a read and a write
credit window (~640 MiB at the ceiling). The point of the modest default is that it is the *forcing function*: an ordinary
app never reaches 64, so anything that genuinely needs the ceiling must declare
a number, and that number is then one a person saw at grant time.

**It follows `fs.quotaBytes` exactly**, which already solved this for disk:
optional in the manifest, enforced in the broker, rendered in the prompt. Both
now share one validator (`readPositiveInteger`, `loader/manifest/capabilities.ts`)
because the reason is shared, not only the shape.

**Clamped, never rejected.** The manifest validator deliberately accepts a
number above the ceiling and `GrantLedger.socketAllowance` takes the minimum.
Rejecting at parse time would make any future change to
`LIMITS.concurrentSockets` a breaking change for every manifest that had
declared the old one.

**`AcquireRequest.socketLimit` is optional and falls back to the CEILING, not
the default.** Deliberate, and the direction matters: a caller that does not
know an origin's declaration must not be able to hand it a budget SMALLER than
it is entitled to. Only `index.ts`'s `connect` knows the ledger, and only it
passes the real number.

### `index.ts` and the files split from it

`index.ts` is split by concern, to stay under Rule 2's 500-line limit: `grants/grant-ledger.ts`
(the per-origin state), `io-errors.ts` (translating an injected dependency's raw error), and
every file under [`capabilities/`](capabilities/) (see that folder's own README for why it is a
folder rather than a sixth top-level file: `net.ts`'s `connect`/`authorisedSend`/`udpBind`/`listen`
alone is the whole of `orivon.net`). What stays in `index.ts` is the dependency shape
`createBroker` fixes, the origin-normalising `canonical()` every capability shares, and the
`fs`/`app`/grant-ledger entry points that do not warrant a file of their own.

### `policy/manifest-patterns.ts`: one conversion from manifest to pattern set

`patternSetFromCapabilities` (Manifest.capabilities -> `update.ts`'s `PatternSet`) lives here
because two consumers need the exact same conversion, the loader's update decision and
`app.requestGrant`'s policy (`policy/request-grant.ts`), and `policy/` may never import
`src/loader/` (this README's own "what it must never import"). `src/loader/index.ts`
imports it directly.

**It must map every capability a manifest can declare, `https.connect` included.** A capability
missing from the conversion is invisible to both consumers: a manifest update that ADDS it
installs SILENTLY, because `decideUpdate`'s subset check never sees the new key and
`widensAuthority` cannot fire, and a `requestGrant` call for it is refused as "not declared".
That would make `request-grant.ts`'s "never exceeds the manifest" guarantee false for that
capability. `policy/tests/manifest-patterns.test.ts` pins the `https.connect` (ADR-0017) mapping.

### `policy/request-grant.ts` and `../main/consent/request-grant.ts`: what a persisted grant may trust

Grants are read back from storage at startup (`grants/grant-persistence.ts`,
`grants/grant-ledger.ts`), so a tampered store must not be able to mint authority the user never
gave. **Hydration never becomes a second place authority can be minted.** `hydrateGrants` (`grant-persistence.ts`)
restores exactly the `(origin, capability, patterns)` tuple a real, accepted `requestGrant`/
install-time `broker.grant()` call already wrote, re-validates it against the origin's CURRENT
manifest via `decideGrantRequest`, the same check a live request gets, reused rather than
reimplemented, and mints a fresh `GrantId` rather than trusting one read off disk (there is not
one to trust: `PersistedGrant` carries no `id` field at all). A grant a live request could no
longer obtain is silently dropped, never restored. See `grants/README.md`'s own design note for
the full mechanism, including why hydration runs from `registerApp` rather than `versionFloor`'s
own earlier-touch hook (it needs a manifest to re-validate against), and the T13c exclusion for
loopback/plain-http origins.

See [`capabilities/README.md`](capabilities/README.md)'s Design notes for `net-connect-secure.ts`,
`net.ts`'s accept-queue bound, `fs.ts`'s `open`/quota behaviour and `web.ts`'s `evaluate` timeout,
and [`transport/README.md`](transport/README.md)'s for the unlink hook, the byte pumps
(`relay/port-pump.ts`/`port-sink.ts`), `relay/socket.ts` and `relay/port-messages.ts`.
