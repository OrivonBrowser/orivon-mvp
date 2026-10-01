# `src/main/appearance/`: what changes how Orivon's own surfaces look

**What lives here.** `shell-style.ts` is the one source for a token override on Orivon's own surfaces: a list of
`ShellStylePart`s, `shellCss` that joins them, `rootTokens` and `darkTokens` that write a rule heavy enough to beat a
page's own `:root`, and `isShellSurface`, which tells those surfaces from a site's tab. `shell-style-runner.ts`'s `installShellStyle`
inserts the stylesheet into each live surface and again after a setting changes; `index.ts` calls it beside `installZoom`, since it
needs the shell's session and the new-tab page's address.

**What it depends on.** `electron` (types); [`../settings/`](../settings/) (the settings a part reads);
[`../shell/`](../shell/) (`contain.ts`, and the `ShellInstaller` type).

**What it must never import.** The renderer, or anything in [`../shell/`](../shell/) beyond the two named above.

**Owner stream.** `shell`.

**Electron dependence.** `shell-style.ts` needs nothing of Electron but its types, and would outlive a change of engine.
Inserting a stylesheet into a page (`shell-style-runner.ts`) is tied to it.

## Design notes

**Author origin, written as `:root:root`.** A stylesheet inserted with `cssOrigin: 'user'` loses to a page's own rule
unless every declaration is `!important`, and `removeInsertedCSS` does not take a user-origin sheet out again, so a
setting changed back would leave the old look. An author-origin sheet is removed cleanly, and `:root:root` outweighs
the `:root` rule each page keeps its tokens in. Measured on the toolbar, a popup, Settings and the new-tab page.

**Surfaces are chosen by session, and the new-tab page by its address.** Every renderer keeps its own copy of the
tokens, and a site's tab must never be styled, so a surface counts only when it runs in the shell's session, the
internal pages' session, or has loaded the new-tab page.
