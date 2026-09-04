# Code guidelines

How code is written here. [`parallel-work.md`](parallel-work.md) covers where it is written and
by whom.

Three rules:

1. **Comments earn their place** — and rationale goes in the README, not the file header.
2. **No source file over 500 lines** — 800 for tests.
3. **One implementation per idea** — search before writing a helper.

Written for a human contributor arriving cold and for a smaller model working here without
holding the whole tree in its head. Both are served by the same three things: short files,
honest comments, and one implementation per idea.

**Read §Rules 1-3 to write code here. Everything below them is background** — where each rule
came from and what the codebase's current state is. It is there so a settled argument is not
reopened, not because you need it to start.

> **Provenance**, per [`CLAUDE.md`](../../CLAUDE.md) Rule 2. The three rules and every exception
> stated with them are the **owner's decision** — taken 2026-08-27, extended 2026-09-02 and
> 2026-09-03. §Status is what is still open. Nothing in the rules is an unconfirmed AI
> recommendation.
>
> No ADR was written: none of this is architecture, and the one structural piece — `src/shared/`
> — is freely reversible while it is small.

---

## Rule 1 — Comments earn their place

**Be as short as possible and as complete as necessary, in language a newcomer can follow.**

A comment passes two tests. The first asks whether it says anything; the second asks whether it
belongs in the source at all.

### Test 1 — does it say what the code cannot?

**A comment explains *why*; the code already says *what*.** If it restates the line beneath it,
delete it.

```ts
// Bad — restates the code, costs a line, teaches nothing.
// Set the length to the byte count.
out.setUint32(0, bytes.length, false)

// Good — says the thing the code cannot.
// UTF-8 BYTE count, never value.length. They differ for every non-ASCII
// string, and swapping them changes the derived key.
out.setUint32(0, bytes.length, false)
```

### Test 2 — is it a trap, or is it rationale?

> **A comment that stops a maintainer breaking the line in front of them belongs in the source.
> A comment that explains why the file has the shape it has belongs in the directory's
> `README.md`, under `## Design notes`, or in an ADR.**
>
> Ask: *would someone editing this line get it wrong without this comment?*
> Yes — it stays. No — it is rationale, and it moves.

Worked example: [`connection-log.ts`](../../src/trust/connection-log.ts), header 29 lines before
this rule and 7 after. Its rationale now lives in
[`src/trust/README.md`](../../src/trust/README.md) §Design notes.

| Comment | Verdict |
|---|---|
| "Undefined, not zero, when byte accounting was not available — zero is a real observation" | **Stays.** A maintainer would get this wrong. |
| "Do not drop these to simplify the shape: an app exfiltrating files over many short connections grades at the *best* available grade" | **Stays**, moved next to the fields it protects. A trap, with a name. |
| "Splitting them into three entry types would force every consumer to merge three arrays back together" | **Moves.** It argues with a reviewer about a design already chosen. |
| "ADR-0006's amendment found the connection ladder was cheaper to fake than to earn…" (9 lines) | **Moves.** Real, and worth keeping — in the README. |

**The tell is arguing with a reviewer in the source**: naming a design you did *not* choose,
justifying the shape against alternatives, pre-empting an objection. That is PR-body content,
and it ages badly in a file.

### Describe the code, not the change that produced it

Git history holds the change. A comment that names a branch, a PR or a moment cannot be resolved
by anyone reading after the merge — and one that names a temporary constraint becomes false the
moment that constraint lifts.

| Do not write | Write instead |
|---|---|
| "a duplicate this PR does not reach into" | "Consolidating these is a behavioural decision, tracked as A39" |
| "not deduplicated because this task may not touch that file" | "`policy/` may not import `loader/`" — name the boundary, not the task |
| "a sibling commit added this" | nothing; delete it |
| "already existed", "nothing had ever wired this up" | nothing; describe what the code does now |

Keep the durable half: write the **constraint**, not the episode.

### The budget

**A source file may open with at most 25 lines of comment**, enforced in CI by
`npm run check:comments` ([`scripts/check-comments.mjs`](../../scripts/check-comments.mjs)).
Only the *leading* block is measured — comment density is not.

**What you can and cannot do:**

