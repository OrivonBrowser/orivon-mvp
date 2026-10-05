# `src/main/display-capture/`: sharing a screen, a window or a tab

**What lives here.** Screen sharing for a page in a tab, website or registered app
([ADR-0055](../../../docs/decisions/ADR-0055-a-page-shares-a-screen-only-through-orivon-s-picker-and-only-by-a-call-orivon-makes.md)):
the gate that grants a capture only to the call Orivon's preload makes after the person picked, the picker, and what
the window shows while a share runs.

| File | Job |
|---|---|
| `types.ts` | Pure: the shapes the gate, the picker, the indicators and the app media grants share |
| `bindings.ts` | Where the gate finds the picker, the app media grants and the share registry; each refuses until bound |
| `install-display-capture.ts` | The shell installer: binds the picker the gate asks, and starts what draws a running share |
| `picker/` | The picker: `choose-display-source.ts` (the `ChooseDisplaySource` the gate asks), the `screen-share-picker` overlay (`picker-overlay.ts` with its pure model, view, tab list, source feed and store), the real wiring (`picker-real.ts`, `picker-platform.ts`) and the test build's `dev-choose.ts` |
| `indicators/` | What shows while a share runs: the sharing bar overlay (`sharing-bar.ts`), the sentences (`shares.ts`), one subscription to the bound registry (`share-events.ts`). The tab badges and the address-bar chip read the registry through `../shell/signals/sharing.ts` and `../shell/state/sharing.ts` |

**What it depends on.** `electron`, [`../sessions/`](../sessions/) (the permission gate and its per-site asker
registry), [`../site-settings/`](../site-settings/) (the `screenShare` kind, the stored block, `isAppOrigin`),
[`../overlays/`](../overlays/) (the picker and the bar), [`../shell/`](../shell/) (the windows, tabs and tab
signals), [`../consent/grant-prompt-origin.ts`](../consent/grant-prompt-origin.ts) (how a site is written for the person) and [`../memory-saver/media-in-use.ts`](../memory-saver/media-in-use.ts).

**What it must never import.** The renderer, or the rest of [`../consent/`](../consent/) directly: an app's media grants reach
the gate through `bindings.ts`, bound by the app door's installer.

**Owner stream.** `shell`.

**Electron dependence.** Tied to Electron. `types.ts`, `bindings.ts` and the ticket rules are pure and tested with
fakes.
