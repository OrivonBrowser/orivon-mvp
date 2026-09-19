# `src/broker/policy/` — pure decision functions

**What lives here.** The security-critical decisions, as pure functions: capability matching,
private-address classification, path confinement, origin derivation, the update decision table.

**What it depends on.** [`src/contracts/`](../../contracts/) — types only.

**What it must never import.** **`electron`, `node:fs`, `node:net`, `node:dns`, or anything
that performs I/O.** This is not a style preference. It is a structural decision taken on day
one because taking it later costs a day of refactor exactly when the schedule is tightest
([`build-plan.md`](../../../docs/planning/build-plan.md) §Week 0).

The broker is constructed as `createBroker({ dial, resolve, now, fs, keychain })`. Every
capability test then runs against stubs, with no Electron and no network — which is what makes
the six security-critical unit tests in
[`docs/development/testing.md`](../../../docs/development/testing.md) cheap enough to actually
write.

**Owner stream.** `broker` — build step 2.

**Why this directory is separate from its parent.** Anything with an `import` of `electron`
belongs one level up, in `src/broker/`. If you find yourself wanting one here, the function is
doing two jobs: split the decision from the effect.

## Design notes

Why the code here has the shape it has. This is the destination
[`code-guidelines.md`](../../../docs/development/code-guidelines.md) Rule 1 names for rationale: a
source comment protects a specific line from a specific mistake; the case for a file's overall
shape belongs here instead.

**[`bind.ts`](bind.ts) — why it is not a mode flag on `connect.ts`.** The two share the word
"capability check" and nothing else. `checkConnect` resolves a hostname, because its whole reason
for existing is that patterns must be matched against resolved addresses (T12); a bind names a
local port, so there is no name to resolve, no rebinding window, and no reason to be async.
The grammars are opposites too: `"*"` is legitimate for `connect` and rejected for `bind`, and
ports below 1024 must work for `connect` and are denied outright for `bind`
(`capability-api.md` A9 §1). `connect.ts`'s own header asked for this split in advance — "a
DIFFERENT decision ... and gets its own function rather than a mode flag on this one, because the
two share a grammar and nothing else."

**Why `bind(0)` returns ranges rather than a yes.** An app asking for port 0 is asking the OS to
pick, and there is no port to check. Answering `true` would mean the OS picks freely, which makes
the sentence the person granting the capability actually read — "listen for messages on ports
6881-6889" — false, without anybody deciding it should be. So the allow branch hands back the
granted ranges and the caller picks from them. It is the same structural trick `ConnectAllowed.
addresses` uses: a caller physically cannot proceed without destructuring what was checked, so
"bind only inside what was granted" is enforced by the shape of the return value instead of by a
comment somebody has to remember. Recommendation, not yet owner-confirmed —
`docs/open-questions.md` A88.

