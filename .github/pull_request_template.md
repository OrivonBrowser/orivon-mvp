<!--
  The blueprint: docs/development/pr-blueprint.md -- rules, reasoning, worked examples.
  This form is the short version. Delete these comments as you fill them in.

  src/contracts/ and src/shared/ go in their OWN PR, with no implementation, merged
  first. If this PR changes either, split it.

  TITLE: imperative, present tense, no prefix, ~72 chars. Name a change, not a noun.
         "Check connect patterns against resolved addresses, never the hostname"
         Carrying several major changes? Name the theme:
         "Land the folder picker and close three broker defects"

  A small PR that genuinely stands alone (a revert, a hotfix) may keep only
  What changes for the user, one Changes entry, and How it was verified.
-->

## What changes for the user

<!--
  Plain language, present tense, across the WHOLE PR. Answer for BOTH audiences:

    User -- a person using Orivon.
    Dev  -- a person building an app ON Orivon. src/contracts/ is their product
            surface, so a change there is as user-facing as moving a button.

  A bare "None" is NOT an answer (d-0034). If you can explain the
  change at length, its effect was derivable. Take the first rung that is true:

    1. Direct       -- someone can now do, see, or no longer do something.
    2. Second-order -- nothing visible yet, but something is faster, cheaper, more
                       reliable, or harder to get wrong. Say which, and for whom.
    3. Enabling     -- a step toward something a person will feel. Name the thing
                       and WHEN. "From step 5 the loader refuses a changed bundle"
                       is an answer; "groundwork" is not.

  Rung 3 is the floor. Where an audience genuinely has nothing today, write
  "nothing today, and <when> it becomes <what>" -- never a bare "None".

  STILL not answers: "improves security", "better performance", "more robust",
  "improves UX", "groundwork", "no user impact". Those name a category.
  Deriving a real second-order effect is the OPPOSITE of inventing a direct one.

  Then set the label: ux:visible if any part is visible to a person using Orivon;
  else ux:dev if it changes what an app developer writes against; else ux:none.
-->

**User:**

**Dev:**

## Changes

<!--
  One ### entry per MAJOR change, each titled like a PR -- imperative, naming a change.
  A PR with a single change has a single entry; that is the normal case.

  Incidental fixes, renames and test tweaks do not each need an entry; one closing
  line covers them, or leave them in the commit log.

  Under each entry:
    Goal            -- one sentence. What this is FOR: the intent, not the mechanism.
    What it achieves -- the outcome: what is now true that was not. 2-5 checkable bullets.
    How it works    -- the mechanism, and the choices that were not obvious. Not a
                       file-by-file narration; the diff is right there. Link the ADR you
                       are implementing rather than re-explaining it, and name the one
                       file to read first.
-->

### <first major change, as an imperative title>

**Goal.**

**What it achieves.**

**How it works.**

### <second major change>

<!-- ...repeat. Delete the unused entries. -->

**Also in this PR:** <!-- one line for the incidental work, or delete -->

## Streams, paths and merge order

- **Streams:** <!-- every stream this PR touched, from the ownership map -->
- **Paths touched:** <!-- and confirmation they are yours -->
- **Contracts:** <!-- which types from src/contracts/ this depends on, and whether any changed.
                     If any changed: STOP -- that belongs in its own PR, merged first, with no
                     implementation and the contracts-change label. src/shared/ is the same. -->
- **Merge order:** <!-- independent | stacked on #N | must merge after #M -->

## Decisions and open questions

<!--
  Anywhere you deviated from a document, chose between two defensible options, or
  made a call nobody has confirmed. Mark anything provisional as provisional.

  A decision that sticks earns a row in docs/decisions/decision-log.md (or an ADR).
  The page it governs states the behaviour, never the provenance.

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

  This covers the WHOLE PR, not the last thing you touched. A PR whose verification
  only exercises its final commit is not verified.
-->

```
npm run typecheck && npm test
npm run check:natives && npm run check:contracts && npm run check:vectors && npm run check:secrets
npm run check:comments && npm run check:size && npm run check:questions
npm run check:manifest-parity && npm run check:dev-grant-absent && npm run check:advisories
npm run smoke     # only if you touched src/main/
```

<!-- smoke prints a JSON result and a failure list. Read those, not the exit code alone. -->

## Risk and rollback

<!--
  Optional. What breaks if this is wrong, and how to undo it. One or two lines.
  Worth writing for: the critical path, a security boundary, anything frozen
  (key derivation, the bundle hash, src/contracts/), anything touching stored data.

  The more a single PR carries, the more this earns its place: if one change in here
  is riskier than the rest, say which.
-->

## Deliberately not done

<!--
  Optional. Follow-ups left out, and why.
  A stated omission is not a gap. A silent one looks like an oversight.
-->

<!--
  LABELS -- set before you request a review:
    every stream:* this PR touched    every type:* it contains
    exactly one ux:*  -- visible > dev > none, highest that applies
    + contracts-change      if src/contracts/ or src/shared/ changed
    + needs-owner-decision  if something above is marked "still open"
-->
