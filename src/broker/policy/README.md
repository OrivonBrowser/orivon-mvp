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

**Why [`paths.ts`](paths.ts)'s confinement verdict must be platform-independent.** Windows and
macOS are supported run-from-source targets, but CI runs on Linux only, so a rule whose answer
depends on the host OS ships to two platforms untested. Path flavour is chosen from the shape of
the root (`C:\...` or `\\...` → win32, otherwise posix) rather than from `process.platform`, so a
Windows root gets Windows separator rules even on a Linux test runner. And everything
Windows-specific about the *requested* path — backslashes, drive letters, UNC prefixes, reserved
device names — is rejected on every platform: `..\..\Windows` is a legal filename on POSIX, but a
security boundary cannot have an answer that depends on where the broker happens to be running.
