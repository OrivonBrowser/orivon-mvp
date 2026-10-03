# ADR-0054: A Web3 Score provider is any address, asked by hash bucket

- **Status:** accepted
- **Date:** 2026-10-03
- **Type:** product
- **Decided by:** owner (provider chosen in Settings, any protocol, a static manager tool, hash
  buckets); AI recommendation accepted by default (grant warnings, unsigned files)

## Decision
The person chooses a Web3 Score provider in Settings (`web3.scoreProvider`): any address Orivon
opens, resolved by the address bar's own parser, so `https://`, `http://127.0.0.1`, `ipfs://`, a
`.eth` name and every protocol Orivon adds later work with no change to the client. Empty, the
default, asks nobody. For a page whose observed Website level is 2, Orivon fetches
`<provider>/provider.json`, then `<provider>/website/<bucket>.json`, where the bucket is the first
`bucketHexChars` (1 or 2) hex characters of the SHA-256 of the page's identifier
(`sha256:<bundle hash>` or `cid:<CID>`), and finds the identifier inside that file itself. The judged level is shown with
the provider's name, beside what Orivon observed, and never silences a capability grant warning.
The wire format is `docs/architecture/web3-score-provider.md`; a provider is built as a static
site by [web3-score-manager](https://github.com/OrivonBrowser/web3-score-manager).

## Context
`open-questions.md` A250 asked who provides this build's judged levels. `ADR-0006` had answered
the mechanism: signed attestations, subscribed to as feeds and verified offline, so that a
provider could not learn what a person browses. No feed format, signing key or subscription
existed, and build step 7 needed real judged levels for the ports Orivon runs.

## Alternatives considered
- **The exact identifier in the URL** (`<provider>/website/sha256/<hash>.json`, or the owner's
  first sketch `<provider>/score/<type>/<hashType>:<hash>`). Simplest for a dynamic server, but
  the provider learns every site a person opens: the tracking `ADR-0006` exists to prevent. The
  colon form also cannot be written as a file name on Windows, so a static provider could not be
  built there.
- **Download the provider's whole list** and look up locally, as `ADR-0006` described. Nothing
  leaks, but the download grows with the provider, and a provider with a million entries would
  send every person all of them. A provider that wants this sets `bucketHexChars` to 1; the
  standard does not need a second mode for it.
- **A provider's Level 4 silences grant warnings, as the developer override does** (`ADR-0037`).
  Rejected: the override is a file only the person at the keyboard can write, while a provider is
  a remote party, reached over plain `http` in the test setup, whose files nobody signs. One
  compromised provider could then remove every breadth warning from any site it named.

## Reasoning
Buckets keep most of the property `ADR-0006` cared about: no request names a site, only one of at
most 256 groups that many sites share, while lookups stay small and every provider is a set of
static files any host or IPFS can serve. The bucket width is capped at 2 hex characters by the
client, not left to the provider: the sites a client asks about can be listed in advance, and at
4,096 buckets or more most buckets hold one known site, so a provider choosing a wide bucket
would learn the site. The provider still sees each request's address and time, and one that knows
only a few sites can guess from a bucket; the Settings help and the spec both say so. Resolving the address with the address bar's parser is the one place Orivon
already decides what an address means, so the provider setting gains each new protocol for free.

## Consequences
- Judged levels exist in this build: Website Levels 3 and 4, plus a provider's own list of a
  site's operations and connections on their canonical scales. Operation and connection subjects
  can be published but are not looked up yet.
- Provider files are **unsigned**, *provisional*: the transport authenticates them (TLS, a CID, a
  verified `.eth` name), and a plain `http` provider is trusted as typed. A provider served from
  mirrors would settle this: the standard then gains a signature field a version 1 reader ignores.
- Only pages with DDOC are asked about, so a page Orivon did not check never shows a judged level.
  A local origin in developer mode is asked about the hash in the tree it serves, and says so.
- `ADR-0037` now applies to the developer override only. `ADR-0006`'s offline feeds are replaced
  by bucket lookups; its rule that a judged level is named, shown apart from evidence and grey `?`
  without a match stands.

## Reversibility
- **Cost to reverse:** moderate. The client is two files (`src/trust/score-provider.ts`,
  `src/main/browsing/score-provider-client.ts`); every published provider follows the standard,
  so changing the request shape means a version 2 that providers publish beside version 1.
- **What would make us revisit:** a provider with enough entries that one bucket file outgrows
  1 MiB at `bucketHexChars` 2 (about 250,000 evaluations), a signed-provider requirement from a
  real deployment, or evidence that 256 buckets are narrow enough to identify the sites people
  actually visit.
