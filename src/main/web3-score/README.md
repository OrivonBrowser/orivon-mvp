# `src/main/web3-score/`: what the Web3 Score is, for someone who has not met it

**What lives here.** The card the address bar's shield opens on a new tab, where there is no site to score, and every
Web mark (Web2, Web2.5, Web3, Web?) opens on a site: `web3-score-overlay.ts` declares it as an overlay, answers its two
requests, open the score provider setting and open the page that explains scores, and replies to a show with the level
the mark's site is at (`thisSiteOf`), which the page marks as "This site". `web3-score-help.ts` is where the "?" marks of
the shield and the card's "How scores work" lead (a tab at `docs.orivonstack.eth/docs/using/web3-score`, opened as the
address bar opens that name), and the site-info popup's Web3 Score page. The card's page is [`../../renderer/overlay/web3-score/`](../../renderer/overlay/web3-score/).
A site's own score is the site-info popup's Web3 Score page ([`../permissions/`](../permissions/)).

**Tied to Electron.** No: it needs only the overlay types and the window's tabs.

**What it depends on.** [`../overlays/`](../overlays/) (`overlay-types.ts`), [`../browsing/`](../browsing/) (`omnibox.ts`, to make the address a URL) and [`../dev/`](../dev/) (`eth-resolver.ts`), and the type of a chrome action from [`../shell/`](../shell/).

**What it must never import.** The renderer, or a value from the shell: the shell lists this feature
(`overlays/overlays.ts`, `shell/press-stamps.ts`), not the other way round.

**Owner stream.** `shell`.
