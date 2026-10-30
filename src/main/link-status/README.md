# `src/main/link-status/`: where the link under the pointer goes

**What lives here.** The bubble in the bottom corner of a page that says which address the link under the pointer, or
under the keyboard's focus, goes to. `link-status.ts` is its behaviour for one window with no Electron in it (which link,
which corner, when it goes); `bubble-geometry.ts` is where it sits and how wide it may be; `link-status-view.ts` is what
main tells the page and how an address is cut; `link-status-overlay.ts` declares the overlay and checks what its page
sends; `link-status-for.ts` holds each window's one `LinkStatus` and gives it the window's overlay host;
`link-status-signal.ts` is the tab's side, listed in [`../shell/tab-signals.ts`](../shell/tab-signals.ts). The page is
[`../../renderer/overlay/link-status/`](../../renderer/overlay/link-status/).

**Tied to Electron.** `link-status-signal.ts` listens to a `WebContents` (`update-target-url` is its event) and the
overlay is a `WebContentsView` through [`../overlays/`](../overlays/). `link-status.ts`, `bubble-geometry.ts` and
`link-status-view.ts` need nothing of it.

**What it depends on.** [`../overlays/`](../overlays/) (`overlay-types.ts`), [`../../protocols/`](../../protocols/)
(`BUILTIN_ADDRESSES`, to read an address as the address bar does), and [`../shell/`](../shell/) for types only
(`window-registry.ts`, `tab-signals.ts`).

**What it must never import.** The renderer, or a value from the rest of the shell: the shell lists this feature, not the
other way round.

**Owner stream.** `shell`.

## Design notes

**Nothing exists until a link is first pointed at.** `linkStatusFor` makes a window's `LinkStatus` on its first link, and the
host builds the overlay's view and renderer on that first show; a window nobody points a link in carries neither. After that
the view is `resident`: kept, hidden in place, for the life of the window, because a view removed and added back stays hidden
on Electron 44 (see [`../overlays/README.md`](../overlays/README.md)) and because moving across a list of links must create
and destroy nothing. A page that says the pointer left a link before any link was pointed at makes nothing either.

**The page measures, main places.** A view blocks the pointer over its whole rectangle, so a bubble wider than its text would
deaden the links under it. The text goes to the page, which measures it in an element that is never seen and reports the
width with the number of the text it measured; main clamps it (`bubbleWidth`: at most 600 pixels and half the pane) and only
then gives the view its size, so no frame shows a bubble of the wrong size. The view is first shown with no size at all, and
a measurement for an older text is ignored. A new link while a bubble is up swaps the text in place; the bubble is wrong
for the time it takes the page to answer, one round trip.

**It is the corner of the link's own pane.** The rectangle comes from the hovered tab's view, never from the pane in front:
in a split window the pointer is in the pane it hovers, whichever the person last pressed in. A tab that is not on screen
has no rectangle, so it shows nothing.

**Its corners that are not the rounded one are off the window.** A view rounds all four corners or none. The bubble is flush
in the corner of the page, with only the corner away from the edges rounded, so its view reaches `BUBBLE_RADIUS` pixels past
the window at the edges that are the window's (`bubbleInset`) and the page draws its text inside what shows. Where a pane's
edge is a neighbour's, not the window's, the view does not reach into the neighbour, and its corner there is rounded.

**It gets out of the pointer's way by the page's own `pointerenter`, once.** The bubble covers a link in its corner; the
pointer enters it, and the tab's page loses the link (`''` arrives, in either order with the page's message). The bubble takes
the bottom-right corner of the same pane and stays there until it has hidden; when the link is hovered again the same text
arrives and nothing more is done, so it ends steadily on the right. No cursor position is read: `screen.getCursorScreenPoint()`
is unreliable on Wayland, and a per-move listener would cost every mouse move.

**It goes after a short delay, and at once when its tab leaves.** An empty address starts a timer (`HIDE_DELAY_MS`) that a
new address cancels, so the pointer crossing the gap between two links keeps one bubble. A navigation of the tab's own page,
a crashed or destroyed page, a tab switch, a resize or a page holding the whole screen end it at once. The overlay is not
closed by the front tab's address changing: a page that rewrites its address while it scrolls would take the bubble down, the
address may be that of the other pane, and Chromium does not say the link again. An empty address, or a link with no room
to show in, from another pane than the bubble's is not about it.

**A push of the tabs' state is the tick that checks its pane.** A split opening or closing, the panes swapping and a tab going
behind change where the tab's page is, and none of them is a layout change of the window, so the overlay's `layout` close never
fires for them. Each of them pushes the tabs' state, so the signal's `state` hook asks the bubble (`checkPane`) whether its tab's
pane is the rectangle it was made for and still on screen, and it goes when not.

**The address is the address bar's.** The text is `BUILTIN_ADDRESSES.displayUrl` of the link, then cut to `MAX_TEXT_LENGTH`: the
name before an `@` is dropped, so `https://accounts.google.com@evil.example/` reads as `evil.example`, and a link on a site
from IPFS reads as its `ipfs://` address, not the host that serves it. The reading comes first, so a long name before an `@`
cannot push the host out of the cut text.

**The end of the host is never what is cut.** A host is read from its end. Main tells the page the most the bubble may be wide
(`room`); the page fits the text to it with `fitAddress` (in the page's directory), which measures candidates in the page: the
path goes first, then the middle of the host, with the end of the host kept; CSS's ellipsis is left as a last resort for
a measure that differs from the one that fitted.

**It keeps the corner it dodged to for a moment.** The bubble takes the bottom-right corner when the pointer enters it and goes
back to the left when it hides. A pointer that is slow to reach the next link would find the bubble reopened in the corner it
left, and it would flicker between the corners, so a bubble that had dodged keeps the right corner for `SIDE_GRACE_MS` after it
hid.

**What the page sends is untrusted.** The overlay accepts a width (a finite number, whole sequence number) and the pointer
entering, and nothing else.
