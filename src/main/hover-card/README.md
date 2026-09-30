# `src/main/hover-card/`: the card shown when pointing at a tab

**What lives here.** The tab hover card and the preview it shows. Until the feature lands, only `install-hover-card.ts`, the installer
[`../shell/shell-installers.ts`](../shell/shell-installers.ts) runs at start; its body is empty.

**What it depends on.** `electron` and [`../shell/`](../shell/) (types, and the one `ShellInstaller` type the installer takes).

**What it must never import.** The renderer, or a value from [`../shell/tabs.ts`](../shell/tabs.ts): the shell lists this
feature, not the other way round.

**Owner stream.** `shell`.

**Electron dependence.** Tied to Electron.
