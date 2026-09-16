---
name: block-destructive-git-tree-wipe
enabled: true
event: bash
pattern: (?:^|[;&|]\s*)git\s+(?:-C\s+\S+\s+)?(?:reset\s+(?:--\S+\s+)*--hard|checkout\s+(?:-f\b|--force\b|(?:--\s+)?[.:])|restore\s+(?:(?:--(?!staged\b)\S+|-\w)\s+)*(?:--\s+)?[.:]|clean\s+(?:-\w*f|--force)|stash\s+(?:drop|clear)\b|switch\s+(?:\S+\s+)*(?:-f\b|--force\b|--discard-changes\b))
action: block
---

**Tree-wide discard blocked: this checkout permanently carries the owner's uncommitted work.**

The primary checkout at `/home/jhon/Desktop/Develop/Claude/orivon-mvp` is **not** a scratch
tree. It routinely holds 25-30 modified files of live, unpushed work across docs,
`src/contracts/` and `src/telemetry/` -- that was true for the whole of 2026-09-10..16 and is
the normal state, not a mess to clean up. Nothing warns you before it is gone.

`git reset --hard`, `git checkout -- .`, `git restore .`, `git clean -f*` and
`git stash drop|clear` all destroy it silently and unrecoverably. Two of the three stashes
currently on this repo are labelled *"not mine"* -- work parked by one agent that another
agent would erase with a single `stash drop`.

**This rule fires most often as the "recovery" from a failed checkout.** Git refuses the
switch, and the tempting next move is to wipe the tree so the switch succeeds. That trades an
error message for permanent data loss. It is never the right move here.

Instead:

- **Blocked by a checkout or pull?** Do not clear the tree -- see
  `block-in-place-branch-switch`, and work in a worktree.
- **Need a genuinely clean tree?** `git stash push -m "<who/why> <date>"`, do the work, and
  **`git stash pop` in the same session.** A stash you leave behind becomes someone else's
  "not mine".
- **Reverting one file you yourself just wrote?** Name it: `git checkout -- <path>`. Targeted
  paths are allowed; `.` and `:/` are not.
- **Anything wider than that is the owner's call.** Stop and ask.
