---
name: "orivon-comments"
description: Use when writing or editing a comment anywhere in src/, when a file's header is growing past a few lines, when you are about to write a comment that cites a PR/branch/commit/finding-ID/date, when deciding whether new rationale belongs in the source or in a README, or when reviewing a diff for comment quality before a commit on the critical path. Captures the working method from the 2026-09-07 repo-wide comment sweep (stream/backlog-15-comment-sweep) so a future pass does not have to re-derive it.
---

# Writing comments that earn their place

This is the working method behind `docs/development/code-guidelines.md` Rule 1 — read that
document for the policy itself (the two tests, the budget, the table of what you can and cannot
do); this skill is how to apply it while writing or editing code, not a restatement of it.

## Before writing the comment, try to make it unnecessary

A comment is the second-best fix. In order, cheapest first:

1. **A named constant instead of a magic number.** `MAX_QUEUE_SIZE = 1` needs no comment to say
   what the cap is; it still needs one to say *why* 1 (that part is real rationale — see below).
2. **A named predicate instead of a commented condition.** `if (isDegenerateSeed(seed))` reads;
   `if (/* every byte identical */ seed.every(...))` does not.
3. **A named helper instead of a narrated block.** If three lines need four lines of comment to
   explain what they do as a unit, the unit wants a name.
4. **A rename of the thing itself**, when the existing name is what forces the comment to exist
   (`docs/development/code-guidelines.md` Rule 1 §Test 3 has the full statement and its one
   exception).

**Skip all four in a file with zero unit-test coverage.** A rename or extraction is a behavior-
preserving refactor only if something actually re-runs the behavior afterward; in an untested
file it is an unverified guess. `src/main/{index,ipc,newtab-ipc,subsystems,tabs,
update-check-runner,window}.ts`, `src/preload/{app,newtab,shell}.ts` and
`src/renderer/{bookmarks-view,icons,main,newtab/main}.ts` are the current zero-coverage set —
comment-only edits there, verified by `xvfb-run npm run smoke` / `test:e2e`, not a refactor.

## When a trap comment survives a good name anyway

Not every comment collapses into a name. Keep one when the mistake it prevents is **deleting or
"simplifying" the code**, not misreading it. The worked case:
[`bundle-hash.ts`](../../../src/broker/policy/bundle-hash.ts)'s `compareUtf8Bytes` — the name
already says what the function does. The comment survives because its own test file states
plainly that a default `Array.prototype.sort()` would pass the *entire* suite; nothing about
reading the code would tell you that swapping it in is safe to try and isn't. A good name earns
its keep by making the *what* free; it does not make the *why-not-the-obvious-alternative* free.

## Tokens that never belong in a source comment

