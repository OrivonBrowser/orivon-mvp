# Code guidelines

How code is written here, as opposed to [`parallel-work.md`](parallel-work.md), which is where
it is written and by whom.

Three rules, set by the owner on 2026-08-27 after reviewing what build steps 1 and 2 had
actually produced. They are not style preferences. Each one is here because the codebase was
already drifting in that direction, and the examples below are drawn from this repository
rather than invented.

The audience is deliberately wide: a human contributor arriving cold, and a smaller model that
has to work here without holding the whole tree in its head. Both are served by the same three
things — short files, honest comments, and one implementation per idea.

> **Provenance**, per [`CLAUDE.md`](../../CLAUDE.md) Rule 2. Rules 1, 2 and 3 and everything
> under §Applying the rules are the **owner's decision**, taken 2026-08-27. §Open points is what
> is **still open**. Nothing here is an unconfirmed AI recommendation.
>
> No ADR was written: none of this is architecture, and the one structural piece — `src/shared/`
> — is freely reversible while it is small. If it grows into a real dependency hub, that is the
> point to record an ADR.

---

## Rule 1 — Comments earn their place

**Be as short as possible and as complete as necessary, in language a newcomer can follow.**

A comment is allowed to be long when length is genuinely what makes a section understandable.
It is not allowed to be long by default.

The test is simple: **a comment explains *why*; the code already says *what*.** If a comment
restates the line beneath it, delete the comment. If it explains a decision, a trap, or a
non-obvious consequence, keep it — and keep it in plain words, because the reader may be new to
the project, new to TypeScript, or a model with a small context window.

```ts
// Bad — restates the code, costs a line, teaches nothing.
// Set the length to the byte count.
out.setUint32(0, bytes.length, false)

// Good — says the thing the code cannot.
// UTF-8 BYTE count, never value.length. They differ for every non-ASCII
// string, and swapping them changes the derived key.
out.setUint32(0, bytes.length, false)
```

**Where a long comment is right.** [`derive.ts`](../../src/broker/policy/derive.ts) spends
about fifteen lines explaining that three different strings once derived the same key through
unpaired surrogates. That is a security property, it was discovered rather than designed, and
nothing in the code below states it. It stays.

**Where it is wrong.** Narration of ordinary control flow, restating a type that is already
written, or a block explaining a function whose name already explains it.

### Where the codebase stands

**Cleaned up 2026-08-27**, on `stream/backlog-07-guidelines-cleanup`. An audit found that density
alone was not the useful signal — the two densest files in the repo
([`src/contracts/handles.ts`](../../src/contracts/handles.ts) at 75% and
[`src/broker/policy/derive.ts`](../../src/broker/policy/derive.ts) at 60%) were both correctly
dense: the first is `src/contracts/`'s own carve-out below, the second is nearly all load-bearing
security reasoning. Two files were genuinely restating themselves:

| File | Cut | Reason |
|---|---|---|
| [`src/telemetry/disclosure.ts`](../../src/telemetry/disclosure.ts) | 200 → 181 lines | The same fact ("undecided excludes itself at the type level") stated three separate times; four purely decorative section-banner rules |
| [`src/main/update-check.ts`](../../src/main/update-check.ts) | 467 → 441 lines (before the Rule-2 split below) | A 14-line header table-of-contents duplicating the file's own section banners; "no download happens here" stated three times |
| [`src/telemetry/accounting.ts`](../../src/telemetry/accounting.ts) | 309 → 298 lines | Three separate restatements of "this is pure"; a header overview overlapping three functions' own docs |
| [`src/broker/policy/derive.ts`](../../src/broker/policy/derive.ts) | 499 → 498 lines | One meta-clause introducing a correction — the correction itself stayed; deleting it would let a future reader re-derive the mistake it exists to prevent |

Left alone, checked rather than skipped: [`src/shim/globals.ts`](../../src/shim/globals.ts) (62%,
nearly all load-bearing trap documentation), and
[`src/contracts/manifest.ts`](../../src/contracts/manifest.ts) /
[`src/contracts/ipc.ts`](../../src/contracts/ipc.ts) (both exempt below, and correctly dense even
setting the exemption aside).

---

## Rule 2 — No source file over 500 lines

**A file at 500 lines is at its limit. Split it.** Test files get **800**, for the reason in
§Rule 2 and test files below.

Two reasons, and the second is the one that is easy to underrate:

1. A file that long has almost always stopped being one thing. The limit forces the split that
   the organisation needed anyway.
2. **A smaller model — Sonnet, or whatever is cheap next year — can hold a 300-line file and
   reason about it confidently. It cannot do that with 900 lines**, and it will make confident
   wrong edits instead of asking. Human contributors get the same benefit; they are just
   politer about the failure.

