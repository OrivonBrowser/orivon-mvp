# `src/main/display-capture/`: sharing a screen, a window or a tab

**What lives here.** Screen sharing for a page in a tab, website or registered app
([ADR-0055](../../../docs/decisions/ADR-0055-a-page-shares-a-screen-only-through-orivon-s-picker-and-only-by-a-call-orivon-makes.md)):
the gate that grants a capture only to the call Orivon's preload makes after the person picked, the picker, and what
the window shows while a share runs.

| File | Job |
|---|---|
| `types.ts` | Pure: the shapes the gate, the picker, the indicators and the app media grants share |
| `display-tickets.ts` | Pure: the one-shot ticket per frame that tells the gate which `media` request with no device type is the call Orivon's preload made after the pick; holds requests, allows exactly one, denies the rest, and marks a frame suspect after a request with no ticket |
| `display-asker.ts` | The per-site asker that owns the `media` request with no device type, grants it only against a ticket, answers the `display-capture` check, and after a grant makes sure the display handler took the choice |
| `end-unexpected-capture.ts` | The backstop for a capture that is not the picked one: ends the tab's renderer and logs why |
| `frame-key.ts` | The ticket key of a tab's top frame |
| `display-policy.ts` | Pure: whether a page may be shown the picker (a website unless blocked, an app with its `media.screen` grant; the person's block first for a registered origin that holds no grant) |
| `display-gate.ts` | Pure: from the page's pick to the ticket: who asked, one picker per tab, fresh activation after a refusal (kept across a navigation, for the refused origin), the picker, the arm and called steps |
| `display-ipc.ts` | The tab preload's channels, read strictly: the sender is a tab's top frame, the payload has exactly its keys |
| `display-handler.ts` | What the session's display handler answers: the ticket's choice as Electron's streams; starts the share |
| `share-registry.ts` | The running shares: starts on the display handler's answer (unconfirmed until the preload reports its call received the stream), ends on the tracks of a confirmed share, a failed call, the requester's page, the shown tab's destruction, and Stop; marks a picked tab pending until its share starts |
| `install-display-capture.ts` | Wires the above into the shell: the asker (added first), the handler, the channels, the registry, the page's lifecycle |
| `bindings.ts` | Where the gate finds the picker, the app media grants and the share registry; each refuses until bound |
| `install-display-ui.ts` | The shell installer for the picker and the indicators: binds the picker the gate asks, and starts what draws a running share |
| `picker/` | The picker: `choose-display-source.ts` (the `ChooseDisplaySource` the gate asks), the `screen-share-picker` overlay (`picker-overlay.ts` with its pure model, view, tab list, source feed and store), and the real wiring (`picker-real.ts`, `picker-platform.ts`); the test build's picker is [`../dev/dev-display-chooser.ts`](../dev/dev-display-chooser.ts) |
| `indicators/` | What shows while a share runs: the sharing bar overlay (`sharing-bar.ts`), the sentences (`shares.ts`), one subscription to the bound registry (`share-events.ts`). The tab badges and the address-bar chip read the registry through `../shell/signals/sharing.ts` and `../shell/state/sharing.ts` |

**What it depends on.** `electron`, [`../channels.ts`](../channels.ts), [`../dev/dev-display-chooser.ts`](../dev/dev-display-chooser.ts) (the test-only picker the installer exposes in an e2e build), [`../sessions/`](../sessions/) (the permission gate and its per-site asker
registry), [`../site-settings/`](../site-settings/) (the `screenShare` kind, the stored block, `isAppOrigin` and `isRegisteredAppOrigin`),
[`../overlays/`](../overlays/) (the picker and the bar), [`../shell/`](../shell/) (the windows, tabs and tab
signals), [`../consent/grant-prompt-origin.ts`](../consent/grant-prompt-origin.ts) (how a site is written for the person) and [`../memory-saver/media-in-use.ts`](../memory-saver/media-in-use.ts).

**What it must never import.** The renderer, or the rest of [`../consent/`](../consent/) directly: an app's media grants reach
the gate through `bindings.ts`, bound by the app door's installer in [`../media-grants/`](../media-grants/).

**Owner stream.** `shell`.

**Electron dependence.** Tied to Electron. `types.ts`, `bindings.ts` and the ticket rules are pure and tested with
fakes.

## Design notes

**[`display-tickets.ts`](display-tickets.ts) holds a request until it has heard from the preload, whichever arrives first.** The
preload's `arm` message and Electron's `media` request travel on different paths and can arrive in either order, so a request
is held while a ticket is open and allowed only when the ticket is armed with its nonce, the preload said its call was made,
and no second request arrived for the quiet window after the later of the last request and the called message. A request
that arrived before the arm message is held too, but only if it was within `EARLY_SLACK_MS` of it: the preload's own request
can overtake its arm message by a moment, while a page's request sent earlier cannot be told from it by anything else. Two requests, a wrong nonce, a rejected call, the page ending or the
ticket's timeout deny everything held. A request with no open ticket is refused at once, which is what ends a legacy
`getUserMedia({ chromeMediaSource })` call: Electron gives it the same request as `getDisplayMedia`.

**A share starts unconfirmed, and the preload's report of its own call decides whether the page's renderer ends.** The display
handler runs inside the call that grants the request, so a ticket still waiting for it right after the grant means the granted
request was not a display request, and the asker ends the renderer. A page's own request can also take the preload's ticket:
Blink handles a frame's media requests one at a time, so a native `getDisplayMedia` or legacy `chromeMediaSource` call the
page left pending queues the preload's call behind it, and the ticket then sees one held request, the page's, which is served.
The registry therefore starts every share unconfirmed. The preload sends `received` when its own call resolves and `failed`
(with one of four names) when it rejects. Only a confirmed share is ended by the tracks ending. A `failed` with
`NotAllowedError` for an unconfirmed share means the gate refused the preload's call because another request had taken the
ticket: the stream went to the page, and [`end-unexpected-capture.ts`](end-unexpected-capture.ts) ends the renderer with
`forcefullyCrashRenderer`, however late the report comes (a page that blocks its own thread only delays it). Any other name
(`AbortError`, `NotReadableError`, `NotFoundError`) means the capture could not start, a picked window that closed for one, and
only the share ends. An unconfirmed share keeps its indicator until it is confirmed and then ended, Stop (sent again on
confirming, since the preload has no tracks to stop before), or its requester's document ends, so a busy page cannot make the
bar disappear. A reload would leave the old document running until the new one commits, and the page's server sets how long;
the tab shows the sad-tab card, whose text says only that the page stopped working, and another tab in the same renderer
process can go with it. A `NotAllowedError` that is an honest failure after the handler served (a system permission for the
screen that was withdrawn) takes the same path.

**A request that reaches main with no ticket is refused, and the frame is suspect for a while; it never ends a renderer.** An
extension content script's `getDisplayMedia` runs in its own isolated world and a ported app's callback-form
`navigator.webkitGetUserMedia` can reach main with no ticket, so such a request is no sign of a capture the page was handed.
[`display-tickets.ts`](display-tickets.ts) refuses it, marks the frame suspect for `SUSPECT_MS` (provisional; what settles it
is a measured honest page that this refuses), shows no picker and opens no ticket meanwhile, and voids a ticket whose request
is held while the frame is suspect, since that request may be its twin. A new document committing in the tab forgets the
suspicion, so a reload inside the window is not refused. A ticket that ends without the display handler taking it (two
requests, suspicion, a wrong nonce, the early slack, the timeout) lets go of the picked tab's pending mark through `onEnd`, and
the page's destruction does the same through the gate. The display handler voids the ticket when the granted request names a
frame that is gone or is not the tab's top frame any more, so the asker's check after the grant ends no honest renderer.

**The real call is made in the page's world, so the page's `CaptureController` binds.** A controller binds only to the call that
carries it in its options, and the context bridge cannot hand one to the isolated world. The preload's wrapper therefore builds,
from natives captured before any page script ran, a closure that makes the one native call, and the isolated world starts it in
the step that arms the ticket ([`ADR-0061`](../../../docs/decisions/ADR-0061-the-page-s-share-call-runs-in-its-own-world-so-its-capturecontroller-binds.md)).
What keeps the call Orivon's: the options are a prototype-free copy made when the page calls (arrays carry an iterator of their own),
so converting them runs no page code; the controller is checked by the browser; the native promise is read with the captured
`then` after it was given its own constructor and species, and its failure is named by the captured `DOMException` getters, so a
changed `Promise`, `Error` or `DOMException` forges nothing; the isolated world's verdict returns as the result of a bridge call and
settles the page's promise in the turn the call settled, and a share the isolated world could not confirm has its tracks stopped.
The page's promise is the wrapper's, so `setFocusBehavior` finds its window closed (A407).

**On Wayland the picker lists nothing, and the capture asks the system dialog itself.** The desktop portal restores a pick by a monitor's make, model and serial (a window's by app and title), so two identical monitors are one monitor to it: a listing first would hand the capture a stored pick that restores the first of them, whichever the person chose. Share on a Wayland card therefore answers with a source id from [`picker-model.ts`](picker/picker-model.ts)'s `portalSourceId` that the capture never issued, so no stored pick exists for it and the capture opens its own portal session, in which the person chooses. A screen capture's session lists windows and screens together, so the picker offers one "Window or screen" segment there, and a window-only one when the page asked for no monitors; a window picked in it reaches the page as a `monitor` surface, since the source's type is a screen. Each share takes an id never used before: a reused id could hold the previous share's pick and restore it with no dialog. The page's call resolves at the share's first frame, read by the page's world from a clone of the track that nobody else holds: cancelling in the system dialog, or Stop while it is open, ends the track before any frame and the call is refused with `NotAllowedError` (the clone goes with it, so nothing keeps the capture alive); a processor that fails hands the stream over. A window that never paints keeps the call waiting, as it would keep the person waiting on a picture. The preload also holds a second track on the source for the share's life, stopped when the page's tracks have all ended or on Stop. A source with one track and a page that calls `applyConstraints` with another format is restarted by Chromium into a new capture, and a new capture is a new portal session that restores by identity (the first of two identical monitors, or the dialog again); with two tracks the constraints apply to the live capture and nothing restarts, so the capture keeps its full size and rate for the share's life and each track is scaled to its own. A cancel, a Stop or the source ending still ends the share through the tracks the preload reports.