| You want to | Allowed | How |
|---|---|---|
| Explain why one line is the way it is | **Yes** | One or two lines, next to that line |
| Keep a long trap explanation next to the code it protects | **Yes** | `derive.ts`'s surrogate-pair note is the example |
| Explain why the *file* has the shape it has | **Not in the source** | `## Design notes` in the directory's `README.md` |
| Write a long doc comment on an exported declaration in `src/contracts/` | **Yes, always** | Exempt — those comments *are* the product's API documentation |
| Write a long narrating comment inside a function body | **No, nowhere** | Not exempt anywhere, contracts included. Split the function |
| Open a file with more than 25 lines of comment | **Only with a written reason** | `// orivon:comment-budget -- <why>` (below) |
| Reference a PR, branch or commit | **No** | Write the constraint, not the episode |

**Long comments stay possible. They stop being free.** If a block genuinely cannot be shortened,
say why, in the file:

```ts
// orivon:comment-budget -- three strings once derived the same key through
// unpaired surrogates; the vectors below are what proves that closed.
```

The reason is required — the guard rejects a bare pragma — and
`npm run check:comments -- --exemptions` lists every exemption in the tree with its reason, so
the set stays small enough to review. **Owner's decision, 2026-09-03**: allow long comments when
they are genuinely necessary and not shortenable, but never silently.

**Not checked:** `src/contracts/` (the carve-out above), test files (Rule 2 already gives them a
higher budget for the same reason), and `spike/` (documented throwaway).

---

## Rule 2 — No source file over 500 lines

**A file at 500 lines is at its limit. Split it.**

| | Limit |
|---|---|
| Source | **500** |
| Test files — `*.test.ts`, anything under [`test/`](../../test/), and [`scripts/smoke.mjs`](../../scripts/smoke.mjs) | **800** |

Everything else in `scripts/` is source and gets 500
([`parallel-work.md`](parallel-work.md) §Why `scripts/` is split).

Two reasons, and the second is easy to underrate:

1. A file that long has almost always stopped being one thing. The limit forces the split the
   organisation needed anyway.
2. **A smaller model can hold a 300-line file and reason about it confidently. It cannot do that
   with 900 lines**, and it will make confident wrong edits instead of asking. Human contributors
   get the same benefit; they are just politer about the failure.

**Split by concern, never by line count.** `derive-part2.ts` is worse than the 600-line file it
came from: same coupling, plus a new lie in its name. If a file cannot be split along a real
seam, that is a design signal — raise it rather than cutting arbitrarily.

Each new file lands inside the owning stream's paths
([`parallel-work.md`](parallel-work.md) §The ownership map), and each directory's `README.md`
already states what it may import.

**Why tests get 800.** Table-driven tests grow with their vector tables, and that growth is
legitimate — a golden vector is data, not logic, and splitting a vector table across files makes
it harder to review, not easier. If a test file approaches 800, move the vector table into a
sibling data module before splitting the tests themselves. That keeps the assertions short and
makes the vectors reviewable on their own, which
[`scripts/check-vectors.mjs`](../../scripts/check-vectors.mjs) already wants.

---

## Rule 3 — One implementation per idea

**Do not rewrite a function that already exists. Find it and reuse it.**

Before writing a helper, search for it: `grep -rn "function <name>" src/` costs seconds. The
same applies to near-misses — if the function you want is the one that exists plus one
parameter, add the parameter.

The failure mode is not someone deciding to duplicate. It is someone — or an agent working
inside one stream's paths — not knowing the helper exists, writing a second one, and both being
correct. Nobody notices, because nothing is broken. Then one gets a bug fix and the other does
not.

**The counterweight, so this rule does not become its own problem.** Two functions that happen
to look alike today but answer to different requirements are not duplicates, and merging them
creates a coupling that has to be undone later. [`CLAUDE.md`](../../CLAUDE.md) Rule 7 already
says not to build abstractions for elegance alone. **Extract when the *reason* is shared, not
when the shape is.**

### Where a shared helper lives

Most duplicates are fixable inside their own directory — that is the ordinary case, and it needs
no special home.

