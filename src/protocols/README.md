# `src/protocols/`: the ways a site is found and loaded besides DNS and HTTP

**What lives here.** Everything that turns a name or address Chromium cannot load by itself into a
page: the one function every protocol registers through, the provider interfaces behind it, each
protocol, and the process that serves their pages.
[`ADR-0038`](../../docs/decisions/ADR-0038-an-address-scheme-is-shown-as-itself-and-served-over-https.md)
is the design; [`ADR-0030`](../../docs/decisions/ADR-0030-a-eth-name-is-an-origin-served-by-a-verifier.md)
is the verifier it builds on.

| Path | Holds | Tied to Electron? |
|---|---|---|
| [`protocol.ts`](protocol.ts) | `ProtocolDescriptor`, `defineProtocol`: what a protocol is, and how one is registered | **No** |
| [`address.ts`](address.ts) | `ProtocolAddresses`: between the address a person reads (`ipfs://<cid>/x`) and the URL a page is served at (`https://<cid>.ipfs.orivon/x`) | **No** |
| [`registry.ts`](registry.ts) | `ProtocolRegistry`: which resolvers answer a host, and the fallback rule across providers | **No** |
| [`builtin.ts`](builtin.ts) | The built-in protocols' descriptors, as the shell routes and shows them | **No** |
| [`resolution/`](resolution/) | The `NameResolver` and `DataGatherer` interfaces, their records and failures | **No** |
| [`ens/`](ens/) | ENS: `.eth` names, proven through a light client | **No** |
| [`ipfs/`](ipfs/) | IPFS: `ipfs://` and `ipns://` addresses, and the gatherer every record naming IPFS content is loaded by | **No** |
| [`verifier-host/`](verifier-host/) | The utility process that runs every protocol's providers and serves their pages on loopback | **Entirely** |

**What it depends on.** The top-level files depend only on [`resolution/`](resolution/) and on
each built-in protocol's `descriptor.ts`. Each folder's own `README.md` says what it depends on.

**What it must never import.** The top-level files and every `descriptor.ts`: `electron`,
`node:*`, any package, and any protocol's code. The main process, the loader and the renderer
import [`builtin.ts`](builtin.ts), so an edge out of these would load a protocol's parser into
them. Nothing here imports [`src/main/`](../main/) beyond type-only imports;
[`src/main/verifier/`](../main/verifier/) is the shell's side, and talks to the verifier host only
over its message protocol.

**Owner stream.** `ens-ipfs`.

## Adding a protocol

1. **A folder**, `src/protocols/<id>/`, with its providers: a `NameResolver` for each namespace it
   answers, and a `DataGatherer` if its records need a new way to load content. A namespace is a
   top-level domain, `.eth`, or an address scheme, `ipfs:`.
2. **Its descriptor**, `<id>/descriptor.ts`: `describeProtocol({ id, schemes, topLevelDomains })`,
   data only. A scheme is shown as `<scheme>://<name>` and served at
   `https://<name>.<scheme>.orivon`; a top-level domain is served at the name itself.
3. **Its entry in [`builtin.ts`](builtin.ts).** From there the shell routes, shows and
   canonicalises it everywhere: the address bar, the omnibox, links, consent dialogs, the
   certificate check and the resolver rules.
4. **Its providers in [`verifier-host/protocols.ts`](verifier-host/protocols.ts)**, through
   `defineProtocol`, with the one way each may reach the network (`verifier-host/egress.ts`).

An address scheme's resolver should define `canonicalName`, and refuse in `resolve` any name that
is not its canonical spelling: the spelling becomes the origin's host, and two spellings would be
two origins for one site. `defineProtocol` refuses a resolver answering a namespace its descriptor
does not declare.

## Design notes

Why the code here has the shape it has. This is the destination
[`code-guidelines.md`](../../docs/development/code-guidelines.md) Rule 1 names for rationale: a
source comment warns about a trap a maintainer would otherwise fall into, and the argument for
a design belongs here instead.

**A descriptor is data, and the shell reads nothing else.** The main process routes hosts, shows
addresses and checks certificates from descriptors alone, so no protocol's parser runs outside the
verifier host, where every untrusted parser already runs. Registering a protocol while Orivon runs
is not part of this build; if it were, it would change a list in the shell, not load code into it.

**Every address scheme shares one suffix** ([`protocol.ts`](protocol.ts)'s `ADDRESS_SUFFIX`).
`--host-resolver-rules` is read at launch only, so a suffix per scheme would cost a restart for
each new one. One `MAP *.orivon` clause covers every scheme there will ever be; the verifier
answers `421` for a scheme nobody registered. A top-level domain cannot share it, since the name is
the host, and so still needs its own clause at launch.

**The protocol canonicalises a written address, through a redirect**
([`verifier-host/serve/server.ts`](verifier-host/serve/server.ts)'s `redirectToCanonical`). A
typed `ipfs://Qm...` is not a valid host label, and turning it into one needs the protocol's own
parser. So the shell sends every written address to its scheme's endpoint,
`https://<scheme>.orivon/<name>/<path>`, and the verifier redirects to the canonical origin. It
costs one local round trip per typed address, and keeps protocol code out of the shell.

**A name becomes one host label the way IPFS subdomain gateways do it**
([`address.ts`](address.ts)'s `labelFor`): each `-` doubled, each `.` made a `-`. A DNSLink name
fits one label that way, a CID or key needs no change, and IPFS content written for subdomain
gateways runs unchanged at the same shape of origin. A name that still cannot fit (over 63
characters, or not lowercase) is refused rather than served under a second rule.

**[`registry.ts`](registry.ts) tries resolvers in the order their protocols are given, and every
gatherer in order.** This is the canonical fallback rule of the DNS resolution and Data gathering
pages. An empty record list counts as a failure, since a resolver that finds nothing has not solved
the name. A thrown error that is not a `ResolutionError` is a bug, and counts as `unavailable`,
never as an answer or a proven absence. When every provider fails, `mostSpecificFailure` ranks a
detected lie (`unverifiable`) above everything else, so that "one gateway was down" never hides
"another sent a block that failed its hash".
