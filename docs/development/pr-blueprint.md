# The pull request blueprint

How a pull request is titled, described and labelled here. One shape, followed by everyone —
human contributors and AI sessions alike.

This is the **source of truth**. [`.github/pull_request_template.md`](../../.github/pull_request_template.md)
is the same thing as a fill-in form, and the pinned issue on the Issues tab is a signpost to
both. **If the three ever disagree, this document wins** and the other two get corrected.

> **Provenance**, per [`CLAUDE.md`](../../CLAUDE.md) Rule 2. The title rule, the section list,
> the label taxonomy and the enforcement decision are the **owner's decision**, taken
> 2026-08-27. §Open points is what is **still open**. Nothing here is an unconfirmed AI
> recommendation.

---

## Why this exists

A pull request body here is not paperwork. With **no dedicated code reviewer**, it is the only
place where the reasoning behind a change is written down for a human, and
[`parallel-work.md`](parallel-work.md) is explicit that the PRs are the public record: *someone
arriving in six months reads them to find out not just what was built, but what was tried and
why it is shaped this way.*

A four-item body was already specified, in two places, before this document existed. It was
followed about half the time. [#13](https://github.com/OrivonBrowser/orivon-mvp/pull/13) used
it well; [#17](https://github.com/OrivonBrowser/orivon-mvp/pull/17) shipped a generic
"Summary / Test plan" instead. **Neither of the eighteen merged PRs said what any of it meant
for a user, and not one carried a label.** That is the gap this closes.

Two changes make it stick where the old spec did not:

- **The template is pre-filled.** GitHub's web UI and `gh pr create` both open
  `.github/pull_request_template.md` automatically. A rule you have to remember loses to a form
  that is already in the box.
- **One copy.** The spec used to live in two documents that could drift.
  [`CONTRIBUTING.md`](../../CONTRIBUTING.md) and [`parallel-work.md`](parallel-work.md) now link
  here instead of restating.

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
blocked-address-range table" names a *noun*, not a change — it could equally be adding one,
deleting one, or fixing one.

**Aim for 72 characters.** `gh pr list` and GitHub's notification emails truncate past roughly
that point, and a title whose verb survives but whose object does not is worse than a short one.

Where a title states the change **and its consequence** in one breath, it is doing the most work
available: *"never the hostname"* and *"not capability kind"* each tell a reader what was
rejected, which is usually the interesting half.

---

## The body

Seven required sections, two optional. In order:

```markdown
## What changes for the user
## Goal
## What it achieves
## How it works
## Stream, paths and merge order
## Decisions and open questions
## How it was verified
## Risk and rollback          (optional)
## Deliberately not done      (optional)
```

`## Goal` and `## What it achieves` look adjacent and are not. Goal is one sentence of
**intent** — what this is for. Achieves is a short list of **outcome** — what is now true that
was not. A PR can hit its goal and achieve less than it set out to; keeping them apart is what
makes that visible instead of blurred.

### `## What changes for the user`

**Plain language, present tense. What can someone do, see, or no longer do?**

**Most pull requests here change nothing a user experiences, and that is the expected answer.**
Write `None — <why>`, then say when it *will* become visible. An honest "none" is worth more
than a paragraph of invention, and inventing one is the specific failure this section is written
to prevent.

> **"Improves security" is not an answer.** Neither is "better performance", "more robust", or
> "improves UX". Those describe the change's category. Say what the **user experiences**.

| Instead of | Write |
|---|---|
| "Improves security around app filesystem access" | "An app can no longer read files outside its own folder, even if it asks for `../../`. Nothing an honest app does changes." |
| "Adds the bundle hash" | "None — this is broker-internal. The user first feels it at build step 5, when the loader starts refusing an app whose files changed without its version changing." |
| "Documentation only" | "None — this documents a rule the code already follows. No behaviour changes now or later." |

The section pairs with the `ux:visible` / `ux:none` label, so the answer is also filterable.

**Why it is mandatory even when the answer is always "none".** The metric this project is judged
by is **100 active users at 25 h/month** ([`mvp-scope.md`](../mvp-scope.md)), not lines of code.
A section that forces the question on every change is cheap; noticing six months late that
nothing shipped touched a user is not. Writing `None` takes ten seconds and is a respected
answer — the point is that somebody looked.

### `## How it works`

**The mechanism, and the choices that were not obvious.** Not a file-by-file narration of the
diff — the diff is right there.

Three rules:

1. **Link the document you are implementing; do not re-explain it.** If the PR implements
   [`ADR-0009`](../decisions/ADR-0009-the-bundle-hash-is-an-app-s-content-identity.md) or a
   section of [`handle-contracts.md`](../architecture/handle-contracts.md), cite it and describe
   only where the code and the document meet.
2. **Name the one file to read first.** With no dedicated reviewer, the highest-value sentence
   in a large PR is often "if you read one thing, read `handles.ts` §ownership check".
3. **Explain *why*, not *what*.** This is [`code-guidelines.md`](code-guidelines.md) Rule 1 in a
   different medium, and the standard is the same — that document carries the reasoning and is
   not restated here.

### `## Stream, paths and merge order`

Four short lines. This is the block that makes parallel work safe, so it stays terse:

```markdown
- **Stream:** broker
- **Paths touched:** src/broker/handles.ts, src/broker/handles.test.ts -- both mine
- **Contracts:** depends on LIMITS, Handle, OrivonError, GrantId. None changed.
- **Merge order:** stacked on #1 -- review that first
```

- **Stream** — from the ownership map in [`parallel-work.md`](parallel-work.md). A
  `backlog-NN` branch owns no paths of its own, so it **names the stream it borrows**.
- **Paths touched** — and confirmation they are yours. If a path is not, that is a signal to
  raise, not a line to write apologetically.
- **Contracts** — which types from [`src/contracts/`](../../src/contracts/) this depends on. If
  any **changed**, this PR contains no implementation, it merges first, and it gets the
  `contracts-change` label. [`src/shared/`](../../src/shared/) follows the same rule.
- **Merge order** — `independent`, or `stacked on #N`, or `must merge after #M`. Four streams
  run concurrently; a PR that silently depends on another is how a green branch merges into a
  red `main`.

### `## Decisions and open questions`

[`CLAUDE.md`](../../CLAUDE.md) Rules 1 and 2, applied at pull request level. Anywhere you:

- **deviated from a document** — say which, say why, and offer the literal reading as an option;
- **chose between two defensible options** — name the one not taken;
- **made a call the owner has not** — label it.

Label each one **owner's decision** / **AI recommendation** / **still open**. Never blur them: a
recommendation presented as a decision is how a project ends up defending a choice nobody made.

If the change files anything in [`open-questions.md`](../open-questions.md), **list the
A-numbers here**. Take them from `main`'s highest, not your branch's — on 2026-08-27 four
branches each claimed A15, and a merged renumber left `origin.ts` citing a stranger's question.
[`parallel-work.md`](parallel-work.md) §Open-question numbers has the one-liner that prevents it.

If a change is architectural and load-bearing, this section is **not** where it goes — write an
ADR ([`CLAUDE.md`](../../CLAUDE.md) Rule 1) and cite it here.

`None.` is a valid answer. It still has to be written, because writing it is what forces the
check.

### `## How it was verified`

**The commands you ran, and what they actually said.** Paste the numbers.

```
npm run typecheck && npm test && npm run check:natives && npm run check:contracts && npm run check:secrets
npm run smoke     # only if you touched src/main/
```

`npm run smoke` prints a JSON result and a failure list. **Read those, not the exit code alone.**

> **"Should work" and "tests pass" are different claims, and this project has already been bitten
> by the difference.** `Tests 1265 passed (1265)` is evidence. "All green" is a summary of
> evidence you are asking the reader to take on trust.

If a command was **not** run, say so and say why — "`smoke` not run, `src/main/` untouched" is a
complete answer. A silently omitted check reads as a passed one.

Where the PR's value depends on a test *noticing* something, say how you know it would. Several
PRs here have used mutation testing for exactly that, and it repeatedly found suites that were
dense, green and blind ([#13](https://github.com/OrivonBrowser/orivon-mvp/pull/13),
[#17](https://github.com/OrivonBrowser/orivon-mvp/pull/17)). Not required — but "a passing suite
proves nothing until it has been watched to fail" is the standard those PRs set.

### `## Risk and rollback` — optional

**What breaks if this is wrong, and how to undo it.** One or two lines.

Worth writing whenever the change touches the critical path, a security boundary, anything
frozen (key derivation, the bundle hash, `src/contracts/`), or anything a user's stored data
depends on. Skip it for documentation.

### `## Deliberately not done` — optional

**Follow-ups left out, and why.** An omission that is stated is not a gap; an omission that is
silent is indistinguishable from an oversight.

This is a direct lesson from [`readability-log.md`](readability-log.md): two of the first
round's findings were absences rather than errors, and the reader could not tell "deliberately
out of scope" from "not thought about".

---

## Labels

Three axes and two flags. Every PR gets **one `stream:`, one `type:`, one `ux:`**, plus a flag
if it applies.

| Axis | Labels |
|---|---|
| `stream:` | `shell` · `contracts` · `shared` · `broker` · `shim` · `loader` · `torrent-app` · `fixture-app` · `trust` · `nostr` · `telemetry` · `packaging` · `docs` |
| `type:` | `feature` · `fix` · `docs` · `security` · `test` · `chore` |
| `ux:` | `visible` · `none` |
| flags | `contracts-change` · `needs-owner-decision` |

**`stream:` mirrors the ownership map exactly** — nothing is invented, and adding a stream there
means adding a label here. A `backlog-NN` branch takes the label of the stream it borrows. The
payoff is that "which streams are open right now, and do any of them overlap?" becomes one
filtered view instead of a reading of branch names.

**`type:security`** is not exclusive with the others — a change that fixes a vulnerability takes
`type:security` rather than `type:fix`, because the distinction is what makes it findable later.

**`contracts-change`** means the PR touches `src/contracts/` or `src/shared/`. Those merge
first, alone, with no implementation in them.

**`needs-owner-decision`** means the PR is blocked on the owner, not on CI. Use it whenever
`## Decisions and open questions` contains something marked *still open* that changes what
merges.

GitHub's stock `bug`, `documentation` and `enhancement` labels are removed — they duplicated
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
reason — never a plausible-looking command block.

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

**A `type:chore` PR, or a fix of a line or two, may collapse to three sections:** `## Goal`,
`## What changes for the user`, `## How it was verified`.

The carve-out is deliberate and narrow. A blueprint that demands seven sections for a typo fix
is a blueprint that gets skipped on small PRs, and then on medium ones. Everything on the
critical path — `src/broker/`, `src/contracts/`, `src/shared/`, `src/loader/`, `src/shim/`, and
anything labelled `type:security` — takes the full form regardless of size.

### Nothing enforces this mechanically

**Owner's decision, 2026-08-27: rules first, enforcement later** — the same call, for the same
reason, as [`code-guidelines.md`](code-guidelines.md) §Status. No CI check parses the PR
body, no workflow requires a label.

The template is doing the work, and it does it by being **already in the box** rather than by
failing a build. The cost, recorded rather than left to be discovered: a PR opened with
`gh pr create --body "..."` bypasses the template entirely, and nothing will say so.

**The signal to revisit** is a merged PR that skipped a required section without saying why. The
check is short — `scripts/` already holds four guards of exactly this kind — and can be written
whenever it is wanted.

### Where the three copies live, and which one wins

| | |
|---|---|
| This document | **Canonical.** Rules, reasoning, worked examples, anti-patterns |
| [`.github/pull_request_template.md`](../../.github/pull_request_template.md) | The form. Section headings and inline guidance only — no reasoning |
| The pinned issue | A signpost: what this is, the checklist, links to the two above |

**They are ordered.** A correction goes into this document first; the other two are derived from
it. The template deliberately carries no reasoning, because reasoning is the part that drifts.

---

## Open points

Raised under [`CLAUDE.md`](../../CLAUDE.md) Rule 3 rather than smoothed over.

**1. `.github/` had no owner in the ownership map. Resolved 2026-08-27 by assigning it to
`docs`.**

The map in [`parallel-work.md`](parallel-work.md) covers every path under `src/`, `scripts/`,
`apps/`, `test/`, `docs/` and root markdown — but not `.github/`, which already held `ci.yml`
before this PR added the template. Two changes have now landed in a directory nobody owned.

`docs` is the right home: the contents are process and documentation infrastructure, and `docs`
is the stream that is always available. **The CI workflow is the awkward part** — a change to
`ci.yml` is far more likely to come from `packaging` or from whichever stream added the check it
runs. Recorded as a split worth watching rather than pre-emptively divided.

**2. The template cannot be enforced on `gh pr create --body`.** See §Nothing enforces this
mechanically. Known, accepted, and the reason the blueprint is also a document an agent reads
rather than only a file GitHub injects.

**3. Whether `## What changes for the user` survives contact with a run of infrastructure PRs
is genuinely unknown.** Build step 2 is broker-internal end to end, so the honest expectation is
`None — ...` on nearly every PR until the loader lands at step 5. If that section becomes
copy-paste, it has stopped working and should be reconsidered rather than tolerated — the
failure mode of a mandatory field is that it gets filled, not that it gets skipped.

---

## See also

| | |
|---|---|
| [`parallel-work.md`](parallel-work.md) | The ownership map, the merge protocol, and the open-question numbering rule |
| [`code-guidelines.md`](code-guidelines.md) | How code is written here. Rule 1 is the same standard `## How it works` is held to |
| [`CONTRIBUTING.md`](../../CONTRIBUTING.md) | The eight rules, the pre-commit hook, and the gate to run before opening a PR |
| [`readability-log.md`](readability-log.md) | Why "state omissions as omissions" is a rule here |
