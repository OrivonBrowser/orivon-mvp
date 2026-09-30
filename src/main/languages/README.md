# `src/main/languages/`: the languages Orivon asks for and checks spelling in

**What lives here.** The content languages, the start-up locale and the spelling languages. Until the feature lands, only `install-languages.ts`, the installer
[`../shell/shell-installers.ts`](../shell/shell-installers.ts) runs at start; its body is empty.

**What it depends on.** `electron` and [`../shell/`](../shell/) (types, and the one `ShellInstaller` type the installer takes).

**What it must never import.** The renderer, or a value from [`../shell/tabs.ts`](../shell/tabs.ts): the shell lists this
feature, not the other way round.

**Owner stream.** `shell`.

**Electron dependence.** Tied to Electron.
