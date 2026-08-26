# Contributing

Contributions are welcome. This document is what you need to make one that gets merged.

## Setup

[`docs/development/setup.md`](docs/development/setup.md). Short version: Node ≥22.12, `npm
install`, `npm run dev`. No compiler required.

**Read the `ELECTRON_RUN_AS_NODE` section before you debug anything.** If that variable is set
in your shell, Electron runs as plain Node with no window and **fails silently**. It is the
most expensive thing here to discover the hard way.

## The rules

Eight of them. Each has a reason, and the reason matters more than the rule.

**1. Do not silently promote assumptions into architecture.** If a choice is load-bearing and
reversible only at cost, write an ADR ([`docs/decisions/ADR-0000-template.md`](docs/decisions/ADR-0000-template.md)).
Monotonically numbered, never renumbered. A superseded ADR is rewritten in place with the
reversal recorded — see [`ADR-0004`](docs/decisions/ADR-0004-telemetry.md).

**2. Label uncertainty explicitly.** Distinguish *decided* from *recommended* from *still
open*. Never blur them. A recommendation presented as a decision is how a project ends up
defending a choice nobody actually made.

**3. Surface contradictions; do not smooth them over.** Append to
[`docs/open-questions.md`](docs/open-questions.md). This is why several documents here contain
a claim and its reversal side by side — that is deliberate, and it is more useful than a clean
document that quietly lost its history.

**4. Scope discipline.** Anything absent from the IN table in
[`docs/mvp-scope.md`](docs/mvp-scope.md) is **out by default**. The long-term vision is large
and coherent and seductive; scope creep out of it is the single biggest risk to this project.

**5. No dead ends toward a future Chromium fork.** For each component, state whether it
survives that migration or is knowingly disposable. [`ARCHITECTURE.md`](ARCHITECTURE.md) has
the current table.

**6. Prefer mature components.** Per subsystem, decide: build / library / fork / embed /
interface. Do not reinvent without a written reason.

**7. Don't over-document trivia**, and don't create abstractions for elegance alone.

**8. Pure-JS dependencies only.** No native modules requiring compilation. Windows and macOS
are supported by running from source, and an `npm install` that needs `node-gyp` is a worse
wall than the code-signing certificate it was meant to avoid. Enforced by `npm run
check:natives`, which runs automatically on every install.

Two more that are less philosophical and more immediate:

**TypeScript only.** No Rust, no C++ ([`ADR-0002`](docs/decisions/ADR-0002-capability-api-is-the-durable-asset.md)).

**`src/contracts/` references nothing outside itself.** Not `electron`, not `node:*`, not any
package. It is the interface every part of the system agrees on, and tying it to the engine
beneath it would defeat its entire purpose. Enforced by `npm run check:contracts`.

## Before you open a pull request

```bash
npm run typecheck && npm test && npm run check:natives && npm run check:contracts
npm run smoke     # only if you touched src/main/
```

`npm run smoke` prints a JSON result and a failure list. **Read those, not the exit code
alone.**

All five run in CI on every push. **With no dedicated code reviewer, CI is the reviewer** — a
red pull request does not merge, ever.

## Pull request body

Four things:

- **Goal** — what this is for, in one sentence.
- **Paths touched** — and confirmation they're within your area.
- **Contracts depended on** — which types from `src/contracts/`, and whether any changed.
- **How it was verified** — the commands you ran and what they said.

The last one is not a formality. "Should work" and "tests pass" are different claims, and this
project has already been bitten by the difference.

## Working alongside others

[`docs/development/parallel-work.md`](docs/development/parallel-work.md) — worktrees, the
ownership map, and how conflicts get resolved. Two rules from it are worth repeating here:

**Never change `src/contracts/` in the same pull request as an implementation.** A contracts
change affects everyone at once; it goes in its own PR and merges first.

**Never hand-merge `package-lock.json`.** Take either side wholesale, run `npm install`, commit
the result. A hand-merged lockfile can look entirely correct and install a different dependency
tree than either side intended, and nothing will tell you.

## Tests

[`docs/development/testing.md`](docs/development/testing.md) explains what is tested and — more
importantly — why so little is. Read it before concluding the suite is neglected.

If you're adding tests, the bar is: **does this failure mode announce itself?** A broken tab
switch is visible in seconds and doesn't need a test. A broken capability check is invisible
and does.

## Commits

Imperative subject line. A body explaining **why**, not what — the diff already says what.
Match the existing log; it is unusually informative on purpose, because it is the only record
of reasoning that travels with the code.

## Security

Please don't open a public issue for a vulnerability. [`SECURITY.md`](SECURITY.md).

## A note on how this was built

Much of this repository was written with AI assistance (Claude Code). [`CLAUDE.md`](CLAUDE.md)
is its instruction file, and `.claude/` holds project-specific tooling configuration.

**None of that is required to contribute, and this is not an AI-only project.** The human
documentation — this file, [`README.md`](README.md), [`ARCHITECTURE.md`](ARCHITECTURE.md),
[`docs/`](docs/) — is the contract, and it is maintained to be sufficient on its own. If you
find a place where it isn't, that is a bug worth reporting: it is
[tracked deliberately](docs/development/readability-log.md).
