# AI workflow audit: where tokens, quality and alignment are lost, and what to change

Written 2026-09-28 for the agent session that will apply it, and for the owner, who reads
section 6. `docs/planning/` is exempt from CLAUDE.md Rule 2, so this page carries dates and
history on purpose. Applied the same day on `stream/ai-workflow-audit`; §7 records where the
application departed from the plan.

## 1. What was measured

Sources, all read directly rather than recalled:

- the 332 Claude Code session transcripts for this repository under `~/.claude/projects/`
  (238 at the old checkout path, 94 at the current one; 2026-08-25 to 2026-09-28), using the
  per-turn `usage` fields (`cache_read_input_tokens`, `cache_creation_input_tokens`,
  `input_tokens`, `output_tokens`), the `tool_use` blocks and the `tool_result` lengths;
- the git history (1,366 commits, 511 merges) and the 24 merged PRs of the public repository;
- the plugin, skill and hook configuration in `~/.claude/` and `.claude/`;
- the repository's docs, guards and test timings, run today.

The transcripts are private to the owner's machine. Reproducing the numbers means re-reading
them; the scripts were throwaway and are not kept.

## 2. The numbers

### Token usage across 332 sessions

| Measure | Value |
|---|---|
| Assistant turns | 48,044 |
| Cache-read input tokens | 16.9 billion |
| Cache-write input tokens | 282 million |
| Output tokens | 59 million |
| Average context per turn | about 355k tokens |
| Share of all context tokens spent on turns whose context was over 400k | 65% |
| Share spent on turns under 200k | 11% |
| Compactions in 332 sessions | 10 |
| Sessions whose context peaked over 600k | 23 |
| Longest single session | two days, 798 tool calls, peak over 900k |
| Peak day (2026-09-25) | 3,808 turns, 1.69 billion context tokens, 3.5 M output |
| Sessions alive in the same hour, maximum | 15; three or more in 186 of 705 active hours |

At Opus list prices the cache reads alone are about three quarters of the equivalent bill.
Every turn re-reads the whole context, so a 700k-token session pays for its entire history on
every tool call, and most of that history is tool output that no longer matters.

### What fills the context

| Source | Volume |
|---|---|
| Bash results | 17,224 calls, 30 M chars, 62% of all tool-result text |
| Read results | 2,577 calls, 14.7 M chars, 5.7k chars per call |
| Files re-read inside one session | 706 extra reads |
| Test and smoke runs | 2,408 runs, 1.8 M chars |
| ExitPlanMode plans | 50, median 15k chars, largest 43k |
| Agent prompts | 478, median 4.3k chars, largest 21.6k |
| Owner prompts | median 200-350 chars; p90 11k; largest 269k (a skill body pasted as a prompt) |
| Fixed per-turn prompt from the repository | CLAUDE.md 18.8 KB, MEMORY.md 4.7 KB |
| Fixed per-turn prompt from plugins | 77 skill and agent descriptions, about 27 KB, plus 38 codeArbiter commands |
| Injected at every session start and compaction | superpowers, 3.5 KB |

### Where the tooling stands

| Item | Value |
|---|---|
| User skills in `~/.claude/skills` | 35; 30 never invoked in any session here (AWS, Azure, Stripe, IoT, MS365, ...) |
| codeArbiter plugin | enabled globally: 42 skills and agents, 38 commands, Python hooks on every Bash, Read, Edit, Write, prompt and compaction; `.codearbiter/` here holds two marker files and is not initialised; 6 invocations ever |
| superpowers plugin | enabled for this project: 14 invocations in 332 sessions, none in the last 12 days |
| security-guidance plugin | runs an LLM review through its own API calls on every Stop, SubagentStop, commit and push; 22 rewake messages seen |
| hookify | 13 rules, 443 hits; each rule body is 0.6-2.5 KB and is injected on every hit |
| Model mix, in turns | Opus 5 18.5k, Sonnet 5 17.5k, Opus 5.5 8.8k, Fable 0.9k; `effortLevel: xhigh` for every model |

### The repository's own weight

| Item | Value |
|---|---|
| `docs/` | 78 files, 1.87 MB |
| `docs/open-questions.md` | 698 KB, 9,364 lines, 234 entries; changed in 272 commits, the most-changed file in the repository; 131 entries not marked resolved, 63 tagged for the owner |
| `src/**/README.md` | 48 files, 397 KB; README bytes per code byte from 0.15 to 0.53 per directory |
| `CLAUDE.md` | 18.8 KB, 37 commits, 835 lines changed in the last week |
| Merged PR bodies | 4-22 KB each, median about 10 KB |
| Commit bodies | median 514 chars, p90 1.7k |
| Commits titled "Correct ..." (a stale claim fixed) | 27; "fix" in the subject: 85 |
| Worktrees | 28 listed; 19 of the 20 branch worktrees are already merged into `origin/main` |
| Unit suite, typecheck, CI check job, CI e2e job | 20 s, 2 s, 1.3 min, 2.6 min: not a bottleneck |

