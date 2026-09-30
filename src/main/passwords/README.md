# `src/main/passwords/`: the saved-login store and the form watcher that feeds it

**What lives here.** `install-form-watch.ts`, the installer `../shell/shell-installers.ts` runs at start. It is empty until the feature that fills it lands.

**What it depends on.** `electron` (types), [`../shell/`](../shell/) (`ShellInstaller`, `ShellServices`).

**What it must never import.** [`../shell/tabs.ts`](../shell/tabs.ts) or [`../shell/tab-view.ts`](../shell/tab-view.ts). A saved password is never handed to a page through a channel a page can call.

**Owner stream.** `shell`.

**Electron dependence.** Installers are tied to Electron; the store and its helpers import no `electron`.