**[`derive-p256.ts`](derive-p256.ts) — why secp256k1 isn't served here.** WebCrypto has no
secp256k1 at all, so serving it would mean either hand-rolling scalar multiplication — variable-
time, over a secret scalar, in the file that holds every user's identity — or reaching for a curve
library from the layer ADR-0002 says must outlive the engine beneath it. The first is unacceptable
outright. The second is a real option, just not one to take here: `src/nostr/` needs a secp256k1
implementation regardless (WebCrypto cannot produce a BIP-340 Schnorr signature either), so the
point multiplication costs nothing extra there and buys nothing extra here. The project rule is
CLAUDE.md Rule 8 ("pure-JS dependencies only") and Rule 6 ("do not reinvent without a written
reason") — there is no blanket "add no dependency" rule, and a pure-JS audited curve library would
satisfy both. The argument for staying on WebCrypto is engine-independence, not dependency count.
Owner decision, 2026-08-27; revisit in the `nostr` stream (ADR-0010 §Rejected). What this file owns
for secp256k1 — the scalar, frozen by golden vectors — is the part that must never change; the
point is a deterministic function of it, so the identity is pinned either way.

**[`origin.ts`](origin.ts)'s `ORIGIN_BEARING_SCHEMES` is an allowlist, never a denylist.**
`URL.origin` has two distinct silent failure modes a denylist of `file:`/`data:` misses both of:
(1) `new URL('file:///etc/passwd').origin` is the STRING `"null"`, not the value `null` — returned
unchecked, every `file:`, `data:`, `about:`, `javascript:` and `magnet:` URL would collapse into
one shared storage domain and one grant ledger entry, with nothing throwing and nothing looking
wrong (security-model.md T13b); (2) `new URL('blob:https://x.example/u').origin` is the real,
legitimate-looking `https://x.example`, for a scheme T13b requires be rejected outright — `ws:`,
`wss:` and `ftp:` do the same. IPFS CIDs and ENS names key on something other than
scheme+host+port and are deferred until trustless resolution exists (capability-api.md); an
unrecognised scheme denies for now, which is the failure direction wanted. `http:` stays in the
allowlist on purpose: T13c forbids *persisting* a grant for a loopback or plain-http origin, not
*deriving* one — the developer-mode and localhost-fixture paths both need a real origin to scope a
session-lifetime grant to (testing.md).

**[`update.ts`](update.ts)'s re-consent rule is a subset check over the granted pattern set, never
a comparison of capability kinds** (capability-api.md open item A9 §2, corrected 2026-08-25;
security-model.md T19; ADR-0005's 2026-08-25 evening amendment). An update changing
`connect: ["api.example.com:443"]` to `connect: ["*:*"]` requests no new capability *kind* at all —
under a kind comparison it installs silently, and a user who granted "talk to one host" ends up
running an app that may connect to any computer on the internet, the exact grant journey 1 puts on
camera. Its failure mode is "no prompt appeared", which no manual checklist catches (testing.md
§5) — `update.test.ts` mutation-tests itself against three deliberately-wrong implementations for
exactly that reason.

*Why `rollback-notice` can never be a shortcut past `capability-prompt`/`reconsent`.* Fixed
2026-09-05, ADR-0013's amendment: this decision table used to reach `rollback-notice` — a silent
install — even when the offering also widened authority or changed the bundle, downgrading what
should have been a prompt into the one outcome that installs unattended. `ordinaryEscalation` now
runs on both the at-or-above-floor path and the acknowledged-rollback path for exactly this
reason, so a rollback is never less scrutinised than an ordinary update with the same change.

*Why `rollback-choice` is a choice, not a block.* Owner decision, 2026-09-04, reversing this
module's original stance: a below-floor version used to be refused outright with no prompt. It is
now a warned, explicit choice — proceed with the older version, or keep what is cached — the first
time this happens for a given origin. Once acknowledged, `rollbackAcknowledged` never expires on
its own; the owner's framing was "warn every time, but never require a click" for everything after
that first choice.

**[`address.ts`](address.ts) is tested exhaustively, not with a handful of examples, because of
two properties.** (1) The failure is silent: a missed encoding does not throw or log, it answers
`'public'` for an address that actually reaches localhost, and the connection succeeds — nothing
downstream re-checks. (2) It fails closed: anything unparseable is blocked, never allowed, because
an unparseable string is either a caller bug or someone hunting for an encoding the table doesn't
know. `classifyAddress` and `canonicalAddress` share one file on purpose even though they answer
different questions — the DENY side ("what range is this in", staying permissive so it can
recognise `2130706433` in order to block it) and the ALLOW side ("will everything downstream read
this string as the same address", docs/open-questions.md A20) — because both are built from the
same [`address-parse.ts`](address-parse.ts) parsers and so can never disagree about what an
address *is*, only about how it should be spelled.

**[`connect-src.ts`](connect-src.ts)'s CSP `connect-src` derivation is pure; S4-6 wired it onto
the served response directly** (`src/loader/serve.ts`'s `buildResponse`), never via
`session.webRequest.onHeadersReceived` — A110 (`docs/open-questions.md`) confirmed that listener
never fires for a `protocol.handle`-served response in this Electron version, so the header is
set on the handler's own `Response` instead, the alternative that ADR-0007 itself names once A110
closes it. What that wiring did with the four open items this note used to list for whoever built
it: (1) there is nothing to ADD-not-REPLACE against — this `Response` is built from nothing, not
intercepted from an existing one, so there is no prior CSP header to clobber; a `<meta
http-equiv>` CSP the app's own HTML declares still *intersects* with this one regardless, which is
what actually makes "the app cannot relax it" true. (2) Confirmed FALSE, per A110 above — settled,
not still open. (3) Recomputed on every request, not once at registration — `serve.ts`'s
`GrantedConnectPatterns` callback reads the broker's live grant ledger fresh each time, so a
revoke or a new grant reaches the very next request through an already-registered handler; the
one thing even that cannot fix is a document already loaded, which keeps the CSP its own
navigation response carried until the next load — inherent to how CSP delivery works, not a gap
this wiring left open. (4) Done — see the PR that landed this note's rewrite. Two scope gaps
remain, both filed rather than silently accepted: CSP bounds *names*, `connect.ts`'s `checkConnect`
bounds *resolved addresses* —
for a hostname pattern the two diverge exactly on DNS rebinding, and no CSP construction closes
that. A42 also listed `img-src`/`form-action`/`script-src`/`frame-src` as open channels this
header never touched — `serve.ts`'s `cspHeaderValue` now sets `default-src 'self'` (which every
one of those falls back to, unset) and an explicit `script-src 'self' 'unsafe-inline'`, so A42
narrows to what CSP structurally cannot cover at all: top-level navigation (`<a href>`,
`location.href` — `default-src` never governs it) and the DNS-rebinding gap above. And the emitted list is the
app's *entire* `connect-src` allowlist, so an omitted pattern is not "uncovered", it is blocked —
the flagship's `tcp.connect: ["*:*"]` has no CSP equivalent at all and is reported via `omitted`
rather than widened to CSP's bare `*` (owner decision, A43: widening is the bigger bug). An IPv6
literal is the same story: CSP's host grammar has no `[`, `]` or `:`, confirmed in Electron
44.0.0/Chrome 152 that Chromium drops such a source outright — `host-ipv6-literal` exists so
`omitted` stays honest about that gap instead of silently claiming coverage a grant doesn't have.

**`img-src` is no longer one of A42's unset-and-therefore-`default-src`-covered directives, as of
A143's 2026-09-14 resolution — `font-src`/`media-src` never were `default-src`-covered examples
A42 named, but the same statement now applies to them too.** `connect-src.ts`'s
`appReachCspHeaderValue` reuses `connectSrcFor`'s own translate/emit logic unchanged (Rule 3),
fed from the `https.connect` grant rather than `connect-src`'s own `tcp.connect` — a deliberately
different capability, because `src/loader/serve.ts`'s `fetchThirdParty` (the live handler these
three directives now have to agree with) authorises a third-party fetch against `https.connect`,
never `tcp.connect`. `form-action`/`frame-src`/`script-src`/`worker-src` are UNCHANGED by this —
still `default-src 'self'`'s fallback (`frame-src`/`worker-src`/`form-action`) or the explicit
`'self' 'unsafe-inline'` (`script-src`) `serve.ts`'s `cspHeaderValue` already set — a deliberate
scope line: embedding a live third-party document or running third-party code at the app's own
origin is a materially bigger step than fetching a static image/font/media resource, and neither
was asked for.

**[`lookup.ts`](lookup.ts) -- why a host-only check (no port, no resolved address) still opens
nothing new (A171, `docs/open-questions.md` A167), and why `https.connect` does not belong in
the union it checks against (d-0031, A190/A193).** `orivon.net.lookup` (d-0030) checks
`hostname` against the HOST PORTION of a pattern the app already holds under `tcp.connect` or
`udp.send` -- never a port, and never a resolved address the way `connect.ts`'s own
`checkConnect` does. That looks weaker until you notice what those two capabilities already let
an app force today: `checkConnect`'s own pre-resolve gate (`couldAnyPatternMatch`) lets a
granted pattern's exact host -- or `*`, or an address literal -- through to the real resolver
before any port or address is checked, so an app holding `example.com:22` can already make the
broker resolve `example.com` by attempting a connection to it, whatever the outcome of that
connection turns out to be; `authorisedSend` (`../net-capability.ts`) reuses `checkConnect`
verbatim, so `udp.send` gets the identical argument. `lookup` authorised the same way hands back
a name-to-address MAPPING the app did not have before; it never hands back the ability to force
a NAME resolved that the app could not already force resolved by name through
`connect`/`udpBind`. A82's reserved-port carve-out is therefore irrelevant here too: whatever
port a pattern names, the app already knows it (it is in the app's own held grant, readable via
`app.grants()`) and can replay it through `connect` to force that exact host's resolution
regardless of which port `lookup` itself does not have to check.

**`https.connect` was originally read into this same union and is not any more -- the one case
the argument above never covered.** `connect-secure.ts`'s own header says why directly:
`checkConnectSecure` never resolves a hostname at all -- TLS certificate verification stands in
for the address check `checkConnect` performs -- so before `net.lookup` existed, an app holding
ONLY `https.connect: ["*:*"]` had no broker-exposed way to learn what a hostname resolves to.
Folding it into `net.lookup`'s union anyway (this lane's original, unconfirmed reading) handed
that app exactly that: a general DNS oracle over any hostname it can guess, behind a capability
whose stated intent was "let this app fetch over TLS," never "let this app query DNS for
arbitrary names" -- A190's own finding, confirmed by an independent adversarial review. **Owner's
decision, d-0031:** `https.connect` is dropped from `OUTBOUND_CAPABILITIES`
(`../net-capability.ts`); an `https.connect`-only app loses the DNS-lookup convenience
`net.lookup` used to give it, and must hold `tcp.connect` or `udp.send` to resolve a name at
all. `tcp.connect` and `udp.send` are unaffected -- the pre-resolve-gate argument above holds for
both without qualification.

**The capability layer's `'denied'` stays uniform for this refusal, same as every other
one** (`errors.ts`) -- an app that is refused a lookup because it holds only `https.connect`
sees exactly the same `'denied'`, with no `platformCode`, as any other reason `checkLookup`
declines. Naming the reason for a ported app's benefit happens one layer up, in
`src/shim/node-dns.ts`, which reads the app's OWN `orivon.app.grants()` -- a standing,
already-legitimate capability an app has over itself -- to tell this specific refusal apart from
an ordinary one, rather than the broker's reply carrying anything new. See that file's own
`describeLookupDenial` for the mechanism and why it fails back to the ordinary generic message
whenever it cannot say more with confidence.

**Owner decision, not an AI recommendation, as of 2026-09-16 (d-0031).** `d-0030` itself states
the bound ("as wide as the app's network grant already is") but not which capabilities count;
A167 flagged that reading as unconfirmed, and A190 (an independent adversarial review) found the
`https.connect` half of it concretely wrong rather than merely unconfirmed. d-0031 settles both:
the union is `tcp.connect` + `udp.send`, and it is now the recorded intent, not this lane's own
inference.

**Why [`paths.ts`](paths.ts)'s confinement verdict must be platform-independent.** Windows and
macOS are supported run-from-source targets, but CI runs on Linux only, so a rule whose answer
depends on the host OS ships to two platforms untested. Path flavour is chosen from the shape of
the root (`C:\...` or `\\...` → win32, otherwise posix) rather than from `process.platform`, so a
Windows root gets Windows separator rules even on a Linux test runner. And everything
Windows-specific about the *requested* path — backslashes, drive letters, UNC prefixes, reserved
device names — is rejected on every platform: `..\..\Windows` is a legal filename on POSIX, but a
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
(the old check this file replaces, in `../web-capability.ts`) silently turned the first group into
strings-or-`{}` and the second into `null`, and returned the ORIGINAL value regardless -- so a
script's `NaN` or a live `Date` object used to sail straight through to the app. A result that IS
or CONTAINS a function, a symbol, a `bigint`, or a DOM object (`window`, `document`) never reaches
this file at all: Electron's own structured-clone step refuses to clone those, so the whole
`executeJavaScript` call rejects first, which `web-capability.ts`'s existing catch-all already
turns into `'invalid'`.

Cycle detection walks the CURRENT PATH only (a `Set` of ancestor objects, added on entry and
removed on exit), not every object seen -- structured clone can legitimately hand back a DAG where
the same object is reachable twice through two different branches, which is sharing, not a cycle,
and an ancestor-only check is what tells the two apart without rejecting valid non-circular reuse.
Depth is bounded (64) for the same reason a network-facing parser bounds recursion: a script
inside the context is untrusted input to the broker's own process, and an unbounded walk trades a
clean `'invalid'` rejection for a `RangeError` stack overflow instead.
