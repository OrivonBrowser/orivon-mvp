# The pull request blueprint

How a pull request is titled, described and labelled here. One shape, followed by everyone:
human contributors and AI sessions alike.

This is the **source of truth**. [`.github/pull_request_template.md`](../../.github/pull_request_template.md)
is the same thing as a fill-in form, and the pinned issue on the Issues tab is a signpost to
both. **If the three ever disagree, this document wins** and the other two get corrected.

> The title rule, the section list, the label taxonomy and the enforcement position are
> settled. §Open points is what is **still open**.

> **The body scales to a PR carrying several changes.** A single-change PR has a single entry
> and reads almost as simply; every anti-pattern below holds at any size, and
> `src/contracts/`/`src/shared/` still go alone and merge first.

---

## Why this exists

A pull request body here is not paperwork. With **no dedicated code reviewer**, it is the only
place where the reasoning behind a change is written down for a human, and
[`parallel-work.md`](parallel-work.md) is explicit that the PRs are the public record: *someone
arriving in six months reads them to find out not just what was built, but what was tried and
why it is shaped this way.*

Two things make the shape stick:

- **The template is pre-filled.** GitHub's web UI and `gh pr create` both open
  `.github/pull_request_template.md` automatically. A rule you have to remember loses to a form
  that is already in the box.
- **One copy.** [`CONTRIBUTING.md`](../../CONTRIBUTING.md) and [`parallel-work.md`](parallel-work.md)
  link here instead of restating, so there is nothing to drift.

---

---

## The title

**Imperative, present tense. No prefix, no ticket number, no `feat(scope):`.**

The test: **could someone who was not there tell what changed, without opening it?**

Drawn from this repository's own history rather than invented:

```
Good   Check connect patterns against resolved addresses, never the hostname
Good   Decide app updates by pattern subset, not capability kind
Good   Confine app filesystem paths to the app's own root

Weak   broker-02-address: the blocked-address-range table (T12)
```

The weak one fails twice. The `broker-02-address` prefix duplicates what the `stream:broker`
label and the branch name already say, and it costs characters in every list view. And "the
blocked-address-range table" names a *noun*, not a change: it could equally be adding one,
deleting one, or fixing one.

**Aim for 72 characters.** `gh pr list` and GitHub's notification emails truncate past roughly
that point, and a title whose verb survives but whose object does not is worse than a short one.

Where a title states the change **and its consequence** in one breath, it is doing the most work
available: *"never the hostname"* and *"not capability kind"* each tell a reader what was
rejected, which is usually the interesting half.

**Where a PR carries several major changes, the title names the theme rather than one of them.**
The imperative rule and the 72 characters are unchanged; the object may simply be plural. Where
one change dominates, name it and let the rest sit in `## Changes`.

```
Good   Land the folder picker and close three broker defects
Good   Finish the loader cache path, and stop trusting the manifest's own hash

Weak   2026-09-17
Weak   Various fixes and improvements
```

The weak ones fail the original test: someone who was not there cannot tell what changed. A date
is not a change, and "various" is the absence of a title.

---

## The body

Five required sections, two optional. In order:

```markdown
## What changes for the user
## Changes                     <- one ### entry per major change
## Streams, paths and merge order
## Decisions and open questions
## How it was verified
## Risk and rollback          (optional)
## Deliberately not done      (optional)
```

> Goal, what it achieves and how it works are asked *per change*, inside `## Changes`, one
> entry each. **A PR with one change has one entry.**

### `## Changes`

**One `###` entry per major change, each titled like a PR**: imperative, naming a change. Under each, in as much room as it needs:

- **Goal**. One sentence of *intent*. What is this for?
- **What it achieves**. A short list of *outcome*. What is now true that was not?
- **How it works**. The mechanism, for a reader who will maintain it.

`Goal` and `What it achieves` look adjacent and are not. A change can hit its goal and achieve
less than it set out to; keeping them apart is what makes that visible instead of blurred.

**"Major" is the filter.** Incidental fixes, renames and test tweaks do not each need an entry;
they belong in one closing line, or in the commit log where they already are. If a PR has so many
major changes that the section stops being readable, that is the signal to split it.

### `## What changes for the user`

**Plain language, present tense. What can someone do, see, or no longer do?** Answer for two
audiences, both named:

- **User**. A person using Orivon.
- **Dev**. A person building an app *on* Orivon. [`src/contracts/`](../../src/contracts/) is
  their product surface, so a change there is as user-facing as moving a button.

> **A bare "None" is not an answer.** If a paragraph of explanation exists, the effect was
> derivable and the "None" was a skipped question rather than an honest one.

