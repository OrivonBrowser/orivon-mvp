# ADR-0037: A Level 4 site's grants are shown without warnings

- **Status:** accepted
- **Date:** 2026-09-26
- **Type:** product
- **Decided by:** owner

## Decision
On every surface where a capability grant's breadth is shown — the native install-consent
dialog, the `app.requestGrant` prompt, the update-widening prompt, the site-info popup's switch
rows and the all-sites settings panel's rows — a site whose displayed Website level
(`src/trust/website-level.ts`'s `displayedLevel`) is 4 shows every grant **without** the warning
that grant would otherwise carry: no `⚠` glyph, no `warning: true` (so the native dialog's icon
stays `'question'`, never `'warning'`), no breadth explanation line. The words that remain say
exactly what they said before; only the alarm markers are gone.

This is decided once, in `src/main/consent/grant-level.ts`'s `summaryAtLevel`, and applied at
row-building time by every caller that produces a `CapabilityGrantSummary` or a picked-path
summary — never re-derived per surface.

**What this does not touch.** The rollback-choice prompt (`describeRollbackChoice`) and the
staged "this app asked for these together" note (`site-info/main-view.ts`) are not about a
grant's breadth, and Level 4 leaves both untouched. `describeReconsent` renders no capability row
at all.

**No provider exists yet** (`open-questions.md` A250), so Level 4 is reachable in this build only
through the developer-only override (`src/main/dev/score-levels.ts`, `ORIVON_SCORE_LEVELS_FILE`),
gated the same way `src/main/dev/eth-resolver.ts` gates fake `.eth` names. A future provider's
Level 4 attestation inherits this same rule automatically: the summary functions read only the
displayed level, never how it was reached.

## Context
The owner asked for the shield and its panel to lead with the site's Website level
(`ADR-0006`'s 2026-09-25 amendment already ties every trust surface to the canonical scale), and
for an L4 site's consent surfaces to read as reassuring rather than alarming — the practical
payoff of having earned the top of the scale. Before this decision, `warning`/`⚠` were computed
purely from a grant's own pattern breadth (`grant-prompt-connect.ts`), with no way for a site's
trust standing to affect how its own grants are presented.

## Alternatives considered
**Silence warnings only in the site-info popup and the all-sites panel, leaving the native
consent dialogs unchanged.** Rejected: an L4 site's FIRST install-consent dialog is exactly where
a person decides whether to trust it at all, and leaving that one dialog alarmed while every
later view of the same grant reads calm would be a more confusing inconsistency than either
extreme, not a safer middle ground.

**Grade the warning rather than remove it** (a lower-severity marker at L4 instead of none).
Rejected on the same reasoning `grant-prompt-render.ts`'s own design notes already give for not
grading `tcp.listen`/`udp.bind` against `tcp.connect`: a grant's breadth is a fact about what it
reaches, not about how much the reader should worry, and introducing a second severity tier here
would need its own justification this decision has no occasion to invent.

**Strip the marker from `message` by re-deriving the sentence, rather than stripping the literal
`⚠ ` prefix.** Rejected: every warned sentence is already produced once, by
`describeCapabilityGrant`/`describeInboundAccess`, and a second code path that reconstructs the
non-alarmed wording would risk drifting from the literal words those functions already chose.
Stripping the fixed `WARNING_MARK` prefix (`grant-prompt-connect.ts`) guarantees the exact same
sentence, minus the glyph.

## Reasoning
One function, one rule, applied at the single point every surface already funnels a grant summary
through (`describeCapabilityGrant`/`describePickedPath`), is the only shape that keeps "does this
grant warn" answered identically everywhere — the alternative, each of five call sites deciding
for itself whether the site is L4, is exactly the kind of duplicated policy `code-guidelines.md`
Rule 3 exists to prevent, and the one most likely to drift as a sixth surface is added later.

## Consequences
- **A wrongly-claimed Level 4 silences every breadth warning that site's grants would otherwise
  carry**, including the loopback/private-address explanation (A197) and the "this opens a door
  into your device" line (A134) — see `docs/architecture/security-model.md` T39. In this build
  the only way to reach Level 4 is the developer-only override, gated behind
  `ORIVON_DEV_ORIGINS=1` and a named env file, logged loudly on every use
  (`src/main/dev/score-levels.ts`), and never reachable from `window.orivon`, IPC or any other
  renderer-reachable surface. A future real provider's Level 4 inherits the same power this
  decision grants, and whoever wires that provider in must weigh it again, not assume this
  decision already settled it for a judged level.
- **The widening (`app.requestGrant`) and update-consent prompts are in scope**, deliberately —
  the surfaces where breadth visibility matters most keep no exemption.
- Every `toEqual` assertion on a grant row's exact shape (permissions/site-info test suites) had
  to be updated deliberately for the rows this reaches, rather than loosened.

## Reversibility
- **Cost to reverse:** cheap. `summaryAtLevel` is one pure function called from one place per
  surface; removing the call, or narrowing which levels it fires on, touches no stored state.
- **What would make us revisit:** a real Web3 Score provider's Level 4 attestation turning out to
  need a different presentation than the developer override's (for instance, naming the provider
  on the row itself) — `ADR-0006`'s own "a judged level is its provider's claim, never the
  machine's" would then need this decision to say how a named provider's Level 4 differs, if at
  all, from an unattributed one.
