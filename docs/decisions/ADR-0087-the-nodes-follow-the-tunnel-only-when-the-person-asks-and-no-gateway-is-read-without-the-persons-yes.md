# ADR-0087: The local nodes follow the tunnel only when the person asks, and no public gateway is read without the person's yes

- **Status:** accepted.
- **Date:** 2026-10-15
- **Type:** architecture / security
- **Decided by:** owner (the setting, off by default, worded "Use tunnel to run network nodes (such as IPFS and Swarm)"; that Orivon never falls back to public IPFS gateways without the person's awareness and consent; that the Ethereum light client follows the same setting; that the yes to gateways is for one load and nothing is remembered); AI recommendation accepted by default for the shape and the conservative handling of a website in the tunnel profile

## Decision

**1. A setting decides whether the IPFS and Swarm nodes, and the Ethereum light client, go through the tunnel.** `network.tunnel.nodes`, in Settings under
Tunnels, **off by default**. It amends [`ADR-0086`](ADR-0086-the-local-nodes-run-through-the-tunnel-while-the-whole-browser-does.md),
which made the nodes run through the tunnel whenever the whole browser does:

| Browser-wide tunnel | Setting | The IPFS and Swarm nodes and the Ethereum light client |
|---|---|---|
| off | either | direct (as before) |
| on | off | **direct**; the websites' own connections, and everything else Orivon sends, still go through the tunnel |
| on | on | through the tunnel, as `ADR-0086` has it for the nodes and `ADR-0084` for the light client |

Flipping the setting stops the nodes in that turn and the next ask starts them on the path it names. A node that runs direct
beside the whole-browser tunnel is refused only by a proxy the system itself sets (the question goes to the session that follows
the system alone, never to the default session, which is the tunnel's front); a node that runs through the tunnel is asked
nothing about proxies, as before.

**The Ethereum light client** (Helios, its execution and beacon requests, and CCIP-Read) follows the same setting. With the
setting off it leaves outside the tunnel even while the whole browser is on it: the verifier host, whose own requests `app.setProxy`
points at the tunnel's front, sends them on Node's own sockets to addresses it resolves and checks itself (public unicast,
canonical, TLS checked against the real name; `outside-fetch.ts`). The Ethereum RPC and beacon providers then see this computer's
address and which `.eth` names are asked for. If the system itself sets a proxy while the whole browser is on the tunnel, the light
client stays on the tunnel (T20: a proxy the person set must keep carrying what leaves). A website in the tunnel profile is proved,
with the setting off, by the same shared light client every other website is, and no second, tunnelled client starts for it; with
the setting on it keeps the tunnelled client of its own. The DNS-over-HTTPS lookups of a DNSLink name stay on the tunnel in both
cases: they belong to the website's content, not to a node.

**A website with a tunnel of its own (browser-wide off).** The nodes serve it when the setting is off: the person accepted that
the networks a node asks see this computer's address, and the website's own requests stay in the tunnel. With the setting on and
the whole browser not on the tunnel, a node runs direct and so cannot serve such a website without showing the address the tunnel
hides: the load fails with that reason and the offer of item 2. This resolves the provisional note in `ADR-0086`: the website no
longer reads IPFS from gateways on its own. A Swarm address for such a website is refused with the same kind of sentence, since
Swarm has no public gateway.

**2. No public gateway is read without the person's yes.** Public IPFS gateways are used only when
- the person chose "Public IPFS gateways" under "Load IPFS sites from" in Settings (the standing choice, which builds no node
  at all), or
- the person pressed **Load through public gateways** on the error page of a site whose load failed because the node could not
  serve it (not running, refused, its tunnel cannot carry it, or it could not find the content): the yes is for **that one
  load** of that site (its origin) alone. It waits a minute for the load that follows the press, is used up by the first mount
  that takes it, and is never written anywhere; a reload, a new tab or a later visit asks again, because a page load the person
  starts does not reuse a site that a yes loaded. The files of the page that was loaded are read from it without asking again.

Every other reader is a background reader: the Web3 Score provider's lookup, an app's install or update check, a tab icon, an
`ipns://` lookup. It never has the person's yes for the site it reads, so it waits for the node or fails with the reason.
Nothing here changes the IPNS name-service lookup setting: that service is asked a record, not for content, and its own
toggle stays what decides it. The error page says what the gateways would see (the computer's address, or the tunnel's exit for
a website in the tunnel profile, and which content is asked for), says nothing has been sent, and points to Settings for the
standing choice. A page loaded after the yes says so in the site-info popover ("Public IPFS gateways, as you chose for this site;
your node could not serve it: ...").

The button is a link to a path under `/.orivon/` on the site's own origin, carrying a token only that error page was given
(an HMAC of the site's origin with a key made at the host's start). A request without the token for the page's own origin, or
that is not a navigation, is refused. A site's own files cannot shadow the path.

## Context

The owner reported two things in one test of Nym as the whole-browser tunnel: every IPFS connection failed, and the browser fell
back to IPFS gateways without telling anyone. Both came from `ADR-0086`: with the browser on Nym the nodes were forced through
it, a node whose tunnel could not carry it was refused, and the node-first reader then read gateways through Nym, which answer
502 or time out. The owner asked for the nodes to be a choice of their own ("so that a person who sets Nym can still load pages
quickly and decentralised through IPFS and Swarm directly, and let the apps' own connection be anonymous"), and for the silent
fall to gateways to stop.

## Alternatives considered

- **Keep `ADR-0086` and only fix the fall to gateways.** Rejected: the nodes would still be 15 to 100 times slower than direct,
  without the person having chosen that cost.
- **A third state for the nodes, "stop while the tunnel is on".** Rejected by the owner earlier (`ADR-0086`).
- **Remember the yes for a site, for the browsing session or across restarts.** Rejected by the owner: a remembered yes is a
  standing exposure the person may have forgotten, and the Settings choice already exists for a standing wish.
- **Serve a website in the tunnel profile from the node whatever the setting.** Rejected: the node's peers would learn the
  address the tunnel is there to hide, for a site the person opens only through the tunnel.
- **A second node per tunnel identity.** Left open (`ADR-0086`).

## Reasoning

The two things that make a page slow through Nym, the node's hundreds of streams and a gateway's own latency, are costs the
person should pay by choice; a browser that is quick by default and says what it would cost before it spends it is the one a
person keeps. The shapes already exist (a node reads IPFS, a gateway is a source with a different exposure), so the change is
where the decision is taken, not how any read is made. Putting the yes on the error page, at the moment of the failure, is where
the person has the facts (which site, why the node could not) and the means to act.

## Consequences

- With the whole-browser tunnel on and the setting off, IPFS and Swarm peers see this computer's address and which content it
  fetches (T86). The Available networks card names the tunnel only when the node really goes through it.
- An IPFS page that the node cannot serve fails with a page instead of loading slowly from gateways: a person with a
  node that cannot run (a system proxy, a missing file) meets the error page on every IPFS site until they press the button
  for each, or choose gateways in Settings.
- Every load that needs the gateways asks: a site the node cannot serve costs a click per load, by decision.
- The Ethereum RPC and beacon providers see this computer's address and the `.eth` names opened while the whole browser is on
  the tunnel and the setting is off (T86).

## Reversibility

- **Cost to reverse:** small. The setting is one key and one row; the yes is one class in the host.
- **What would make us revisit:** a node and a light client that are fast enough through the tunnel that the default can be on.