**Every change reaches somebody. Derive it.** Take the first rung that is true:

1. **Direct.** Someone can now do, see, or no longer do something. Say what.
2. **Second-order.** Nothing is visible yet, but something is now faster, cheaper, more
   reliable, or harder to get wrong. Say which, and for whom.
3. **Enabling.** This is a step toward something a person will feel. Name that thing and when
   it arrives. *"From step 4 the loader refuses an app whose files changed"* is an answer;
   *"groundwork"* is not.

**Rung 3 is the floor.** A change that cannot reach even rung 3 for either audience is a change
worth questioning.

> **Still not answers:** "Improves security", "better performance", "more robust", "improves
> UX", "groundwork", "no user impact". Those name a *category*. Say what somebody experiences.
> The old anti-invention rule has not gone anywhere: **deriving a real second-order effect is
> the opposite of inventing a direct one you do not have.** Where an audience genuinely has
> nothing today, write *"nothing today, and <when> it becomes <what>"*, never a bare "None".

| Instead of | Write |
|---|---|
| "Improves security around app filesystem access" | **User:** an app can no longer read files outside its own folder, even if it asks for `../../`. Nothing an honest app does changes. **Dev:** a path outside your app root now fails with `OrivonError`; ask for access deliberately via `fs.userSelected`. |
| "None — this is broker-internal" (the bundle hash) | **User:** nothing today. From build step 4 an app whose files changed without its version changing stops loading, so a tampered update fails instead of running silently. **Dev:** bump your version with any file change, or the loader rejects the bundle. |
| "Documentation only" | **User:** nothing today, and nothing later, since this records a rule the code already enforces. **Dev:** the rule your app already had to follow is now written where you will find it, instead of only in the code. |

The section pairs with the `ux:` label, so the answer is also filterable.

**Why it is mandatory.** The metric this project is judged by is **100 active users at
25 h/month** ([`mvp-scope.md`](../mvp-scope.md)), not lines of code. A section that forces the
question on every change is cheap; noticing six months late that nothing shipped touched anybody
is not. The point is that somebody looked, and answered.

### `## How it works`: now one part of each `## Changes` entry

> Asked once per `###` entry under `## Changes`, not once per PR.


**The mechanism, and the choices that were not obvious.** Not a file-by-file narration of the
diff; the diff is right there.

Three rules:

1. **Link the document you are implementing; do not re-explain it.** If the PR implements
   [`ADR-0009`](../decisions/ADR-0009-the-bundle-hash-is-an-app-s-content-identity.md) or a
   section of [`handle-contracts.md`](../architecture/handle-contracts.md), cite it and describe
   only where the code and the document meet.
2. **Name the one file to read first.** With no dedicated reviewer, the highest-value sentence
   in a large PR is often "if you read one thing, read `handles.ts` §ownership check".
3. **Explain *why*, not *what*.** This is [`code-guidelines.md`](code-guidelines.md) Rule 1 in a
   different medium, and the standard is the same: that document carries the reasoning and is
   not restated here.

### `## Streams, paths and merge order`

Four short lines. This is the block that makes parallel work safe, so it stays terse:

```markdown
- **Streams:** broker, loader, docs
- **Paths touched:** src/broker/handles/, src/loader/cache.ts, docs/development/ -- all mine
- **Contracts:** depends on LIMITS, Handle, OrivonError, GrantId. None changed.
- **Merge order:** independent -- but after #204, which moved fs.open's dispatch
```

> A PR may span several streams, and each one it touched gets named. This block matters *more*
> the more a PR carries: it is the only place a reader learns the real footprint before opening
> the diff.

- **Streams**. From the ownership map in [`parallel-work.md`](parallel-work.md). A
  `backlog-NN` branch owns no paths of its own, so it **names the stream it borrows**.
- **Paths touched**. And confirmation they are yours. If a path is not, that is a signal to
  raise, not a line to write apologetically.
- **Contracts**. Which types from [`src/contracts/`](../../src/contracts/) this depends on. If
  any **changed**, this PR contains no implementation, it merges first, and it gets the
  `contracts-change` label. [`src/shared/`](../../src/shared/) follows the same rule.
- **Merge order**: `independent`, or `stacked on #N`, or `must merge after #M`. Four streams
  run concurrently; a PR that silently depends on another is how a green branch merges into a
  red `main`.

### `## Decisions and open questions`

[`CLAUDE.md`](../../CLAUDE.md) Rules 1 and 2, applied at pull request level. Anywhere you:

- **deviated from a document**. Say which, say why, and offer the literal reading as an option;
- **chose between two defensible options**. Name the one not taken;
- **made a call nobody has confirmed**. Label it.

