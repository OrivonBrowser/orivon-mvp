# ADR-0079: IPFS content is read from Orivon's own node by default

- **Status:** accepted. *Provisional* on two calls: the fallback to public gateways when the node cannot run (what would settle it: the owner's answer on whether a person who chose the node should ever be served by gateways without being asked), and where the node's files are published (the manifest holds no CID until the owner approves publishing, and a build without the files runs IPFS from gateways).
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

The node finds who holds a block by asking a delegated lookup service and the IPFS network at the same time,
and uses the first answer. A second setting (`web3.ipfsLookupService`, on by default) turns the service off,
and the node then asks the network only. Both settings apply at once: the node and the verifier host stop, and
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
the lookup service and the network together costs the service the knowledge of which sites are looked up, which
the setting lets a person refuse; the content that comes back is checked either way.

## Consequences

- The node only reads. It does not serve other peers, provide content to the network, or pin; each is later work
  with its own decision, and the last two need an inbound listen rule `node-net.ts` does not have.
- The node's HTTP API is on a loopback port a page in any tab can request. It serves reads only; a page that can
  name a CID can already ask any public gateway for it, and the node adds that this computer fetches it.
- A change of either setting puts the verifier host to sleep, so a page loading at that moment fails once and a
  reload works.
- Where gateways are named to the person (Settings' list of servers, the site-info popover's "Loaded from" row),
  they say the node when the node served the content, and name the gateways, with the reason, when it did not.
- The node's one endpoint takes 12 concurrent block reads, what three gateways took together, because each block
  it lacks is a lookup of its own; a block that fails its hash sits the node out for 30 seconds and is not
  dropped for the session as a gateway is.

## Reversibility

- **Cost to reverse:** low. Changing the default is a schema line; removing the node is one kind, one manifest
  and the host config's `ipfsNode`.
- **What would make us revisit:** a node that cannot find content from inside the seam's rules, or a measured
  load time on a cold profile that makes the default worse than gateways for the people it serves first.
