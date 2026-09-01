# Testing

## Read this first, because the test suite looks neglected and is not

There are no UI tests, no coverage targets, and a deliberately small number of unit tests. That
is a decision, not a backlog ([`build-plan.md`](../planning/build-plan.md) §Testing).

The reasoning: this is a one-month MVP built by one person, and at that scale broad test suites
cost more than they return — they are written once, then maintained forever, against code that
is still changing shape weekly. So testing is **concentrated where a silent failure is both
plausible and expensive**, and absent everywhere else.

The concentration is not arbitrary. Every area listed below has the same property: **its
failure mode is silence.** A broken capability check does not throw; the app just works, with
more authority than the user granted. That is the class of bug a person cannot catch by using
the product, and it is exactly the class this project is about.

Where a bug is loud — the window does not open, the tab does not switch — a person notices in
seconds, and a test would be paying rent to tell you something you already know.

## How to run

| Command | What |
|---|---|
| `npm run typecheck` | `tsc --noEmit`. Strict mode with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` — the compiler is doing a lot of the work a test suite would elsewhere |
| `npm test` | Vitest. `environment: 'node'`, no DOM. Picks up `src/**/*.test.ts` and `scripts/**/*.test.ts` |
| `npm run smoke` | Builds and drives the real shell with real clicks. The only check that proves a window appears |

Unit tests are **colocated** with what they test: `src/main/omnibox.test.ts` sits beside
`src/main/omnibox.ts`.

### What `npm run smoke` is, and what it is not

It is the **shell's** regression check — a different thing from the unit tests below, held to a
different bar. §The six security-critical areas argues for testing only where failure is
*silent*; that argument governs the unit tests. `smoke.mjs` also asserts loud things (a window
opens, the back button works), on purpose: it launches the real app either way, so the extra
assertions are nearly free once the launch is paid for.

Three properties it is required to keep:

- **It reports, it does not just exit.** It prints a JSON result and a failure list. **Read
  those, not the exit code alone.** A thrown error is recorded as a failed check rather than
  replacing the output, and every click is bounded, so a broken run still tells you what broke.
- **It is hermetic, structurally.** It launches Electron with
  `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1` — nothing but loopback resolves, so
  it passes air-gapped and a change that made it depend on the network fails loudly instead of
  quietly phoning out. Deliberately a whole-world blackhole rather than a per-host one: a
  per-host rule only protects the host somebody thought of.
- **It waits for conditions, never for the clock — except when asserting an absence.** Fixed
  sleeps make a slow machine report a harness race as a product bug. But `waitFor` returns the
  instant its predicate holds, so **it must never be pointed at a condition the pre-action state
  already satisfies** — that is a no-op that reports green. Two checks were written that way and
  both passed while the exact regression they existed to catch was present. Either establish an
  observable *transition* first, or settle and read once. And a refusal — a navigation that must
  *not* happen — cannot be polled for at all; only waited out.

It is **not** an end-to-end test of the capability stack — that is the separate one described in
§The end-to-end test, and it does not exist yet.

---

## The six security-critical areas

Each is a pure function tested against stubs. This is why
[`src/broker/policy/`](../../src/broker/policy/) may not import `electron` or perform I/O —
that constraint is what makes these tests cheap enough to actually exist.

### 1. Capability checking at the call site

`checkConnect(patterns, hostArg, port, resolveFn)` with an **injected stub resolver** — not just
the pattern matcher in isolation. `patterns` is the **GRANTED** `readonly Pattern[]`, not a
`Manifest` — see the second correction below.

> **Corrected 2026-08-27.** This said `checkConnect(manifest, hostArg, resolveFn)`, with no
> `port`. A connect pattern is `host:port`, so the port is half the decision and the function
> cannot make it without one — `stream/broker-03-connect-check` added the parameter and this
> document is following, rather than the other way round. Recorded because that PR cited this
> line as fixing the signature *while changing it*, which is the kind of drift
> [`CLAUDE.md`](../../CLAUDE.md) rule 3 exists to catch.
>
> The manifest-versus-grant question in the same signature is **not** settled and is filed as
> [`open-questions.md`](../open-questions.md) A18.
>
> **Corrected again, 2026-08-27, the same day.** A18 is now resolved (owner decision) and
> implemented on `stream/a18-grant-not-manifest`: the first parameter changed from a whole
> `Manifest` to `readonly Pattern[]` — the patterns the user actually **granted**, already
> narrowed by the caller, not the wider set the manifest merely **declared**. The
> manifest-versus-grant question the correction above pointed at is no longer open.

*Why the distinction matters:* a perfectly correct glob matcher, fed a **hostname**, is still
completely defeated by DNS rebinding (T12). Testing the matcher alone covers the harmless half
of the threat. Patterns must be checked against **resolved addresses**.

Plus an `isPublicUnicast` table covering `127/8`, `10/8`, `172.16/12`, `192.168/16`,
`169.254/16`, `::1`, `fc00::/7`, IPv4-mapped `::ffff:127.0.0.1`, and integer and octal literal
forms.

### 2. `fs` path-traversal rejection

`path.relative(root, resolved)` must be non-empty, must not start with `..`, and must not be
absolute — **plus `realpath` on the parent**, so a planted symlink cannot escape.

*Why both:* a string-prefix check passes `/apps/foo-evil` against root `/apps/foo`, and
`path.resolve` does not follow symlinks.

Table: `..`, absolute paths, symlink escape, NUL bytes, sibling-prefix, Windows separators and
drive letters, `\\?\` UNC, reserved names, macOS case-insensitivity. One `fast-check` property:
for random segment arrays, the resolved path is always inside root.

**This is also the flagship's happy path.** A `.torrent` file declares its own file paths, and
`../../../.ssh/authorized_keys` is a real BitTorrent CVE class. T1 and T10 combine here.

### 3. Origin derivation, split in two

1. **URL → origin normalisation:** default ports, trailing dots, case, punycode/IDN, userinfo,
   and rejection of `file:` and `data:`.
2. **`senderFrame` → origin:** asserting that an origin field **in the IPC payload** is
   ignored, that `url` and `frame.origin` must **agree** or the frame is denied, that an
   **opaque** origin (`frame.origin === 'null'`, what a `CSP: sandbox` document reports) is
   rejected outright, and that unbound frames are rejected (T3, T13b).

   *The phrasing here used to be "a renderer-supplied origin field is ignored", which was read
   as meaning `WebFrameMain.origin` — it is not renderer-supplied, and reading only `url`
   opened a real hole. See `security-model.md`'s 2026-08-27 amendment.*

### 4. Key derivation as frozen golden vectors

Hardcoded seed / origin / curve → expected public key hex, for both the `"app"` and
`"identity"` labels, asserting the two differ.

*Not* a determinism test — same-input-same-output is near-tautological for a KDF. The real risk
is the derivation **changing between releases** and silently orphaning every user's identity,
with no export path to recover from ([`ADR-0003`](../decisions/ADR-0003-local-first-storage.md)).

### 5. The update decision table

`decideUpdate({pinnedHash, newHash, grantedPatterns, newPatterns, version, versionFloor})`
→ `'silent' | 'reconsent' | 'capability-prompt' | 'reject'`, about eight rows.

*Why:* its failure mode is **"no prompt appeared"**, which no manual checklist catches, and the
capability at stake is `tcp.connect *:*`.

### 6. Telemetry session accounting

A pure fold over an event stream: start/stop, suspend/resume, tab switch, **active vs
background attribution**, month rollover, abnormal termination (assert a periodic checkpoint,
so a crash loses minutes rather than a session).

*Why:* this is the number the project is judged on, and its likeliest bug **biases it
downward** — making a succeeding product look like a failing one.

---

## The end-to-end test

**One test, covering four of the five critical-path layers in a single launch:**

fixture app served over localhost HTTP with a real `/.well-known/orivon.json` → loaded via the
app loader → grant accepted → `require('net')` **through the shim** connects to a local echo
server and moves bytes → **then the same app attempts a connection outside its manifest
patterns and is rejected.**

**That last clause is the highest-value assertion in the entire plan.** Without it, *nothing
fails if capability enforcement degrades to allow-all* — the unit tests check the matcher in
isolation, the e2e would test only the allow path, and every user journey is a happy path. A
broker regression that skipped the check entirely would pass every test while the product
appeared to work perfectly.

It costs about thirty lines to close. Do not drop it.

### Known risk, check early

Spike gate 3 is **BLOCKED, not failed.** The app works — confirmed by a direct, non-Playwright
launch — but Playwright's `_electron` driver could not attach to that window, for a cause still
unidentified ([`open-questions.md`](../open-questions.md) C6).

**The end-to-end test uses the same driver.** Verify it can attach at the *start* of build step
2, not on the day the test is due.

---

## Guards

Two checks that are not tests but fail the build the same way:

| Guard | Enforces |
|---|---|
| `scripts/check-no-native-modules.mjs` | No dependency requires a compiler (Rule 8). Runs on every `npm install` |
| `scripts/check-contracts-pure.mjs` | `src/contracts/` is complete and references nothing outside itself |

Both are exported pure functions over a root directory, unit tested against temp fixtures, with
a CLI block. Follow that shape if you add a third.

---

## The manual checklist

[`release-checklist.md`](release-checklist.md) — run before each release. It includes
**run-from-source on Windows and macOS**, because that is a supported path that nothing in CI
exercises and it is the one most likely to break silently.

---

## CI

[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) runs on every push and pull
request: `npm ci` (which fires the Rule 8 guard via `postinstall`), typecheck, unit tests,
`check:natives`, `check:contracts`, build.

**With no dedicated code reviewer, CI is the reviewer.** A red pull request does not merge.
