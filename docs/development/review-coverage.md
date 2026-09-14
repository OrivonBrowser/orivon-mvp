# Review coverage

Which pull requests have been independently reviewed, and by what, used to exist in **no label,
no field and no document** -- only in prose inside fleet ledgers kept outside this repository
(`docs/open-questions.md` A126). The owner had to reconstruct the gap by hand and hand the list
over; it could not be derived from the repository at all. This is that record, moved in-repo.

## What belongs here

Not every merged PR gets a row. An ordinary PR merges on its own author's testing, as this
repository has always allowed, and that is not a gap this document exists to close.

An entry belongs here when an **independent** review pass ran over a PR or a range of them --
independent meaning a second reader, human or agent, checking work that was not their own:

- a conductor's hand-review of a diff (the standing carve-out for `src/broker/` and `src/main/`,
  from `docs/development/unattended-run-protocol.md`'s "Which model runs what" -- those two
  directories are hand-reviewed personally, never trusted from a lane's own report alone);
- an `adversarial-reviewer` or `named-persona-adversarial-review` pass (`CLAUDE.md`'s tooling
  table: run after each build step lands, on the broker and the app loader at minimum);
- a `/claude-security` scan (`CLAUDE.md`'s tooling table: end of build step 2, and before
  packaging);
- a clean-checkout verification -- a fresh clone and install, run to catch what a shared
  `node_modules` symlink across worktrees cannot.

Record the range, what ran, who or what ran it, and the outcome in aggregate -- not a
re-narration of each individual finding, which belongs in `open-questions.md` or in the PR
itself.

## Where the record starts

**Nothing before PR #163 is recorded here.** That is not a claim that earlier PRs went
unreviewed -- `docs/planning/audit-2026-08-25.md` records five independent audits that predate
this document, and `CLAUDE.md`'s tooling table has required `adversarial-reviewer` and
`/claude-security` at named points since 2026-08-25. It is only that no one brought the record
inside the repository before now, so the honest state of everything earlier is **unrecorded**,
not **unreviewed**. Do not read an absence above this line as a finding.

## Log

### PRs #163-#182 -- build step 4 landing and hardening pass (19 PRs, 2026-09-13/14)

| Mechanism | Scope | Outcome |
|---|---|---|
| Conductor hand-review | Every diff in this range touching `src/broker/` or `src/main/`, applied PR by PR as each one merged | Caught issues before merge within this range -- for example three rationale comments ("nothing calls this yet") that had gone stale between being written and tonight, fixed conductor-authored in PR #177 before they could mislead a later reader |
| Three-reviewer adversarial pass | The 93-file, ~7400-insertion step-4 landing (PRs #163-#177) as a whole, once it was complete -- split by axis rather than by file count: adv1 (the consent and grant path), adv2 (the loader and pinned-bundle serving), adv3 (the seams between PRs -- the axis no single-PR review can see) | 10 issues found. 8 fixed in the same run (PRs #179-#181); 2 filed open pending an owner decision -- `open-questions.md` A157 (partially) and A158 (fully) |
| Clean-checkout verification | Main after the adversarial fixes (PR #181, 18 PRs) -- a fresh clone from the GitHub remote (not the local repository, so it also proved `origin/main` reachable), its own `npm install`, the full gate suite, full e2e, `npm run build`, `check:dev-grant-absent` | Passed completely against a genuinely fresh `out/`. Also surfaced an unrelated leak (`scripts/smoke.mjs` never removing its temp profile), fixed as PR #182, the last PR in this range |

Per-finding detail is in `open-questions.md` (A153-A158) and this run's own fleet ledger, kept
outside this repository. This row records that the review happened and what it found in
aggregate, not a re-narration of each finding.

## Adding an entry

When an independent review event finishes -- a hand-review, an adversarial pass, a security
scan, a clean-checkout run -- add one row naming the PR or range it covered, what ran, and the
outcome. This is not filled in per ordinary PR; most PRs here merge on their author's own
verification, and recording that would not tell a later reader anything they could not already
see in the PR itself.
