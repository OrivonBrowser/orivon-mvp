# `src/main/passwords/`: the saved-login store and the form watcher that feeds it

**What lives here.** The contract the rest of the shell uses for saved logins (`vault.ts`, with an in-memory store
that keeps it, and `generate-password.ts`) and everything that turns a page's sign-in form into a saved login and
a filled one:

| File | Job |
|---|---|
| `form-message.ts`, `form-watch-ipc.ts` | what a tab's watcher may say (validated, bounded, rate limited) and the one listener that hears it; `formWatch.on(type, handler)` is the dispatcher other form features subscribe to, `fillFrame` the only way a value reaches a page |
| `save-offer.ts` | pure: whether a submitted sign-in worked (`judge`) and what offering it would do (`classify`) |
| `window-forms.ts`, `forms-registry.ts` | per window: which tab has a password field, each tab's pending credential and its timers, what the password button and the chooser may show |
| `password-overlays.ts` | the save prompt |
| `chooser-overlays.ts`, `suggest-keys.ts`, `field-anchor.ts` | the chooser under the password button, and under a focused box with the keys main routes to it |
| `fill-login.ts` | fills a chosen login or a generated password, only while the page is still at the login's origin |
| `logins-state.ts`, `passwords-key-action.ts` | `ShellState.logins` for the address bar's password button, and the button's click |
| `install-form-watch.ts` | the installer `../shell/shell-installers.ts` runs at start: the channel, the navigations, the settings and vault changes |

The watcher itself is [`../../preload/form-watch.ts`](../../preload/form-watch.ts); the two overlay pages are
[`../../renderer/overlay/password-save/`](../../renderer/overlay/password-save/) and
[`../../renderer/overlay/password-fill/`](../../renderer/overlay/password-fill/).

**What it depends on.** `electron` (types, and `ipcMain` in the installer), [`../shell/`](../shell/)
(`ShellInstaller`, `ShellServices`, `WindowRegistry`, `ShellStatePart`), [`../overlays/`](../overlays/) (overlay
definitions and `requestSlot`), [`../../broker/policy/origin.ts`](../../broker/policy/origin.ts).

**What it must never import.** [`../shell/tabs.ts`](../shell/tabs.ts) or [`../shell/tab-view.ts`](../shell/tab-view.ts).
A saved password is never handed to a page through a channel a page can call.

**Owner stream.** `shell`.

**Electron dependence.** Installers and overlay definitions are tied to Electron; the store, the decisions
(`save-offer.ts`, `suggest-keys.ts`, `field-anchor.ts`, `form-message.ts`) and the per-window state import no `electron` value.

## Design notes

**No page-visible API, and a fill only after a choice.** The watcher exposes nothing to the page's main world and
stays inert until main says the vault can keep logins and a setting is on. A fill starts only from a request of
Orivon's own chooser, and `fillFrame` sends it only while the tab's top frame is still at the origin the login
belongs to, so a page that navigates between the choice and the fill receives nothing. Only the top frame of a tab
is watched: a frame has no watcher, and a message from one is ignored.

**A sign-in is offered once it worked.** The submit proves nothing, so the credential waits (in memory, at most five
minutes) for the tab's next move: a navigation with an error status, a page that asks for a password again, or
another site drops it; a page that no longer has a password field offers it. A typed-in form the person leaves
without submitting is never reported.

**The chooser under a box never has the keyboard.** The person is typing in the page, so main reads the arrow
keys, Enter (only with a row chosen) and Escape from the tab's input before the page does
(`before-input-event`) and tells the chooser which row is chosen. A click on a row reaches it without moving focus.
