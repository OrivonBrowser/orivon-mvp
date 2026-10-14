# Devlog journal — running capture

This file is the raw material for the Sunday devlog. It is append-only during the
week and compiled by `/devlog` into `devlog/updates/YYYY-MM-DD.md`, after which the
compiled week is cleared and a fresh week heading is started.

Three buckets per week:

- **Done / results** — technical outcomes worth telling the team. One line each.
- **In my head** — what the owner has been thinking about: doubts, direction changes,
  things circling that are not visible in commits. These become the voice-note cues.
- **Non-repo** — calls, Notion work, admin, anything outside this repository. Claude
  cannot see these, so the owner jots them here (or they get a placeholder on Sunday).

Mark anything that must not leave the team draft as `(Keep private)`.

---

## Week of 2026-10-12

### Done / results

- Slow IPFS loads traced to public gateways (one throttling, one dead), not code; Orivon now asks the next gateway sooner when one stalls.
- Swarm sites (bzz:// and .eth on Swarm) now load with every chunk checked against its hash; it stays off until Orivon's own Swarm node ships.
- IPFS sites load from Orivon's own IPFS node on your computer, every block still checked; it switches on once the node is published.
- A page can no longer tell which IPFS sites you opened: the node keeps a separate store per site, and tabs cannot reach it.
- Orivon's own IPFS and Swarm nodes are published on IPFS: new builds fetch them, so IPFS reads from your computer and Swarm switches on.
- Installed apps can send all their traffic through a SOCKS5 proxy like Tor, per app; what it cannot carry is refused, never sent direct.
- A routed app opening a website now asks first: through the proxy in a throwaway tab, directly, or not at all.
- Pre-release security review: scanners triaged, four code reviews; fixed proxy bypass on app loads, download retry session, extension pattern freeze.
- Orivon also ships as a Microsoft Store package, signed by Microsoft, so Store installs show no SmartScreen warning; no certificate bought.
- Nym mixnet ships inside Orivon as the default tunnel for installed apps: one tunnel per app, nothing to install; your own SOCKS5 stays a choice.
- A .eth or ipfs:// site opened through your tunnel is now read entirely through it, name proofs included; Swarm sites are refused.
- The tunnel now works per site or for the whole browser; tunnelled sites share one profile that keeps their logins and extensions.
- A toolbar button lists the nodes Orivon runs on your machine, with memory, a switch each and a status dot; permissions are Settings switches.
- An app's first-visit question is now a panel of switches, Grant all or Close; the key shows a dot while permissions are off.
- Swarm and .eth IPFS sites now work on Windows: both local nodes silently failed to start there. Error pages gain Try again.
- A slow IPFS node no longer leaves pages half loaded: a file it could not give is asked again once its memory clears.
- Going offline no longer strips a loaded Web3 site's score; a site no provider has judged shows a gray Web? instead of Web2.5.
- The new tab's Orivon Featured row is now Explore, WebTorrent, ASGARDEX, Ledger Wallet and The Lounge; no more Chrome Web Store advice.
- Deep security audit (Cloudflare's method): no critical or high; all 15 confirmed findings fixed, including extension regex rules now matched in linear time.

### In my head

- Swarm should come from a node on the user's own machine, never public gateways: trustless and permissionless, or not at all.
- Letting users pin sites and serve them to others is the next step for the IPFS node; today it only reads.
- A per-app tunnel belongs at Orivon's socket layer, not the OS: any protocol an app builds rides it, no drivers.
- Extensions per tunnel profile, never per site: a hundred tunnelled sites should cost one copy of uBlock, not a hundred.

### Non-repo
