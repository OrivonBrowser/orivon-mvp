# ADR-0089: Each website and app picks its own tunnel, and an installed app's tunnel is set as a website's is

- **Status:** accepted. Supersedes the single-tunnel parts of [`ADR-0080`](ADR-0080-an-installed-app-can-send-everything-through-one-proxy.md) (one tunnel for every routed origin, set for an app only on its card in Settings) and the two-profile layout of [`ADR-0084`](ADR-0084-the-tunnel-can-carry-the-whole-browser-and-a-website-with-an-entry-lives-in-one-of-two-shared-profiles.md) (the tunnel profile and the direct profile become three profiles). The rest of both stands: a tunnel state per origin, an app's own session and identity, the shared identity, the whole-browser setting, the verifier host reading a tunnelled website's names through its profile's front.
- **Date:** 2026-10-16
- **Type:** architecture / security
- **Decided by:** owner (installed apps behave as websites do, kept locally; the tunnel menu lists every tunnel and sets the proxy in place; each site or app keeps its own tunnel, so one site goes through Nym while another goes through the proxy); AI recommendation accepted by default for the shape and the migration

## Decision

**An origin's entry is a tunnel or `off`.** The tunnels are Nym and the person's own SOCKS5 proxy. Every origin, an installed app or a website, has no entry (it follows the browser's default), `off`, `nym` or `socks5`. The default is `off` while the whole browser is not on a tunnel, and the tunnel chosen in Settings (`network.route.kind`) while it is. An entry equal to what the default already says is not kept, so the origin returns to the session it follows. Where a website lives follows its own entry alone, never the default (ADR-0084 stands).

**Three profiles.** A website whose entry is Nym lives in `persist:tunnel-profile`, one whose entry is the proxy in `persist:proxy-profile`, and one whose entry is `off` in `persist:direct-profile`; each is one persistent session shared by its websites, with a memory twin for an origin that may not be written to disk. Each tunnel's profile has one front and one set of tunnel credentials. Nym keeps the profile name it has always had, so nobody who uses Nym moves. The person's extensions load into whichever profiles have a website open, as ADR-0084 says.

**An installed app is set as a website is.** It keeps its own `persist:app-<hash>` session and its own tunnel identity (so its storage is never shared and its connections are isolated), and it has no extension and no storage notice. Its entry is written by the same switch, with the same three choices, from the same menu. It differs from a website only where it must: it is served from files kept here (so it cannot be tunnelled until they are pinned and persistable), its updates are not checked while it goes through a tunnel, and the broker closes what it held open when its tunnel changes.

**The file.** `routes.json` stays at version 1 so an older build reads it: `origins` lists every origin that goes through either tunnel (an older build routes all of them, never direct), `via` names the ones that use the proxy (Nym when absent), `apartProxy` lists the websites with storage in the proxy profile, and the marker `kinds: 1` says each origin names its own tunnel. A private window held to Nym refuses an entry other than Nym.

**Migration.** Before this build every origin that went through a tunnel went through the one chosen tunnel, and every such website had its storage in the tunnel profile. A file without the `kinds` marker is read with every origin on the tunnel that was the choice at that start. When that was Nym nothing moves. When it was the proxy, the folder of the tunnel profile (`Partitions/tunnel-profile` under the profile's data folder, the website storage and the extension copies' data in it) is renamed to the proxy profile's (`Partitions/proxy-profile`) before any session opens it, so nobody is signed out; the list of websites with storage there moves with it. A rename that fails (the folder in use, the proxy profile's folder already holding data) is not retried by copying: the proxy profile starts empty, the person signs in to those sites once, and the old storage stays listed under the Nym profile with the existing "Remove its separate storage". The marker is written after the rename. Measured on Electron 44: a cookie set in `persist:tunnel-profile` is read back from `persist:proxy-profile` after the folder is renamed between two runs. When the settings file cannot be read the choice is not guessed and the file is left unmarked until it can.

## Context

The owner's words: installed apps behave exactly as normal websites do, the difference being that they are kept locally; the tunnel icon on any site or app enables any tunnel; and the same menu sets a proxy without opening Settings. ADR-0080 and ADR-0084 made the app's switch a card in Settings with one browser-wide tunnel; this makes the unit of choice the origin.

## Alternatives considered

- **One tunnel at a time (choosing the other tunnel for a site switches the whole browser).** Rejected by the owner: one site could not use Nym while another uses the proxy.
- **One session per tunnel with the tunnel chosen per request.** Rejected: Chromium sets a proxy per session; a request-time choice would put one tunnel's storage next to another's.
- **Copy the tunnel profile's data into the proxy profile on migration.** Rejected: the cookies database and local databases are open files in a profile in use and copying them doubles the storage; the rename is atomic on one volume and the failure path is the safe one.
- **Sign everyone in again.** Rejected as the main path: a person who set up their proxy before this build would lose every login for nothing.
- **Give an installed app a profile like a website.** Rejected: an app's session is also what serves its bundle (`protocol.handle` per session) and what keeps its storage apart from every website's.

## Consequences

- A website through Nym and another through the proxy cost two fronts, two profile sessions and, while both are open, two sets of the person's extension copies. Moving a site from one tunnel to the other signs the person in again once, as moving into any profile does.
- Threat T84 (an app's route) and T85 (the tunnel profile's shared identity) now read per tunnel; `docs/architecture/egress.md` says "routed origin" for an origin on either tunnel.
- A build older than this one that rewrites `routes.json` drops the tunnel of each origin and the proxy profile's list. The next start of this build reads that file as unmarked and gives every origin the tunnel chosen at that start; the storage of a website that was on the other tunnel stays in its profile folder, listed under no website.
- The Web3 sites path (the verifier host reading names through the profile's front) and the menu follow in later steps; until then every front leaves by the chosen tunnel, so a website whose entry names the other tunnel is still sent through a tunnel, never direct.

## Reversibility

- **Cost to reverse:** moderate. The proxy profile's name is a stored layout, and the file keeps `origins` as the older build reads it, so going back to one tunnel for all costs one sign-in for the sites that used the proxy.
- **What would make us revisit:** a third tunnel, which adds a profile and a `via` value; or the owner's first use showing that the memory of two profiles is too much.