**Split by concern, never by line count.** `derive-part2.ts` is worse than the 600-line file it
came from: it has the same coupling plus a new lie in its name. If a file cannot be split along
a real seam, that is a design signal — raise it rather than cutting arbitrarily.

Each new file lands inside the owning stream's paths
([`parallel-work.md`](parallel-work.md) §The ownership map), and each directory's `README.md`
already states what it may import.

### Where the codebase stands

**Nothing is over its limit**, as of two coordinated branches landing 2026-08-27:
`stream/backlog-06-rule2-violations` (the files that had already broken the rule) and
`stream/backlog-07-guidelines-cleanup` (the four that were close enough to break it on the next
ordinary change). Both must merge for the table below to be accurate — check `git log` if you are
reading this before they have.

**The real violations, found after PRs #8 and #13 landed** (`backlog-06`):

| File | Before | Split into | Largest part after |
|---|---|---|---|
| [`src/broker/handles.ts`](../../src/broker/handles.ts) | 1045 | `handle-contracts.ts`, `errors.ts`, `handle-store.ts`, `handles.ts` | 497 |
| [`src/broker/policy/connect.ts`](../../src/broker/policy/connect.ts) | 622 | `canonical-host.ts`, `connect-patterns.ts`, `connect.ts` | 297 |
| `src/broker/handles.test.ts` | 1212 | `handles.test-helpers.ts`, `handles.test.ts`, `handles-limits.test.ts` | 750 |
| `src/broker/policy/connect.test.ts` | 1149 | `connect.test-helpers.ts`, `connect.test.ts`, `connect-patterns.test.ts` | 623 |

`handles.ts`'s split required a design decision, not just a mechanical move: the nine methods
that acted on one origin's state became a real `OriginTable` **class** (`handle-store.ts`) rather
than free functions taking a table parameter, so the ownership check that used to live in
`#`-privacy did not quietly disappear. See that commit's message for the reasoning.

**The four that were about to break it** (`backlog-07`, this branch):

| File | Before | Split into | Largest part after |
|---|---|---|---|
| [`src/broker/policy/derive.ts`](../../src/broker/policy/derive.ts) | 499 | `derive-encoding.ts`, `derive.ts`, `derive-p256.ts` | 267 |
| [`src/broker/policy/bundle-hash.ts`](../../src/broker/policy/bundle-hash.ts) | 473 | `canonical-path.ts`, `bundle-hash.ts` | 253 |
| [`src/broker/policy/address.ts`](../../src/broker/policy/address.ts) | 468 | `address-ranges.ts`, `address-parse.ts`, `address.ts` | 208 |
| [`src/main/update-check.ts`](../../src/main/update-check.ts) | 467 | `github-release-version.ts`, `update-check.ts`, `update-check-runner.ts` | 213 |

Two splits paid for themselves beyond the line count: `canonical-path.ts` let
[`pin.ts`](../../src/broker/policy/pin.ts) drop a dependency on the hashing half of
`bundle-hash.ts` it never used, and `github-release-version.ts`'s extraction is what surfaced
that its semver grammar had quietly diverged from
[`policy/update.ts`](../../src/broker/policy/update.ts)'s (see Rule 3 below).

Two test files ([`bundle-hash.test.ts`](../../src/broker/policy/bundle-hash.test.ts),
[`address.test.ts`](../../src/broker/policy/address.test.ts)) were also split or had their vector
tables extracted (to `canonical-path.test.ts` and `address-vectors.ts`) even though neither was
over the 800-line test limit — Rule 2 and test files below explains why that extraction is worth
doing before a file is actually at risk, not after. Verifying these splits took more than a
passing test count: several tests loop over path arrays inside one `it()`, where a dropped row is
invisible to a count, and the extraction caught two real corrupted-Unicode mistakes in its own
first pass — see that commit's message.

`scripts/smoke.mjs` (688/800) and the vector-table test files this audit originally flagged
(`paths.test.ts`, `derive.test.ts`) were never violations under the 800-line test limit; the
original table above listed them for context, not as a worklist.

---

## Rule 3 — One implementation per idea

**Do not rewrite a function that already exists. Find it and reuse it.**

The failure mode is not a developer deciding to duplicate. It is a developer — or an agent
working inside one stream's paths — not knowing the helper already exists, writing a second
one, and both being correct. Nobody notices, because nothing is broken. Then one gets a bug fix
and the other does not.

**This had already happened here, twice, in the same pair of files** — found 2026-08-27 and fixed
on `stream/backlog-07-guidelines-cleanup`:

