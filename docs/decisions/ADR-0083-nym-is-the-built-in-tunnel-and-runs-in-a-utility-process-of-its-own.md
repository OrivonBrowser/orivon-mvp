# ADR-0083: Nym is the built-in tunnel for installed apps, and runs as WebAssembly in a utility process of its own

- **Status:** accepted
- **Date:** 2026-10-13
- **Type:** architecture / security
- **Decided by:** owner (Nym ships inside Orivon and is the default far end of the tunnel, a person can choose their own SOCKS5 address instead, and Nym is named plainly: `d-0620`); AI recommendation accepted by default for the process shape (`d-0621`)

## Decision

The tunnel for installed apps ([`ADR-0080`](ADR-0080-an-installed-app-can-send-everything-through-one-proxy.md))
has two far ends, chosen under Privacy and data (`network.route.kind`): **Nym**, built into Orivon and the
default, and the person's own SOCKS5 address. For Nym the route's provider is the SOCKS5 provider pointed at
a SOCKS5 server on loopback, with the app's isolation user name and a secret as the password; nothing else in
the tunnel changes: the fronts, the fail-closed rules and the question before a website opens are the same.

The server is the **Nym tunnel host** (`src/protocols/nym-tunnel/`), an Electron utility process that runs
Nym's `smolmix` mixnet client, compiled to WebAssembly with raw TCP and UDP added (`vendor/nym-smolmix/`). The
module's files are published as one IPFS directory and pinned by size and sha256 in
`resources/nym-tunnel/nym-tunnel.json`, compiled into the app; main checks them before it forks the process,
and the process reads each file once and runs only the bytes it hashed. The host keeps **one mixnet tunnel
per app** (per SOCKS5 user name), started at the app's first request and closed after ten minutes unused, with
at most six at once: past that a new app is refused, never given another app's tunnel. The module's only
network is `https` and `wss` to public addresses, enforced where the dial takes its addresses. Main starts
the process when the first routed app needs it, on a quiet loopback port under a secret made for each start,
stops it ten minutes after the last tunnel is gone, and does not start it while a system proxy is configured.
A person's existing SOCKS5 address keeps working as it did: a settings file written before the choice existed
keeps its address as the choice.

## Context

`ADR-0080` made a tunnel the person supplies. The people Orivon is for mostly have no SOCKS5 server to point it at, so the
feature was reachable only by those who already run Tor. The owner decided that Orivon ships a mixnet client
and uses it by default. Nym publishes a client as a Rust crate that builds for WebAssembly, with fetch, WebSocket and
DNS only; the tunnel needs any TCP stream and UDP datagrams, so the module gets two functions added (a 177-line patch).

## Alternatives considered

- **A native Nym or Tor binary.** Rejected: Rule 8 and `ADR-0040`; one download per operating system, and no confinement
  beyond what Orivon adds around a program it cannot look into.
- **Run the module in the verifier host.** Rejected: that process holds every untrusted parser and serves every
  protocol's pages; a trap or a leak in a mixnet client should end only the client.
- **Run it in a hidden page, or in the main process.** Rejected: a page needs grants for every gateway; the main
  process must not run network-facing WebAssembly.
- **One tunnel shared by every routed app.** Rejected: apps would be linkable by their exit address and timing, and a
  SOCKS5 server that isolates by credentials (Tor's default) is what the route already promises.
- **Reuse a module instance after a tunnel closes.** Not possible: after `disconnectMixTunnel` the same instance refuses
  a new tunnel (measured), so each tunnel is a fresh instance.
- **A maintained SOCKS5 server package.** None carries UDP ASSOCIATE; the host's is about 300 lines (see its README).

## Reasoning

This is not app code. The module is WebAssembly pinned by hash, whose glue is generated at our build and reaches only the globals the host
hands it; its network is a dispatcher that dials nothing but public addresses over TLS, so a hostile gateway
cannot make it reach the local network. It follows `ADR-0078`'s reasoning for the Swarm node. A crash ends the process, never the shell. A mixnet adds
delay and cover traffic against an observer who sees both ends of a connection, which a circuit network does not, and the
person who prefers Tor keeps it.

## Consequences

- A fifth bundle entry (`nym-tunnel-host`) and a resources folder that `package:*` fetches (`--required`); a build
  without the module has Nym off with a reason, and a routed app on Nym fails closed.
- The module's crate notices (`THIRD_PARTY_LICENSES`, from `cargo-about`) are published with it, because the licences of
  its 600 or so crates ask for their copyright notices in a binary distribution.
- Nym's gateways see this computer's address; the destinations see the exit. A first connection takes about ten
  seconds on a cold start (a tunnel up in 3 to 8 s, a first HTTPS GET in 5 to 6 s) and a UDP round trip about a second.
- The process holds about 130 MB with the module loaded and 6 to 15 MB more per tunnel (222 MB at six).
- Each tunnel's module instance stays in the process until it exits, so the process is replaced after it has started 24 tunnels.
- The module cannot half-close a stream, so a client's end of sending is not passed on: the stream is closed ten quiet seconds after it.
- `settings.json` is written as version 2; a build before this one reads none of it.
- Nym's paid bandwidth credentials are not used: the mixnet answers without them today. If that changes, the Nym
  choice says so and refuses, and never goes direct.

## Reversibility

- **Cost to reverse:** moderate. The host is one folder, one bundle entry and one subsystem file in `src/main/route/`; the
  route is unchanged by it. Removing the default would leave the SOCKS5 choice as it was.
- **What would make us revisit:** Nym's client no longer answering without credentials, a module that cannot be
  built reproducibly, or a mixnet exit pool too small to give each app an address of its own.