Mark anything provisional as provisional. Presenting an unconfirmed call as settled is how a
project ends up defending a choice nobody made.

If the change files anything in [`open-questions.md`](../open-questions.md), **list the
A-numbers here**. Take them from `main`'s highest, not your branch's: on 2026-08-27 four
branches each claimed A15, and a merged renumber left `origin.ts` citing a stranger's question.
[`parallel-work.md`](parallel-work.md) §Open-question numbers has the one-liner that prevents it.
Taking the number from `main`'s highest reduces the collision, but two branches opened at the
same time can still both take the same next number, and `npm run check:questions` catches it in CI;
the fix is to renumber whichever branch merges later and move its citations with it.

If a change is architectural and load-bearing, this section is **not** where it goes; write an
ADR ([`CLAUDE.md`](../../CLAUDE.md) Rule 1) and cite it here.

`None.` is a valid answer. It still has to be written, because writing it is what forces the
check.

### `## How it was verified`

**The commands you ran, and what they actually said.** Paste the numbers.

```
npm run typecheck && npm test && npm run check:natives && npm run check:contracts && npm run check:vectors && npm run check:secrets && npm run check:comments && npm run check:size
npm run smoke     # only if you touched src/main/
```

`npm run smoke` prints a JSON result and a failure list. **Read those, not the exit code alone.**

> **"Should work" and "tests pass" are different claims, and this project has already been bitten
> by the difference.** `Tests 1265 passed (1265)` is evidence. "All green" is a summary of
> evidence you are asking the reader to take on trust.

If a command was **not** run, say so and say why: "`smoke` not run, `src/main/` untouched" is a
complete answer. A silently omitted check reads as a passed one.

Where the PR's value depends on a test *noticing* something, say how you know it would.
Mutation testing is the strongest answer: it repeatedly finds suites that are dense, green and
blind. Not required, but the standard is that a passing suite proves nothing until it has been
watched to fail.

### `## Risk and rollback`: optional

**What breaks if this is wrong, and how to undo it.** One or two lines.

Worth writing whenever the change touches the critical path, a security boundary, anything
frozen (key derivation, the bundle hash, `src/contracts/`), or anything a user's stored data
depends on. Skip it for documentation.

### `## Deliberately not done`: optional

**Follow-ups left out, and why.** An omission that is stated is not a gap; an omission that is
silent is indistinguishable from an oversight.

This is a direct lesson from [`readability-log.md`](readability-log.md): two of the first
round's findings were absences rather than errors, and the reader could not tell "deliberately
out of scope" from "not thought about".

---

## Labels

Three axes and two flags. Every PR gets **at least one `stream:`, at least one `type:`, and
exactly one `ux:`**, plus a flag if it applies.

> **`ux:` has three values, because `## What changes for the user` answers for two audiences.**
> Precedence, highest first: **`ux:visible`** if any part is visible to a person using Orivon;
> **`ux:dev`** if not, but it changes what an app developer can write against: a capability, an
> error, anything in `src/contracts/`; **`ux:none`** only when neither is true, which should
> be rare and is worth a second look when you reach for it. *The third value is
> provisional: the section and the label were explicitly paired, so leaving `ux:` at two values
> would have split them.*

| Axis | Labels |
|---|---|
| `stream:` | `shell` · `contracts` · `shared` · `broker` · `shim` · `loader` · `torrent-app` · `fixture-app` · `trust` · `nostr` · `telemetry` · `packaging` · `docs` |
| `type:` | `feature` · `fix` · `docs` · `security` · `test` · `chore` |
| `ux:` | `visible` · `dev` · `none` |
| flags | `contracts-change` · `needs-owner-decision` |

**`stream:` and `type:` are multi-valued**: carry every stream the PR touched and every type it
contains. **`ux:` is single**, because it answers one question, "does any part of this change
what a person sees?", so `ux:visible` wins whenever any part of the PR is user-visible.

**`stream:` mirrors the ownership map exactly**: nothing is invented, and adding a stream there
means adding a label here. A `backlog-NN` branch takes the label of the stream it borrows. The
payoff is that "which streams are open right now, and do any of them overlap?" becomes one
filtered view instead of a reading of branch names.

**`type:security`** is not exclusive with the others: a change that fixes a vulnerability takes
`type:security` rather than `type:fix`, because the distinction is what makes it findable later.

**`contracts-change`** means the PR touches `src/contracts/` or `src/shared/`. Those merge
first, alone, with no implementation in them.

