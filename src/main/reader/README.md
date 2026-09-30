# `src/main/reader/`: the reader view

**What lives here.** Article extraction and the reader page that shows it. Until the feature lands, only `install-reader.ts`, the installer
[`../shell/shell-installers.ts`](../shell/shell-installers.ts) runs at start; its body is empty.

**What it depends on.** `electron` and [`../shell/`](../shell/) (types, and the one `ShellInstaller` type the installer takes).

**What it must never import.** The renderer, or a value from [`../shell/tabs.ts`](../shell/tabs.ts): the shell lists this
feature, not the other way round.

**Owner stream.** `shell`.

**Electron dependence.** Tied to Electron.
