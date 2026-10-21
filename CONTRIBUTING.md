# Contributing

Contributions are welcome. This document is what you need to make one that gets merged.

## Setup

[`docs/development/setup.md`](docs/development/setup.md). Short version: Node ≥22.13, `npm
install`, `npm run dev`. No compiler required.

**Read the `ELECTRON_RUN_AS_NODE` section before you debug anything.** If that variable is set
in your shell, Electron runs as plain Node with no window and fails silently. It is the most
expensive thing here to discover the hard way.

## The rules

Eight of them. Each has a reason, and the reason matters more than the rule.

**1. Do not silently promote assumptions into architecture.** If a choice is load-bearing and
reversible only at cost, write an ADR ([`docs/decisions/ADR-0000-template.md`](docs/decisions/ADR-0000-template.md)).
Monotonically numbered, never renumbered. A superseded ADR is rewritten in place with the
reversal recorded; see [`ADR-0004`](docs/decisions/ADR-0004-telemetry.md).

**2. A page says how Orivon works now, never who decided it or how it got there.** Dates,
decision IDs and attribution go in [`docs/decisions/decision-log.md`](docs/decisions/decision-log.md)
or an ADR, never inline in the prose, and so does change history: no "what changed since", no
"the first version did", no PR numbers, no struck-through rows. Git and
[`CHANGELOG.md`](CHANGELOG.md) remember how a page got here. `CHANGELOG.md`, `docs/decisions/`,
`docs/open-questions.md` and the dated records in `docs/planning/` are about change, and keep
their history. The one status a page must still carry is *provisional*: a
recommendation presented as a decision is how a project ends up defending a choice nobody
actually made.

**3. Surface contradictions; do not smooth them over.** A contradiction you can settle from the
repository is fixed in place and named in the pull request. One that only the owner can answer
is filed in [`docs/open-questions.md`](docs/open-questions.md), in the shape its header gives; a
resolved entry becomes one row in
[`docs/decisions/resolved-questions.md`](docs/decisions/resolved-questions.md). When a page turns
out to be wrong, rewrite it to be right rather than leaving a correction under the wrong text.
The page states what is true now; git remembers that it changed.

**4. Build a feature when a need calls for it.** A feature is picked up once a real app, a user,
a roadmap item ([`docs/roadmap.md`](docs/roadmap.md)) or the success metric needs it, and
[`docs/features.md`](docs/features.md) records it as it lands. The ambition is large and the
team is small: name the need before building.

**5. Label every component durable or tied to Electron.** For each component, state whether it
would outlive a change of the engine beneath it. [`ARCHITECTURE.md`](ARCHITECTURE.md) has the
current table. This is about spending care in the right place.

**6. Prefer mature components.** Per subsystem, decide: build / library / fork / embed /
interface. Do not reinvent without a written reason.

**7. Don't over-document trivia**, and don't create abstractions for elegance alone. Prefer self explanatory code over long comment sections.

**8. No native modules in Orivon's own dependencies.** No native modules requiring
compilation; JavaScript and WebAssembly both pass. Windows and macOS run from source as well as
from the release packages, and an `npm install` that needs `node-gyp` is a worse wall than the
code-signing certificate a run from source does without. Enforced by `npm run check:natives`, which runs
automatically on every install. This bounds this repository's dependencies, not the apps
Orivon runs: an app qualifies by running in the Node environment, WebAssembly included
([`ADR-0036`](docs/decisions/ADR-0036-an-app-qualifies-by-running-in-the-node-environment.md)).

Two more that are less philosophical and more immediate:

**This repository's code is TypeScript only.** No Rust, no C++
([`ADR-0002`](docs/decisions/ADR-0002-capability-api-is-the-durable-asset.md)).

**`src/contracts/` references nothing outside itself.** Not `electron`, not `node:*`, not any
package. It is the interface every part of the system agrees on, and tying it to the engine
beneath it would defeat its entire purpose. Enforced by `npm run check:contracts`.

## Enable the pre-commit hook, once

```bash
git config core.hooksPath .githooks
```