**`src/shared/` exists only for helpers needed across a trust boundary**, where Rule 3 otherwise
has no legal answer: [`src/broker/`](../../src/broker/README.md) must never import `src/shim/`,
and [`src/shim/`](../../src/shim/README.md) must never import `src/broker/`, so a helper both
need has nowhere else to go. `src/contracts/` cannot be the answer either —
`npm run check:contracts` fails the build if anything there references code outside itself, and
runtime helpers are not contracts.

Two rules travel with it, both borrowed from contracts because the failure mode is the same (one
change touching every stream at once):

- **It imports nothing from `src/`.** Pure, dependency-free helpers only. If it needs `electron`,
  a broker type, or anything stream-owned, it does not belong there.
- **A change to it goes in its own PR and merges first**, never mixed with an implementation
  ([`CLAUDE.md`](../../CLAUDE.md) §Parallel work).

**It is not a dumping ground.** A helper earns its place by being needed on both sides of a
boundary. One caller means it stays where it is. See
[`src/shared/README.md`](../../src/shared/README.md).

---

# Background

**Nothing below is a rule.** It is where the rules came from and what the codebase's current
state is, kept so a settled argument is not reopened. Skip it unless you are changing a rule or
wondering why one exists.

## Where each rule came from

**Rule 1, the restatement test (2026-08-27).** An audit found that density alone was not the
useful signal — the two densest files in the repo
([`src/contracts/handles.ts`](../../src/contracts/handles.ts) at 75% and
[`src/broker/policy/derive.ts`](../../src/broker/policy/derive.ts) at 60%) were both correctly
dense. Two files were genuinely restating themselves, and were cut on
`stream/backlog-07-guidelines-cleanup`:

| File | Cut | Reason |
|---|---|---|
| [`src/telemetry/disclosure.ts`](../../src/telemetry/disclosure.ts) | 200 → 181 lines | The same fact ("undecided excludes itself at the type level") stated three times; four decorative section banners |
| [`src/main/update-check.ts`](../../src/main/update-check.ts) | 467 → 441 lines | A 14-line header table-of-contents duplicating the file's own banners; "no download happens here" stated three times |
| [`src/telemetry/accounting.ts`](../../src/telemetry/accounting.ts) | 309 → 298 lines | Three restatements of "this is pure"; a header overview overlapping three functions' own docs |
| [`src/broker/policy/derive.ts`](../../src/broker/policy/derive.ts) | 499 → 498 lines | One meta-clause introducing a correction — the correction itself stayed |

Left alone, checked rather than skipped: [`src/shim/globals.ts`](../../src/shim/globals.ts)
(62%, nearly all load-bearing trap documentation) and
[`src/contracts/manifest.ts`](../../src/contracts/manifest.ts) /
[`src/contracts/ipc.ts`](../../src/contracts/ipc.ts).

**Rule 1, describe-the-code-not-the-change (2026-09-02).** An audit found eight comments across
three streams naming a branch, a PR or a temporary constraint. Every one passed the restatement
test, which is why the rule needed a sentence of its own
([`open-questions.md`](../open-questions.md) A40).

**Rule 1, the destination test and the budget (2026-09-03).** The owner reported that agents
kept writing comment essays. Measurement showed **40 of 84 non-contracts source files at or
above 50% comment lines**, and 18 opening with a block over 25 lines — up to 94, in
`policy/connect-src.ts`.

The cause was that Rule 1 had only the restatement test, **which a file-header essay passes**:
every line of one explains a decision, a trap or a non-obvious consequence, exactly as the rule
asks. An agent following Rule 1 faithfully still wrote a 90-line preamble. Hence the destination
test, and the budget to hold it.

The 25 is calibrated, not picked. The files this document defends as correctly dense open with
**14–21** lines (`derive.ts` 20, `globals.ts` 21, `contracts/manifest.ts` 14); the essays open
with **26–94**. Density was tried first and dropped — it cannot separate the two cases, because
`derive.ts` is 67% comment and correct while `connection-log.ts` was 75% and an essay. What
separates them is *where the comment sits*.

A related finding, recorded because it explains why the 2026-09-02 correction did not hold: the
hookify rule written to enforce it had **never fired**, and neither had `scope-creep`. Both
anchored `file_path` at `^src/`, and `Write`/`Edit` always pass an absolute path
([`open-questions.md`](../open-questions.md) A55).

