# `src/main/devices/`: the choosers for a screen to share and for a USB or HID device

**What lives here.** `install-choosers.ts`, the installer `../shell/shell-installers.ts` runs at start. It is empty until the feature that fills it lands.

**What it depends on.** `electron` (types), [`../shell/`](../shell/) (`ShellInstaller`, `ShellServices`).

**What it must never import.** [`../shell/tabs.ts`](../shell/tabs.ts) or [`../shell/tab-view.ts`](../shell/tab-view.ts).

**Owner stream.** `shell`.

**Electron dependence.** Installers and the handlers they register are tied to Electron; a decision file here imports no `electron`.
