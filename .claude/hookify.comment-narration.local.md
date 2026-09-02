---
name: warn-comment-narrates-the-change
enabled: true
event: file
action: warn
conditions:
  - field: file_path
    operator: regex_match
    pattern: ^(src|scripts|test)/.*\.(ts|tsx|mjs)$
  - field: content
    operator: regex_match
    pattern: (?i)(//|\*)[^\n]*\b(this (PR|commit|task)|the PR body|sibling commit|nothing had ever|already existed|already fully tested|previously (two|separate))\b
---

**A comment here narrates the change, not the code (`docs/development/code-guidelines.md` Rule 1).**

"This PR", "a sibling commit", "already existed", "nothing had ever wired a caller up to it" —
after the branch merges, none of these name anything a reader can resolve, and a comment about
what a task "may not touch" ages into a lie the moment that constraint lifts. Git history holds
the change; the comment should describe the code as it stands.

Keep the durable half — write the constraint, not the episode. "Consolidating these is a
behavioural decision, tracked as A39" survives the merge; "a duplicate this PR does not reach
into" does not. If the reason is genuinely a live cross-stream boundary, name the boundary
(`policy/` may not import `loader/`) or file it in `docs/open-questions.md` and cite the
A-number.

Added 2026-09-02 after an audit found eight of these across three streams — every one of them
passed Rule 1's restates-the-line-below test, which is why the rule needed a second sentence
and this needed a hook. Warn, not block: a false positive is cheap and the judgement is a
reviewer's. See `open-questions.md` A40, which also records why this is warn-only rather than a
`check:comments` build gate (Open point 2 — rules first, enforcement later, owner's decision).
