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
  signal fires or (for a question about a page) the page navigates. A call with no tab goes to the tab
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
  A question about a link ends when the tab gets a new page; a consent question stays, and the page's own
  navigations are dropped meanwhile. A server redirect that follows a navigation the person started in that
  tab while a consent question is open is dropped too.
- Every call site's tests replace `askQuestion` with a function; none replaces `dialog`.
- A change to `src/main/shell/question/` is reviewed as a change to the consent surface of every grant.

## Reversibility

- **Cost to reverse:** moderate
- **What would make us revisit:** a measured case of a page drawing above the toolbar line, or a platform
  where the overlay cannot be put over the chrome view.
