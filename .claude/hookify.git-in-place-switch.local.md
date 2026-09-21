---
name: block-in-place-branch-switch
enabled: true
event: bash
pattern: (?:^|[;&|]\s*)git\s+(?:[-\w]+\s+\S+\s+)?pull\b|(?:^|[;&|]\s*)git\s+(?!-C\b)(?:checkout|switch)\s+(?!--\s)[^\s;&|]+|(?:^|[;&|]\s*)gh\s+pr\s+checkout\b
action: block
---

**Branch switch / pull blocked: it fails on this tree, and the usual recovery destroys work.**

This checkout is permanently dirty by design (25-30 modified files of the owner's live work),
so `git checkout <branch>`, `git switch`, `gh pr checkout` and `git pull` abort with:

> Your local changes to the following files would be overwritten by checkout ...
> Please commit your changes or stash them before you switch branches.

In VSCodium the owner sees only *"Please clean your repository working tree before checkout."*
-- the extension regex-matches git's stderr and replaces it, **dropping the file list**. The
`git-error-<n>` tab it opens alongside still has the full stderr; the popup does not. So when
an agent leaves this landmine, the owner gets the least useful half of the message.

Do this instead:

- **Reading or building another branch?** Never switch in place. `git worktree add <path>
  -b <branch> <base>` gives you an isolated tree and touches nothing here. Roughly 100 already
  exist (`git worktree list`) precisely so nobody has to switch. Remember the `node_modules`
  symlink -- `docs/development/parallel-work.md`.
- **Reviewing a PR?** `gh pr checkout` in a fresh worktree, or fetch the ref:
  `git -C <worktree> fetch origin pull/<n>/head`.
- **Syncing `main` with `origin`?** Never `git pull` -- `docs/development/parallel-work.md` §Syncing `main` with `origin` gives the exact procedure
  (fetch, back the tree up to a patch, `git stash push`, `git merge --ff-only origin/main`,
  `git stash pop`, verify with `git diff --numstat`). Owner's decision, 2026-09-15: run it
  unprompted **only when the tree is clean**, and **report rather than act when it is dirty**.
  It is dirty now, and has been for a week -- so the answer is almost always: tell the owner,
  do not sync.
- **Already inside a worktree you own?** Address it explicitly -- `git -C <literal path> ...`
  is not blocked by this rule. The bare form is, because bare means "whatever directory this
  shell happens to be in", which is usually this one.

If you stash to get past something, **pop it in the same session.** Unpopped stashes here are
already labelled "not mine" and nobody dares touch them.
