# ADR-0079: IPFS content is read from Orivon's own node by default

- **Status:** accepted; **amended 2026-10-13 (`d-0610`)**: the node resolves names over DNS-over-HTTPS first (see Amendment); **amended 2026-10-13 (`d-0612`)**: the node's files are published as one IPFS directory, pinned by the IPFS node that pins Orivon's releases, and a build fetches them by the CID in `resources/ipfs-node/ipfs-node.json`; a build without them runs IPFS from gateways. *Provisional* on one call: the fallback to public gateways when the node cannot run (what would settle it: the owner's answer on whether a person who chose the node should ever be served by gateways without being asked).
- **Date:** 2026-10-12
- **Type:** architecture / privacy
- **Decided by:** owner (own node by default, public gateways as a setting: `d-0605`; ask the lookup service and the network at once, a setting turns the service off: `d-0606`); AI recommendation accepted by default for the fallback (`d-0607`)

## Decision

IPFS blocks and IPNS records are read from an IPFS node that Orivon runs on the person's own computer, unless
the person chose public gateways in Settings (`web3.ipfsSource`, `node` by default). The node is a Rust
program compiled to `wasm32-wasip2` and transpiled by jco, run by the same shared local-node host as the Swarm
node ([`ADR-0078`](ADR-0078-the-swarm-node-is-webassembly-in-a-utility-process-of-its-own.md)): the same
utility process, the same two seam files, the same pinned-file check, the same on-demand start, idle stop and
refusal under a system proxy. The IPFS protocol reads the node's loopback trustless-gateway endpoint exactly as
it reads a gateway, and still hashes every block and checks every IPNS record itself, so the node is trusted
for availability only. DNSLink stays on Orivon's own DNS-over-HTTPS resolver, and a name service is still asked
for an IPNS record after the node.

The node finds who holds a block by asking two delegated lookup services (`delegated-ipfs.dev` and
`cid.contact`, given as one comma list the node races and fails over across) and the IPFS network at the same
time, and uses the first answer. There are two services because the node resolves their names through this
computer's resolver, and a resolver that hijacks DNS breaks the first with a certificate error while the second
keeps working. A second setting (`web3.ipfsLookupService`, on by default) turns the service off,
and the node then asks the network only, with no service named. Both settings apply at once: the node and the verifier host stop, and
their next start reads the new choice.

When the person chose the node and it cannot run (this build has no node files, a system proxy is
configured, or it failed to start or to answer in time), a mount reads from the public gateways instead. The
site-info popover then says "Public IPFS gateways, because ..." with the reason, and Settings says in one
sentence why the node is not in use. IPFS never waits on a node that will not come.

## Context

An IPFS address asked three public gateways for every block, so each of them learned which sites a person
opens. Swarm already loads only from a node on the person's own machine, and the host that runs it is shared.
The node serves what the protocol already reads (`/ipfs/<cid>?format=raw`, `/ipns/<key>?format=ipns-record`),
so the protocol and its verification do not change.

## Alternatives considered

- **Public gateways only (as before).** Rejected as the default: every gateway learns what a person opens.
  Kept as the setting's other value, since a person may prefer speed or have a computer that cannot run the
  node.
- **A node as a native binary.** Rejected: Rule 8 and `ADR-0040`; one download per operating system, and no
  confinement beyond what Orivon adds around a process it cannot look into.
- **A JavaScript full node (Helia).** Rejected: it pulls in a native module (Rule 8) and a peer-to-peer stack
  the main process or the host would carry, where a trap should end only the node.
- **The node first, with the gateways asked if it is slow.** Rejected: it would tell the gateways what a
  person opens whenever the node was slower than a hedge, which is the leak the node removes.

## Reasoning

The shared host was built for this: a kind is one folder and one line, and the confinement is the same for
every kind. The node holds no grant, so `node-net.ts` is the defence, and it already allows exactly what this
node does: connections to public addresses, datagrams to a public resolver on port 53, loopback listens. Asking
the lookup services and the network together costs the services the knowledge of which sites are looked up, which
the setting lets a person refuse; the content that comes back is checked either way.

## Consequences

- The node only reads. It does not serve other peers, provide content to the network, or pin; each is later work
  with its own decision, and the last two need an inbound listen rule `node-net.ts` does not have.
- The node's HTTP API is on a loopback port a page in any tab can request. It serves reads only; a page that can
  name a CID can already ask any public gateway for it, and the node adds that this computer fetches it.
- A change of the source puts the verifier host to sleep (the light client syncs again and mounted sites are
  dropped), so a page loading at that moment fails once and a reload works. A change of the lookup service stops
  only the IPFS node, whose next start has the new arguments; the host and the Swarm node are left alone.
- Where gateways are named to the person (Settings' list of servers, the site-info popover's "Loaded from" row),
  they say the node when the node served the content, and name the gateways, with the reason, when it did not.
- One node and one database serve every site, so the node must not become a way to learn what the person has
  visited ([`A256`](resolved-questions.md) closed that for the verifier's own caches: mounts in different partitions
  share nothing a page could time). Three measures keep it closed. First, every read from the verifier carries the
  header `x-orivon-partition` with `base64url(sha256(salt || partition))` (43 characters), where the salt is
  random per profile, kept with the verifier's other per-profile data and sent to the verifier host alone; the node
  keys its store, hot cache and in-flight fetches by (partition, CID), so its `blocks.db` holds no origin in plain
  text, and a read with no header is served from the network and kept nowhere. Second, main cancels every request
  from any page, in any session, to a loopback port a local node holds (`local-node-port-gate.ts`), so no page
  can time the node's API directly; this also closes the Swarm node's loopback residual. Third, clearing cached
  data or all history stops the node, deletes `blocks.db` with its journal, `-wal` and `-shm`, and replaces the
  salt.
- With the lookup service off, nothing third-party is asked for an IPNS record either: the name services are
  skipped after the node, so Settings' sentence "only the IPFS network is asked" is true.
- Residuals that stay: the node's short-lived provider and peer caches and its in-flight lookups are shared across
  sites for minutes, as a public gateway's edge cache is; and a DNS name an attacker points at 127.0.0.1 reaches
  the node's port unless the request is cancelled by address, which a URL filter cannot see (a node that required
  a per-run secret header would close it, and is a follow-up).
