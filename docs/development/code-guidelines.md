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

Comment lines as a share of the file, source only:

| File | Comment lines | Total | Share |
|---|---|---|---|
| [`src/contracts/handles.ts`](../../src/contracts/handles.ts) | 186 | 247 | 75% |
| [`src/shim/globals.ts`](../../src/shim/globals.ts) | 153 | 247 | 62% |
| [`src/telemetry/disclosure.ts`](../../src/telemetry/disclosure.ts) | 122 | 200 | 61% |
| [`src/main/update-check.ts`](../../src/main/update-check.ts) | 191 | 467 | 41% |

Density alone is not the violation — see the carve-out for `src/contracts/` below. These are
the files to read first when the cleanup starts, not a list of confirmed faults.

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

**Nothing is over its limit today.** That is the good news and also the whole problem — four
source files are close enough that the next ordinary change to any of them breaks the rule:

| File | Lines | Limit | Headroom |
|---|---|---|---|
| [`src/broker/policy/derive.ts`](../../src/broker/policy/derive.ts) | 499 | 500 | **1** |
| [`src/broker/policy/bundle-hash.ts`](../../src/broker/policy/bundle-hash.ts) | 473 | 500 | 27 |
| [`src/broker/policy/address.ts`](../../src/broker/policy/address.ts) | 468 | 500 | 32 |
| [`src/main/update-check.ts`](../../src/main/update-check.ts) | 467 | 500 | 33 |
| [`scripts/smoke.mjs`](../../scripts/smoke.mjs) | 688 | 800 | 112 |
| [`src/broker/policy/bundle-hash.test.ts`](../../src/broker/policy/bundle-hash.test.ts) | 525 | 800 | 275 |
| [`src/broker/policy/paths.test.ts`](../../src/broker/policy/paths.test.ts) | 500 | 800 | 300 |
| [`src/broker/policy/derive.test.ts`](../../src/broker/policy/derive.test.ts) | 482 | 800 | 318 |

The first four are the refactoring worklist. `derive.ts` at one line of headroom is effectively
already over: it cannot absorb a bug fix without a split, and it is on the critical path.

Three of the four are in `src/broker/policy/`, which is a signal in itself — that directory is
where the limit will keep biting, and it is the one to plan a split for rather than to shave.

---

## Rule 3 — One implementation per idea

**Do not rewrite a function that already exists. Find it and reuse it.**

The failure mode is not a developer deciding to duplicate. It is a developer — or an agent
working inside one stream's paths — not knowing the helper already exists, writing a second
one, and both being correct. Nobody notices, because nothing is broken. Then one gets a bug fix
and the other does not.

**This has already happened here, twice, in the same pair of files:**

| Helper | Copy A | Copy B |
|---|---|---|
| `concat(parts)` | [`derive.ts:256`](../../src/broker/policy/derive.ts#L256) | [`bundle-hash.ts:337`](../../src/broker/policy/bundle-hash.ts#L337) |
| `encodeField(value)` | [`derive.ts:215`](../../src/broker/policy/derive.ts#L215) | [`bundle-hash.ts:324`](../../src/broker/policy/bundle-hash.ts#L324) |

The `concat` pair is byte-for-byte the same function. The `encodeField` pair implements the
same length-prefix framing — a big-endian `uint32` byte count followed by the bytes — differing
only in that one takes a string and validates it first. That framing is a **wire format**: if
the two copies ever disagree, two subsystems disagree about an encoding that hashes and keys
depend on.

**Both copies sit in the same directory, owned by the same stream.** There was no boundary in
the way and nothing to raise with anyone — the first copy was simply never looked for. That is
the ordinary case this rule is aimed at, and it is why the first line of defence is a `grep`
rather than a process.

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
  conventions have **already split**. 115 function declarations are written
  `function name (args)`; 14 are written `function name(args)` — and all 14 are in
  [`derive.ts`](../../src/broker/policy/derive.ts) and
  [`derive.test.ts`](../../src/broker/policy/derive.test.ts), nowhere else. One module's worth,
  which is the shape of a convention set in a single session that then never spread. Nobody
  chose it. It is what happens when a rule lives only in reviewers' heads — exactly where
  Rules 1, 2 and 3 live today.
- Rule 2 is trivially checkable, and `scripts/` already holds four guards of this exact kind
  (`check:natives`, `check:contracts`, `check:secrets`, `check:vectors`), so the pattern and the
  CI wiring exist. It is a short script whenever it is wanted.
- Rule 1 is not mechanically checkable by anything, and never will be. It depends on review.

Deferring is defensible while the codebase is small and one person is reading every diff. The
thing to watch for is a **second** convention splitting the way the spacing did — that is the
signal the deferral has expired.

---

## See also

| | |
|---|---|
| [`parallel-work.md`](parallel-work.md) | Who owns which paths — a split under Rule 2 must respect it |
| [`testing.md`](testing.md) | What is tested here, and why so little is |
| [`CLAUDE.md`](../../CLAUDE.md) | §Rules 6 and 7: prefer mature components, and no abstractions for elegance alone |
