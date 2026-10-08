# `src/protocols/resolution/`: name resolvers and data gatherers

**What lives here.** The two provider shapes a name resolver and a data gatherer have,
as internal TypeScript (the older published docs describe them; verify anything taken from there
with the owner): a `NameResolver` returns a name's records for the namespaces it
declares, and a `DataGatherer` loads a site from those records and reports DDOC. Plus
[`pointer-chain.ts`](pointer-chain.ts), the one rule both an open page and an installed app use to
judge a chain of pointers, and three helpers the providers, the verifier host and its supervisor
share ([`dns-name.ts`](dns-name.ts), [`slots.ts`](slots.ts), and [`timing.ts`](timing.ts)'s
timeouts and waits, which leave no timer or listener behind). Ordinary ICANN names never pass through
here; Chromium resolves them. Opening these interfaces to third-party Apps would be a
`src/contracts/` change, and is not part of this build.

**Not tied to Electron.** Durable.

**What it depends on.** Nothing outside this directory.

**What it must never import.** `electron`, `node:*`, any package, every other `src/`
directory, and the rest of `src/protocols/`. Every protocol, the registry, the verifier host and
the shell import it, so an edge out of it would reach all of them.

**Owner stream.** `ens-ipfs`.

## Design notes

**A CID or key in [`records.ts`](records.ts) is an unchecked string.** Records cross a
`MessagePort`, and this directory stays free of any IPFS library, so the gatherer parses each one
and refuses what does not parse; never treat one as a valid CID before that.
