# Code guidelines

How code is written here. [`parallel-work.md`](parallel-work.md) covers where it is written and
by whom.

Three rules:

1. **Comments earn their place**, and rationale goes in the README, not the file header.
2. **No source file over 500 lines**, or 800 for tests.
3. **One implementation per idea**: search before writing a helper.

Written for a human contributor arriving cold and for a smaller model working here without
holding the whole tree in its head. Both are served by the same three things: short files,
honest comments, and one implementation per idea.

**Read §Rules 1-3 to write code here. Everything below them is background**: why each rule is
shaped the way it is, and what is still open. It is there so a settled argument is not reopened,
not because you need it to start.

> The three rules and every exception stated with them are settled. §Status is what is still
> open. No ADR was written: none of this is architecture, and the one structural piece,
> `src/shared/`, is freely reversible while it is small.

---

## Rule 1: Comments earn their place

**Be as short as possible and as complete as necessary, in language a newcomer can follow.**

A comment passes two tests. The first asks whether it says anything; the second asks whether it
belongs in the source at all.

### Test 1: does it say what the code cannot?

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

### Test 2: is it a trap, or is it rationale?

> **A comment that stops a maintainer breaking the line in front of them belongs in the source.
> A comment that explains why the file has the shape it has belongs in the directory's
> `README.md`, under `## Design notes`, or in an ADR.**
>
> Ask: *would someone editing this line get it wrong without this comment?*
> Yes, it stays. No, it is rationale, and it moves.

Worked example: [`connection-log.ts`](../../src/trust/connection-log.ts), header 29 lines before
this rule and 7 after. Its rationale lives in
[`src/trust/README.md`](../../src/trust/README.md) §Design notes.

| Comment | Verdict |
|---|---|
| "Undefined, not zero, when byte accounting was not available — zero is a real observation" | **Stays.** A maintainer would get this wrong. |
| "Do not drop these to simplify the shape: an app exfiltrating files over many short connections grades at the *best* available grade" | **Stays**, moved next to the fields it protects. A trap, with a name. |
| "Splitting them into three entry types would force every consumer to merge three arrays back together" | **Moves.** It argues with a reviewer about a design already chosen. |
| "ADR-0006's amendment found the connection ladder was cheaper to fake than to earn…" (9 lines) | **Moves.** Real, and worth keeping, but in the README. |

**The tell is arguing with a reviewer in the source**: naming a design you did *not* choose,
justifying the shape against alternatives, pre-empting an objection. That is PR-body content,
and it ages badly in a file.

### Test 3: could a name carry it instead? *(provisional)*

Before writing a comment, try to make it unnecessary: a named constant instead of a magic number,
a named predicate instead of a commented condition, a named helper instead of a narrated block.
If the rename lands, delete the comment it replaced.

**One exception.** Keep a trap comment even after a good name, when the mistake it guards
against is *deleting or "simplifying" the code*, not misreading it. Worked case:
[`bundle-hash.ts`](../../src/broker/policy/bundle-hash.ts)'s `compareUtf8Bytes`, where the name
already says what the function does; the comment survives because a default
`Array.prototype.sort()` would pass the entire test suite, and only the comment stops someone
"simplifying" it away.

### Describe the code, not the change that produced it

Git history holds the change. A comment that names a branch, a PR or a moment cannot be resolved
by anyone reading after the merge, and one that names a temporary constraint becomes false the
moment that constraint lifts.

| Do not write | Write instead |
|---|---|
| "a duplicate this PR does not reach into" | "Consolidating these is a behavioural decision, tracked as A39" |
| "not deduplicated because this task may not touch that file" | "`policy/` may not import `loader/`", naming the boundary rather than the task |
| "a sibling commit added this" | nothing; delete it |
| "already existed", "nothing had ever wired this up" | nothing; describe what the code does now |

Keep the durable half: write the **constraint**, not the episode.

### The budget

**A source file may open with at most 25 lines of comment**, enforced in CI by
`npm run check:comments` ([`scripts/check-comments.mjs`](../../scripts/check-comments.mjs)).
Only the *leading* block is measured; comment density is not.

**What you can and cannot do:**

| You want to | Allowed | How |
|---|---|---|
| Explain why one line is the way it is | **Yes** | One or two lines, next to that line |
| Keep a long trap explanation next to the code it protects | **Yes** | `derive.ts`'s surrogate-pair note is the example |
| Explain why the *file* has the shape it has | **Not in the source** | `## Design notes` in the directory's `README.md` |
| Write a long doc comment on an exported declaration in `src/contracts/` | **Yes, always** | Exempt: those comments *are* the product's API documentation |
| Write a long narrating comment inside a function body | **No, nowhere** | Not exempt anywhere, contracts included. Split the function |
| Open a file with more than 25 lines of comment | **Only with a written reason** | `// orivon:comment-budget -- <why>` (below) |
| Reference a PR, branch or commit | **No** | Write the constraint, not the episode |
| Cite a per-review finding ID (`F2`, `B-F8`, `P-F13`) | **No** | Same problem as a PR/branch/commit reference: it resolves to nothing once the review round that produced it closes |

