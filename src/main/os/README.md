# `src/main/os/`: what the operating system is told about Orivon: links opened from other programs, the default-browser registration, shortcuts and sharing

**What lives here.** `install-os-links.ts`, the installer `../shell/shell-installers.ts` runs at start. It is empty until the feature that fills it lands.

**What it depends on.** `electron` (types), [`../shell/`](../shell/) (`ShellInstaller`, `ShellServices`).

**What it must never import.** [`../shell/tabs.ts`](../shell/tabs.ts) or [`../shell/tab-view.ts`](../shell/tab-view.ts). Nothing a page or a link supplies reaches a command line or a file path unvalidated.

**Owner stream.** `shell`.

**Electron dependence.** Installers and the runners that talk to the OS are tied to Electron; a pure builder of a file or an address imports no `electron`.
