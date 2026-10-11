# `src/main/web3-score/`: what the Web3 Score is, for someone who has not met it

**What lives here.** The card the address bar's shield opens on a new tab, where there is no site to score:
`web3-score-overlay.ts` declares it as an overlay and answers its two requests, open the score provider setting and
open the page that explains scores. The page is [`../../renderer/overlay/web3-score/`](../../renderer/overlay/web3-score/).
A site's own score is the site-info popup's Web3 Score page ([`../permissions/`](../permissions/)).

**Tied to Electron.** No: it needs only the overlay types and the window's tabs.

**What it depends on.** [`../overlays/`](../overlays/) (`overlay-types.ts`).

**What it must never import.** The renderer, or a value from the shell: the shell lists this feature
(`overlays/overlays.ts`, `shell/press-stamps.ts`), not the other way round.

**Owner stream.** `shell`.