**A tab that is not showing in a window cannot be shared.** Chromium refuses to capture the view of a background tab and the
page's call fails with `AbortError`; the preload tells main when its call failed after the display handler answered, so the
registry never keeps a share that has no track. The gate does not check that a picked tab is showing: the picker has to
offer only tabs that are.

**A shared tab's page reads visible while another tab is in front.** The shared tab stays attached and keeps painting, so [`../shell/tab-visibility.ts`](../shell/tab-visibility.ts) does not tell its page it is hidden while `forCaptured` lists a share for it, and tells it again when the share ends if the tab is still behind; a minimized or hidden window still reads hidden.

**The permission check names the page as its own embedder.** Electron sets `embeddingOrigin` for a top frame too, so only an
embedder that is a different origin refuses the `display-capture` check.

**A tab share's end is read from `isBeingCaptured()` and from the tracks the preload reports.** A browser under automation
that records its views (Playwright's screencast) keeps `isBeingCaptured()` true, so the end-to-end spec proves the share's
end through the preload's report; the registry's own poll is unit-tested.

**A picked tab stays attached from the pick, not from the share.** The share starts only when the display handler answers,
a moment after the person pressed Share, and a person can leave the picked tab in between; a view taken out of the window
then cannot be captured and the page's call fails with `AbortError`. The gate tells the registry to expect the tab under the
ticket's nonce, [`../shell/tab-panes.ts`](../shell/tab-panes.ts) keeps a pending tab's view in the window, and the mark ends
when the share starts, the call is rejected, the page goes away or the ticket's lifetime is over.

**A shared tab keeps being shared when it loads another document.** Chromium keeps capturing a tab across its navigations
(measured), so the registry watches the shown tab only for its destruction or loss of renderer; the requester's navigation
still ends the share, because the page that holds the tracks is gone.

**A refused page keeps its gesture requirement across a navigation that never commits.** `endForTab` aborts the picker and voids the
ticket but keeps the tab's `needsActivation`, so a download or a 204 cannot reopen the picker in a loop; the refusal holds for
the origin it was made on, so a tab that commits another origin starts fresh.
