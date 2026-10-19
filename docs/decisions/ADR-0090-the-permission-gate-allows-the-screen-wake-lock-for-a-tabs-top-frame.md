# ADR-0090: The permission gate allows the screen wake lock for a tab's top frame

- **Status:** accepted, provisional until the owner has seen a lock held on a real desktop
- **Date:** 2026-10-19
- **Type:** security
- **Decided by:** AI recommendation accepted by default

## Decision

The permission gate answers `screen-wake-lock`, on the request handler and on the check handler, with
yes for the top frame of an ordinary tab (a website's or an installed app's) and no for anything else:
an embedded frame, an extension's page, a shell view, an embed. It never asks. `system-wake-lock`, the
name Chromium uses for keeping the machine awake with no page showing, stays denied. The answer comes
from a per-site asker (`src/main/sessions/wake-lock-asker.ts`), the registry `site-asks.ts` describes,
because the decision needs the contents to be a tab and `allowed-permissions.ts` sees only a name and
its details.

The tab's preload (`src/preload/page-visibility.ts`) releases every screen lock its page holds when the
shell reports the tab hidden (behind another tab, or its window minimised or hidden), and refuses a
request made while hidden with `NotAllowedError`, as the platform does for a hidden document. The page
asks again when it turns visible, as the Screen Wake Lock specification has it.

## Context

Every `navigator.wakeLock.request('screen')` failed with `NotAllowedError`, in an app's tab and in a
website's alike (measured on Electron 44 under the e2e harness): the gate's deny-by-default answers
any name not in `ALLOWED_PERMISSIONS`, and Electron 44 does name `screen-wake-lock` and
`system-wake-lock` in its typings for both handlers. So nothing could keep the screen on during a
video or a call: the wake locks of FreeTube, Element, Ledger Wallet and WebTorrent, and the
`powerSaveBlocker` of the `electron` shim (`src/shim-electron/power-save-blocker.ts`), were all
refused. Two specs accepted the refusal (`wake-lock-request-settles` passes on a refusal; the
`powerSaveBlocker` spec tolerated one), which is why nothing caught it.

Measured with the gate allowing the name:

- The request is granted with no prompt; the sentinel's `type` is `screen` and it stays held until the
  page releases it.
- A page that is not a secure context has no `navigator.wakeLock` at all (an `http` origin that is not
  loopback: `isSecureContext` false, the property absent).
- **Electron never marks a tab behind another as hidden, so Chromium does not release its lock.** The
  tab bar takes a background tab off its window, and the view keeps reading `visible` to Chromium
  (the same fact `src/main/shell/tab-visibility.ts` opens with). A lock held by the tab in back was
  still held eight seconds after another tab came to the front. The page's own `visibilityState`
  reads `hidden` there, because the preload says so, but Chromium's release works from its own
  state, not from that getter.

## Alternatives considered

**Keep it denied.** Every video and call app then leaves the screen to the system's idle timer, and
the `powerSaveBlocker` shim is a no-op that logs a warning. The deny protects against battery use by a
page the person is looking at, which every other browser accepts without a prompt.

**Allow the name in `ALLOWED_PERMISSIONS`, for every page and frame.** That is the shape the other
allowed names have, and the first plan. It fails the rule that file states: the web platform's own
gating is what makes a name safe, and here that gating does not hold, because Chromium releases a lock
when its page is hidden and Chromium is never told a background tab is. A page could keep the screen
on from behind a tab the person had stopped looking at, with nothing on screen saying so.

**Ask the person per site.** A question no other browser asks for a power that costs a little battery
while the page shows. It would also turn the video call that has just started into a prompt.

**Allow embedded frames too.** A lock held by a frame is not released by the preload, which runs in
the top frame alone, so a page would only need to put the request in a cross-origin frame to keep the
lock from behind a tab. The cost of refusing is a widget in an iframe (a call embedded in a page) that
cannot keep the screen on; the top frame of the same app can.

**Allow `system-wake-lock`.** It keeps the machine awake whatever is on screen and has no visibility or
secure-context gate in the web platform at all. Nothing an app counts on needs it.

## Reasoning

The name passes on ground 1(b) of the gate's rule (`src/main/sessions/README.md`): the platform gates
the power, and the shell answers its one abuse. The platform gates it on a secure context and on a
visible document, and a page may hold it only while it is on screen. The abuse is a page using
battery while shown, which a person sees and closes; a lock that outlived the page being shown would
be the abuse the gate must not allow, and the release in the preload is how the shell answers it,
because Chromium cannot. The release does what the specification says happens on a hidden document,
so a page written for any browser behaves the same here.

The rule has one more clause than the other names: the answer depends on the contents, so the asker
owns it, and a name an asker owns falls through to deny for contents it does not know.

## Consequences

- A page in front can keep the screen on; when its tab goes behind another, or the window is
  minimised or hidden, the lock ends and the page's `release` event fires. A page that wants the lock
  back asks again on `visibilitychange`, as the `powerSaveBlocker` shim does.
- The preload replaces `WakeLock.prototype.request` on a tab's page, with the browser's own
  descriptor shape and name, in the way it replaces the visibility getters (`page-visibility.ts`).
  A page that reads `String(WakeLock.prototype.request)` sees a function that is not native, as
  with any wrapper.
- An embedded frame, an extension's page and a shell view cannot take the lock. A call widget in an
  iframe cannot keep the screen on; it can ask its host page to. Widening this is cheap once the
  release reaches frames.
- **Residual:** the release is the page's own wrapper, so a hostile page can step round it: a same-origin
  frame is another realm with the browser's own `request`, which it can call on the page's
  `navigator.wakeLock`. The lock it takes is then not released when the tab goes behind another, and the
  screen stays on until the tab closes. Nothing leaves the machine and nothing is read; the cost is the
  screen and battery. A video playing in a tab behind another already keeps the screen on in the same
  way, because Chromium is never told the tab is hidden. Closing it needs either Electron reporting a
  hidden tab as hidden or a release from the main process.
- The lock keeps the screen on and nothing in the shell says so. The tab strip draws no indicator,
  and Chromium shows none either.
- The argument rests on upstream behaviour: the secure-context attribute of the API, the release on a
  hidden page, the absence of a prompt for `screen-wake-lock`, and Electron's never hiding a tab behind
  another. `test/app-behaviours/e2e-app-wake-lock.test.ts` asserts the grant for an app tab and a
  website tab, the missing API outside a secure context, the refusal in an embedded frame and the
  release behind another tab, against the real shell. Only a real desktop can show that Chromium
  releases the lock for a minimised window of its own accord; the preload's release covers that
  case too.

## Reversibility

- **Cost to reverse:** cheap. The asker is removed from the installer and the gate denies the name
  again; the preload wrapper is inert without a grant. Nothing is persisted.
- **What would make us revisit:** Electron marking views hidden when they are taken off their window
  (the preload release then duplicates Chromium's own and can go); a page found to hold a lock the
  preload did not release; a subframe release path that makes embedded frames safe to allow; or a
  need for `system-wake-lock`.
