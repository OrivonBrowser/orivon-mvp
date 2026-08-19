# ADR-0001: BitTorrent streaming as the MVP flagship app

- **Status:** **accepted**
- **Date:** 2026-08-18
- **Type:** product
- **Decided by:** AI recommendation, accepted by owner

> The owner explicitly asked that the reasoning behind this choice be stored somewhere
> easily recoverable, so it is not forgotten. **This file is that place.**

## Decision
Make **BitTorrent-with-instant-streaming** the flagship application of the Orivon MVP:
a magnet link or `.torrent` opens in a tab and begins *playing* within seconds via
sequential download, while seeding back to the swarm. A **Nostr client** follows as a
cheap second sticky app.

## Context
The MVP's success metric is **100 active users in EU/USA, where active = 25 hours/month**
(~50 min/day). That is daily-driver usage: the product must replace the user's normal
browser for some real task, not merely be tried once. One solo developer, one month of
build, Claude Max for AI assistance. Target early adopters are "A+ players with liberal
mindset" — Monero / Tor / Bitcoin-maximalist / Durov / Vitalik sensibilities. Distribution
is organic plus ~€50.

## Alternatives considered
- **Wallet (Monero/Bitcoin) as flagship.** Rejected: nobody spends 50 min/day in a wallet.
  Episodic usage cannot reach 25 h/month. Also does not clip well for distribution.
- **Bisq / decentralised trading.** Rejected: trading is episodic, not daily. Bisq is a JVM
  app (compatibility **tier 3**), so bundling a JVM is heavy work for few daily minutes.
- **Mastodon.** Rejected outright, not merely as flagship. Mastodon's *client* is a website,
  but the system is not trustless: identity is `@user@instance`, owned by the instance
  admin, migration is lossy, and the whole feed is served by a party you must trust. It
  would score poorly on Orivon's own Trustlessity ladder. Running the Mastodon *server*
  in a URL (as `mastodon.eth` in the public docs implies) is Rails + Postgres — tier 3, and
  the hardest possible case. Weak on every axis.
- **Nostr as flagship.** Rejected as *flagship*, adopted as fast-follow: it only needs
  WebSockets, so it is achievable in an ordinary browser and does not by itself demonstrate
  capability-gated native execution. But it is ~3 days of work, adds real daily social
  minutes, and — unlike Mastodon — is genuinely sovereign: user-held keypair, fungible
  relays, no instance owning identity. It is the ideal first consumer of the no-setup
  per-origin identity (NIP-07). **Nostr replaces Mastodon; they are not both kept.**
- **IPFS / decentralised video.** Rejected: no content on it, therefore no daily use.
- **Ship a single-purpose desktop app instead of a browser.** Rejected: faster, but it
  becomes "another torrent client", discards the browser framing, and the capability API
  (the durable asset) never emerges.

## Reasoning
Seven properties, and torrent streaming is the only candidate with all of them:

1. **Genuine daily use.** People torrent daily. It becomes their client *and* their player.
2. **Actually impossible in Chrome.** No TCP, no DHT/UDP, no listening socket. Not a
   marketing claim — a platform fact.
3. **Not a re-skin of what exists.** Brave has shipped WebTorrent since 2018, but only over
   the WebRTC swarm — it cannot fetch ordinary torrents. Run in Node, the same `webtorrent`
   library does real TCP + DHT + PEX. Same idea, categorically better execution. Brave's
   precedent also de-risks the brand question (below).
4. **Cheap.** `webtorrent` in the main process ships a built-in HTTP streaming server;
   sequential download feeds a `<video>` in the renderer. Reuse is at the *library* level,
   not by forking someone's app.
5. **Exact audience fit.** Anti-bloat, pro-P2P, privacy-first — the target A+ players, and
   reachable organically.
6. **It clips.** Distribution is Show HN / Reddit / X / Discord with ~€50. "Magnet link, no
   client installed, instantly streaming" is a 15-second video. A wallet is not.
   Shareability is a product requirement here, not a nice-to-have.
7. **It is a literal instance of the thesis.** BitTorrent appears twice in Orivon's own
   examples, and it is the owner's "decentralised YouTube that rewards you for supporting
   the network", minus the token.

**It also solves the trust-indicator problem for free.** A magnet link is content-addressed:
the infohash *is* the trust root — self-verifying, requiring zero DNS trust and zero human
judge. Fetching from a swarm has no single trusted party. So the honest, locally-verifiable
trust indicator (ADR-0003) has a perfect showcase on day one, *without* the trustless
resolution layer that the DDOC / site-level ladder would have required.

## Consequences
- Commits the MVP to real TCP/UDP sockets and a listening socket in month 1 — precisely the
  capability broker in ADR-0002. Flagship and architecture reinforce each other rather than
  competing for budget.
- Commits to a media player surface (seek, subtitles, audio track selection): real but
  bounded UI work.
- **Brand exposure:** a browser that streams magnet links invites "piracy browser" framing.
- Mitigations, treated as product rules: never ship default content; never bundle an index
  or search; position strictly as "P2P content, self-verifying by hash".
- Legal reality, for the record: torrent clients are lawful software (qBittorrent,
  Transmission, WebTorrent all distribute freely), and a mainstream funded Chromium browser
  (Brave) already ships the capability. The exposure is framing, not liability.
- Grant exposure appears low and possibly positive: NLnet actively funds P2P and
  decentralisation tooling; Monero CCS is a natural fit.

## Reversibility
- **Cost to reverse:** **cheap.** The flagship is an *application* on top of the capability
  broker, not the architecture. Swapping it for a Nostr-native social/media flagship costs
  the app work, not the platform work.
- **What would make us revisit:** the first demo clip failing to produce organic traction,
  indicating the daily-use hypothesis is wrong.
