---
name: block-destructive-git-tree-wipe
enabled: true
event: bash
pattern: (?:^|[;&|]\s*)git\s+(?:-C\s+\S+\s+)?(?:reset\s+(?:--\S+\s+)*--hard|checkout\s+(?:-f\b|--force\b|(?:--\s+)?[.:])|restore\s+(?:(?:--(?!staged\b)\S+|-\w)\s+)*(?:--\s+)?[.:]|clean\s+(?:-\w*f|--force)|stash\s+(?:drop|clear)\b|switch\s+(?:\S+\s+)*(?:-f\b|--force\b|--discard-changes\b))
action: block
---

**Tree-wide discard blocked: the primary checkout (`<primary-checkout>`) carries the owner's
uncommitted work.**

`git reset --hard`, `git checkout -- .`, `git restore .`, `git clean -f*`, `git stash drop|clear`
and a forced `git switch` destroy it silently and unrecoverably, stashes other agents parked
included. Wiping the tree is never the recovery from a failed checkout. Instead:

- **Blocked by a checkout or pull?** Work in a worktree (see `block-in-place-branch-switch`).
- **Need a clean tree?** `git stash push -m "<who/why>"`, then `git stash pop` in the same session.
- **Reverting one file you just wrote?** Name it: `git checkout -- <path>`. `.` and `:/` are blocked.
- **Anything wider** is the owner's call. Stop and ask.
