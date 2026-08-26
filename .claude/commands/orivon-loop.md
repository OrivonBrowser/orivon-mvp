---
description: One cycle of the autonomous build loop. Run by cron, not by hand.
---

# One loop cycle

You are running **unattended**. The owner is not watching. Behave accordingly:
never guess where you could queue a question, never merge, and leave the board
consistent even if you are killed mid-cycle.

Design and decisions: `docs/planning/autonomous-loop-design.md`.
Selection policy: `orchestration/policy.mjs` — **call it, do not re-derive it in
your head.** It is unit tested; your reasoning is not.

**If `$ARGUMENTS` contains `--dry-run`:** do steps 1–4, print the plan, change
nothing, dispatch nothing, exit.

---

## 1. Load

```bash
node -e "
import('./orchestration/board.mjs').then(async b => {
  const dir = 'orchestration/state'
  b.ensureState(dir)
  const board = b.loadBoard(dir)
  const control = b.loadControl(dir)
  console.log(JSON.stringify({ board, control, pending: b.pendingAnswers(dir, board) }, null, 2))
})"
```

If `board.tasks` is empty, seed it from `orchestration/tasks.json`: every task
gets `status: 'todo'`, `branch: null`, `baseBranch: 'main'`, `pr: null`,
`blockedOn: []`, `assumption: null`, `attempts: 0`.

If `control.globalStop` is true — **stop now.** Write nothing, dispatch nothing.

## 2. Reconcile with GitHub

For every task with `status: 'pr-open'`:

```bash
gh pr view <pr> --json state,mergedAt,statusCheckRollup
```

Build a map `{ <pr>: { state, checks } }` where `state` is
`merged | closed | open` and `checks` is `success | failure | pending`, then
call `reconcile(board, prStates)`.

Also **close the loop on merged work**: for each task that just became `merged`,
remove its worktree (`git worktree remove ../orivon-wt-<id> --force`) and delete
the local branch.

## 3. Apply the owner's answers

Call `ingestAnswers(board, pending)`, then `markAnswersConsumed(board, pending.length)`.

For every task in `invalidated` — the owner's answer contradicted an assumption
it was built on:

1. Close its PR with a comment saying which assumption was wrong.
2. Delete the branch and worktree.
3. Leave it `todo`, unblocked, so it is rebuilt correctly.

**Do not keep a branch built on a rejected assumption.** Its PR looks exactly as
legitimate as any other, which is precisely the problem.

## 4. Select

```
selectWork({ board, control, maxConcurrent: 3, maxAssumptions: 2, maxStackDepth: 4 })
```

Log the returned `reason` verbatim into the cycle log. On `--dry-run`, stop here
and print it.

If `idle` is true: heartbeat, notify **once** (not every cycle — check whether
the previous cycle already did), and exit.

## 5. Dispatch

For each dispatched task, in parallel:

```bash
git worktree add ../orivon-wt-<id> -b stream/<id> <baseBranch>
```

Then spawn **one agent** with `model` from the task and `isolation: "worktree"`.

The agent's brief must contain, verbatim:

- The `definitionOfDone` from the catalogue.
- **The exact paths it may write.** Nothing outside them, for any reason.
- Which types it may use from `src/contracts/` — and that it **must not modify
  `src/contracts/` at all**. A contracts change is its own PR, merged first.
- The relevant sections of `docs/architecture/` for its area.
- `docs/development/testing.md`'s standard: a test earns its place when the
  failure mode is **silent**.
- **"If you hit a real decision — something the owner would want to decide, or
  something where you would otherwise guess — STOP and return a question.
  Do not guess. A queued question costs a day; a wrong assumption baked into the
  broker costs the migration."**
- If the task carries an `assumption`: state the assumed answer explicitly and
  tell the agent to build on it, note it at the top of every file it touches,
  and flag it in the PR.

## 6. Land

For each finished agent, inside its worktree:

```bash
npm run typecheck && npm test && npm run check:natives \
  && npm run check:contracts && npm run check:secrets
npm run smoke      # only if src/main/ changed
```

**A red gate is not a PR.** Set the task back to `todo`, increment `attempts`,
log why. At `attempts === 3` the policy stops selecting it — queue a question
describing what failed all three times.

Green:

```bash
git add -A && git commit    # imperative subject, body explains WHY
git rebase <baseBranch>     # conflicts surface here, not in the owner's face
git push -u origin stream/<id>
gh pr create --base <baseBranch> --title "..." --body "..."
```

PR body, the four parts from `CONTRIBUTING.md`:

```
**Goal** — one sentence.
**Paths touched** — and that they are this task's own.
**Contracts depended on** — which types; state if none changed.
**How it was verified** — the commands run and what they said.
```

If the task carries an assumption, **prefix the title `ASSUMED:`** and make the
first line of the body:

```
> **Built on an assumption.** <question> — assumed: <answer>.
> If that is wrong, close this PR; the branch will be rebuilt.
```

**Never merge. Never use `--admin`, `--auto`, or `gh pr merge` in any form.**
The owner merges. That is decision L1 and branch protection enforces it too.

On an unresolvable rebase conflict: mark the task `conflict`, leave the branch,
move on. Do not spend the cycle on it.

## 7. Questions

Any question from an agent, or from you, goes to
`orchestration/state/questions.jsonl`:

```jsonc
{ "id": "q-000N", "asked": "<iso>", "task": "<task-id>", "urgency": "blocking",
  "question": "...", "options": ["..."], "aiRecommendation": "...",
  "whyItMatters": "what changes depending on the answer", "status": "open" }
```

**Write it the way you would ask the owner out loud.** Explain what each option
*is* before asking them to choose — never bare identifiers, never
`A12 or A13?`. They will be reading it on a phone.

Set `blockedOn: ['q-000N']` on the task.

## 8. Record

- `saveBoard`, incrementing `cycle`.
- `heartbeat(dir, { cycle, dispatched, reason })`.
- `pruneRuns(dir)`.
- Append one line to `devlog/journal.md` **only** for something notable — a
  build step completed, a decision reversed, a blocker found. Not routine
  progress.

## 9. Notify

`orchestration/notify.sh <urgency> <message>` — and only for:

| Urgency | When |
|---|---|
| `blocking` | A new question the owner must answer |
| `review` | A PR is ready — this is the L1 bottleneck, so it matters |
| `failure` | The cycle failed, or a task hit `attempts === 3` |
| `idle` | Nothing left to do — **once**, not every cycle |

**Never notify for routine progress.** A notification nobody needed is annoying
in a way that accumulates, and the owner will mute the bot.

---

## Hard rules

1. **Never merge to `main`.**
2. **Never edit** `.claude/**`, `orchestration/loop.sh`,
   `orchestration/loop-settings.json`, the crontab, or any `~` dotfile. A loop
   that can widen its own permissions has none.
3. **Never put a credential in a tracked file.** `check:secrets` runs in the
   gate and as a pre-commit hook.
4. **Never modify `src/contracts/`** in the same PR as an implementation.
5. **Never exceed the paths a task declares.**
6. **Queue a question rather than guess** — unless the policy explicitly handed
   you an assumption, in which case label it loudly.
7. **Leave the board consistent.** Write it before doing anything slow, so being
   killed mid-cycle costs one cycle and not the run.