| Helper | Copy A | Copy B | Now lives in |
|---|---|---|---|
| `concat(parts)` | `derive.ts:256` | `bundle-hash.ts:337` | [`bytes.ts`](../../src/broker/policy/bytes.ts) |
| `encodeField(value)` | `derive.ts:215` | `bundle-hash.ts:324` | [`bytes.ts`](../../src/broker/policy/bytes.ts)'s `frame()`, wrapped by `derive-encoding.ts` |

The `concat` pair was byte-for-byte the same function. The `encodeField` pair implemented the
same length-prefix framing — a big-endian `uint32` byte count followed by the bytes — differing
only in that one took a string and validated it first. That framing is a **wire format**: if the
two copies had drifted, two subsystems would have disagreed about an encoding that hashes and
keys depend on. Both frozen golden-vector tables (`derive.ts`'s and `bundle-hash.ts`'s) hash
byte-identically after the consolidation — verified, not assumed.

**Both copies sat in the same directory, owned by the same stream.** There was no boundary in
the way and nothing to raise with anyone — the first copy was simply never looked for. That is
the ordinary case this rule is aimed at, and it is why the first line of defence is a `grep`
rather than a process.

**Six more turned up in the same audit, and all six were fixable inside their own directory —
none needed `src/shared/`:**

| Helper | Copies | Now lives in |
|---|---|---|
| `fail(code, message)` | 4 copies across `derive.ts`, `derive-encoding.ts`, `bundle-hash.ts`, `pin.ts` | [`policy/errors.ts`](../../src/broker/policy/errors.ts) |
| Own-property read + type guard | `pin.ts`'s `ownString`/`ownNumber`/`ownFiniteNumber`, `update.ts`'s `patternsFor` | [`own-property.ts`](../../src/broker/policy/own-property.ts) |
| Truncate-for-logging (`x.slice(0, 120)`) | 5 inline copies in `pin.ts` | `canonical-path.ts`'s `describePath`, already exported |
| Windows reserved-device-name table | `paths.ts`, `canonical-path.ts` | [`windows-device-names.ts`](../../src/broker/policy/windows-device-names.ts) (table only — the two wrapper checks apply it with different case rules and stayed separate) |
| `invokedDirectly` CLI guard + `rel()` | 3 copies across `check-no-native-modules.mjs`, `check-contracts-pure.mjs`, `check-no-secrets.mjs` | [`scripts/cli.mjs`](../../scripts/cli.mjs) |
| IPC channel strings | `main/ipc.ts`, `main/window.ts`, `preload/shell.ts`, under 3 different constant names | [`main/channels.ts`](../../src/main/channels.ts) |

**Two known duplicates were deliberately left alone**, not missed: a lowercase-hex encoder shared
between `bundle-hash.ts` and `handles.ts`, and `MAX_HOST_LENGTH`/`MAX_PORT` shared between
`origin.ts` and `connect.ts`. Both cross into files `backlog-06` (above) restructured wholesale;
fixing them from this branch would have created a guaranteed structural merge conflict rather than
a content one. Left for a follow-up once both branches have merged.

Before writing a helper, search for it. `grep -rn "function <name>" src/` costs seconds. The
same applies to near-misses: if the function you want is the one that exists plus one
parameter, add the parameter.

**The counterweight, so this rule does not become its own problem.** Two functions that happen
to look alike today but answer to different requirements are not duplicates, and merging them
creates a coupling that has to be undone later. [`CLAUDE.md`](../../CLAUDE.md) Rule 7 already
says not to build abstractions for elegance alone. Extract when the *reason* is shared, not
when the shape is.

---

## Applying the rules

### Rule 1 and `src/contracts/`

**Doc comments on exported declarations in `src/contracts/` are exempt from Rule 1's brevity
pressure. Inline comments inside function bodies are not — anywhere, contracts included.**

[`src/contracts/handles.ts`](../../src/contracts/handles.ts) is 75% comment lines, and that is
correct rather than a violation. `src/contracts/` is the durable surface — a shortcut there
costs every app ever written for Orivon ([`CLAUDE.md`](../../CLAUDE.md) §The load-bearing idea)
— and its doc comments *are* the API documentation an app developer reads. Thinning them to hit
a density target would be trading the expensive thing for the cheap one.

The exemption is narrow on purpose. It covers the `/** ... */` block above an exported type or
function. It does not license narration inside a body.

### Rule 2 and test files

**Test files get 800 lines. Source gets 500.**

Table-driven tests grow with their vector tables, and that growth is legitimate — a golden
vector is data, not logic, and splitting a vector table across files makes it harder to review,
not easier. 800 leaves room for that while still bounding the file.

"Test file" here means `*.test.ts`, plus [`test/`](../../test/) and
[`scripts/smoke.mjs`](../../scripts/smoke.mjs) — the shell's e2e regression check, which is a
test harness despite living in `scripts/` ([`parallel-work.md`](parallel-work.md) §Why
`scripts/` is split). Everything else in `scripts/` is source and gets 500.

