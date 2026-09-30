# ADR-0048: Orivon's own overlays share one host and one preload bridge, each view reaching only its own handler

- **Status:** proposed
- **Date:** 2026-09-30
- **Type:** security
- **Decided by:** AI recommendation accepted by default

## Decision

Every panel, bar and sheet Orivon draws above a page (the main menu, the find bar, tab search, the
screenshot sheet, the toast, the sad-tab card, the restore bar) is a `WebContentsView` of its own,
built and owned by **one overlay host per window** (`src/main/overlays/`). All of them load the **one
overlay renderer entry** and the **one sandboxed preload**, `src/preload/overlay.ts`, which exposes
the same small bridge (`ready`, `request`, `size`, `close`, `onEvent`) and nothing else. A feature adds
an `OverlayDef` (a name, a placement, a handler) to a registry and a page to a second registry; it adds
no preload, no IPC channel and no renderer entry.

The bridge is safe to share because of three rules the host enforces, none of which a page can change:

- **A view reaches only the handler of the definition it was built from.** The IPC handler is
  registered on that view's own `webContents.ipc`, and the `OverlayPort` it calls closes over the one
  slot the view belongs to. There is no overlay name in a message for a page to forge.
- **Every call is checked twice in main.** The sender frame must be the view's main frame, and its URL
  must equal, character for character, the address main built for it. The navigation lock refuses to
  ever change that address, and the preload exposes nothing when the document is at any other address.
- **A handler treats its request as untrusted input.** Text a page controls (a tab's title, the
  address a site is at, a search the person typed) reaches an overlay as data to display, and a
  request from the overlay is validated field by field before it does anything; a handler that throws
  is logged in main and the page is told nothing.

## Context

Before this, each popover under the toolbar (permissions and site info) had a preload, an
IPC channel and a renderer entry of its own, each a copy of the same sender check. The next features
(find, tab search, a screenshot sheet, a toast, a crashed-tab card, a restore bar) would have added
six more of each: six preloads to keep in step, six channels whose handlers each had to remember the
check, and a fresh chance in every one to forget it. The overlays also need behaviour that belongs to
no feature: where a view sits, when a tab switch or a resize closes it, where focus goes, and what
happens when its renderer process dies. That behaviour was being copied too.

The text these overlays show is the most page-derived in the shell: tab titles and addresses in tab
search, the page's selection in the find bar, a file name in a toast. An overlay's renderer is
therefore the one place where hostile page text and a privileged main-process handler meet, and the
question is what a compromised overlay renderer could reach.

## Alternatives considered

- **One preload and one IPC channel per popover** (what existed). A compromise of one popover reaches
  only its own channel, which is the real strength of the shape. It lost on cost: every feature repeats
  the sender check and the host behaviour, the copies drift, and the security property depends on each
  author remembering both. One shared bridge makes the check one piece of code with one test.
- **Draw the overlays inside the chrome view**, as regions of it. No new view, no new bridge. It cannot
  be done: the chrome view is exactly as tall as the chrome, Electron honours a transparent view only
  inside a transparent window, which the shell's is not, and the chrome's preload is the most
  privileged in the shell, so page-derived text would be rendered beside its commands.
- **One shared view that swaps its page.** One renderer process instead of several. It loses the
  isolation between overlays (a bar and a popup open at once would share a document), and the
  layering and focus rules differ per overlay.
- **A per-overlay preload that exposes only that overlay's commands.** It keeps the isolation of the
  first option, but it is a file, a build entry and a channel per feature again. The shared bridge gets
  the same isolation from the handler being bound to the view's own `webContents`, with no file to add.

## Reasoning

The bridge carries four verbs and no authority. What a page can do through it is decided by the handler
of the one definition its view was built from, so the security review of an overlay is the review of its
handler's `request` function. Everything else (who may call, from which frame, at which address) is
shared, small and tested once. A feature that cannot add a preload cannot add a wider one.

The host is also where the lifecycle bugs live, and there is one place to fix them: a renderer that
died is rebuilt on the next show, a handler is told when its window goes, events sent before a page is
ready are held and replayed in order, and a blur that arrives inside a native resize is delivered after
it. Copies of that code would each have had the bug.

## Consequences

- An overlay renderer that is compromised can call `request` on its own handler with any payload, and
  nothing else. Each handler must therefore validate every field and never take a path, an address or a
  command id from its page without checking it (the toast's link runs the command of the toast shown,
  never one the page names; the screenshot sheet accepts exactly `{ area, to }`).
- Every overlay shares one renderer bundle, so one overlay's stylesheet or script can affect another's
  page in principle; each page's rules sit under `body[data-overlay='<name>']` and the pages do not
  share state.
- The sad-tab card and the toast run in the shell's own session, where no extension loads, like the
  chrome (`ADR-0041`); an overlay must never be loaded in a tab's session.
- The permissions and site-info popovers stay on their own preloads for now and are handed to the host
  only for layering; they do not gain the shared bridge.
- A change to `src/preload/overlay.ts` is a change to every overlay's authority and is reviewed as one.

## Reversibility

- **Cost to reverse:** moderate
- **What would make us revisit:** an overlay that needs a verb the four do not carry in a way that cannot
  be expressed as a `request` command, or a measured case of one overlay's page reading another's
  document.