### Whether the prescribed reading happens

CLAUDE.md's "Read | Before" table names about 250 KB of documents. Sessions, out of 332,
that opened each:

| Document | Sessions |
|---|---|
| `src/contracts/` | 89 |
| `open-questions.md` | 85 (962 accesses: 691 greps, 271 `cat`/`sed` of a file too large for one result) |
| `parallel-work.md` | 49 |
| `code-guidelines.md` | 29 |
| `pr-blueprint.md` | 21 |
| `docs/README.md` | 16 |
| `testing.md` | 15 |

## 3. Findings, ranked by leverage

### F1. Context size is the bill, and nothing bounds it

Evidence: 65% of all context tokens go to turns over 400k. Ten compactions in 332 sessions.
Sessions run for one or two days; the usage guard is built to keep a session alive across a
limit, so its context survives too. Up to 15 sessions alive in one hour, each with its own
context. The `[1m]` model variant is the global default in `~/.claude/settings.json`.

Cost: tokens, and quality. A 700k context is mostly stale tool output; the model's attention
to CLAUDE.md and to the task degrades as it grows. The 706 in-session re-reads are the symptom:
the file is already in the context and the model can no longer find it.

### F2. Three process frameworks compete, and two of them are never used

Evidence: superpowers injects "if there is a 1% chance a skill applies you MUST invoke it" at
every start and compaction; CLAUDE.md's tooling table names specific skills at specific steps;
codeArbiter adds 38 `/ca:*` commands and a "sanctioned path" for commits and PRs this
repository does not follow. Measured use: superpowers 14 invocations, codeArbiter 6, in 332
sessions. Thirty of the 35 user skills have never been invoked here.

Cost: about 30 KB of prompt on every turn (roughly 8k tokens, times 48k turns), a Python
subprocess on every tool call, and contradiction. An agent told by one prompt to brainstorm
before answering and by another to act directly picks one, and the owner cannot predict which.

### F3. open-questions.md is an append-only journal that every agent is told to append to

Evidence: 698 KB, organised by session date ("Build step 4 -- the app loader (2026-09-13)"
holds 119 entries); entries average 38 lines and read as essays. CLAUDE.md Rule 3 and the PR
blueprint both tell an agent to append. Agents grep it 691 times because it cannot be read;
whole reads are truncated. `check:questions` checks only duplicate numbers.

Cost: tokens on every access. Quality: an agent cannot tell whether a question already exists,
so questions repeat, and the RESOLVED table at the top already records reversals of reversals.
Alignment: 63 entries wait on the owner, who cannot read a 9,000-line file either, so decisions
are not taken and agents build around the gap, then get corrected.

### F4. Every fact is written in up to seven places, and the places drift

Evidence: one landed feature is narrated in the PR body (10-22 KB), `CHANGELOG.md`,
`devlog/journal.md`, `decision-log.md`, `open-questions.md`, an ADR amendment, the directory
README's design notes, `README.md`'s banner and the compatibility matrix. PR #24 touched 11
Markdown files for one reliability fix. Twenty-seven commits exist only to correct a claim that
went stale in one of those copies. The readability log's Round 5 names this failure ("a decision
reversed in one place survives in another"). Code Rule 3, one implementation per idea, has no
prose equivalent.

Cost: tokens to write, tokens to keep consistent, and a corpus that contradicts itself with a
human reading 1.9 MB as its only guard.

### F5. CLAUDE.md is a document about the project, not a set of instructions

Evidence: 18.8 KB, of which the Status block, the "what this repository is" essay, the tooling
table, the devlog paragraph and the local quirks are context an agent rarely acts on. The rules
that matter (headless launch, no in-place branch switch, no native modules) are already
enforced by hooks. The "Read | Before" table prescribes reading that measured sessions mostly
skip, so the rules that live only in those pages (PR shape, comment rules) are the ones broken
and then corrected by hand.

Cost: about 5k tokens per turn of text that does not change behaviour; and rules in unread
files are not rules.

### F6. History narration has moved from the docs into files no guard covers

