# ADR-0026: The permission gate allows pointer lock and keyboard lock

- **Status:** accepted
- **Date:** 2026-09-22
- **Type:** security
- **Decided by:** owner

## Decision

`src/main/sessions/permission-gate.ts` allows the Chromium permissions `pointerLock` and
`keyboardLock` on every session the gate covers, without asking. The shell draws the notice
Chromium would: "Press Esc to show your cursor" when a page locks the pointer outside
fullscreen, and "Press and hold Esc to exit full screen" when a page in fullscreen locks the
keyboard (`src/main/shell/exclusive-access-notice.ts`, `src/main/shell/window-notice.ts`). Like
fullscreen (`ADR-0025`), neither is an `orivon.*` capability: nothing is declared in a manifest,
no grant is issued, and nothing appears in the permissions panel.

## Context

The deny-all gate refused both, so browser games, 3D viewers and remote-desktop pages could not
capture the mouse, and a fullscreen game could not keep Escape or other browser shortcuts.

Measured against a real page in Electron 44:

- `requestPointerLock()` reaches the session's request handler as `pointerLock`, never its check
  handler. Chromium refuses the lock without a click in the page even when the gate says yes,
  and Escape releases it in the browser process before the page sees the key.
- `navigator.keyboard.lock()` reaches the request handler as `keyboardLock`, never the check
  handler. It needs no click, but Chromium applies it only in fullscreen, and asks for it again
  each time the page enters fullscreen. With Escape locked, a single press goes to the page, and
  holding Escape for about one and a half to two seconds still leaves fullscreen.
- Electron shows no bubble of its own for either, so nothing tells the person how to get the
  cursor or the window back unless the shell does.

A notice view that navigates while attached to the window takes focus from the page under it:
measured, the pointer-lock notice ended the lock one millisecond after it began. So each notice
is loaded while detached and attached only once it has loaded.

## Alternatives considered

**Keep both denied.** Games and viewers break on every site, and the deny protects against
nothing the click requirement and the browser-handled Escape do not already cover.

**Ask per site.** A prompt before a game can capture the mouse is a question no other browser
asks, and the thing it would guard against is already answered by a notice and a key the page
cannot intercept.

**Allow only keyboard locks that leave Escape free.** Not possible here: the request the gate
sees carries no key list, so it cannot tell a lock that takes Escape from one that does not.

## Reasoning

Both pass on ground 1(b) of the gate's rule (`docs/open-questions.md` A202): the platform gates
the power on something the person does, and the shell draws the affordance that answers its one
abuse. Pointer lock needs a click, and Escape, handled in the browser process, always releases
it. Keyboard lock only acts in fullscreen, which itself needs a click (`ADR-0025`), and holding
Escape still leaves. The abuse of each, leaving the person unsure how to get their cursor or
window back, is what the notices say.

## Consequences

- Pointer capture works in every page after a click; a fullscreen page can hold the keyboard,
  Escape included, until the person holds Escape.
- In fullscreen, Escape releases the pointer and leaves fullscreen together, so the fullscreen
  notice covers it and no pointer-lock notice is shown.
- `web-context-host.ts`'s deny-everything handlers keep both away from `ADR-0019` isolated
  contexts, as they do the other names the gate allows.
- The argument rests on upstream behaviour: the click requirement for pointer lock, Escape in the
  browser process, keyboard lock acting only in fullscreen, and the held-Escape exit.
  `test/e2e-site-permissions.test.ts` asserts the keyboard half against the real shell (one
  Escape reaches the page, holding it leaves) and the pointer half where the test display can
  give the window focus.

## Reversibility

- **Cost to reverse:** cheap. Two names leave a set and the notices go unused. Nothing is
  persisted.
- **What would make us revisit:** Chromium dropping the click requirement for pointer lock;
  Escape ceasing to be handled in the browser process; keyboard lock applying outside
  fullscreen; or an abuse the notices do not answer.