**Rule 2 (2026-08-27).** Two coordinated branches. `stream/backlog-06-rule2-violations` fixed
what had already broken the rule:

| File | Before | Split into | Largest part after |
|---|---|---|---|
| [`src/broker/handles.ts`](../../src/broker/handles.ts) | 1045 | `handle-contracts.ts`, `errors.ts`, `handle-store.ts`, `handles.ts` | 497 |
| [`src/broker/policy/connect.ts`](../../src/broker/policy/connect.ts) | 622 | `canonical-host.ts`, `connect-patterns.ts`, `connect.ts` | 297 |
| `src/broker/handles.test.ts` | 1212 | `handles.test-helpers.ts`, `handles.test.ts`, `handles-limits.test.ts` | 750 |
| `src/broker/policy/connect.test.ts` | 1149 | `connect.test-helpers.ts`, `connect.test.ts`, `connect-patterns.test.ts` | 623 |

`handles.ts`'s split needed a design decision, not a mechanical move: the nine methods acting on
one origin's state became a real `OriginTable` **class** (`handle-store.ts`) rather than free
functions taking a table parameter, so the ownership check that lived in `#`-privacy did not
quietly disappear.

`stream/backlog-07-guidelines-cleanup` fixed the four about to break it:

| File | Before | Split into | Largest part after |
|---|---|---|---|
| [`src/broker/policy/derive.ts`](../../src/broker/policy/derive.ts) | 499 | `derive-encoding.ts`, `derive.ts`, `derive-p256.ts` | 267 |
| [`src/broker/policy/bundle-hash.ts`](../../src/broker/policy/bundle-hash.ts) | 473 | `canonical-path.ts`, `bundle-hash.ts` | 253 |
| [`src/broker/policy/address.ts`](../../src/broker/policy/address.ts) | 468 | `address-ranges.ts`, `address-parse.ts`, `address.ts` | 208 |
| [`src/main/update-check.ts`](../../src/main/update-check.ts) | 467 | `github-release-version.ts`, `update-check.ts`, `update-check-runner.ts` | 213 |

Two splits paid for themselves beyond the line count: `canonical-path.ts` let
[`pin.ts`](../../src/broker/policy/pin.ts) drop a dependency on the hashing half of
`bundle-hash.ts` it never used, and `github-release-version.ts`'s extraction surfaced that its
semver grammar had quietly diverged from
[`policy/update.ts`](../../src/broker/policy/update.ts)'s.

Verifying those splits took more than a passing test count: several tests loop over path arrays
inside one `it()`, where a dropped row is invisible to a count, and the extraction caught two
real corrupted-Unicode mistakes in its own first pass.

**Rule 3 (2026-08-27).** It had already happened twice in the same pair of files:

| Helper | Copy A | Copy B | Now lives in |
|---|---|---|---|
| `concat(parts)` | `derive.ts:256` | `bundle-hash.ts:337` | [`bytes.ts`](../../src/broker/policy/bytes.ts) |
| `encodeField(value)` | `derive.ts:215` | `bundle-hash.ts:324` | [`bytes.ts`](../../src/broker/policy/bytes.ts)'s `frame()` |

The `concat` pair was byte-for-byte identical. The `encodeField` pair implemented the same
length-prefix framing — a big-endian `uint32` byte count followed by the bytes — differing only
in that one took a string and validated it first. That framing is a **wire format**: had the
copies drifted, two subsystems would have disagreed about an encoding that hashes and keys
depend on. Both frozen golden-vector tables hash byte-identically after the consolidation —
verified, not assumed.

**Both copies sat in the same directory, owned by the same stream.** No boundary was in the way
and there was nothing to raise with anyone — the first copy was simply never looked for. That is
why the first line of defence is a `grep` rather than a process.

Six more turned up in the same audit, all fixable inside their own directory:

