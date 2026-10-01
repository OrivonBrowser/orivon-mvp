# `src/main/autofill/`: saved postal addresses and the chooser that fills a form from them

**What lives here.** `install-autofill.ts`, the installer `../shell/shell-installers.ts` runs at start. It is empty until the feature that fills it lands.

**What it depends on.** `electron` (types), [`../shell/`](../shell/) (`ShellInstaller`, `ShellServices`).

**What it must never import.** [`../shell/tabs.ts`](../shell/tabs.ts) or [`../shell/tab-view.ts`](../shell/tab-view.ts).

**Owner stream.** `shell`.

**Electron dependence.** Installers are tied to Electron; the store and its helpers import no `electron`.
