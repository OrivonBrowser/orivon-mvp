# `src/broker/policy/`: pure decision functions

**What lives here.** The security-critical decisions, as pure functions: capability matching,
private-address classification, path confinement, origin derivation, the update decision table.

**What it depends on.** [`src/contracts/`](../../contracts/), types only.

**What it must never import.** **`electron`, `node:fs`, `node:net`, `node:dns`, or anything
that performs I/O.** This is not a style preference. It is a structural decision taken on day
one because taking it later costs a day of refactor exactly when the schedule is tightest
([`build-plan.md`](../../../docs/planning/build-plan.md) §Week 0).

The broker is constructed as `createBroker({ dial, resolve, now, fs, keychain })`. Every
capability test then runs against stubs, with no Electron and no network, which is what makes
the six security-critical unit tests in
[`docs/development/testing.md`](../../../docs/development/testing.md) cheap enough to actually
write.

**Owner stream.** `broker`, build step 2.

**Why this directory is separate from its parent.** Anything with an `import` of `electron`
belongs one level up, in `src/broker/`. If you find yourself wanting one here, the function is
doing two jobs: split the decision from the effect.

## Design notes

Why the code here has the shape it has. This is the destination
[`code-guidelines.md`](../../../docs/development/code-guidelines.md) Rule 1 names for rationale: a
source comment protects a specific line from a specific mistake; the case for a file's overall
shape belongs here instead.

**[`bind.ts`](bind.ts): why it is not a mode flag on `connect.ts`.** The two share the word
"capability check" and nothing else. `checkConnect` resolves a hostname, because its whole reason
for existing is that patterns must be matched against resolved addresses (T12); a bind names a
local port, so there is no name to resolve, no rebinding window, and no reason to be async.
The grammars are opposites too: `"*"` is legitimate for `connect` and rejected for `bind`, and
ports below 1024 must work for `connect` and are denied outright for `bind`
(`capability-api.md` A9 §1). `connect.ts`'s own header asked for this split in advance: "a
DIFFERENT decision ... and gets its own function rather than a mode flag on this one, because the
two share a grammar and nothing else."

