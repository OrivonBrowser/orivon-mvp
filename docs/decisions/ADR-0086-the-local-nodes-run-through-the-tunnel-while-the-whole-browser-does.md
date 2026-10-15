# ADR-0086: The local nodes run through the tunnel while the whole browser does

- **Status:** accepted. Amended by [`ADR-0087`](ADR-0087-the-nodes-follow-the-tunnel-only-when-the-person-asks-and-no-gateway-is-read-without-the-persons-yes.md): the nodes follow the tunnel only when the person turns on "Use tunnel to run network nodes", and gateways are no longer the fallback. *Provisional* on a website that has its tunnel on by itself (below).
- **Date:** 2026-10-15
- **Type:** architecture / security
- **Decided by:** owner (the nodes run through Nym while the whole browser is on the tunnel, so that nothing leaks and the node keeps working, slower; "pause it and say so" and "keep it outside Nym" were offered and both rejected); AI recommendation accepted by default for the shape

## Decision

**While `network.tunnel.everywhere` is on, Orivon's own IPFS and Swarm nodes start through the tunnel, and a node
never runs direct beside it.** This replaces the refusal [`ADR-0084`](ADR-0084-the-tunnel-can-carry-the-whole-browser-and-a-website-with-an-entry-lives-in-one-of-two-shared-profiles.md)
recorded ("the local IPFS and Swarm nodes do not run while the setting is on").

**One seam, for every kind of node.** All of a node's network is `node-net.ts`, and the rules it enforces (public
addresses only, port 53 for datagrams, loopback listeners, the budgets) are unchanged. What changes is what stands behind
its four calls, in `src/protocols/local-node/node-route.ts`:

- `dial`: a SOCKS5 CONNECT through the tunnel to the literal address `node-net.ts` checked, IPv4 first, the next address
  when one fails, at most thirty-two openings in flight so a mixnet tunnel is not handed hundreds together;
- `bind` (datagrams): a UDP ASSOCIATE channel; the node is given no socket of its own, and the only datagram socket in the process is the SOCKS5 client's, on loopback for a tunnel on this computer;
- `lookup`: DNS-over-HTTPS over a TLS connection the tunnel carries (a CONNECT to the endpoint's name; the certificate is
  checked for that name; the connection is kept), and **no system resolver**: a name the endpoints cannot answer stays
  unresolved, never asked of this computer;
- `listen`: loopback, as before.

A node started with `routed` in its config and no way to ask for a route gets no network at all.

