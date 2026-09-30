# `src/main/site-settings/`: what a site may do: per-site permissions, content settings and the prompt that asks

**What lives here.** The per-site permission asker and everything it needs.

| File | What it is |
|---|---|
| `kinds.ts` | `SITE_KINDS`: every kind of thing a site can be asked about or told it may not do, with its label, its setting key and whether a feature enforces it yet |
| `site-settings-store.ts` | `site-settings.json`: the answer (allow or block) per site and kind; a memory-only variant for a private session |
| `electron-names.ts` | pure: Electron's permission names and details to kinds |
| `site-asks-engine.ts` | pure: who may ask, what is remembered, when the person is asked, what the page is told |
| `site-asker.ts` | adapts the engine to the gate's `SiteAsker` |
| `page-access.ts` | per tab, what the current page was asked and answered, for the address bar's chip and its bubble |
| `ask-site.ts` | `askSite(kinds, tab)`: the question under the address bar, through the tab slots; the ask held in main by a random id |
| `site-prompt-overlay.ts`, `site-prompt-text.ts` | the `site-prompt` overlay (the question, and the review bubble under the chip) and the words it shows |
| `install-site-permissions.ts`, `install-content-settings.ts` | the installers `../shell/shell-installers.ts` runs at start; the second is empty until content settings land |

**What it depends on.** `electron` (types), [`../shell/`](../shell/) (`ShellInstaller`, `ShellServices`, the
window registry, the prompt anchor), [`../overlays/`](../overlays/) (`requestSlot`),
[`../sessions/site-asks.ts`](../sessions/site-asks.ts) (the registry the asker joins),
[`../consent/grant-prompt-origin.ts`](../consent/grant-prompt-origin.ts) (how a site is written for the person),
[`../../broker/policy/origin.ts`](../../broker/policy/origin.ts).

**What it must never import.** [`../shell/tabs.ts`](../shell/tabs.ts) or [`../shell/tab-view.ts`](../shell/tab-view.ts): a feature here
reaches tabs through the `ShellServices` and window registry it is handed.

**Owner stream.** `shell`.

**Electron dependence.** The installers, the overlay, `ask-site.ts` and the asker are tied to Electron; the store, the
engine, `electron-names.ts`, `page-access.ts` and the prompt text import no `electron` at runtime.

## Design notes

**One answer per site and kind, asked once.** A main frame on an `http(s)` site that is not a registered app is asked
the first time; Allow and Block are both remembered, and closing the prompt decides nothing (the site may ask again
after the next page load, not before). A frame never asks. A `block` default for a kind refuses without asking.

**The check handler never allows on the person's behalf.** It answers `true` only for a stored allow whose site is the
page's own, and a cross-origin frame (which Electron reports with an `embeddingOrigin`) never borrows its embedder's
answer. It notes the allowance on the page's record so the chip can show it, but writes no store.

**Camera and microphone are one question** when a page asks for both, and each is stored. Chromium reports both plain and
system-exclusive MIDI as `midiSysex`, so that request carries the stronger wording and Allow covers both.

**Location is asked, and answered "unavailable".** Orivon has no location provider, so an allowed page still gets a
position error; the prompt says so before the person allows it.
