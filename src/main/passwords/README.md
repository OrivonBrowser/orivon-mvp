# `src/main/passwords/`: the saved-login store, its Settings domain, and the form watcher that feeds it

**What lives here.** `vault.ts` is what the rest of the shell may ask of the store (`PasswordVault`) and an in-memory
implementation of it. `encrypted-vault.ts` is the store on disk: `passwords.json`, each password encrypted by the
system keyring through `safeStorage`, origins and usernames in the clear. `open-vault.ts` chooses the store for this
run; `dev-password-storage.ts` is the test build's stand-in keyring. `passwords-file.ts` holds the file's shape and
limits, `passwords-csv.ts` and `passwords-transfer.ts` the CSV import and export, `passwords-domain.ts` what the
Settings page may ask (`passwords-runner.ts` builds its Electron side), and `secret-clipboard.ts` copying a password
and removing it a minute later. `generate-password.ts` makes a password. `install-form-watch.ts` is the installer
`../shell/shell-installers.ts` runs at start; it is empty until the feature that fills it lands.

**What it depends on.** `electron` (types, and `safeStorage` and the clipboard in `passwords-runner.ts` alone),
[`../keyring/seed-store.ts`](../keyring/seed-store.ts) (`SafeStorageLike` and its rule for which backends are real),
[`../shell/`](../shell/) (`ShellInstaller`, `ShellServices`, file dialogs), [`../pages/`](../pages/) (the domain type).

**What it must never import.** [`../shell/tabs.ts`](../shell/tabs.ts) or [`../shell/tab-view.ts`](../shell/tab-view.ts),
and nothing from [`../../broker/`](../../broker/) beyond the origin and atomic-write helpers. A saved password is never
handed to a page through a channel a page can call.

**Owner stream.** `shell`.

**Electron dependence.** Installers and `passwords-runner.ts` are tied to Electron; the store and its helpers import no `electron`.

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
