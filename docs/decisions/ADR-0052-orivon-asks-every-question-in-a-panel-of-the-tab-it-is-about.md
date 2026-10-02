# ADR-0052: Orivon asks every question in a panel of the tab it is about, across the toolbar line

- **Status:** proposed
- **Date:** 2026-10-02
- **Type:** security
- **Decided by:** AI recommendation accepted by default

## Decision

A question the browser puts to the person (a grant, an install, an update, an external link, the
developer-tools warning, an extension install, a refused pick) is drawn in a **question panel** in the
window of the tab it belongs to, never in a native message box. The panel is an overlay (`ADR-0048`)
with one ask function, `askQuestion(target, spec, options)` in `src/main/shell/question/`, which
resolves in the shape of Electron's message box so a call site changes one call.

The panel is safe to trust because of rules main enforces and the page of the panel cannot change:

- **It crosses the toolbar line.** It hangs from the address pill with its top edge inside the toolbar,
  where a page can never draw, so a page-drawn copy cannot sit flush against the same edge. A consent
  question waits for the toolbar to be in view (asking a page that holds the whole screen to let go
  first) and ends as a cancel after five seconds; a kiosk, which has no toolbar, draws the panel centred.
- **It belongs to one tab.** It is shown while its tab is in front, waits for the tab when it is not,
  hides on a tab switch and ends as a cancel when the tab or window closes, the queue is full, an abort
  signal fires or (for a question about a link or a tool) the page navigates. A call with no tab goes to the tab
  in front of the focused shell window; a native box is the fallback only when no shell window exists.
- **Words come from main.** The page of the panel is told a random id and nothing it could be made to
  restate; the spec, its buttons, which of them are guarded and what a way out answers are held in main.
  Page-supplied text is cleaned of control and bidirectional characters and cut before it is drawn.
- **An accepting button ignores the person for 500 ms** after every show, counted in main from the moment
  the page reports it drawn. Focus starts on the panel itself, so Enter accepts nothing. Escape answers
  the way out.
- **The page that asked is held while its consent question is open.** Its main-frame navigations,
  redirects and `window.open` are dropped and logged (`src/main/shell/navigation-hold.ts`), so the answer
  applies to the page asked about, and on a first visit the tab is not rebuilt as the app before the
  person has said yes.

A page's own questions go through the same panel, and the mechanism is part of this decision:

- **A page's `alert`, `confirm` and `prompt` are asked in the panel.** The tab's preload wraps the three
  functions (a `Proxy` over the native ones, so `toString`, `name` and the property's descriptor read as the
  page expects) and blocks on a synchronous send; main sets the reply when the person has answered, which
  Electron allows to come later (`src/preload/page-dialogs.ts`, `src/main/shell/page-dialogs.ts`). The
  panel is headed with the frame's own origin, read in main from the committed frame and never from the page:
  "<origin> says", and "An embedded page on <origin> says" for a frame inside the page. It offers OK and
  Cancel only, in a style a grant never has, and the text is cleaned and cut like any page text. Every path
  out replies: a navigation of the tab, a closed tab or window, a crashed page and a refused call each give
  the page what a dismissed dialog gives. After a document's second dialog the next one offers "Do not let
  this page show more dialogs", and once ticked the rest are answered at once until the next page.
- **A tab's preloads run in its subframes and give them only that wrapper.** This is what lets a frame's
  own dialog reach the panel under its own origin. Every tab preload asks `src/preload/frame.ts` first, and a
  subframe installs no `window.orivon`, no routed network and nothing else; a preload that cannot tell which
  frame it is in counts as a subframe. The tab's `disableDialogs` answers at once a dialog in a frame the
  preload never reached (a frame created blank), so Electron's native box is never drawn for a tab.
- **A page that is blocked on its own dialog is not reported as unresponsive.** The renderer cannot
  answer input while it waits, and the browser would otherwise offer the person the sad-tab card for a page
  that is waiting on them.
