# ADR-0013: A below-floor version is warned and chosen, never silently blocked

- **Status:** accepted
- **Date:** 2026-09-04
- **Type:** security / product
- **Decided by:** owner

## Decision
When an origin offers a version below its own T19 version floor (the highest version ever
installed for it — a signal that this may be a replayed, older, more-vulnerable bundle), Orivon no
longer refuses it outright with no prompt. Instead:

- **The first time this happens for a given origin:** the user is warned and given an actual
  choice — proceed with the older version being offered, or decline and keep using the version
  already cached.
- **Every later visit where the served version is still below the floor, once the user has chosen
  to proceed at least once for that origin:** an ongoing, passive, informational notice is shown —
  visible, but it never blocks anything and never requires a click to dismiss or proceed past.

The floor itself is unchanged by this ADR: `GrantLedger.versionFloor` still only ever rises, and it
remains the single source of truth for "has this origin ever shipped something newer than what
it's offering now." What changes is the *response* to reaching it — from a silent, no-prompt
refusal to a user decision, made once and then remembered as a standing, low-key acknowledgement
rather than re-litigated at every visit.

## Context
`src/broker/policy/update.ts`'s `decideUpdate()` was built (`docs/open-questions.md`, the PR-61/62
push) with a `'reject'` outcome specifically for this case, and its own doc comment stated the
reasoning plainly: *"do not install at any prompt... a replayed old bundle looks identical to a
legitimate one and no prompt can tell the user which they are looking at."* That reasoning was
sound as far as it went — no popup, no matter how worded, can distinguish a legitimate version
regression (a publisher genuinely reverting a bad release) from an attacker replaying an old,
vulnerable bundle to suppress a fix. The two are byte-for-byte, hash-for-hash indistinguishable.

Asked directly while scoping the discovery-trigger wiring that would have made this path live for
the first time (build step 2/4, this session): **that was never the intended tradeoff.** The
owner's own words: *"I never wanted actually an anti-rollback protection. When it's detected
however, the user should be warned and choose to follow the new Web3site files the URL is
offering, or not (and keep using from cache instead)."* Pressed on the specific mechanic of
repeated warnings: *"After his choice, warn every single time, but that's just an informational
warning that does not require user input to skip."*

