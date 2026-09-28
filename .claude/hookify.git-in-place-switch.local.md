---
name: block-in-place-branch-switch
enabled: true
event: bash
pattern: (?:^|[;&|]\s*)git\s+(?:[-\w]+\s+\S+\s+)?pull\b|(?:^|[;&|]\s*)git\s+(?!-C\b)(?:checkout|switch)\s+(?!--\s)[^\s;&|]+|(?:^|[;&|]\s*)gh\s+pr\s+checkout\b
action: block
---

**In-place branch switch or pull blocked: it fails on this dirty tree, and the usual recovery
destroys work.**

The primary checkout carries the owner's uncommitted work, so `git checkout <branch>`,
`git switch`, `gh pr checkout` and `git pull` abort, and clearing the tree to get past that
loses the work. Instead:

- **Another branch:** `git worktree add <path> -b <branch> <base>`, then symlink `node_modules`
  (`docs/development/parallel-work.md`).
- **A PR:** `git -C <worktree> fetch origin pull/<n>/head` (this rule blocks `gh pr checkout`).
- **Syncing `main`:** never `git pull`; follow parallel-work.md §Syncing `main` with `origin`.
  Sync unprompted only on a clean tree; on a dirty tree, report and do not act.
- **Inside a worktree you own:** `git -C <literal path> ...` is not blocked.
- **Stashed something?** Pop it in the same session.