**`needs-owner-decision`** means the PR is blocked on the owner, not on CI. Use it whenever
`## Decisions and open questions` contains something marked *still open* that changes what
merges.

GitHub's stock `bug`, `documentation` and `enhancement` labels are removed, because they duplicated
`type:fix`, `type:docs` and `type:feature`, and two names for one idea is
[`code-guidelines.md`](code-guidelines.md) Rule 3 in a different costume. `good first issue`,
`help wanted` and `question` remain; they do not overlap and they are useful on a public repo.

---

## Filling this in

Written flatly, because the audience is a human contributor arriving cold **and** an AI session
that will pattern-match whatever it sees. Anti-examples work better than principles on both.

**Never write these:**

| Phrase | Why it fails |
|---|---|
| "Should work" | Not a claim about anything that happened. Run it. |
| "Tests pass" | Which tests, how many? Paste the line. |
| "Improves UX" / "improves security" | A category, not an effect. Say what the user experiences. |
| "Various fixes", "minor changes", "cleanup" | The reader now has to read the whole diff to learn what you already know. |
| "As requested" / "as discussed" | The record does not include the conversation. It has to stand alone. |
| "Refactored for clarity" | Say what was unclear and what is clearer. |

**Every claim in `## How it was verified` must be something you ran**, in this tree, on this
branch. If you are an agent and you did not run it, the honest sentence is "not run" plus the
reason, never a plausible-looking command block.

**Do not invent a user impact.** `None` is the common answer and it is respected. See the
worked table above.

**Keep the AI attribution.** [`CONTRIBUTING.md`](../../CONTRIBUTING.md) already discloses that
much of this repository was written with AI assistance, and a trailer on the PR is consistent
with that rather than an apology for it.

**Size.** [`parallel-work.md`](parallel-work.md) puts it best: *a small PR is reviewed in
seconds and a large one is not reviewed at all.* If the body needs three "How it works"
subsections for three unrelated things, that is three PRs.

---

## Applying the blueprint

### The short form

**A PR that genuinely stands alone and is small (a revert, a hotfix, a `type:chore`) may
collapse to three sections:** `## What changes for the user`, `## Changes` with a single entry,
and `## How it was verified`.

> A `src/contracts/` PR is never a candidate for the short form: it is on the critical path and
> takes the full form.

The carve-out is deliberate and narrow. A blueprint that demands the full form for a typo fix
is a blueprint that gets skipped on small PRs, and then on medium ones. Everything on the
critical path (`src/broker/`, `src/contracts/`, `src/shared/`, `src/loader/`, `src/shim/`, and
anything labelled `type:security`) takes the full form regardless of size.

### Nothing enforces this mechanically

**Rules first, enforcement later.** The same call, for the same
reason, as [`code-guidelines.md`](code-guidelines.md) §Status. No CI check parses the PR
body, no workflow requires a label.

The template is doing the work, and it does it by being **already in the box** rather than by
failing a build. The cost, recorded rather than left to be discovered: a PR opened with
`gh pr create --body "..."` bypasses the template entirely, and nothing will say so.

**The signal to revisit** is a merged PR that skipped a required section without saying why. The
check is short (`scripts/` already holds four guards of exactly this kind) and can be written
whenever it is wanted.

### Where the three copies live, and which one wins

| | |
|---|---|
| This document | **Canonical.** Rules, reasoning, worked examples, anti-patterns |
| [`.github/pull_request_template.md`](../../.github/pull_request_template.md) | The form. Section headings and inline guidance only, no reasoning |
| The pinned issue | A signpost: what this is, the checklist, links to the two above |

**They are ordered.** A correction goes into this document first; the other two are derived from
it. The template deliberately carries no reasoning, because reasoning is the part that drifts.

---

## Open points

**The template cannot be enforced on `gh pr create --body`.** See §Nothing enforces this
mechanically. Known, accepted, and the reason the blueprint is also a document an agent reads
rather than only a file GitHub injects.

---

## See also

| | |
|---|---|
| [`parallel-work.md`](parallel-work.md) | The ownership map, the merge protocol, and the open-question numbering rule |
| [`code-guidelines.md`](code-guidelines.md) | How code is written here. Rule 1 is the same standard `## How it works` is held to |
| [`CONTRIBUTING.md`](../../CONTRIBUTING.md) | The eight rules, the pre-commit hook, and the gate to run before opening a PR |
| [`readability-log.md`](readability-log.md) | Why "state omissions as omissions" is a rule here |
| [`review-coverage.md`](review-coverage.md) | Where an independent review pass (a hand-review, an adversarial pass, a security scan, a clean-checkout run) gets recorded once it happens |
