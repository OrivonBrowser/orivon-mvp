# `src/resolution/`: name resolvers and data gatherers

**What lives here.** The two provider shapes the canonical
[DNS resolution](https://docs.orivonstack.com/docs/implementations/dns-resolution) and
[Data gathering](https://docs.orivonstack.com/docs/implementations/data-gathering) pages give
Apps, as internal TypeScript: a `NameResolver` returns a name's records for the top-level domains
it declares, and a `DataGatherer` loads a site from those records and reports DDOC. Plus the
registry that orders them, the one rule both an open page and an installed app use to judge a
chain of pointers, and two helpers the providers and the verifier host share: DNS-name validation
([`dns-name.ts`](dns-name.ts)) and a concurrency limit ([`slots.ts`](slots.ts)).

In this build each list has one built-in entry: the ENS resolver ([`src/ens/`](../ens/)) for
`.eth`, and the IPFS gatherer ([`src/ipfs/`](../ipfs/)). Ordinary ICANN names never pass through
here; Chromium resolves them. Opening these interfaces to third-party Apps would be a
`src/contracts/` change, and is not part of this build.

**Not tied to Electron.** Durable: nothing here would change if the shell did.

**What it depends on.** Nothing outside this directory.

**What it must never import.** `electron`, `node:*`, any package, and every other `src/`
directory. It is imported by [`src/ens/`](../ens/), [`src/ipfs/`](../ipfs/), the verifier host
and the shell, so an edge out of it would reach all of them.

**Owner stream.** `ens-ipfs`.

## Design notes

Why the code here has the shape it has. This is the destination
[`code-guidelines.md`](../../docs/development/code-guidelines.md) Rule 1 names for rationale: a
source comment warns about a trap a maintainer would otherwise fall into, and the argument for
a design belongs here instead.

**[`providers.ts`](providers.ts)'s gatherer mounts a site once, then opens paths under it.**
The canonical page describes a gatherer that loads a site from its records. Following the pointers
from those records to a root (a signed IPNS record, a DNSLink) happens once per mount, so every
file of one page, and every asset of one installed bundle, is read from the same root. Resolving
per file would let an IPNS update land halfway through a page, and a bundle hash would then cover
files from two releases.

**[`records.ts`](records.ts) holds CIDs and keys as strings.** They cross a `MessagePort` between
the verifier host and the shell, and this directory stays free of any IPFS library. The gatherer
parses them and refuses anything that does not parse, so a string here is never trusted as a
valid CID.

**An empty record list counts as a failure in [`registry.ts`](registry.ts).** The canonical
fallback hands a name to the next resolver when one "fails to solve" it, and a resolver that finds
nothing has not solved it. A thrown error that is not a `ResolutionError` is a bug, and counts as
`unavailable`, never as an answer or as a proven absence.

**When every provider fails, the most specific failure is shown.** `mostSpecificFailure` ranks a
detected lie (`unverifiable`) above everything else, so that "one gateway was down" never hides
"another sent a block that failed its hash". The message keeps every provider's reason.

**[`pointer-chain.ts`](pointer-chain.ts) judges the pointers, not the bytes.** DDOC for a `.eth`
name has two halves: every pointer from the name to the root verified, and every byte served
checked against the root. The gatherer's per-navigation report adds the second. An installed app
has only the first to store, since its bytes were checked when it was pinned. A DNSLink hop is
not verified, because DNS can forge the TXT record; the bytes are still checked against the CID it
named. That is why a DNSLink name is Level 1 and not a failure. A test build's `fixture`
provenance counts as proven: the seam that produces it is compiled out of an ordinary build.
