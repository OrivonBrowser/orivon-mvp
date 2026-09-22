# ADR-0021: The permission gate allows clipboard write, to every page

- **Status:** proposed
- **Date:** 2026-09-22
- **Type:** security
- **Decided by:** owner

## Decision

`src/main/permission-gate.ts` allows the Chromium permission
`clipboard-sanitized-write` on every session, so any page may call
`navigator.clipboard.writeText()`. Every other permission Chromium can ask for stays denied,
including both reading forms, `clipboard-read` and `deprecated-sync-clipboard-read`. The
allowance is not a capability: nothing is declared in a manifest, no grant is issued, and no row
appears in the permissions panel. What bounds it is the web platform's own rule that a write
requires transient user activation in a focused document.

## Context

The gate was built to close a real hole: with no handler installed, Electron approves every
permission, so any site could take the camera, the microphone or the clipboard unprompted. It
closed that by allowing nothing at all, and recorded the intent that a name be added "only
alongside that surface, never as a bare unlock".

A ported third-party app then needed the async Clipboard API, and measuring the gate against a
real page found the deny reached further than intended. The gate is installed through
`app.on('session-created', ...)`, which covers `session.defaultSession`; ordinary browsing has no
partition, so it runs there. Copy was therefore broken on every website in the browser, not only
in apps -- and an ordinary website has no manifest, so no per-app capability could have restored
it.

The same measurement found `document.execCommand('copy')` succeeding on every origin it tried.
The legacy path reaches the same clipboard, needs the same user gesture, and Electron exposes no
hook to close it.

## Alternatives considered

**A `clipboard.write` capability with a grant** -- a new `CapabilityKind`, a manifest field, a
consent-dialog line, a permissions-panel row, and a grant-aware gate. It lost on two counts that
are not matters of taste. It leaves copy broken on every ordinary website, because the mechanism
it uses to decide is a manifest that only apps have. And it would gate an API the app can bypass
in one line via `execCommand`, so the grant would describe a boundary that is not there -- the
dishonesty `ADR-0006` exists to prevent, in a prompt a person is asked to read.

**Allow for websites, require a grant for apps** -- would make an Orivon app strictly less
capable than the website in the next tab, and still gate nothing `execCommand` does not reopen.

**Leave it denied and fix nothing** -- the status quo: a browser whose copy buttons do not work,
while the legacy path writes the clipboard unprompted anyway. Strict in appearance only.

## Reasoning

The question is what the deny actually bought. Against a page that wants the clipboard, nothing:
`execCommand` is open and cannot be closed. Against a page that does not, nothing either. What
it cost was every correctly-written copy button in the browser.

Writing is also not the dangerous direction. A write needs the person to have just acted in a
focused page and replaces content they can see; a read hands over whatever they last copied
anywhere, which is how a seed phrase or a password leaves the machine. Those two deserve
different answers, and the gate now gives them different answers.

The grant ledger governs `orivon.*` capabilities, not Chromium's own. Keeping this out of the
ledger keeps that line intact: no app gained a power a plain website does not already have.

## Consequences

- The gate is no longer deny-everything, so the rule for adding a name has to be stated rather
  than assumed. It is: the web platform's own gating must be what makes the name safe. An
  entry that needs a per-app decision belongs in the grant ledger instead, or nowhere.
- `web-context-host.ts`'s deny-everything handlers on `ADR-0019` isolated-context sessions stop
  being redundant. They are now the only thing keeping clipboard write away from a document
  running another site's script, and deleting them as duplication reopens exactly that.
- The security argument rests on Chromium's activation rule, which is upstream behaviour this
  project does not control. It is asserted against a real page in
  `test/e2e-clipboard-write.test.ts` rather than assumed.
- A page can overwrite the clipboard with something other than what the person expected to copy.
  That was already true through `execCommand`; this does not add it, and nothing here detects it.

## Reversibility

- **Cost to reverse:** cheap. One name leaves a set, and the tests naming it fail until they are
  updated. No persisted state, no manifest field, no migration.
- **What would make us revisit:** Chromium dropping the transient-activation requirement for
  sanitized writes, which would remove the whole basis for this; a route appearing that closes
  `document.execCommand('copy')`, which would make a real per-app gate possible for the first
  time; or a concrete abuse this does not anticipate. `docs/open-questions.md` A202 tracks the
  wider question of which permission, if any, follows this one.
