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

**[`connect-src.ts`](connect-src.ts)'s CSP `connect-src` derivation is pure; wiring it via
`session.webRequest.onHeadersReceived` is build step 4's job.** Four things that step still needs
to check, recorded here because nothing else in the corpus does: (1) ADD this header to the
response, never REPLACE — multiple CSP headers intersect, which is what makes "the app cannot
relax it" true without stripping the app's own document's CSP. (2) Verify whether
`onHeadersReceived` fires for `protocol.handle`-served responses at all — ADR-0007 serves the
cached bundle that way, and nothing in the corpus confirms `webRequest` sees those responses; set
the header on the protocol handler's own `Response` too, just in case, since a worker script
served the same way inherits its own response's CSP, not the document's. (3) It is per-partition,
per-origin, and must be recomputed whenever a grant changes. (4) A live `context7` check is
required before writing the actual Electron wiring. Two scope gaps, both filed rather than
silently accepted: CSP bounds *names*, `connect.ts`'s `checkConnect` bounds *resolved addresses* —
for a hostname pattern the two diverge exactly on DNS rebinding, and no CSP construction closes
that (A42, also noting `img-src`/`form-action`/`script-src`/`frame-src`/navigation/
`<link rel=prefetch>` stay open channels this header never touches). And the emitted list is the
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
