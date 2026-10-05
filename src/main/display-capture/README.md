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
| `bindings.ts` | Where the gate finds the picker, the app media grants and the share registry; each refuses until bound |

**What it depends on.** `electron`, [`../sessions/`](../sessions/) (the permission gate and its per-site asker
registry), [`../site-settings/`](../site-settings/) (the `screenShare` kind, the stored block, `isAppOrigin`),
[`../overlays/`](../overlays/) (the picker and the bar), [`../shell/`](../shell/) (the windows, tabs and tab
signals) and [`../memory-saver/media-in-use.ts`](../memory-saver/media-in-use.ts).

**What it must never import.** The renderer, or [`../consent/`](../consent/) directly: an app's media grants reach
the gate through `bindings.ts`, bound by the app door's installer.

**Owner stream.** `shell`.

**Electron dependence.** Tied to Electron. `types.ts`, `bindings.ts` and the ticket rules are pure and tested with
fakes.
