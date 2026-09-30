# `src/main/passwords/`: the saved-login store, its Settings domain, and the form watcher that feeds it

**What lives here.** `vault.ts` is what the rest of the shell may ask of the store (`PasswordVault`) and an in-memory
implementation of it. `encrypted-vault.ts` is the store on disk: `passwords.json`, each password encrypted by the
system keyring through `safeStorage`, origins and usernames in the clear. `open-vault.ts` chooses the store for this
run; `dev-password-storage.ts` is the test build's stand-in keyring. `passwords-file.ts` holds the file's shape and
limits, `passwords-csv.ts` and `passwords-transfer.ts` the CSV import and export, `passwords-domain.ts` what the
Settings page may ask (`passwords-runner.ts` builds its Electron side), and `secret-clipboard.ts` copying a password
and removing it a minute later. `generate-password.ts` makes a password. The rest turns a page's sign-in form into a
saved login and a filled one:

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

**What it depends on.** `electron` (types, `ipcMain` in the installer, and `safeStorage` and the clipboard in `passwords-runner.ts` alone),
[`../keyring/seed-store.ts`](../keyring/seed-store.ts) (`SafeStorageLike` and its rule for which backends are real),
[`../shell/`](../shell/) (`ShellInstaller`, `ShellServices`, `WindowRegistry`, `ShellStatePart`, file dialogs),
[`../overlays/`](../overlays/) (overlay definitions and `requestSlot`), [`../pages/`](../pages/) (the domain type),
[`../../broker/policy/origin.ts`](../../broker/policy/origin.ts).

**What it must never import.** [`../shell/tabs.ts`](../shell/tabs.ts) or [`../shell/tab-view.ts`](../shell/tab-view.ts).
A saved password is never handed to a page through a channel a page can call.

**Owner stream.** `shell`.

**Electron dependence.** Installers, overlay definitions and `passwords-runner.ts` are tied to Electron; the store, the decisions
(`save-offer.ts`, `suggest-keys.ts`, `field-anchor.ts`, `form-message.ts`) and the per-window state import no `electron` value.

## Design notes

**The store refuses instead of falling back.** Without a real keyring behind `safeStorage` (`basic_text` or `unknown`,
the rule the identity seed uses), in a private window, and with a file this build cannot read, `state()` is not `ready`
and nothing is written: a password stored under a key that sits beside the file protects nothing, and overwriting a
file that may hold real passwords is worse than not saving. A file with some invalid entries is used without them, and
the file they came from is kept beside it as `passwords.json.invalid` before the first write.

**Usernames are stored in the clear** so the list can be drawn without a keyring round trip (and without an unlock
prompt). Only the password is a secret; a password never appears in a list reply, a log line, or a message to a page
other than the answer to `reveal`.

**Changes made in one turn share one write**, and every caller learns whether it landed, so importing a few thousand
rows costs a write per batch instead of one per row.

**Revealing is a two-step click** because Electron offers no cross-platform re-authentication to gate it with; the page
hides a shown password after a time that main reports, so a test build can shorten it.

**The exported file is plain text by nature.** The page asks for a second click before the save dialog, the domain
refuses an export that does not say it was asked, the file is created readable by its owner alone, and the page says it
is unencrypted afterwards.

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
