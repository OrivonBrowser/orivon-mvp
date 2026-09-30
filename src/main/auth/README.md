# `src/main/auth/`: the sign-in sheets an HTTP server asks for and the certificates a connection shows

**What lives here.** `install-auth.ts`, the installer `../shell/shell-installers.ts` runs at start. It is empty until the feature that fills it lands.

**What it depends on.** `electron` (types), [`../shell/`](../shell/) (`ShellInstaller`, `ShellServices`).

**What it must never import.** [`../shell/tabs.ts`](../shell/tabs.ts) or [`../shell/tab-view.ts`](../shell/tab-view.ts).

**Owner stream.** `shell`.

**Electron dependence.** Installers are tied to Electron; a decision file here imports no `electron`.