**The finding-ID row is provisional**, added because the sweep
that produced this table found ~25 such citations in one directory alone, all as unresolvable as
the PR/branch/commit references the row above already bans, for the identical reason.

**Long comments stay possible. They stop being free.** If a block genuinely cannot be shortened,
say why, in the file:

```ts
// orivon:comment-budget -- three strings once derived the same key through
// unpaired surrogates; the vectors below are what proves that closed.
```

The reason is required (the guard rejects a bare pragma), and
`npm run check:comments -- --exemptions` lists every exemption in the tree with its reason, so
the set stays small enough to review. Long comments are allowed when they are genuinely
necessary and not shortenable, but never silently.

**Not checked:** `src/contracts/` (the carve-out above), test files (Rule 2 already gives them a
higher budget for the same reason), and `spike/` (documented throwaway).

---

## Rule 2: No source file over 500 lines

**A file at 500 lines is at its limit. Split it.**

| | Limit |
|---|---|
| Source | **500** |
| Test files (`*.test.ts`, anything under [`test/`](../../test/), and [`scripts/smoke.mjs`](../../scripts/smoke.mjs)) | **800** |

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
seam, that is a design signal; raise it rather than cutting arbitrarily.

Each new file lands inside the owning stream's paths
([`parallel-work.md`](parallel-work.md) §The ownership map), and each directory's `README.md`
already states what it may import.

**Why tests get 800.** Table-driven tests grow with their vector tables, and that growth is
legitimate: a golden vector is data, not logic, and splitting a vector table across files makes
it harder to review, not easier. If a test file approaches 800, move the vector table into a
sibling data module before splitting the tests themselves. That keeps the assertions short and
makes the vectors reviewable on their own, which
[`scripts/check-vectors.mjs`](../../scripts/check-vectors.mjs) already wants.


### Where a test file lives

**Every test lives in a `tests/` folder inside the directory whose code it covers**, not beside
that code, and not pooled into one directory at the root. `src/loader/index.test.ts` is
`src/loader/tests/index.test.ts`; `src/broker/handles/handles.test.ts` is
`src/broker/handles/tests/handles.test.ts`.

The reason is what a directory listing is *for*. Before this, `src/broker/` held 83 files of
which 40 were tests, interleaved alphabetically, so roughly half of what a reader scrolled past
was not the code being read. Grouping by directory rather than pooling at the root keeps the
locality that made colocation attractive in the first place: a directory still shows its own
tests and nobody else's.

This applies to test helpers and test-only fixtures too (`*.test-helpers.ts`, a vector table
imported only by a test). It does **not** apply to an artefact that a guard verifies
independently: [`src/broker/policy/derive-vectors.json`](../../src/broker/policy/derive-vectors.json)
stays beside the code it freezes, because
[`check-vectors.mjs`](../../scripts/check-vectors.mjs) and `ADR-0010` treat it as a
specification rather than a fixture.

**Nothing enforces this.** The line-limit and comment guards classify by filename suffix, not by
directory, so a stray `foo.test.ts` beside its source still gets the 800-line budget and still
passes CI. Filed with the other unenforced layout rules as `A85`.

---

## Rule 3: One implementation per idea

**Do not rewrite a function that already exists. Find it and reuse it.**

Before writing a helper, search for it: `grep -rn "function <name>" src/` costs seconds. The
same applies to near-misses: if the function you want is the one that exists plus one
parameter, add the parameter.

The failure mode is not someone deciding to duplicate. It is someone, or an agent working
inside one stream's paths, not knowing the helper exists, writing a second one, and both being
correct. Nobody notices, because nothing is broken. Then one gets a bug fix and the other does
not.

**The counterweight, so this rule does not become its own problem.** Two functions that happen
to look alike today but answer to different requirements are not duplicates, and merging them
creates a coupling that has to be undone later. [`CLAUDE.md`](../../CLAUDE.md) Rule 7 already
says not to build abstractions for elegance alone. **Extract when the *reason* is shared, not
when the shape is.**

### Where a shared helper lives

Most duplicates are fixable inside their own directory, which is the ordinary case, and it needs
no special home.

**`src/shared/` exists only for helpers needed across a trust boundary**, where Rule 3 otherwise
has no legal answer: [`src/broker/`](../../src/broker/README.md) must never import `src/shim/`,
and [`src/shim/`](../../src/shim/README.md) must never import `src/broker/`, so a helper both
need has nowhere else to go. `src/contracts/` cannot be the answer either, because
`npm run check:contracts` fails the build if anything there references code outside itself, and
runtime helpers are not contracts.

Two rules travel with it, both borrowed from contracts because the failure mode is the same (one
change touching every stream at once):

- **It imports nothing from `src/`.** Pure, dependency-free helpers only. If it needs `electron`,
  a broker type, or anything stream-owned, it does not belong there.