It blocks a commit that would put a credential into this repository. This repo is public, so a
token that reaches a commit and gets pushed is scraped within minutes, and the only correct
response is rotating it. Deleting the line does not help, because the value stays in the object
store and in every fork.

The hook is one of three layers, and none is sufficient alone: the hook runs before the commit
exists (and is bypassable with `--no-verify`), CI's `check:secrets` runs after push but before
a merge, and branch protection means nothing reaches `main` without the owner.

## Before you open a pull request

```bash
npm run typecheck && npm test
npm run check:natives && npm run check:contracts && npm run check:vectors && npm run check:secrets
npm run check:comments && npm run check:size && npm run check:questions
npm run check:manifest-parity && npm run check:dev-grant-absent && npm run check:advisories
npm run smoke     # only if you touched src/main/
```

`npm run smoke` prints a JSON result and a failure list. Read those, not the exit code alone.

`check` (typecheck, unit tests and every guard) runs in CI on every pull request and every push to `main`.
The end-to-end suite runs the specs a change can reach, in parallel shards; `main` and the nightly run all of
it. With no dedicated code reviewer, CI is the reviewer: a pull request whose `check` or selected e2e shards are
red does not merge, ever. A pull request from a fork runs `check` once a maintainer approves the workflow, and
a maintainer adds the `ci:e2e` label to run its e2e; `ci:e2e-full` runs the whole suite for any pull request.

## Pull request title and body

[`docs/development/pr-blueprint.md`](docs/development/pr-blueprint.md) has the shape every pull
request here follows, and why. You do not have to read it first:
[`.github/pull_request_template.md`](.github/pull_request_template.md) is the same thing as a
form, and GitHub opens it for you automatically.

The title rule, because it is the one part no template can fill in for you: imperative, present
tense, no prefix, about 72 characters. The test is whether someone who wasn't there could tell
what changed without opening it. *"Check connect patterns against resolved addresses, never the
hostname"* passes. *"broker-02-address: the blocked-address-range table"* does not, because it
names a noun rather than a change, and the prefix repeats what the label already says.

Two things from the blueprint worth stating here, because both have already cost this project
something:

- **Say what the change means, and note there are two audiences:** a person *using* Orivon,
  and a developer *building an app on* it. A bare "None" is not an answer: if you can explain
  the change at length, its effect was derivable. Where one audience has nothing today, say
  when it becomes something. Naming a category ("improves security") is still not an answer.
- **"Should work" and "tests pass" are different claims.** Paste what the commands actually
  said. This project has already been bitten by the difference.

## Working alongside others

[`docs/development/parallel-work.md`](docs/development/parallel-work.md) covers worktrees, the
ownership map, and how conflicts get resolved. Two rules from it are worth repeating here:

**Never change `src/contracts/` in the same pull request as an implementation.** A contracts
change affects everyone at once; it goes in its own PR and merges first.

**Never hand-merge `package-lock.json`.** Take either side wholesale, run `npm install`, commit
the result. A hand-merged lockfile can look entirely correct and install a different dependency
tree than either side intended, and nothing will tell you.

## Tests

[`docs/development/testing.md`](docs/development/testing.md) explains what is tested and, more
importantly, why so little is. Read it before concluding the suite is neglected.

If you're adding tests, the bar is: does this failure mode announce itself? A broken tab
switch is visible in seconds and doesn't need a test. A broken capability check is invisible
and does.

## Commits

Imperative subject line. A body explaining why, not what: the diff already says what. Match the
existing log; it is unusually informative on purpose, because it is the only record of
reasoning that travels with the code.

## Security

Please don't open a public issue for a vulnerability. [`SECURITY.md`](SECURITY.md).

## A note on how this was built

Much of this repository was written with AI assistance (Claude Code). [`CLAUDE.md`](CLAUDE.md)
is its instruction file, and `.claude/` holds project-specific tooling configuration.

None of that is required to contribute, and this is not an AI-only project. The human
documentation (this file, [`README.md`](README.md), [`ARCHITECTURE.md`](ARCHITECTURE.md),
[`docs/`](docs/)) is the contract, and it is maintained to be sufficient on its own. If you
find a place where it isn't, that is a bug worth reporting: it is
[tracked deliberately](docs/development/readability-log.md).
