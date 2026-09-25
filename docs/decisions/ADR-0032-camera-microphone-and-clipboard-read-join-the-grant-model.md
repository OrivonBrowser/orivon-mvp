# ADR-0032: Camera, microphone and clipboard read join the grant model; a website gets the traditional per-site prompt instead

- **Status:** proposed
- **Date:** 2026-09-24
- **Type:** security
- **Decided by:** owner

## Decision

Orivon gains three capability kinds -- `media.camera`, `media.microphone`, `clipboard.read` --
declared in `Capabilities.media`/`Capabilities.clipboard` (`src/contracts/manifest.ts`). The
**same** kind, and the same two places it is shown (a switch in the site-info popover, a row in
the all-sites permissions panel), cover both an **app** and an ordinary **website**, but the two
reach a grant through different doors:

- **An app** (an origin the broker has registered, with a manifest) goes through the grant ledger
  exactly like every other capability: declared in the manifest, offered at install consent
  alongside the app's other capabilities, re-asked with an Allow/Deny dialog the first time the
  page actually calls `getUserMedia`/`readText` while holding no grant, persisted, and revocable
  from the same panel any other grant is revoked from.
- **A website** (no manifest, never registered) never reaches the broker for this. It gets the
  traditional browser prompt this codebase already built for notifications (`ADR-0028`):
  Allow/Block/Not now, with Allow and Block remembered per site and Not now deciding nothing.

Camera and microphone ship **grant only**: no in-use indicator on the tab, and revoking or
blocking does not stop a stream already running. This is a stated divergence from Chrome, not an
oversight -- see Consequences.

`clipboard-read` and `deprecated-sync-clipboard-read`'s underlying refusal in
`permission-gate.ts` is otherwise unchanged for anyone who does not hold one of these three: it
still denies by default.

## Context

`docs/planning/compatibility-matrix.md` Table 3 listed both as `❌ missing`, both with no route to
a yes. `ADR-0022` deliberately drew the line at write-only for clipboard, arguing clause 2(a) of
the gate's rule (a legacy path already grants the same power) does not exist for reads, and
clause 2(b) (an affordance the shell draws) does not exist either -- reading needs a real,
per-site decision. `open-questions.md` A202 left the question open explicitly for this reason,
and Table 4's row 8 named both as blocked on that same owner call. AirGap Vault, a ported app, has
exactly two ways to receive a transaction to sign: paste from clipboard, or scan a QR code with
the camera. Neither worked.

## Alternatives considered

**Both stay denied.** Leaves AirGap Vault unable to receive a transaction either way, and every
ordinary paste-to-verify or QR-scan flow broken. Rejected: nothing about either power needs a
blanket refusal once a real per-site question exists.

**One `orivon.*` capability, for everyone, no website path.** Simpler, but an ordinary website has
no manifest and would stay broken -- exactly `ADR-0028`'s own argument against a manifest-only
notifications capability, applied here.

**A single Chromium-level prompt for everyone, apps included.** Rejected: an app already has a
manifest and an install-time consent screen an app author can rely on being asked once, up front,
with the rest of what the app needs; routing it through a second, independent Chromium-level
mechanism would mean an app never actually knows at install time whether it will get the camera,
only discovers it mid-run, and cannot declare the need visibly beside its other capabilities.

**Camera/microphone with a tab indicator and a stream-stop on revoke, now.** Considered and
deferred, not rejected -- see Consequences. Chrome draws both; this build ships neither yet.

## Reasoning

Two doors for one power is not two designs: it is the same rule (`open-questions.md` A202) applied
to two different kinds of caller. An app already carries a manifest a person reads before it runs
at all; asking through that same channel, and only falling back to a per-request dialog for what
the manifest did not cover, matches how every other `orivon.*` capability already works and costs
an app author nothing new to learn. A website carries no such declaration, so it gets exactly the
mechanism `ADR-0028` already built and proved for notifications, generalized to a small set of
named permissions instead of one.

Showing both in the **same** UI position -- one switch per kind in the site-info popover, one row
per kind in the all-sites panel -- means a person checking what a site or app can do never has to
know which door it came through to find the answer.

## Consequences

- AirGap Vault's "Paste from clipboard" and its QR-scan path both become reachable, for the first
  time, through a real per-site or per-app decision.
- **Known divergence from Chrome:** no camera/microphone in-use indicator on the tab, and turning
  the permission off in the panel does not stop a stream already running -- a page that started
  recording before being revoked keeps recording until it stops on its own or the tab closes.
  Deferred, not silently dropped: `docs/open-questions.md` carries the open item, and it is real
  work (`webContents.setWindowOpenHandler`-adjacent per-tab UI, track-level teardown reachable
  from the permission gate) that touches the shell rather than the grant model this ADR settles.
- `notification-decisions.ts`'s per-site store generalizes to cover more than one permission name;
  its own file format gains a version.
- The permission gate (`critical: true`) gains three more branches that must fail closed.

## Reversibility

- **Cost to reverse:** cheap before any app ships depending on the kind names; moderate after,
  the same cost any `CapabilityKind` removal carries (`ADR-0002`).
- **What would make us revisit:** a report of the no-indicator/no-stop divergence being abused in
  practice, which would move the tab-indicator work up the priority order named in Consequences.