Evidence: `.github/workflows/ci.yml` is 150 lines of comment narrating what earlier versions
did wrong; both vitest configs carry the same; each hookify rule body tells the story of the
correction that produced it ("raised again on 2026-09-15 when an e2e stole focus"); the two
project skills say "found 2026-09-15, the hard way". Rule 2 and the `page-history-narration`
hook cover Markdown pages only; `check:comments` measures a leading block in `.ts`/`.mjs` only.

Cost: every hook hit injects its 2 KB story; every CI edit re-reads 150 lines of it; and agents
copy the style they see, which is how it spread.

### F7. Corrections are learned in chat and forgotten by the next session

Evidence: memory records the devlog length corrected twice, the window-focus rule corrected
three times in one session, "stop messing with my tabs", "I don't want to keep prompting over
and over to fix thing by thing". The memory directory is keyed to the checkout path; when the
repository moved, the devlog memory silently stopped loading and the same mistake reached the
next compile. Rule 10 (remove merged worktrees) was added today; 19 merged worktrees remain.

Cost: repeated owner time and repeated agent tokens on the same mistake.

### F8. Review runs are large and duplicated

Evidence: `review-coverage.md` records five independent mechanisms over one 16-PR range (four
adversarial lanes, a hand review, `/code-review`, `ca:security-reviewer`, named-persona),
finding 10, 3, 5, 1 and 5 issues with overlap. PR bodies of 10-22 KB are written for a reviewer
the repository says does not exist. `/security-review` injects the whole diff (54-145 KB) as a
user message.

Cost: tokens, and a real quality question, since a review nobody reads is not review.

### F9. Smaller signals

- `effortLevel: xhigh` for every model and every task, renames and doc syncs included.
- 46 non-test source files hold 107 `console.*` calls; quiet under the default reporter,
  85 stderr blocks under `--reporter=dot` or on a failure.
- 16 of 397 source files sit at 450-500 lines: the limit is producing splits at the boundary
  rather than by job. Watch, do not act.