- The node's one endpoint is read differently from a gateway, from what was measured of the real node: a block
  with a provider arrives in 0.3 to 2.3 s, a lookup that finds nothing ends in 25 to 93 s with a 404 or 504, and
  an empty lookup is remembered by the node for 30 s. So the endpoint takes 12 concurrent block reads (what three
  gateways took together, since each block it lacks is a lookup of its own); a block waits 45 s (about twenty
  times the slowest success, ending a hopeless lookup before its worst case); an IPNS record waits 15 s (about
  10 s measured), so that a name service is asked inside a mount's 25 s when the node has nothing; a 5xx is the
  node's answer that it found nothing, so it is neither retried nor cooled for and the page shows its ordinary
  "not available" error at once; and a block that fails its hash sits the node out for 30 s instead of dropping
  it for the session as a gateway is.
- The node resolves the lookup services' names through this computer's resolver, which Orivon does not change.
  On a network that hijacks DNS, a service whose name is hijacked fails with a certificate error and the other
  keeps answering (0.14 to 0.2 s, blocks in 0.4 to 0.9 s cold); a site whose providers only the hijacked service
  knows is not found there, and its page shows the ordinary "not available" error after about 35 s. A follow-up
  could give the node a resolver of its own. Measured live: the node is ready about 1.2 s after its start (the
  component compiles lazily in tens of milliseconds) and holds about 180 to 230 MB.

## Amendment recorded 2026-10-13

The last Consequences line, which left the node's name resolution to the system resolver, is resolved: the node
resolves names over DNS-over-HTTPS first (the verifier host's endpoints, handed over in the node's config) and uses
the system resolver only when no endpoint answered, so a hijacked name no longer fails the node's certificate check.
`node-net.ts` checks every answer as before. Provisional (`d-0610`): the DoH providers learn the node's host names,
and the owner may prefer other providers or none. Measured on a network that hijacks `delegated-ipfs.dev`: a
DNSLink site only that service knew went from "not available" after about 35 s to shown after about 22 s.

## Reversibility

- **Cost to reverse:** low. Changing the default is a schema line; removing the node is one kind, one manifest
  and the host config's `ipfsNode`.
- **What would make us revisit:** a node that cannot find content from inside the seam's rules, or a measured
  load time on a cold profile that makes the default worse than gateways for the people it serves first.