This is a genuine reversal of a documented threat-model position (`security-model.md` T19,
`ADR-0009`'s Consequences section), not a UI wording change — recorded here per `CLAUDE.md` Rule 1
rather than folded silently into the discovery-trigger PR.

## Alternatives considered

**Keep the hard block (`decideUpdate` returns `'reject'`, no UI ever).** This is what shipped
before this ADR. Rejected: it is not what the owner wants, and it means a publisher who
legitimately needs to revert a bad release has no path back for a user who already reached the bad
version — the browser silently refuses every subsequent visit forever, with nothing on screen
explaining why. A user who trusts a site and wants to use whatever it is currently serving has no
way to do that.

**Warn and ask every single time, with no persisted acknowledgement.** Considered as the simplest
implementation of "warn the user." Rejected on the owner's own explicit correction: the FIRST
warning should be an interactive choice, but repeating that same interactive choice on every
subsequent visit to a site the user has already decided to trust is exactly the prompt-fatigue
failure `ADR-0012` was written to avoid for the unrelated fetch-and-cache step — training the user
to reflexively click through a security-relevant dialog makes it worthless the one time it matters
for a genuinely new decision.

**Silently install every below-floor version once acknowledged once, with no notice at all.**
Simpler still, and closer to how an ordinary browser cache behaves. Rejected: the owner was
explicit that the warning should keep appearing ("warn every single time"), just without requiring
interaction — the point is ongoing visibility that this origin is behind its own high-water mark,
not a one-time decision the user then forgets was ever made.

## Reasoning
The chosen shape treats "has this origin ever offered something newer" and "has the user already
decided they're fine with this origin regressing" as two independent, separately-tracked facts.
The first (the floor) is a pure, objective record and must never be user-editable or reset by
anything short of the origin itself shipping something newer, or the user removing the app
entirely (see `ADR-0009`'s own 2026-09-04 amendment, filed alongside this one, for why removal —
not this ADR — is what resets it). The second (has the user already said yes) is a per-origin
preference, set once by an actual choice and then respected going forward without re-asking,
matching every other place this codebase already remembers a user's decision by exact scope rather
than re-prompting (approval remembered per exact file hash, `ADR-0012`'s own design).

Splitting the DECISION this way — `rollback-choice` the first time, `rollback-notice` every time
after — keeps `decideUpdate()` a pure function of its own stated inputs, with no hidden state and
no second decision point living outside this module (the same discipline this file's own header
already insists on: *"its failure mode is 'no prompt appeared', which no manual checklist
catches"*). The caller supplies whether this origin has been acknowledged before, the same way it
already supplies `grantedPatterns` and `versionFloor` — this module does not reach into storage
for any of them.

## Consequences
- `UpdateDecision` (`src/broker/policy/update.ts`) drops `'reject'` and gains `'rollback-choice'`
  and `'rollback-notice'`. `UpdateInput` gains `rollbackAcknowledged: boolean`. The floor check
  still runs first and still outranks every other check (a rollback that also widens authority is
  still a rollback decision, never silently downgraded to a capability-prompt) — only what it
  returns changed.
- `LoadResult` (`src/loader/index.ts`) gains `LoadNeedsRollbackChoice` (parallel to
  `LoadNeedsReconsent`/`LoadNeedsCapabilityPrompt` — carries `manifest`/`tree`/`entries` so
  approving can persist without re-fetching, plus the origin's own `versionFloor` for the prompt to
  display). `LoadInstalled` gains an optional `rollbackNotice?: true`, set only when the install is
  an acknowledged rollback — the caller uses this to render the passive notice, never a prompt.
- **Not decided here, flagged rather than guessed:** whether choosing "proceed with the older
  version" persists it as the new pin (so the app keeps running that version until something else
  changes) or is session-ephemeral. This ADR's own implementation recommends persisting it — the
  point of choosing to stay on an older version is to keep using it, and a choice that silently
  reverted on the next launch would surprise the user — but this specific sub-point was not asked
  directly and should be confirmed, not assumed settled by this document alone.
- **Not built by this ADR:** where `rollbackAcknowledged` itself is read from and written to. It
  is a new, small piece of per-origin state, analogous to `versionFloor` (A57) — the natural home
  is the same `LedgerStorage`-backed mechanism, extended with a second field, built as part of the
  work that actually wires a real caller to `Loader.load()` (`src/main/app-install.ts`, per the
  session plan this ADR was written alongside). Until that lands, `rollbackAcknowledged` is a
  caller-supplied boolean with no real production source, the same "not yet a live risk" position
  `grantedPatterns` and `versionFloor` were both in before their own wiring existed
  (`docs/open-questions.md` A61, A57).
- `security-model.md` T19's row, `docs/architecture/capability-api.md`'s two version-floor
  sections, and `docs/architecture/bundle-hash.md`'s summary line are corrected in place, dated,
  alongside this ADR — all three previously described the floor as something that "rejects."

## Reversibility
- **Cost to reverse:** moderate. No pin, hash, or persisted floor value depends on which response
  a below-floor version gets — reverting to a hard block is a policy change in `decideUpdate()`
  and a UI removal, not a data-format change. The cost is mostly in the UX: once real users have
  seen an interactive rollback choice and an ongoing notice, removing both to a silent block again
  reads as the product becoming more restrictive, a harder sell than shipping the warn-and-choose
  behaviour from the start (the same asymmetry `ADR-0012`'s own Reversibility section names for a
  related reason).
- **What would make us revisit:** evidence that users routinely choose "proceed with the older
  version" without understanding they may be accepting a rollback attack — e.g. a real incident,
  or user research showing the warning's wording doesn't land. Not "if it turns out badly" in the
  abstract; a specific, observed failure of the warning to actually inform the choice it exists to
  support.
