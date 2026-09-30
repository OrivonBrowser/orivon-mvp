# `src/main/site-settings/`: what a site may do: per-site permissions, content settings and the prompt that asks

**What lives here.** `install-site-permissions.ts` and `install-content-settings.ts`, the two installers `../shell/shell-installers.ts` runs at start. Both are empty until the features that fill them land.

**What it depends on.** `electron` (types), [`../shell/`](../shell/) (`ShellInstaller`, `ShellServices`), [`../sessions/site-asks.ts`](../sessions/site-asks.ts) (the registry an asker joins).

**What it must never import.** [`../shell/tabs.ts`](../shell/tabs.ts) or [`../shell/tab-view.ts`](../shell/tab-view.ts): a feature here reaches tabs through the `ShellServices` and window registry it is handed.

**Owner stream.** `shell`.

**Electron dependence.** Installers and the asker an installer registers are tied to Electron; a decision file here (a store, a rule) imports no `electron`.
