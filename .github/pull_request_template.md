<!--
  The blueprint: docs/development/pr-blueprint.md -- rules, reasoning, worked examples.
  This form is the short version. Delete these comments as you fill them in.

  TITLE: imperative, present tense, no prefix, ~72 chars.
         "Check connect patterns against resolved addresses, never the hostname"
         not "broker-02-address: the blocked-address-range table"

  A type:chore PR or a one-line fix may keep only Goal, What changes for the user,
  and How it was verified. Anything on the critical path takes the full form.
-->

## What changes for the user

<!--
  Plain language, present tense. What can someone do, see, or no longer do?

  Most PRs here change nothing a user experiences, and "None" is the expected,
  respected answer. Write:  None -- <why>, and when it WILL be visible.

  "Improves security" / "better performance" / "improves UX" are NOT answers.
  They name a category. Say what the user experiences.

  Then set the ux:visible or ux:none label to match.
-->

## Goal

<!-- One sentence. What this is FOR -- the intent, not the mechanism. -->

## What it achieves

<!-- The outcome: what is now true that was not. 2-5 bullets, each checkable. -->

## How it works

<!--
  The mechanism, and the choices that were not obvious. Not a file-by-file
  narration -- the diff is right there.

  - Link the ADR or architecture doc you are implementing; do not re-explain it.
  - Name the one file to read first.
  - Explain why, not what (code-guidelines.md Rule 1, different medium).
-->

## Stream, paths and merge order

- **Stream:** <!-- from the ownership map; a backlog-NN branch names the stream it borrows -->
- **Paths touched:** <!-- and confirmation they are yours -->
- **Contracts:** <!-- which types from src/contracts/ this depends on, and whether any changed.
                     If any changed: this PR contains no implementation, merges first, and gets
                     the contracts-change label. src/shared/ follows the same rule. -->
- **Merge order:** <!-- independent | stacked on #N | must merge after #M -->

## Decisions and open questions

<!--
  Anywhere you deviated from a document, chose between two defensible options, or
  made a call the owner has not. Label each one:
      owner's decision / AI recommendation / still open

  Open questions filed: list the A-numbers, taken from MAIN's highest, not your
  branch's (parallel-work.md, "Open-question numbers").

  Load-bearing and architectural? That is an ADR, not this section -- write it and
  cite it here.

  "None." is a valid answer. Write it anyway -- writing it is what forces the check.
-->

## How it was verified

<!--
  The commands you ran and what they ACTUALLY said. Paste the numbers.
  "Should work" and "tests pass" are different claims.
  A check you did not run: say so and say why. Silence reads as a pass.
-->

```
npm run typecheck && npm test && npm run check:natives && npm run check:contracts && npm run check:secrets
npm run smoke     # only if you touched src/main/
```

<!-- smoke prints a JSON result and a failure list. Read those, not the exit code alone. -->

## Risk and rollback

<!--
  Optional. What breaks if this is wrong, and how to undo it. One or two lines.
  Worth writing for: the critical path, a security boundary, anything frozen
  (key derivation, the bundle hash, src/contracts/), anything touching stored data.
  Skip for documentation.
-->

## Deliberately not done

<!--
  Optional. Follow-ups left out, and why.
  A stated omission is not a gap. A silent one looks like an oversight.
-->

<!--
  LABELS -- set before you request a review:
    one stream:*  one type:*  one ux:*
    + contracts-change      if src/contracts/ or src/shared/ changed
    + needs-owner-decision  if something above is marked "still open"
-->
