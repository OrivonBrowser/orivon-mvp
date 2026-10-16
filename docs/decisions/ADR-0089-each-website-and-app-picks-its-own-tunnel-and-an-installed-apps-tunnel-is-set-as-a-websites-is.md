# ADR-0089: Each website and app picks its own tunnel, and an installed app's tunnel is set as a website's is

- **Status:** accepted. Supersedes the single-tunnel parts of [`ADR-0080`](ADR-0080-an-installed-app-can-send-everything-through-one-proxy.md) (one tunnel for every routed origin, set for an app only on its card in Settings) and the two-profile layout of [`ADR-0084`](ADR-0084-the-tunnel-can-carry-the-whole-browser-and-a-website-with-an-entry-lives-in-one-of-two-shared-profiles.md) (the tunnel profile and the direct profile become three profiles). The rest of both stands: a tunnel state per origin, an app's own session and identity, the shared identity, the whole-browser setting, the verifier host reading a tunnelled website's names through its profile's front.
- **Date:** 2026-10-16
- **Type:** architecture / security
- **Decided by:** owner (installed apps behave as websites do, kept locally; the tunnel menu lists every tunnel and sets the proxy in place; each site or app keeps its own tunnel, so one site goes through Nym while another goes through the proxy); AI recommendation accepted by default for the shape and the migration

## Decision

**An origin's entry is a tunnel or `off`.** The tunnels are Nym and the person's own SOCKS5 proxy. Every origin, an installed app or a website, has no entry (it follows the browser's default), `off`, `nym` or `socks5`. The default is `off` while the whole browser is not on a tunnel, and the tunnel chosen in Settings (`network.route.kind`) while it is. An entry equal to what the default already says is not kept, so the origin returns to the session it follows. Where a website lives follows its own entry alone, never the default (ADR-0084 stands).

**Three profiles.** A website whose entry is Nym lives in `persist:tunnel-profile`, one whose entry is the proxy in `persist:proxy-profile`, and one whose entry is `off` in `persist:direct-profile`; each is one persistent session shared by its websites, with a memory twin for an origin that may not be written to disk. Each tunnel's profile has one front and one set of tunnel credentials. Nym keeps the profile name it has always had, so nobody who uses Nym moves. The person's extensions load into whichever profiles have a website open, as ADR-0084 says.

**An installed app is set as a website is.** It keeps its own `persist:app-<hash>` session and its own tunnel identity (so its storage is never shared and its connections are isolated), and it has no extension and no storage notice. Its entry is written by the same switch, with the same three choices, from the same menu. It differs from a website only where it must: it is served from files kept here (so it cannot be tunnelled until they are pinned and persistable), its updates are not checked while it goes through a tunnel, and the broker closes what it held open when its tunnel changes.

**Site permissions follow the grants.** An installed app that holds no grant is a website to the per-site permissions (the asker, the content rules, the popover's rows): ADR-0044 ties the manifest's permissions to holding grants, and an app that holds none has none to stand in for a prompt. The media, screen and device surfaces still treat any installed or registered origin as an app, so an app's camera or screen is never offered through the website prompt.

**Orivon's own requests about a website with a tunnel of its own** (its app manifest, the loader's reads, the lookup of its name) are made in that tunnel's profile session whatever the browser-wide setting and its tunnel are, so they leave by the exit its pages use, and the name is resolved at the far end of that tunnel and never here.

**The file.** `routes.json` stays at version 1 so an older build reads it: `origins` lists every origin that goes through either tunnel (an older build routes all of them, never direct), `via` names the ones that use the proxy (Nym when absent), `apartProxy` lists the websites with storage in the proxy profile, and the marker `kinds: 1` says each origin names its own tunnel. A private window held to Nym refuses an entry other than Nym. A file that cannot be read says nothing about which tunnel each origin picked, so every origin goes through the default tunnel when it has an address and through Nym when it has none (and fails when Nym is switched off), never direct.

**Migration.** Before this build every origin that went through a tunnel went through the one chosen tunnel, and every such website had its storage in the tunnel profile. A file without the `kinds` marker is read with every origin on the tunnel that was the choice at that start. When that was Nym nothing moves. When it was the proxy, the folder of the tunnel profile (`Partitions/tunnel-profile` under the profile's data folder, the website storage and the extension copies' data in it) is renamed to the proxy profile's (`Partitions/proxy-profile`) before any session opens it, so nobody is signed out; the list of websites with storage there moves with it. A rename that fails because something holds the folder open (an indexer or antivirus program) leaves the file unmarked and is tried again at the next start, three starts at most, with every origin read at the proxy meanwhile; one that cannot succeed (the proxy profile's folder already holds data) is not tried again. Neither is retried by copying: once the tries are spent the proxy profile starts empty, the person signs in to those sites once, and the old storage stays in Nym's profile, listed under it with the existing "Remove its separate storage" and recorded as the proxy's, so that moving such a site to Nym tells the person as for a first move and clears that site's data from Nym's profile before it arrives. The marker is written after the rename, or after the tries are spent. Measured on Electron 44: a cookie set in `persist:tunnel-profile` is read back from `persist:proxy-profile` after the folder is renamed between two runs. When the settings file cannot be read the choice is not guessed and the file is left unmarked until it can.

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
- Each identity's front leaves by the tunnel its origin picked, and a session that goes through a different tunnel from the one its origin picked is refused a main-frame load. The verifier host reads the names and files of a website in a tunnel's profile through that profile's front, with a set of protocols and a light client for each tunnel, started when the first website of the tunnel asks. A Swarm address stays refused for a tunnelled website.

## Reversibility

- **Cost to reverse:** moderate. The proxy profile's name is a stored layout, and the file keeps `origins` as the older build reads it, so going back to one tunnel for all costs one sign-in for the sites that used the proxy.
- **What would make us revisit:** a third tunnel, which adds a profile and a `via` value; or the owner's first use showing that the memory of two profiles is too much.