| Helper | Copies | Now lives in |
|---|---|---|
| `fail(code, message)` | 4, across `derive.ts`, `derive-encoding.ts`, `bundle-hash.ts`, `pin.ts` | [`policy/errors.ts`](../../src/broker/policy/errors.ts) |
| Own-property read + type guard | `pin.ts`'s `ownString`/`ownNumber`/`ownFiniteNumber`, `update.ts`'s `patternsFor` | [`own-property.ts`](../../src/broker/policy/own-property.ts) |
| Truncate-for-logging (`x.slice(0, 120)`) | 5 inline copies in `pin.ts` | `canonical-path.ts`'s `describePath` |
| Windows reserved-device-name table | `paths.ts`, `canonical-path.ts` | [`windows-device-names.ts`](../../src/broker/policy/windows-device-names.ts) (table only) |
| `invokedDirectly` CLI guard + `rel()` | 3, across the `check-no-*.mjs` guards | [`scripts/cli.mjs`](../../scripts/cli.mjs) |
| IPC channel strings | `main/ipc.ts`, `main/window.ts`, `preload/shell.ts`, under 3 names | [`main/channels.ts`](../../src/main/channels.ts) |

## Status

Raised under [`CLAUDE.md`](../../CLAUDE.md) Rule 3 rather than smoothed over.

**Enforcement — partly reversed 2026-09-03.** Rule 1's comment budget is now enforced in CI by
`npm run check:comments`. **Rules 2 and 3 remain unenforced, by owner's decision** ("rules first,
enforcement later", 2026-08-27).

> **Correction, 2026-09-04 (owner's decision).** Rule 2 is now enforced too: `npm run check:size`
> (`scripts/check-size.mjs`) is wired into CI's `check` job, in the same change that split
> `src/broker/index.ts` back under the limit (`src/broker/broker-contracts.ts`,
> `stream/backlog-09-rule2-and-size-gate`) so the newly-enforced gate would not immediately fail
> on an existing file. This entry's "Rules 2 and 3 remain unenforced" is superseded for **Rule 2
> only** — **Rule 3 remains unenforced**, unaffected by this change, and the bullet below about
> `check-size.mjs` being deliberately unwired is stale for the same reason.

The deferral expired for Rule 1 for the reason it named: the rule was read and followed, and the
codebase drifted anyway. It also corrects that decision's claim that *"Rule 1 is not mechanically
checkable by anything, and never will be"* — comment **quality** is not checkable, and that part
stands; a comment **budget** is, and the guard never judges quality.

Still true, and still the cost of deferring:

- There is no `eslint`, `prettier`, `biome` or `.editorconfig`, and the conventions **had already
  split once** — 14 function declarations in `derive.ts` written `function name(args)` against 115
  elsewhere written `function name (args)`. Normalised 2026-08-27, but the mechanism that let it
  happen is unchanged. A **second** such split is the signal this deferral has expired for style
  too.
- Rule 2 is trivially checkable. `scripts/check-size.mjs` exists on
  `stream/packaging-01-build-verify` and is deliberately **not** wired to CI, pending the same
  owner call this correction made for Rule 1.

**Open — the comment-budget baseline.** 16 files listed in
[`scripts/comment-budget-baseline.txt`](../../scripts/comment-budget-baseline.txt) open over
budget and were not rewritten, because each is owned by a stream with a live branch. The list is
a **ratchet**: an entry whose file comes back within budget fails the check, so it can only
shrink ([`open-questions.md`](../open-questions.md) A54).

**Open — two Rule-3 duplicates, deliberately unfixed.** A lowercase-hex encoder
([`bundle-hash.ts`](../../src/broker/policy/bundle-hash.ts)'s `toLowercaseHex`, inlined again in
`handles.ts`'s `newHandleId`) and `MAX_HOST_LENGTH`/`MAX_PORT` (duplicated between `origin.ts`
and `connect.ts`). Both cross into files `backlog-06` restructured wholesale; fixing them from
`backlog-07` would have guaranteed a structural merge conflict. Both are real violations and
neither is fixed.

**Open — whether the hookify rules fire.** Two of seven never had. Three more are fine by
inspection; two were untested ([`open-questions.md`](../open-questions.md) A55).

---

## See also

| | |
|---|---|
| [`parallel-work.md`](parallel-work.md) | Who owns which paths — a split under Rule 2 must respect it |
| [`testing.md`](testing.md) | What is tested here, and why so little is |
| [`CLAUDE.md`](../../CLAUDE.md) | §Rules 6 and 7: prefer mature components, and no abstractions for elegance alone |
