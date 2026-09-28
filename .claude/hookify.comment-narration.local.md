---
name: warn-comment-narrates-the-change
enabled: true
event: file
action: warn
conditions:
  - field: file_path
    operator: regex_match
    pattern: ^(?:.*/)?(?:src|scripts|test)/.*\.(?:ts|tsx|mjs)$
  - field: content
    operator: regex_match
    pattern: (?i)(//|\*)[^\n]*\b(this (PR|commit|task)|the PR body|sibling commit|nothing had ever|already existed|already fully tested|previously (two|separate))\b
---

**This comment narrates the change, not the code (`docs/development/code-guidelines.md` Rule 1).**

"This PR", "a sibling commit", "already existed", "nothing had ever wired this up": after the
merge none of these name anything a reader can resolve. Git holds the change; the comment
describes the code as it stands.

Write the constraint, not the episode. "Consolidating these is a behavioural decision, tracked
as A39" survives the merge; "a duplicate this PR does not reach into" does not. For a live
boundary, name it (`policy/` may not import `loader/`), or file it in `docs/open-questions.md`
and cite the A-number.
