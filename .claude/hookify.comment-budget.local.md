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
  - field: file_path
    operator: regex_match
    pattern: ^(?!.*(?:src/contracts/|(?:^|/)test/|\.test\.ts$|\.d\.ts$|scripts/smoke\.mjs$))(?:.*/)?(?:src|scripts|apps)/.*\.(?:ts|tsx|mts|cts|js|mjs|cjs)$
  - field: content
    operator: regex_match
    pattern: ^(?:[ \t]*(?://|/\*|\*)[^\n]*\n|[ \t]*\n){26,}
---

**This file opens with more than 25 lines of comment (`docs/development/code-guidelines.md`
Rule 1, §The budget). `npm run check:comments` will fail on it.**

Rule 1's first test is whether a comment restates the code. A header essay passes that test,
which is exactly why this second one exists: **a comment that stops a maintainer breaking the
line in front of them belongs in the source; a comment explaining why the file has the shape it
has belongs in the directory's `README.md`.**

Ask: *would someone editing this line get it wrong without this comment?* Yes — keep it, and
put it next to that line rather than at the top. No — it is rationale. Move it to
`## Design notes` in the directory's `README.md` ([`src/trust/README.md`](../src/trust/README.md)
is the worked example) or to an ADR, and leave a one-line pointer.

The tell is arguing with a reviewer in the source: naming a design you did *not* choose,
justifying the shape against alternatives, or pre-empting an objection. That is PR-body
content, and it ages badly in a file.

If the block genuinely cannot be shortened, keep it and say why — the guard accepts it, and the
reason is required rather than optional:

```
// orivon:comment-budget -- <why this cannot be shortened>
```

Added 2026-09-03. Warn rather than block, because the judgement is a reviewer's and a false
positive is cheap — CI is what actually holds the line. The narrower 2026-09-02 rule
(`hookify.comment-narration.local.md`) catches a different failure and both still apply.