If a test file does approach 800, move the vector table into a sibling data module before
splitting the tests themselves. That keeps the assertions short and makes the vectors
reviewable on their own, which [`scripts/check-vectors.mjs`](../../scripts/check-vectors.mjs)
already wants.

### Where a shared helper lives

**`src/shared/`, change-controlled the way `src/contracts/` is.**

For helpers needed across a trust boundary — the case where Rule 3 previously had no legal
answer. See [`src/shared/README.md`](../../src/shared/README.md) for what may go in it, and
§Open points for the boundary problem that motivated it.

Two rules travel with it, both borrowed from contracts because the failure mode is the same
(one change touching every stream at once):

- **It imports nothing from `src/`.** Pure, dependency-free helpers only. If it needs
  `electron`, a broker type, or anything stream-owned, it does not belong there.
- **A change to it goes in its own PR and merges first**, never mixed with an implementation
  ([`CLAUDE.md`](../../CLAUDE.md) §Parallel work).

**It is not a dumping ground.** A helper earns its place there by being needed on both sides of
a boundary. One caller means it stays where it is.

---

## Open points

Raised under [`CLAUDE.md`](../../CLAUDE.md) Rule 3 rather than smoothed over.

**1. Why `src/shared/` exists — the boundary problem. Answered 2026-08-27.**

Not an ownership-map oversight — a consequence of the trust boundaries. The per-directory
`README.md` files state what each may never import, and two of them point at each other:
[`src/broker/`](../../src/broker/README.md) must never import `src/shim/`, and
[`src/shim/`](../../src/shim/README.md) must never import `src/broker/`. Those are real
(importing the broker would hand renderer-side code main-process authority), so they are not
going to be relaxed.

The consequence: a helper needed by both has nowhere legal to live. Whichever stream writes it
second is left with exactly the option Rule 3 forbids.

`src/contracts/` cannot be the answer either — `npm run check:contracts` deliberately fails the
build if anything there references code outside itself, and runtime helpers are not contracts.

**This does not excuse the duplicates above**, which were same-directory and same-stream. It is
the case Rule 3 could not answer, not the case that produced today's violations.

Resolved by `src/shared/` — see §Where a shared helper lives.

**2. Nothing mechanically enforces any of these rules, and that is deliberate for now.**

**Owner's decision, 2026-08-27: rules first, enforcement later.** No linter, no formatter, no
`check:size`. Revisit after the refactor lands.

Recorded here because the cost is real and should be visible rather than discovered later:

- There is no `eslint`, `prettier`, `biome` or `.editorconfig` in the repository, and the
  conventions **had already split once**: 14 function declarations in
  [`derive.ts`](../../src/broker/policy/derive.ts) and `derive.test.ts` were written
  `function name(args)` against 115 written `function name (args)` everywhere else — one
  module's worth, the shape of a convention set in a single session that then never spread.
  Nobody chose it. Normalised 2026-08-27 (whitespace-only, verified with `git diff -w`, before
  those two files were split further) as part of `backlog-07`, but the mechanism that let it
  happen — nothing enforces style — is unchanged, and a **second** such split is the signal the
  deferral below has expired.
- Rule 2 is trivially checkable, and `scripts/` already holds four guards of this exact kind
  (`check:natives`, `check:contracts`, `check:secrets`, `check:vectors`), so the pattern and the
  CI wiring exist. It is a short script whenever it is wanted.
- Rule 1 is not mechanically checkable by anything, and never will be. It depends on review.

Deferring is defensible while the codebase is small and one person is reading every diff.

**3. Two Rule-3 duplicates were found and deliberately left unfixed. Still open.**

A lowercase-hex encoder ([`bundle-hash.ts`](../../src/broker/policy/bundle-hash.ts)'s
`toLowercaseHex`, inlined again in `handles.ts`'s `newHandleId`) and the network-limit constants
`MAX_HOST_LENGTH`/`MAX_PORT` (duplicated between `origin.ts` and `connect.ts`) both cross into a
file `backlog-06` restructured wholesale in the same window this cleanup ran in. Editing either
from `backlog-07` would have edited a file about to become three different files under a
different branch, guaranteeing a structural merge conflict rather than the ordinary kind. Both
are real Rule-3 violations and neither is fixed. Next up once both branches have merged.

---

## See also

| | |
|---|---|
| [`parallel-work.md`](parallel-work.md) | Who owns which paths — a split under Rule 2 must respect it |
| [`testing.md`](testing.md) | What is tested here, and why so little is |
| [`CLAUDE.md`](../../CLAUDE.md) | §Rules 6 and 7: prefer mature components, and no abstractions for elegance alone |