- 20 basenames repeat across job directories (`fs.ts`, `net.ts`, `manifest.ts`, ...). By design
  after ADR-0035, but `Slots` existed twice (`src/resolution/slots.ts`,
  `src/loader/reach/slots.ts`) and one had a bug the other did not (PR #24). Rule 3 needs a
  search step before a new helper; a short list of shared helpers in `src/shared/README.md`
  gives one.
- The e2e harness has a known startup race (`launchElectron` returns before `runAfterReady`);
  each hit costs a CI rerun and a debugging detour.
- Local `main` is one commit behind `origin/main` (the intro-screen commit, pushed without a
  PR). The tree is dirty (`CLAUDE.md`, `devlog/journal.md`), so per the sync policy this is
  reported, not acted on; the upstream commit touches neither dirty file.

## 4. Work plan for the executing agent

Steps 1-4 cut the cost of every later step, so they go first. Each step names its acceptance
check. Repository changes go in one PR the owner reads before merge; changes under `~/.claude`
are outside the repository and are listed for the owner instead of applied silently.

**Step 1. Session budget rules into CLAUDE.md.** A section of at most 12 lines:

- One PR per session. A new task is a new session; a session is never resumed across days.
- Compact when the task changes, with a one-line summary of what is done and what is next.
- Explore with an `Explore` agent, not with `cat`. Never print a file over 300 lines; use
  `sed -n` ranges or `grep -n`.
- Never read `docs/open-questions.md` whole; grep for the A-number.
- Run `npm test` and the guards with output filtered to the summary lines.
- Plans stay under 2,000 words, live in a file, and are referenced by path, never pasted back.

Acceptance: the section exists; after step 9, `wc -c CLAUDE.md` is under 8,000.

**Step 2. Plugin diet in `~/.claude/settings.json`** (owner approves each line):

- `"ca@codearbiter": false`; delete the two marker files in `.codearbiter/` (gitignored).
- Keep `humanizer` only if the owner uses it; it has no hooks, so its cost is one line.
- Move the 30 never-used directories out of `~/.claude/skills/` into `~/.claude/skills-off/`.
  Keep `adversarial-reviewer`, `named-persona-adversarial-review`, `usage-guard`, plus whatever
  the owner names.

Acceptance: a fresh session's skill listing shows fewer than 15 non-built-in entries.

**Step 3. superpowers off.** `"superpowers@superpowers-marketplace": false` in
`.claude/settings.json`. Replace its row in the tooling table with two lines that already
describe the practice here: write the failing test first for any broker or policy function;
on a failure, reproduce before changing code.

Acceptance: no `SessionStart` injection from superpowers in a new session.

**Step 4. security-guidance.** Keep it for commit and push; ask the owner whether an LLM
review on every Stop and SubagentStop earns its API call. The plugin has no per-hook toggle,
so the choice is on or off.

Acceptance: an owner decision, one row in the decision log.

**Step 5. Split `open-questions.md`.** Move every entry whose heading says resolved, closed,
superseded or withdrawn into `docs/decisions/resolved-questions.md` as one table row each:
number, one-line question, one-line resolution, link (ADR, decision-log row or commit). What
remains in `docs/open-questions.md` is ordered by number, not by session, and every entry is
rewritten to a fixed shape with a ceiling of 12 lines: Question, Why it matters, Options, Who
decides, Blocks. Update `scripts/check-questions.mjs` to check unique numbers across both files
and the 12-line ceiling on open entries. Update CLAUDE.md Rule 3, `pr-blueprint.md` and
`parallel-work.md` to point at the shape. Do it in a worktree; it is the largest diff here.

Acceptance: `docs/open-questions.md` under 80 KB; every A-number cited in `src/` or `docs/`
resolves in one of the two files; `npm run check:questions` passes.

**Step 6. One home per fact, applied to prose.** Add a fourth rule to `code-guidelines.md`: a
fact lives in one page and is linked from the others. Then one pass over the ten largest
`src/*/README.md` (consent, transport, policy, shim, sessions, shim-electron, preload/routed,
broker, renderer, reach): keep the dependency and boundary lines, the design-notes traps and
any table the code needs; delete paragraphs that restate an ADR or the code.

Acceptance: `find src -name README.md -exec cat {} + | wc -c` under 200,000; each deleted
paragraph had a surviving home, named in the PR body.

**Step 7. PR body short form as the default.** In `pr-blueprint.md` and the template: the five
sections stay, with a 400-word ceiling unless the PR touches `src/contracts/`, `src/broker/`,
`src/loader/`, `src/shim/`, `src/main/consent/` or carries `type:security`; each `## Changes`
entry at most six lines; `## How it was verified` is the pasted summary lines only.

Acceptance: the next ordinary PR body is under 4 KB.

**Step 8. CHANGELOG entries** at most three lines each; the user-facing paragraph belongs to the
PR body. Trim the current `[Unreleased]` section to that.

Acceptance: `CHANGELOG.md` under 8 KB.

**Step 9. CLAUDE.md diet.** Keep: the reading table cut to per-task rows ("before opening a
PR: pr-blueprint.md"), rules 1-10, the commands table, the PR cadence paragraph, the sync
policy, the session budget from step 1. Leave the Status block as one line pointing at
`README.md`. Move the tooling table into a project skill,
`.claude/skills/orivon-workflow/SKILL.md`, loaded on demand, and leave a one-line pointer.
Reduce Local quirks to one line per hook; the hooks carry the explanation.

Acceptance: under 8,000 bytes, and `/revise-claude-md` finds nothing stale.

**Step 10. Narration out of config files and hook bodies.** Trim `ci.yml` comments to the
constraint each step enforces (target: under 120 lines in total). Same for both vitest configs.
Rewrite each hookify rule body to what is blocked and what to do instead, at most 15 lines; the
story moves to git. Extend `scripts/check-comments.mjs` with a 10-line per-block budget for
`.github/workflows/*.yml` and `*.config.ts`, and add the two project skills to the
`page-history-narration` file list.

Acceptance: `npm run check:comments` covers the new paths and passes.

**Step 11. Mechanise the repeated corrections.** Add `scripts/check-devlog.mjs` (every bullet
in `devlog/journal.md` and `devlog/updates/*.md` at most 25 words), wired into the `/devlog`
command's step 5 and into CI. Add `scripts/worktree-gc.mjs`, which lists worktrees whose branch
is merged into `origin/main` and removes them with `git worktree remove`, and cite it from Rule
10. Run it once now: 19 worktrees qualify.

Acceptance: both scripts have a unit test under `scripts/tests/`; `git worktree list` shows at
most five entries.

**Step 12. Memory hygiene.** One line in CLAUDE.md: a rule the owner states twice goes into the
repository (hook, guard or CLAUDE.md line) in the same session, never only into memory. Memory
is keyed to the checkout path and does not survive a move.

Acceptance: the line exists; MEMORY.md entries that are now repository rules (devlog length,
desktop automation, worktree cleanup) point at the repository file.

**Step 13. Review shape.** One `/code-review` per PR before merge; `adversarial-reviewer` on the
broker and loader at build-step ends only, as CLAUDE.md already says; no multi-lane review of
ranges unless the owner asks. Each run is one row in `review-coverage.md`.

Acceptance: the tooling table, now in the skill, says exactly this.

**Step 14. Fix the e2e startup race** in `test/launch-electron.mjs`: after the
is-real-Electron check, poll `BaseWindow.getAllWindows().length > 0` through `app.evaluate`
with a bounded wait that does not throw. Run the full e2e suite twice.

Acceptance: two green runs; the memory entry `e2e-launch-races-afterready-hooks` marked fixed.

**Step 15. Sync `main`** once the owner has committed or stashed `CLAUDE.md` and
`devlog/journal.md`: `git merge --ff-only origin/main`.

## 5. Decisions only the owner can take

Ask them in one batch, before step 2.

1. Model default: keep the `[1m]` variant as the global default, or a standard variant with
   `[1m]` chosen per session when a task needs it?
2. Effort: `xhigh` everywhere, or `high` by default and `xhigh` for broker, contracts and
   consent work?
3. Which of the 35 user skills to keep.
4. security-guidance on every Stop: on or off.
5. PR body ceiling for ordinary PRs: 400 words, or another number.
6. The 63 open-questions entries tagged for the owner: which ten to answer first. The executing
   agent prepares the list, one line each.

## 6. Lessons only a human can apply

1. **The session is the unit of cost.** One task per session; never nurse a session for two
   days. The `[1m]` default is why 900k contexts exist; make it the exception.
2. **Fewer sessions at once.** Fifteen alive in one hour, each re-reading a 400k-plus context,
   is the peak-day bill. Two or three at a time, each on one PR.
3. **Choose the model at the start, not mid-session.** Sonnet for mechanical passes (doc sync,
   renames, running gates, worktree cleanup), Opus for design and the critical path, Fable for
   review. Set effort to `high` by default.
4. **Uninstall what you do not use.** Thirty-five skills and codeArbiter were installed "just
   for research"; each has cost every turn of every session since.
5. **A correction that is not in the repository by the end of the day did not happen.** Devlog
   length was corrected twice and window focus three times, each time in chat. Say "make this a
   hook" or "put this in CLAUDE.md" at the moment you correct.
6. **State the acceptance criterion in the first prompt.** "Every feature of the app must work"
   and "one PR per day" both arrived as corrections after a session had done the narrow thing.
7. **Point at files, do not paste them.** The p90 prompt is 11k characters and plans come back
   pasted at 43k. "See docs/planning/x.md, section 3" costs twenty tokens.
8. **Decide the open questions.** Sixty-three entries wait on you; agents build around the gap
   and then get corrected. Fifteen minutes a week on a batch of ten.
9. **Decide how much documentation tax to pay.** 1.9 MB of docs, 400 KB of READMEs and 10 KB PR
   bodies are written for a contributor who has not arrived. Name the places a change must be
   recorded in; an agent can enforce only what you choose.
10. **Model the rules yourself.** The direct push to `main` and the two commits titled "Commit"
    are in the history agents pattern-match on.
11. **Keep the repository path stable.** Memory is keyed to it and stops loading after a move
    without saying so.
12. **Read the PR body you asked for, or shorten it until you do.** A record nobody reads is
    not a record.
13. **When the same flake hits CI twice, commission the fix.** Rerunning is the expensive
    option over a month.

## 7. How it was applied (2026-09-28)

Owner answers to §5: standard model and effort `high` by default; keep adversarial-reviewer,
named-persona-adversarial-review, usage-guard and humanizer; security-guidance stays on; a
400-word PR ceiling (d-0144 to d-0147). Decision 6 is answered by the list in the PR body.

Where the application departed from §4:

- **Step 3.** The auto-mode classifier refused an agent edit to `.claude/settings.json`, so
  flipping superpowers off is left to the owner.
- **Step 5.** Eight entries resolved in the 2026-09-03 decisions table were also open further
  down; seven resolved ("Not built yet" where the work is missing), and A47 stayed open as a
  narrower question. B5 names two different questions in live docs; the guard checks A-numbers
  only, as before. Entries whose code already does what they asked were resolved (d-0149).
- **Step 6.** The ten largest READMEs held 173 KB, so no cut to them alone could reach 200 KB;
  the pass covered every README except `src/contracts/` and `src/shared/` (408 KB to 162 KB).
- **Step 10.** `electron.vite.config.ts` is also a root `*.config.ts`, so its comments were
  trimmed to the new 10-line block budget too.
- **Step 11.** `check:devlog` exempts updates compiled before rule C (2026-09-01 to 09-13), which
  were sent as written. `worktree-gc.mjs` also keeps a branch sitting exactly at `origin/main`,
  which may have just been started. It removed 20 worktrees; six remain until this branch
  merges.
- **Step 15.** `origin/main` moved twice during the work, and local `main` stayed dirty, so it
  was reported rather than synced.

