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
| `install-site-permissions.ts`, `install-content-settings.ts` | the installers `../shell/shell-installers.ts` runs at start: the permission asker, and the content settings below |
| `popup-policy.ts`, `tab-interaction.ts`, `popup-blocks.ts`, `popup-blocker.ts`, `site-popups.ts` | the pop-up blocker: the rule (pure), when the person last clicked or pressed a key in each tab, what each page tried to open, the join of the three, and the process-wide instance `shell/tab-view.ts` asks from the window-open handler |
| `popups-overlay.ts`, `popups-view.ts` | the `popups-blocked` overlay under the address bar's pop-up chip: the list of refused addresses, opening one on purpose, always allowing the site |
| `content-rules.ts` | pure: which sites have JavaScript, images or sound switched off, and the response header that switches scripts off |
| `site-sound.ts` | `siteSound`, the rule `shell/signals/audio.ts` asks when it decides a tab's mute |
| `auto-downloads.ts` | holds a second download a page starts without a click and asks about it as the `autoDownloads` kind |

**What it depends on.** `electron` (types), [`../shell/`](../shell/) (`ShellInstaller`, `ShellServices`, the
window registry, the prompt anchor, `signals/audio.ts`'s `applyMuted`), [`../privacy/cookie-policy.ts`](../privacy/cookie-policy.ts)
(`topUrlOf`: the page a request belongs to), [`../downloads/`](../downloads/) (`StartInfo`),
[`../sessions/web-request-owner.ts`](../sessions/web-request-owner.ts) (the one owner of the default session's request events), [`../overlays/`](../overlays/) (`requestSlot`),
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

**A pop-up is blocked unless the person's own input opened it.** `HandlerDetails` reports no user gesture, so
`popup-policy.ts` uses the person's input instead: a mouse press, touch or key press in the opener's tab within five
seconds (Chromium's own transient-activation lifetime, so a sign-in popup opened after a short network call still
opens) lets one window through; a second needs a new input. Input a script synthesises with `dispatchEvent` never
reaches the browser process, so it counts for nothing. A registered app, a page that is not `http(s)` and an
extension are outside the rule.

**JavaScript is switched off with a response header, not a view setting.** `webPreferences.javascript` is fixed when a
view is created and a tab outlives its site, so `install-content-settings.ts` adds a second `Content-Security-Policy:
script-src 'none'` header to the page's document and to every frame in it (policies intersect, so it can only remove
what a script may do, and the page's own policy is kept). It covers inline handlers and `javascript:` addresses; it
applies to a response served from the HTTP cache too. A service worker already installed keeps serving, but the page's
scripts do not run. Images are cancelled at the request. Both settings are the top-level site's and take effect on the
next load, in the default session only: a tab in an app's own partition is never touched.

**A site's sound is composed with the tab's mute, never replaced by it.** `mutedFor` in `signals/audio.ts` is the tab's
mute or the site's setting; the tab menu and the speaker badge change the first only. The tab's badge reports a
site-silenced tab as muted by site settings, and does nothing when pressed.

**An automatic download waits by pausing it.** The download service has set the save path by the time `auto-downloads.ts`
hears of a start, so the item is paused rather than deferred; a file small enough to finish before the pause takes
hold is already on disk when the question is answered.
