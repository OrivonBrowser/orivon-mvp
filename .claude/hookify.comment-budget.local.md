---
name: warn-file-opens-with-an-essay
enabled: true
event: file
action: warn
conditions:
  # Write and Edit always pass an ABSOLUTE file_path, so this must not be
  # anchored at the repo root -- a `^src/` pattern silently never matches and
  # the rule never fires. Verified against the engine, not assumed.
  # Exclusions ride along as a lookahead: hookify has no `not_regex_match`
  # operator, and an unknown operator evaluates to false, killing the rule.
  # `test/` is excluded except `test/apps/`, which is app code the suites
  # serve rather than test code -- same carve-out scripts/check-comments.mjs
  # and scripts/check-size.mjs make.
  - field: file_path
    operator: regex_match
    pattern: ^(?!.*(?:src/contracts/|(?:^|/)test/(?!apps/)|\.test\.ts$|\.d\.ts$|scripts/smoke\.mjs$))(?:.*/)?(?:src|scripts|test/apps)/.*\.(?:ts|tsx|mts|cts|js|mjs|cjs)$
  - field: content
    operator: regex_match
    pattern: ^(?:[ \t]*(?://|/\*|\*)[^\n]*\n|[ \t]*\n){26,}
---

**This file opens with more than 25 lines of comment; `npm run check:comments` will fail it
(`docs/development/code-guidelines.md` Rule 1, §The budget).**

A comment that stops a maintainer breaking the line in front of it belongs in the source, next
to that line. A comment explaining why the file has the shape it has is rationale: move it to
`## Design notes` in the directory's `README.md` (`src/trust/README.md` is the worked example)
or to an ADR, and leave a one-line pointer. Arguing with a reviewer (naming a design you did not
choose, pre-empting an objection) belongs in the PR body.

If the block genuinely cannot be shortened, say why in the file; the reason is required:

    // orivon:comment-budget -- <why this cannot be shortened>
