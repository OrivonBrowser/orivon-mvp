# `src/protocols/`: the ways a site is found and loaded besides DNS and HTTP

**What lives here.** Everything that turns a name or address Chromium cannot load by itself into a
page: `defineProtocol` ([`protocol.ts`](protocol.ts)), the one function every protocol registers
through; [`address.ts`](address.ts), between the address a person reads (`ipfs://<cid>/x`) and the
URL a page is served at (`https://<cid>.ipfs.orivon/x`); [`registry.ts`](registry.ts), the
fallback rule across providers; the provider interfaces ([`resolution/`](resolution/)); each
protocol ([`ens/`](ens/), [`ipfs/`](ipfs/)); and [`verifier-host/`](verifier-host/), the process
that runs every provider and serves their pages.

**Durable**, except `verifier-host/`, which is tied to Electron.

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

1. **A folder**, `src/protocols/<id>/`, with a `NameResolver` for each namespace it answers (a
   top-level domain, `.eth`, or an address scheme, `ipfs:`), and a `DataGatherer` if its records
   need a new way to load content. An address scheme's resolver defines `canonicalName` and
   refuses in `resolve` any other spelling: two spellings would be two origins for one site.
2. **Its descriptor**, `<id>/descriptor.ts`: `describeProtocol({ id, schemes, topLevelDomains })`,
   data only. A protocol with top-level domains may also name `displayScheme`, the address scheme
   a name under one of them is shown with (`ipfs` for `.eth`); its origin stays unchanged. It may
   also give `loadingScreen` (a `title` and an optional `detail`): the words of the screen the shell
   shows over a tab while one of its pages loads. The shell draws the screen and a protocol only
   words it. A top-level-domain name whose protocol gives none shows the screen of the protocol
   serving its `displayScheme`.
3. **Its entry in [`builtin.ts`](builtin.ts).** From there the shell routes, shows and
   canonicalises it everywhere: address bar, omnibox, links, consent dialogs, the certificate
   check and the resolver rules.
4. **Its providers in [`verifier-host/protocols.ts`](verifier-host/protocols.ts)**, through
   `defineProtocol`, with the one way each may reach the network (`verifier-host/egress.ts`).

## Design notes

Why the shell reads only descriptors, why every scheme shares the `.orivon` suffix, and why a
written address is canonicalised by a redirect from the verifier:
[`ADR-0038`](../../docs/decisions/ADR-0038-an-address-scheme-is-shown-as-itself-and-served-over-https.md).
[`ADR-0030`](../../docs/decisions/ADR-0030-a-eth-name-is-an-origin-served-by-a-verifier.md) is the
verifier it builds on.