- **A page's `beforeunload` guard is asked in the panel, and the page stays meanwhile.** Electron settles an
  unload from the event itself and cannot be told later, so the page is kept (Stay is the default and the
  way out), the question is asked, and "Leave" lets the next attempt through unasked, for twenty seconds.
  A navigation the shell started (the address bar, back, forward, reload) is run again at once on Leave. One
  the page started (a link, a script) is not known at that event, so the person repeats it.

A native box remains for the OS file and folder pickers, which are not questions, and for a failure
before any window exists. `npm run check:native-dialogs` fails the build on a message box anywhere else.

## Context

Every question was a `dialog.showMessageBox`: a separate OS window with no tab to belong to, parented to
whichever window the OS chose (or none), unable to wait for a background tab, and impossible to tell from
one a page had provoked. The synchronous forms froze the whole main process while open, and the tests
could only replace the call, not press anything. The `-prompt.ts` suffix (`ADR-0023`) named a native
dialog; it now names the file that asks through the panel.

## Alternatives considered

- **Keep native boxes, parented to the tab's window.** No new surface. It cannot wait for a tab, cannot be
  withdrawn when a call times out, blocks nothing but is a window of its own that a person cannot tie to a
  page, and the specs can never press it. Parenting by the focused window does not work either: shell
  windows are `BaseWindow`s, which `BrowserWindow.getFocusedWindow()` never returns.
- **A page-drawn modal in the tab's own view.** One less overlay. A hostile page could draw the same
  thing, and nothing about it would say which is which.
- **Electron's native dialog for a page's own `alert` and `confirm`, with `prompt()` returning null.** No
  work, and a page's dialog is then the one question the browser cannot place, withdraw or tell from a
  look-alike. Electron offers no hook to supply a prompt, and the private `-run-dialog` event in its binary
  is not an interface.
- **The tab's `safeDialogs` or `disableDialogs` alone.** Both are settings of the whole tab, not of a frame,
  so a frame cannot be given the panel while the main page keeps the native box. `disableDialogs` is kept as
  the backstop for frames the wrapper does not reach, which answer at once as a dismissed dialog does.
- **A separate window per question.** Keeps the isolation of a native box and adds a surface with its own
  `webPreferences` to defend, and the same problem of belonging to no tab.

## Reasoning

The one thing a page cannot do is draw above the toolbar. A panel whose top edge is on the toolbar shows,
by where it is, that the browser asked. Everything else a native box gave (a button the person must
choose, a way out that means no) is rebuilt as rules main enforces. One ask function means the spoofing,
rushing and stacking defences exist once and are tested once.

## Consequences

- A question for a background tab waits for its tab with no sign on the tab strip (open question A340).
- A person can use the address bar while a question is open: the question is tab-modal, not window-modal.
  A question about a link ends when the tab gets a new page. A consent question stays up, and the page's own
  navigations are dropped meanwhile; if the person moved the tab elsewhere, the answer is dropped (nothing
  is granted, nothing recorded as declined, and the tab is not reloaded) because the tab is no longer on the
  origin that was asked about. A server redirect that follows a navigation the person started in that
  tab while a consent question is open is dropped too.
- Every call site's tests replace `askQuestion` with a function; none replaces `dialog`.
- While a page's dialog is open its renderer is blocked, as it is behind a native box, so every tab that
  shares that renderer process waits too. The panel for a tab in the background waits for its tab.
- `nodeIntegrationInSubFrames` is on for every tab. The preloads give a subframe nothing beyond the dialog
  wrapper, and `src/preload/tests/frame-gate.test.ts` fails a subframe that gains more. The editing rule
  that blocks the flag (`.claude/hookify.electron-webprefs.local.md`) still lists it (A341).
- A person who stays on a page that asked to be kept must click its link again after choosing Leave: the
  destination of a navigation the page started is not known at the event that asks.
- A change to `src/main/shell/question/` is reviewed as a change to the consent surface of every grant.

## Reversibility

- **Cost to reverse:** moderate
- **What would make us revisit:** a measured case of a page drawing above the toolbar line, or a platform
  where the overlay cannot be put over the chrome view.