**Why `bind(0)` returns ranges rather than a yes.** An app asking for port 0 is asking the OS to
pick, and there is no port to check. Answering `true` would mean the OS picks freely, which makes
the sentence the person granting the capability actually read ("listen for messages on ports
6881-6889") false, without anybody deciding it should be. So the allow branch hands back the
granted ranges and the caller picks from them. It is the same structural trick `ConnectAllowed.
addresses` uses: a caller physically cannot proceed without destructuring what was checked, so
"bind only inside what was granted" is enforced by the shape of the return value instead of by a
comment somebody has to remember. Recommendation, not yet owner-confirmed;
`docs/open-questions.md` A88.

**[`derive-p256.ts`](derive-p256.ts): why secp256k1 isn't served here.** WebCrypto has no secp256k1
at all, so serving it would mean either hand-rolling scalar multiplication (variable-time, over a
secret scalar, in the file that holds every user's identity) or reaching for a curve library from
the layer ADR-0002 says must outlive the engine beneath it. The first is unacceptable outright. The
second is a real option, just not one to take here: `src/nostr/` needs a secp256k1 implementation
regardless (WebCrypto cannot produce a BIP-340 Schnorr signature either), so the point
multiplication costs nothing extra there and buys nothing extra here. The project rule is CLAUDE.md
Rule 8 ("no native modules in Orivon's own dependencies") and Rule 6 ("do not reinvent without a
written reason"). There is no blanket "add no dependency" rule, and a pure-JS audited curve library
would satisfy both. The argument for staying on WebCrypto is engine-independence, not dependency
count. Revisit in the `nostr` stream (ADR-0010 §Rejected). What this file owns for secp256k1, the
scalar frozen by golden vectors, is the part that must never change; the point is a deterministic
function of it, so the identity is pinned either way.

**[`origin.ts`](origin.ts)'s `ORIGIN_BEARING_SCHEMES` is an allowlist, never a denylist.**
`URL.origin` has two distinct silent failure modes a denylist of `file:`/`data:` misses both of:
(1) `new URL('file:///etc/passwd').origin` is the STRING `"null"`, not the value `null`, and returned
unchecked, every `file:`, `data:`, `about:`, `javascript:` and `magnet:` URL would collapse into
one shared storage domain and one grant ledger entry, with nothing throwing and nothing looking
wrong (security-model.md T13b); (2) `new URL('blob:https://x.example/u').origin` is the real,
legitimate-looking `https://x.example`, for a scheme T13b requires be rejected outright; `ws:`,
`wss:` and `ftp:` do the same. IPFS CIDs and ENS names key on something other than
scheme+host+port and wait for trustless resolution (build step 6; capability-api.md); an
unrecognised scheme denies for now, which is the failure direction wanted. `http:` stays in the
allowlist on purpose: T13c forbids *persisting* a grant for a loopback or plain-http origin, not
*deriving* one: the developer-mode and localhost-fixture paths both need a real origin to scope a
session-lifetime grant to (testing.md).

**[`update.ts`](update.ts)'s re-consent rule is a subset check over the granted pattern set, never
a comparison of capability kinds** (capability-api.md open item A9 §2; security-model.md T19;
ADR-0005). An update changing
`connect: ["api.example.com:443"]` to `connect: ["*:*"]` requests no new capability *kind* at all, so
under a kind comparison it installs silently, and a user who granted "talk to one host" ends up
running an app that may connect to any computer on the internet (the `*:*` grant). Its failure
mode is "no prompt appeared", which no manual checklist catches (testing.md §5), so
`update.test.ts` mutation-tests itself against three deliberately-wrong implementations for
exactly that reason.

*Why `rollback-notice` can never be a shortcut past `capability-prompt`/`reconsent`.*
`rollback-notice` is the one outcome that installs unattended, so reaching it when the offering
also widens authority or changes the bundle would downgrade a prompt into a silent install.
`ordinaryEscalation` therefore runs on both the at-or-above-floor path and the
acknowledged-rollback path (ADR-0013), so a rollback is never less scrutinised than an ordinary
update with the same change.

*Why `rollback-choice` is a choice, not a block.* A below-floor version is a warned, explicit
choice (proceed with the older version, or keep what is cached) the first time it happens for a
given origin. Once acknowledged, `rollbackAcknowledged` never expires on its own: the rule is
"warn every time, but never require a click" for everything after that first choice.

**[`address.ts`](address.ts) is tested exhaustively, not with a handful of examples, because of
two properties.** (1) The failure is silent: a missed encoding does not throw or log, it answers
`'public'` for an address that actually reaches localhost, and the connection succeeds, with nothing
downstream re-checking. (2) It fails closed: anything unparseable is blocked, never allowed, because
an unparseable string is either a caller bug or someone hunting for an encoding the table doesn't
know. `classifyAddress` and `canonicalAddress` share one file on purpose even though they answer
different questions. The DENY side ("what range is this in", staying permissive so it can
recognise `2130706433` in order to block it) and the ALLOW side ("will everything downstream read
this string as the same address", docs/open-questions.md A20), because both are built from the
same [`address-parse.ts`](address-parse.ts) parsers and so can never disagree about what an
address *is*, only about how it should be spelled.

**A connect pattern whose host is exactly `localhost` authorises `127.0.0.1` and `::1` at its
port, and nothing else** ([`connect-patterns.ts`](connect-patterns.ts)'s `LOCALHOST`/
`LOOPBACK_LITERALS`, used by `hostMatches`, `couldAnyPatternMatch`, `connect.ts` and
`lookup.ts`). Why this is safe under T12, whose whole point is that a name is not evidence of
where it leads:

- **`localhost` is never resolved.** `checkConnect` substitutes the two loopback literals for it
  before the resolver could run, and `checkLookup` returns them as its answer, so no nameserver,
  hosts file or TTL-0 server has any say in what it means (RFC 6761 SS6.3 lets a resolution API
  answer it this way, and Chromium does). The rebinding attack needs an answer somebody else
  chose; this one is a constant. That is also why `connect('localhost', p)` dials only the literals
  the grant covers, where a DNS answer must pass in full: filtering a constant hides nothing.
- **It grants exactly what the two literal patterns would, and the person saw it.**
  `localhost:8080` in a grant prompt names this computer as plainly as `127.0.0.1:8080` does;
  requiring both `127.0.0.1:p` and `[::1]:p` bought no safety and broke `connect('localhost', p)`
  for any app that declared one.
- **It is narrow on purpose.** The request must be `localhost` or one of the two literals: a
  different name resolving to `127.0.0.1` is still refused (it is the rebinding attack, spelled
  with a second pattern), as is the rest of `127.0.0.0/8` and every `*.localhost` name, which
  stays an ordinary hostname pattern and so can never reach a private address.
- **Nothing else moves.** `*` still means public unicast only, so `connect('localhost', p)` under
  `*:*` is refused without resolving anything, and every other hostname pattern still requires a
  public answer. `https.connect` is unaffected: its patterns match names, and the certificate
  binds them.

**[`connect-preflight.ts`](connect-preflight.ts) canonicalises an IPv6 request but refuses a
non-canonical IPv4 one.** The asymmetry is the ambiguity, not the family. `inet_aton` reads
`0177.0.0.1` as 127.0.0.1, a person reads it as 177.0.0.1, and `2130706433` is also a valid DNS
label, so an IPv4 literal is accepted only in the dotted-quad form everything downstream reads the
same way. `inet_pton`'s IPv6 grammar has no octal, no short forms and no hex-versus-decimal
choice, so `0:0:0:0:0:0:0:1`, `0000::0001` and `::1` can only ever mean one address; refusing all
but one spelling would only break apps that print addresses in full. Both pipelines check and dial
the canonical spelling (`requested`), never the caller's, so the check and the connect cannot
disagree about which host they mean. Patterns are not canonicalised: a manifest must still declare
a literal canonically, where a person reads it (`declarableConnectHostRejection`).

**[`connect-src.ts`](connect-src.ts)'s CSP source derivation is pure, and the header is set on
the served response directly** (`src/loader/serve/csp.ts` assembles it, `src/loader/serve/serve.ts`'s
`buildResponse` sets it), never via
`session.webRequest.onHeadersReceived`: that listener never fires for a `protocol.handle`-served
response in this Electron version (A110), so the header is set on the handler's own `Response`,
the alternative ADR-0007 names. Three properties follow:

- **There is nothing to clobber.** This `Response` is built from nothing, not intercepted from an
  existing one, so there is no prior CSP header. A `<meta http-equiv>` CSP the app's own HTML
  declares still *intersects* with this one regardless, which is what actually makes "the app
  cannot relax it" true.
- **It is recomputed on every request, not once at registration.** `serve.ts`'s
  `GrantedConnectPatterns` callback reads the broker's live grant ledger fresh each time, so a
  revoke or a new grant reaches the very next request through an already-registered handler.
  The one thing even that cannot fix is a document already loaded, which keeps the CSP its own
  navigation response carried until the next load; that is how CSP delivery works.
- **Two scope gaps remain, both filed.** CSP bounds *names*, `connect.ts`'s `checkConnect`
bounds *resolved addresses*:
for a hostname pattern the two diverge exactly on DNS rebinding, and no CSP construction closes
that. `src/loader/serve/csp.ts` sets `default-src 'self'` and explicit `script-src`, `frame-src`
and `worker-src`. `form-action` has no fallback to `default-src` and is deliberately left unset
(`src/loader/README.md`, "What the served bundle's CSP admits"), so A42 covers what CSP cannot
cover at all: top-level navigation (`<a href>`, `location.href`, which CSP never governs) and the
DNS-rebinding gap above. And the emitted list is the
app's *entire* `connect-src` allowlist, so an omitted pattern is not "uncovered", it is blocked:
a torrent client's `tcp.connect: ["*:*"]` has no CSP equivalent at all and is reported via `omitted`
rather than widened to CSP's bare `*` (A43: widening is the bigger bug). An IPv6
literal is the same story: CSP's host grammar has no `[`, `]` or `:`, confirmed in Electron
44.0.0/Chrome 152 that Chromium drops such a source outright, and `host-ipv6-literal` exists so
`omitted` stays honest about that gap instead of silently claiming coverage a grant doesn't have.

**`https.connect` feeds the reach directives: `connect-src`, `img-src`, `font-src` and
`media-src`** (A143, A192). `reachSourcesFor` reuses `connectSrcFor`'s own translate/emit logic
unchanged (Rule 3), fed from `https.connect`, the grant `src/loader/serve/serve.ts`'s `fetchThirdParty`
authorises a third-party request against. Its sources are scheme-qualified, `https://host:port`,
never `ws:`/`wss:`: a WebSocket never reaches that handler, so no reach source may admit one. A
`*` host emits `https:`, the one source wider than the grant, because every request it admits
reaches the app's own `protocol.handle` and is re-authorised live there. `tcp.connect`
contributes its bare `host:port` sources to `connect-src` alone. A deliberate scope line: no
third-party frame and no third-party script, since embedding a live third-party document or
running third-party code at the app's own origin is a materially bigger step than fetching a
resource, and nothing asks for it.

**[`lookup.ts`](lookup.ts): why a host-only check (no port, no resolved address) still opens
nothing new (A171, `docs/open-questions.md` A167), and why `https.connect` does not belong in
the union it checks against (A190/A193).** `orivon.net.lookup` checks
`hostname` against the HOST PORTION of a pattern the app already holds under `tcp.connect` or
`udp.send`, never a port, and never a resolved address the way `connect.ts`'s own
`checkConnect` does. That looks weaker until you notice what those two capabilities already let
an app force today: `checkConnect`'s own pre-resolve gate (`couldAnyPatternMatch`) lets a
granted pattern's exact host, or `*`, or an address literal, through to the real resolver
before any port or address is checked, so an app holding `example.com:22` can already make the
broker resolve `example.com` by attempting a connection to it, whatever the outcome of that
connection turns out to be; `authorisedSend` (`../capabilities/net.ts`) reuses `checkConnect`
verbatim, so `udp.send` gets the identical argument. `lookup` authorised the same way hands back
a name-to-address MAPPING the app did not have before; it never hands back the ability to force
a NAME resolved that the app could not already force resolved by name through
`connect`/`udpBind`. A82's reserved-port carve-out is therefore irrelevant here too: whatever
port a pattern names, the app already knows it (it is in the app's own held grant, readable via
`app.grants()`) and can replay it through `connect` to force that exact host's resolution
regardless of which port `lookup` itself does not have to check.

**`https.connect` is not part of this union, the one case the argument above does not cover.**
`connect-secure.ts`'s own header says why directly: `checkConnectSecure` never resolves a
hostname at all, and TLS certificate verification stands in for the address check
`checkConnect` performs, so `https.connect` on its own gives an app no broker-exposed way to
learn what a hostname resolves to. Folding it into `net.lookup`'s union would hand an app holding
ONLY `https.connect: ["*:*"]` exactly that: a general DNS oracle over any hostname it can guess,
behind a capability whose stated intent is "let this app fetch over TLS," never "let this app
query DNS for arbitrary names" (A190). So `OUTBOUND_CAPABILITIES` (`../capabilities/net.ts`) is
`tcp.connect` + `udp.send`, and an app must hold one of those to resolve a name at all. The
pre-resolve-gate argument above holds for both without qualification.

**The capability layer's `'denied'` stays uniform for this refusal, same as every other
one** (`errors.ts`): an app that is refused a lookup because it holds only `https.connect`
sees exactly the same `'denied'`, with no `platformCode`, as any other reason `checkLookup`
declines. Naming the reason for a ported app's benefit happens one layer up, in
`src/shim/net/dns.ts`, which reads the app's OWN `orivon.app.grants()`, a standing,
already-legitimate capability an app has over itself, to tell this specific refusal apart from
an ordinary one, rather than the broker's reply carrying anything new. See that file's own
`describeLookupDenial` for the mechanism and why it fails back to the ordinary generic message
whenever it cannot say more with confidence.

**The union is settled, not provisional:** `tcp.connect` + `udp.send`, as wide as the app's
network grant already is.

**Why [`paths.ts`](paths.ts)'s confinement verdict must be platform-independent.** Windows and
macOS are supported run-from-source targets, but CI runs on Linux only, so a rule whose answer
depends on the host OS ships to two platforms untested. Path flavour is chosen from the shape of
the root (`C:\...` or `\\...` → win32, otherwise posix) rather than from `process.platform`, so a
Windows root gets Windows separator rules even on a Linux test runner. And everything
Windows-specific about the *requested* path (backslashes, drive letters, UNC prefixes, reserved
device names) is rejected on every platform: `..\..\Windows` is a legal filename on POSIX, but a
security boundary cannot have an answer that depends on where the broker happens to be running.

**[`web-context-result.ts`](web-context-result.ts) walks the value instead of trusting
`JSON.stringify`, because `WebContext.evaluate`'s result is not JSON to begin with.** Electron's
`executeJavaScript` hands the result back through V8's structured-clone algorithm (the same one
`postMessage` uses), not JSON -- measured directly against Electron 44 rather than assumed, with a
throwaway main-process probe calling `executeJavaScript` on a real offscreen `BrowserWindow`. A
`Date`/`Map`/`Set`/`RegExp`/`Error`/`TypedArray` completion value comes back as a REAL instance of
that class; `NaN`/`Infinity`/`-Infinity` come back as real, live non-finite numbers; and an object
or array with an `undefined`-valued property or element comes back with that key or slot genuinely
present and genuinely `undefined`. Structured clone preserves all of this; only `JSON.stringify`
(the old check this file replaces, in `../capabilities/web.ts`) silently turned the first group into
strings-or-`{}` and the second into `null`, and returned the ORIGINAL value regardless -- so a
script's `NaN` or a live `Date` object used to sail straight through to the app. A result that IS
or CONTAINS a function, a symbol, a `bigint`, or a DOM object (`window`, `document`) never reaches
this file at all: Electron's own structured-clone step refuses to clone those, so the whole
`executeJavaScript` call rejects first, which `capabilities/web.ts`'s existing catch-all already
turns into `'invalid'`.

Cycle detection walks the CURRENT PATH only (a `Set` of ancestor objects, added on entry and
removed on exit), not every object seen -- structured clone can legitimately hand back a DAG where
the same object is reachable twice through two different branches, which is sharing, not a cycle,
and an ancestor-only check is what tells the two apart without rejecting valid non-circular reuse.
Depth is bounded (64) for the same reason a network-facing parser bounds recursion: a script
inside the context is untrusted input to the broker's own process, and an unbounded walk trades a
clean `'invalid'` rejection for a `RangeError` stack overflow instead.