**How the process learns where the tunnel is.** It asks main over its parent port (`route-ask`), and main answers with
the tunnel's loopback port and the secret the Nym host made for its start, with the node's own user name (`route`). The answer is kept until main says the route
moved (`route-reset`, sent when the Nym host's endpoint changes or goes) or the proxy refuses a connection outright. A
refusal from main (Nym is switched off, or cannot start) is never kept. The address and the secret travel over the parent
port only, never in an argument, a start config or a log line, and a restarted Nym host (new port, new secret) cannot leave
the node holding a stale pair.

**Which tunnel identity: one of the node's own, per kind of node.** The user name is the route's isolation name for
`local-node:<kind>`, so Nym gives each node a mixnet client, a gateway and an exit of its own. Reasons: a node opens
hundreds of streams and some stall, and the host replaces a tunnel whose streams stall, so sharing the browsing tunnel would
let the node's stalls replace the tunnel that the person's pages load through; and a node's peers see a persistent peer ID
beside an exit address, which the sites the person opens must not see on the same exit. Cost: one of the host's six tunnel
places per node that runs (so the IPFS and Swarm nodes take two, leaving four for the shared browser tunnel, the tunnel
profile and apps), and the processor time of an open tunnel for as long as the node runs. With the person's own SOCKS5 address
the same name goes in the sign-in, which Tor reads as an isolation key.

**The switch.** `tunnelDefaultChanged` stops the nodes in the turn the setting flips, in either direction, so a node
running on one path never lives on after the setting says the other. The controller reads the setting again after every
wait before it forks and starts again if it moved; a check approved for one path is not used for the other. With the
setting on, the question "does a system proxy apply?" is not asked of the node (the tunnel is its only way out), and the
node is off with the tunnel's reason when the tunnel cannot carry it. A node's card in Available networks says it runs
through Nym (or the person's tunnel) and is slower, in plain words.

**The person's own SOCKS5 address.** Streams and DNS-over-HTTPS go through it as through Nym. Tor's SOCKS5 carries no UDP
ASSOCIATE, so there a routed node has no datagrams and a `/dnsaddr` bootnode name that needs a UDP query is not resolved;
the node's other names (by DNS-over-HTTPS) are.

**Gateways stay the fallback, over the tunnel.** When the node cannot run, IPFS is read from the gateways through the tunnel,
as before.

**A website with its own tunnel (browser-wide off).** Still reads IPFS through the gateways over its tunnel, never through
the node: the node is one process for the whole browser and cannot be both. *Provisional*; what would settle it is a node
per tunnel identity.

**The Swarm node** runs through the tunnel like the IPFS node (Consequences has the measure); where a start does not reach its readiness rule in the time a mount can spare, the Swarm page says so and the person tries again, as on a direct start.

## Context

With the whole browser on the tunnel, nodes that dial their peers and look names up themselves would show the person's
address to every peer, so ADR-0084 refused them and IPFS fell back to gateways over the tunnel, and the Available
networks card said the node was off. The owner asked for the node to keep working through Nym instead, accepting that it
is slower.

## Alternatives considered

- **Pause the nodes and say so.** Rejected by the owner: the node is part of the product, and a card that says "off" while
  pages still load through gateways reads as broken.
- **Keep the nodes outside Nym.** Rejected by the owner: it shows the person's address to every peer.
- **The shared tunnel identity.** Rejected: the stalls above, and the exit-correlation above.
- **Let the tunnel resolve a node's names (CONNECT by name).** Rejected: the rule that a name with one non-public answer is
  refused whole is `node-net.ts`'s, and it needs the answers; a tunnel that resolves for the node would hide them. The
  lookup also has to work through a SOCKS5 server that carries no UDP.
- **Ask the tunnel for names with UDP port-53 queries.** Rejected: Tor has no UDP ASSOCIATE, so the path would work for Nym
  only.
- **Put the tunnel's address in the start config.** Rejected: the Nym host's port and secret are new at each start, so the
  config would be stale after a restart of the host, and the secret would sit in a structure that is logged by a careless
  caller.

## Reasoning

The seam that already decides everything a node may reach is the right place to also decide where it leaves. Doing it once
in the shared host means a new kind of node gets the behaviour with no code of its own. Asking for the route at each
(re)use, as the app's route does, is what keeps a restarted host working.

## Consequences

- A node is slower through Nym. Measured on 2026-10-15 from a home connection, with Nym as the host then had it (Balanced
  level), cold launches: a small block the public network holds widely reaches the IPFS node in 14 to 18 s through Nym (14 s
  of that is the node's own tunnel coming up) and in 1 to 1.3 s directly; the DNSLink site `docs.ipfs.tech` shows its page in
  29 to 38 s through the node and Nym, and in 11.5 s from the gateways through Nym. A direct node never loaded that site in 420 s
  on that connection, so there is no direct figure for it. The host's own speed work will help the node.
- The Swarm node runs through the tunnel as well: a `bzz://` site loaded in 87 to 110 s from a cold start, with 110 sockets
  open, every one on loopback, and 116 dials opened and 14 failed. So it stays on while the tunnel carries everything.
- The operating system, listing the node's process every ten seconds while it worked, showed no socket to anything but
  loopback (TCP to the Nym host's port and UDP to its relay); with the setting off the same node held sockets to peers.
- `ORIVON_<NAME>_LOG=1` now also prints each dial, lookup and datagram channel the routed node makes, with their times.

## Reversibility

- **Cost to reverse:** small. The seam is one file; removing `routed` from the start config restores the refusal.
- **What would make us revisit:** the node's measured load times never becoming usable, or a Nym that cannot hold two tunnels
  open for a long time, in which case the pause the owner rejected would return.