- **A change to it goes in its own PR and merges first**, never mixed with an implementation
  ([`parallel-work.md`](parallel-work.md) §3).

**It is not a dumping ground.** A helper earns its place by being needed on both sides of a
boundary. One caller means it stays where it is. See
[`src/shared/README.md`](../../src/shared/README.md).

---

# Background

**Nothing below is a rule.** It is where the rules came from and what the codebase's current
state is, kept so a settled argument is not reopened. Skip it unless you are changing a rule or
wondering why one exists.

## Why the rules are shaped this way

**Rule 1: density is not the signal.** Some files are correctly dense:
[`src/contracts/handles.ts`](../../src/contracts/handles.ts) is 75% comment and
[`src/broker/policy/derive.ts`](../../src/broker/policy/derive.ts) 67%, and both are right, because
nearly every line documents a trap. What goes wrong is a comment that restates the code (Test 1)
or argues a decision that belongs in a README (Test 2).

**Why the destination test exists alongside the restatement test.** A file-header essay passes
the restatement test: every line of one explains a decision, a trap or a non-obvious
consequence, exactly as Test 1 asks. An agent following Test 1 faithfully can still write a
90-line preamble. Test 2 asks *where* the comment belongs, which is what separates the two
cases, and the budget holds it.

**Why the budget is 25.** The files this document defends as correctly dense open with 14-21
lines of leading comment (`derive.ts` 20, `globals.ts` 21, `contracts/manifest.ts` 14); an essay
opens with 26 or more. Density cannot separate them, since a correct file and an essay can both
sit near 70%; what separates them is where the comment sits.

**Rule 2: a split can need a design decision, not a mechanical move.** Splitting
[`handles.ts`](../../src/broker/handles/handles.ts) turned the methods acting on one origin's
state into a real `OriginTable` class (`handle-store.ts`) rather than free functions taking a
table parameter, so the ownership check that lived in `#`-privacy did not quietly disappear. A
good split also pays for itself: [`canonical-path.ts`](../../src/broker/policy/canonical-path.ts)
let [`pin.ts`](../../src/broker/policy/pin.ts) drop a dependency on the hashing half of
`bundle-hash.ts` it never used.

**Verify a split by more than a passing test count.** Several suites loop over path arrays
inside one `it()`, where a dropped row is invisible to a count.

**Rule 3: duplicates happen inside one directory, not across boundaries.** The typical pair sits
in the same directory, owned by the same stream, with no boundary in the way: the first copy was
simply never looked for. That is why the first line of defence is a `grep` rather than a
process.

**The dangerous duplicate is a wire format.** [`bytes.ts`](../../src/broker/policy/bytes.ts)'s
`frame()` is the length-prefix framing (a big-endian `uint32` byte count followed by the bytes)
that both `derive.ts` and `bundle-hash.ts` depend on. Two drifting copies would make two
subsystems disagree about an encoding that hashes and keys depend on, and both frozen
golden-vector tables are what prove they agree.

## Status

**Enforcement.** Rules 1 and 2 are enforced in CI, by `npm run check:comments` and
`npm run check:size` (`scripts/check-size.mjs`) respectively. **Rule 3 remains unenforced**:
nothing mechanically detects a second implementation of an idea. Comment **quality** is not
checkable either; a comment **budget** is, and the guard never judges quality.

**No formatter or linter.** There is no `eslint`, `prettier`, `biome` or `.editorconfig`, and the
conventions have already split once (function declarations written both `function name(args)`
and `function name (args)`). They were normalised, but nothing stops a second split. If it
happens, that is the signal to add a formatter.

**Open: two Rule-3 duplicates.** A lowercase-hex encoder
([`bundle-hash.ts`](../../src/broker/policy/bundle-hash.ts)'s `toLowercaseHex`, inlined again in
[`handle-store.ts`](../../src/broker/handles/handle-store.ts)'s handle-id generation), and
`MAX_HOST_LENGTH`, defined in both [`origin.ts`](../../src/broker/policy/origin.ts) and
[`canonical-host.ts`](../../src/broker/policy/canonical-host.ts). Both are real violations and
neither is fixed.

**Open: whether every hookify rule fires** ([`open-questions.md`](../open-questions.md) A55). A
rule whose `file_path` pattern is anchored at the repository root never matches the absolute
path `Write`/`Edit` pass, and dies silently.

---

## See also

| | |
|---|---|
| [`parallel-work.md`](parallel-work.md) | Who owns which paths, and a split under Rule 2 must respect it |
| [`testing.md`](testing.md) | What is tested here, and why so little is |
| [`CLAUDE.md`](../../CLAUDE.md) | §Rules 6 and 7: prefer mature components, and no abstractions for elegance alone |
| [`.claude/skills/orivon-comments/`](../../.claude/skills/orivon-comments/SKILL.md) | The working method for applying Rule 1 while writing code: this document is the policy, that skill is how |
