# `src/main/display-capture/`: sharing a screen, a window or a tab

**What lives here.** Screen sharing for a page in a tab, website or registered app
([ADR-0055](../../../docs/decisions/ADR-0055-a-page-shares-a-screen-only-through-orivon-s-picker-and-only-by-a-call-orivon-makes.md)):
the gate that grants a capture only to the call Orivon's preload makes after the person picked, the picker, and what
the window shows while a share runs.

| File | Job |
|---|---|
| `types.ts` | Pure: the shapes the gate, the picker, the indicators and the app media grants share |
| `display-tickets.ts` | Pure: the one-shot ticket per frame that tells the gate which `media` request with no device type is the call Orivon's preload made after the pick; holds requests, allows exactly one, denies the rest |
| `display-asker.ts` | The per-site asker that owns the `media` request with no device type, grants it only against a ticket, answers the `display-capture` check, and after a grant makes sure the display handler took the choice |
| `end-unexpected-capture.ts` | The backstop for a grant that reached no display handler: reloads the tab and logs |
| `frame-key.ts` | The ticket key of a tab's top frame |
| `display-policy.ts` | Pure: whether a page may be shown the picker (a website unless blocked, an app with its `media.screen` grant) |
| `display-gate.ts` | Pure: from the page's pick to the ticket: who asked, one picker per tab, fresh activation after a refusal, the picker, the arm and called steps |
| `display-ipc.ts` | The tab preload's channels, read strictly: the sender is a tab's top frame, the payload has exactly its keys |
| `display-handler.ts` | What the session's display handler answers: the ticket's choice as Electron's streams; starts the share |
| `share-registry.ts` | The running shares: starts on the display handler's answer, ends on the tracks, the requester's page or the shown tab, and Stop |
| `install-display-capture.ts` | Wires the above into the shell: the asker (added first), the handler, the channels, the registry, the page's lifecycle |
| `bindings.ts` | Where the gate finds the picker, the app media grants and the share registry; each refuses until bound |
| `install-display-ui.ts` | The shell installer for the picker and the indicators: binds the picker the gate asks, and starts what draws a running share |
| `picker/` | The picker: `choose-display-source.ts` (the `ChooseDisplaySource` the gate asks), the `screen-share-picker` overlay (`picker-overlay.ts` with its pure model, view, tab list, source feed and store), the real wiring (`picker-real.ts`, `picker-platform.ts`) and the test build's `dev-choose.ts` |
| `indicators/` | What shows while a share runs: the sharing bar overlay (`sharing-bar.ts`), the sentences (`shares.ts`), one subscription to the bound registry (`share-events.ts`). The tab badges and the address-bar chip read the registry through `../shell/signals/sharing.ts` and `../shell/state/sharing.ts` |

**What it depends on.** `electron`, [`../channels.ts`](../channels.ts), [`../dev/dev-display-chooser.ts`](../dev/dev-display-chooser.ts) (the test-only picker the installer exposes in an e2e build), [`../sessions/`](../sessions/) (the permission gate and its per-site asker
registry), [`../site-settings/`](../site-settings/) (the `screenShare` kind, the stored block, `isAppOrigin`),
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

**A grant the display handler did not follow ends the page's document.** The display handler runs inside the call that
grants the request, so a ticket still waiting for it right after the grant means the granted request was not a display
request. `end-unexpected-capture.ts` reloads the tab: provisional, and ending the page's renderer instead is the open
alternative.

**A tab that is not showing in a window cannot be shared.** Chromium refuses to capture the view of a background tab and the
page's call fails with `AbortError`; the preload tells main when its call failed after the display handler answered, so the
registry never keeps a share that has no track. The gate does not check that a picked tab is showing: the picker has to
offer only tabs that are.

**The permission check names the page as its own embedder.** Electron sets `embeddingOrigin` for a top frame too, so only an
embedder that is a different origin refuses the `display-capture` check.

**A tab share's end is read from `isBeingCaptured()` and from the tracks the preload reports.** A browser under automation
that records its views (Playwright's screencast) keeps `isBeingCaptured()` true, so the end-to-end spec proves the share's
end through the preload's report; the registry's own poll is unit-tested.
