# `src/broker/policy/`: pure decision functions

**What lives here.** The security-critical decisions, as pure functions: capability matching,
private-address classification, path confinement, origin derivation, the update decision table.

**What it depends on.** [`src/contracts/`](../../contracts/), types only.

**What it must never import.** **`electron`, `node:fs`, `node:net`, `node:dns`, or anything
that performs I/O.** This is what lets `createBroker({ dial, resolve, now, fs, keychain })` run
every capability test against stubs, with no Electron and no network
([`build-plan.md`](../../../docs/planning/build-plan.md) §Week 0, and
[`../index.ts`](../index.ts)'s header). An I/O step a decision needs is injected, as `paths.ts`'s
`realpath` is. If you want an `electron` import here, the function is doing two jobs: split the
decision from the effect, and put the effect one level up.

**Durable.** No Electron and no I/O, so it outlives a change of the engine beneath it.

**Owner stream.** `broker`, build step 2.

## Design notes

**[`extension-manifest.ts`](extension-manifest.ts)'s `loadableManifest` strips `webRequest*`,
`declarativeNetRequest*` and `nativeMessaging` from the manifest copy Orivon actually loads.**
Why, and what loads the resulting copy: [`src/main/extensions/README.md`](../../main/extensions/README.md)'s Design notes.

**[`bind.ts`](bind.ts) is not a mode flag on `connect.ts`.** `checkConnect` resolves a hostname,
because patterns must be matched against resolved addresses (T12); a bind names a local port, so
there is no name to resolve, no rebinding window and no reason to be async. The grammars are
opposites too (`bind.ts`'s header).

**[`bind-scope.ts`](bind-scope.ts) decides which grants may authorise a bind, and which interface
it opens** (`ADR-0034`). `'local'` may ride `.local` or `.network`, the narrower first; `'network'`
rides `.network` alone. The first grant whose ports cover the port wins and the bind is made
inside its ranges only, so a wider grant beside it never lends ranges to a port the chosen one
does not cover.

**`bind(0)` returns ranges, not a yes.** Port 0 asks the OS to pick, and a bare yes would let it
pick outside what the person read ("ports 6881-6889"). Returning the granted ranges means the
caller binds inside them by the shape of the result, as `ConnectAllowed.addresses` does for
connect. Provisional: A88.

**[`derive-p256.ts`](derive-p256.ts): why secp256k1 is not served here.** WebCrypto has no
secp256k1, and hand-rolling variable-time scalar multiplication over the secret behind every
identity is unacceptable. A pure-JS curve library breaks no rule, but it belongs in `src/nostr/`,
which needs one anyway
([`ADR-0010`](../../../docs/decisions/ADR-0010-key-derivation-frozen-at-v1.md) §Reversibility).
The scalar, frozen by golden vectors, pins the identity either way.

**[`origin.ts`](origin.ts)'s `ORIGIN_BEARING_SCHEMES` is an allowlist, never a denylist.**
`URL.origin` fails silently in two ways a denylist misses. `new URL('file:///etc/passwd').origin`
is the string `"null"`, so every `file:`, `data:`, `about:`, `javascript:` and `magnet:` URL would
share one storage domain and one grant entry. And `blob:https://x.example/u` reports the
legitimate-looking `https://x.example` (so do `ws:`, `wss:` and `ftp:`), for a scheme T13b
rejects. An unrecognised scheme denies. Why `http:` stays: the comment on the constant.

**[`update.ts`](update.ts)'s re-consent rule is a subset check over the granted pattern set,
never a comparison of capability kinds** (T19,
[`ADR-0005`](../../../docs/decisions/ADR-0005-apps-are-url-addressed-not-bundled.md)).
`connect: ["api.example.com:443"]` becoming `["*:*"]` requests no new kind, so a kind comparison
installs it silently. The failure mode is "no prompt appeared", which no manual checklist
catches, so `update.test.ts` mutation-tests itself against deliberately wrong implementations.
The two rollback outcomes, and why an acknowledged rollback still runs the ordinary escalation
checks:
[`ADR-0013`](../../../docs/decisions/ADR-0013-rollback-is-warned-and-chosen-not-blocked.md) and
its amendment.

**[`address.ts`](address.ts) is tested exhaustively, because of two properties.** Its failure is
silent: a missed encoding answers `'public'` for an address that reaches localhost, and nothing
downstream re-checks. And it fails closed: anything unparseable is blocked, since it is either a
caller bug or someone hunting for an encoding the table does not know. Why classification and
canonicalisation share one file: `canonicalAddress`'s doc.

**A connect pattern whose host is exactly `localhost` authorises `127.0.0.1` and `::1` at its
port, and nothing else** ([`connect-patterns.ts`](connect-patterns.ts)'s `LOCALHOST`/
`LOOPBACK_LITERALS`). Why this is safe under T12, whose point is that a name is not evidence of
where it leads:

- **`localhost` is never resolved.** `checkConnect` substitutes the two literals and
  `checkLookup` returns them, so no nameserver or hosts file has a say (RFC 6761 §6.3). Rebinding
  needs an answer somebody else chose; this one is a constant, which is also why
  `connect('localhost', p)` dials only the literals the grant covers.
- **It grants what the two literal patterns would, and the person saw it:** `localhost:8080`
  names this computer as plainly as `127.0.0.1:8080` does.
- **It is narrow.** Another name resolving to `127.0.0.1`, the rest of `127.0.0.0/8` and every
  `*.localhost` name stay refused. `*` still means public unicast only, and `https.connect` is
  unaffected: its patterns match names, and the certificate binds them.

**[`connect-preflight.ts`](connect-preflight.ts) canonicalises an IPv6 request but refuses a
non-canonical IPv4 one.** Why: the comment at the literal check. Both pipelines check and dial the
canonical spelling (`requested`). Patterns are not canonicalised: a manifest must declare a
literal canonically, where a person reads it (`declarableConnectHostRejection`).

**[`connect-src.ts`](connect-src.ts) derives CSP sources, purely.** How the header is assembled,
delivered and refreshed, and what each directive admits:
[`src/loader/serve/README.md`](../../loader/serve/README.md), "What the served bundle's CSP
admits". Two scope gaps no CSP construction closes:

- CSP bounds *names* and `checkConnect` bounds *resolved addresses*, so for a hostname pattern
  the two diverge exactly on DNS rebinding. That, and top-level navigation, which CSP never
  governs, are A42.
- The emitted list is the app's entire `connect-src` allowlist, so an omitted pattern is blocked,
  not uncovered. `tcp.connect: ["*:*"]` has no CSP equivalent and is reported in `omitted`, never
  widened to CSP's bare `*` (A43: widening is the bigger bug). An IPv6 literal is omitted the
  same way (`host-ipv6-literal`).

**`https.connect` feeds the reach directives** (`connect-src`, `img-src`, `font-src`,
`media-src`; A143, A192). `reachSourcesFor` reuses `connectSrcFor`'s logic and emits
scheme-qualified `https://host:port` sources, never `ws:`/`wss:`; a `*` host emits `https:`.
`tcp.connect` contributes bare `host:port` sources to `connect-src` alone.

**[`lookup.ts`](lookup.ts): why a host-only check opens nothing new** (A167, A171).
`checkLookup` matches `hostname` against the host portion of a `tcp.connect` or `udp.send`
pattern the app already holds: no port, no resolved address. Such an app can already make the
broker resolve that host by attempting a connection, since `checkConnect`'s pre-resolve gate
(`couldAnyPatternMatch`) lets a granted host, `*` or a literal through to the resolver before any
port or address is checked, and `authorisedSend` reuses `checkConnect`. So `lookup` hands back a
name-to-address mapping, never the ability to force a resolution the app lacked. A82's
reserved-port carve-out is irrelevant for the same reason: the app knows the port from its own
grant (`app.grants()`) and can replay it through `connect`.

Why `https.connect` is not in that union: `OUTBOUND_CAPABILITIES`'s doc in
[`../capabilities/net.ts`](../capabilities/net.ts). The refusal stays a uniform `'denied'`
([`handle-contracts.md`](../../../docs/architecture/handle-contracts.md) §How much failure detail
an app receives); `src/shim/net/dns.ts`'s `describeLookupDenial` names it for a ported app from
the app's own grants.

**[`paths.ts`](paths.ts)'s confinement verdict is platform-independent.** CI runs on Linux only,
so a verdict that depends on the host OS ships untested to Windows and macOS. The flavour comes
from the root's shape, and everything Windows-specific in a requested path is rejected on every
platform: `..\..\Windows` is a legal POSIX filename, and a security boundary cannot answer
differently depending on where the broker runs.

**[`web-context-result.ts`](web-context-result.ts) walks the value instead of trusting
`JSON.stringify`.** `executeJavaScript` returns its result through structured clone, not JSON
(measured, Electron 44): a `Date` or `Map` arrives as a real instance, `NaN` and `Infinity` as
live numbers, an `undefined`-valued key as present. A `JSON.stringify` check tests a rewritten
copy and passes the original through. A function, symbol, `bigint` or DOM object never reaches
this file: structured clone refuses it, `executeJavaScript` rejects, and
`../capabilities/web.ts` answers `'invalid'`. Depth is bounded because the script is untrusted
input to the broker's own process: a clean `'invalid'`, never a stack overflow.