None of these resolve for a reader who was not in the room when the comment was written. Write
the constraint they were protecting instead — see `docs/README.md`'s
[§Reference shorthand](../../../docs/README.md#reference-shorthand) for which tokens *do*
resolve to something (`T<n>`, `A<n>`, `ADR-NNNN`) and which explicitly do not (`d-NNNN`,
per-review finding IDs).

| Instead of | Write |
|---|---|
| `SS<Word>` (an ASCII stand-in for `§`, common in older source) | `"<Word>" section` — spell it out, do not introduce a literal `§` into `src/` (ASCII-only prose; `docs/open-questions.md` A91 is the filed contradiction between that rule and the docs corpus's own 185 real `§` characters) |
| A bare per-review finding ID (`F2`, `B-F8`, `P-F13`) | The actual constraint the finding was about. It resolves to nothing once the review round closes — `code-guidelines.md`'s comment-budget table bans it outright |
| A PR/branch/commit reference | The constraint, not the episode — already banned in `code-guidelines.md` §Describe the code, not the change that produced it |
| "Fixed 2026-08-27", "found by review, 2026-08-27" | Nothing, once the fix itself is what the surrounding comment already states. Keep the date only when the *history itself* is the load-bearing fact (a frozen-vector one-way door, a revised owner decision) |
| "this lane", "this task", "this PR" | Name the actual boundary or component instead (`policy/` may not import `loader/`, not "this task doesn't touch that file") |
| A bare `d-NNNN` owner-decision id | The token, plus the decision spelled out in words next to it — the register doesn't exist yet (A90), so the token alone is not load-bearing |

## Rationale goes to the directory README, not the file header

`code-guidelines.md`'s Test 2 is the rule; the mechanical part is where it goes and in what
shape:

- Target: the directory's `README.md`, under a `## Design notes` heading. If the directory has
  no such section yet, use the preamble every existing one shares (`src/trust/README.md` is the
  worked example) — do not invent new wording per directory.
- One entry per topic, bold-led with the file/function it concerns:
  `**[\`file.ts\`](file.ts)'s \`thing\` does X, on purpose.** Why...` — a reader scanning the
  section should be able to tell what each entry is about from its first sentence alone.
- Leave a one-line pointer in the source at the spot the rationale used to occupy: `see
  README.md's Design notes for why`. Never leave the reader to guess that a README exists.
- A caller-facing warning (what a function does *not* do, what a caller must additionally check)
  belongs on that function's own doc comment, not the README — a maintainer calling it will read
  the doc comment; they will not necessarily open the README first. Design notes are for *why the
  file has the shape it has*, not for a contract a caller needs at the call site.

## Duplicate paragraphs are a Rule 3 violation, not a style choice

The same paragraph copied across N files is N chances for it to drift, and Rule 3
(`docs/development/code-guidelines.md`) already names the fix: write it once, in the file that
owns the concept, and reduce every other copy to a one-line pointer at the same spot. Before
adding rationale anywhere, grep for a phrase from it — a hit elsewhere means you are the second
copy, not the first. This sweep's own register (now resolved, so absent from `main`, but the
method stands): a probe-oracle paragraph on denial uniformity, a handle/grant sentence, an
exhaustiveness-guard note, a rollback-acknowledgement doc, an interface-not-a-class note, a
tcp.connect/tcp.listen scope paragraph, and an `import type` rationale each had 2-6 copies before
being collapsed to one owner plus pointers.

## How the comment-budget guard actually measures a file

`npm run check:comments` ([`scripts/check-comments.mjs`](../../../scripts/check-comments.mjs))
finds the single largest contiguous run of comment lines before the first substantive line, and
fails a source file whose run exceeds 25 lines. Three mechanics worth knowing before you fight
the number instead of the shape:

- **Density is not checked, only the leading run.** A file that is 67% comment throughout
  (`derive.ts`) can pass while a 75%-comment file with a 29-line header (`connection-log.ts`,
  before this rule) fails — position, not proportion, is what the guard measures, because that is
  what actually separates "comment that earns its place next to the code" from "essay paid for by
  every reader before line one."
- **An import statement does not end the run, and does not extend it either.** A header split by
  moving half of it below the imports is measured as one continuous block, not two short ones —
  there is no way to dodge the limit by relocating comments around an `import`.
- **`src/contracts/` and `spike/` are exempt**, and test files are never checked at all (Rule 2
  already gives them a separate 800-line budget for the same underlying reason). Nowhere else is
  exempt by directory.
- **A block that genuinely cannot shrink stays, with a reason**:
  `// orivon:comment-budget -- <why>`. The reason is mandatory — a bare pragma is rejected — and
  `npm run check:comments -- --exemptions` lists every one in the tree, so the escape hatch stays
  visible rather than silent (`docs/development/code-guidelines.md` §The budget).

## What a comment-only change still has to verify

"Comment-only" is a claim about intent, not a fact the guard checks for you — verify it the same
way any other change is verified:

- `npm run typecheck && npm test && npm run check:comments && npm run check:size` on every file,
  always.
- `npm run check:vectors` for anything under `src/broker/policy/` — it re-reads `derive.ts` as
  raw text, so a comment mentioning the `CURVE_ORDER` hex values a second time fails it exactly
  as a code change would.
- Editing `src/preload/*.ts` can silently trigger a real `npm run build` inside the next
  `npm test`, because the preload test suite rebuilds the bundle whenever a source file is newer
  than the built output — a slow `npm test` after a preload comment edit is that rebuild, not a
  hang. Run `xvfb-run -a npm run test:e2e` afterward if anything besides a comment changed.
- `src/preload/tests/main-world-socket.test.ts` extracts `installOrivon`'s source out of the
  *built* bundle and evals it with a restricted global scope. Renaming that function breaks the
  test; an unbalanced `{`/`}` inside a comment *inside* its body corrupts the slice the test
  extracts. Extracting a helper to module scope (outside the function) also breaks it — only
  extraction that stays inside the function body is safe.
- Non-comment changes under `src/main/` still need `xvfb-run -a npm run smoke` even when they
  look purely mechanical — several files there (`subsystems.ts` among them) have zero unit
  coverage, so the smoke run is the only thing that actually exercises them.
