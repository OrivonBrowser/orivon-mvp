# ADR-0025: The permission gate allows HTML fullscreen, to every page

- **Status:** accepted
- **Date:** 2026-09-22
- **Type:** security
- **Decided by:** owner

## Decision

`src/main/sessions/permission-gate.ts` allows the Chromium permission `fullscreen` on every
session the gate covers: the default session and every app partition. `automatic-fullscreen`,
the content setting that lets a page go fullscreen without a click, stays denied. When a page
enters fullscreen the shell makes that tab fill the window, hides the chrome, and shows
"Press Esc to exit full screen" for four seconds (`src/main/shell/fullscreen.ts`,
`src/main/shell/window-notice.ts`). Like clipboard write (`ADR-0022`) and a chosen file
(`ADR-0024`), this is not an `orivon.*` capability: nothing is declared in a manifest, no grant
is issued, and nothing appears in the permissions panel.

## Context

The gate refused every name it did not list, so `requestFullscreen()` failed in every page:
video players, games, FreeTube's player, YouTube. Because the gate covers
`session.defaultSession`, ordinary websites failed too, and an ordinary website has no manifest
through which a per-app capability could restore it.

Measured against a real page in Electron 44: `requestFullscreen()` reaches the session's request
handler as `fullscreen` and its check handler as `automatic-fullscreen`. Allowing the first is
enough for a click-initiated request. Electron then puts the window into fullscreen but leaves a
`WebContentsView` at the bounds it already had, so the page stayed under the chrome; the shell has
to lay the tab out itself.

`docs/open-questions.md` A202 recommended a two-clause rule for adding a name to the gate:
(1) the web platform gates the power on an action by the person that the shell can neither fake
nor suppress, and (2) a legacy path already grants the same power. Fullscreen meets the first
clause and not the second: no legacy path reaches it. Its one abuse is instead answered by an
affordance every browser draws. The rule is amended to admit that case: a name passes when
clause (1) holds and either (2a) a legacy path already grants the same power, or (2b) the power's
one abuse is answered by an affordance the shell draws, as every browser does.

## Alternatives considered

**A per-app capability with a manifest field.** It leaves every ordinary website broken, since
only apps have a manifest, and it would gate a power no browser asks about: Chrome, Firefox and
Safari all grant fullscreen from a click without a prompt. A grant row would describe a boundary
no other browser draws, in a prompt a person is asked to read.

**Keep it denied.** Video breaks on every site, and the deny protects nothing that the click
requirement and a browser-handled Escape do not already protect.

**Also allow `automatic-fullscreen`.** It lets a page take the screen with no click, which
removes the action the whole argument rests on.

## Reasoning

Entry needs the person: Chromium grants fullscreen only from transient user activation. The
shell-fidelity e2e asserts it: a request made at load, before anyone touched the page, is
refused and the window stays windowed. A request from a tab that is no longer the active one is
turned back by the shell rather than filling the window with content the person is not looking
at.

Exit is not the page's to refuse. Escape is consumed in the browser process before the page sees
the key, so no script can trap the person in fullscreen. The shell also ends fullscreen itself
when the tab closes, crashes or stops being the active tab, asking the page through an isolated
world where its own script cannot have replaced `document.exitFullscreen`.

The abuse fullscreen enables is spoofing: a page filling the screen can draw a fake address bar
or a fake system dialog. Every browser answers that with an exit notice on entry, and so does
this one. That is clause (2b).

## Consequences

- Fullscreen works in every page from a click, and Escape always gives the window back.
- `web-context-host.ts`'s deny-everything handlers on `ADR-0019` isolated-context sessions now
  also keep fullscreen away from a document running another site's script, as they do clipboard
  write and file access. They look redundant with the gate and are not.
- The argument rests on upstream behaviour this project does not control: the activation
  requirement, and Escape being handled in the browser process. `test/e2e-shell-fidelity.test.ts`
  asserts both through their effects against the real shell: a load-time request is refused, a
  click fills the window with the chrome hidden and the notice shown, and an Escape sent through
  the browser's own input path leaves.
- The notice covers a 320x44 strip at the top centre of the window for four seconds after each
  entry.
- The gate's rule for a new name is now the amended one above. A202 keeps its second part, whether
  `clipboard-read` ever becomes a capability, open.

## Reversibility

- **Cost to reverse:** cheap. One name leaves a set, the shell's layout code becomes unused, and
  the tests naming it fail until updated. Nothing is persisted: no manifest field, no grant, no
  migration.
- **What would make us revisit:** Chromium dropping the user-activation requirement for
  fullscreen; Escape ceasing to be handled in the browser process; or a spoofing abuse the exit
  notice does not cover.
