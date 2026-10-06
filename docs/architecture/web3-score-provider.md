# Web3 Score providers

**Audience: anyone running a Web3 Score provider, or writing a client that reads one.** This page
is the wire format, precise enough to implement without reading Orivon's code. `ADR-0054` says why
it has this shape; [web3-score-manager](https://github.com/OrivonBrowser/web3-score-manager)
is a tool that builds a provider as a static site.

A Web3 Score provider publishes judged levels from the canonical scale
(docs.orivonstack.com/docs/implementations/web3-score): the levels a browser cannot observe by
itself, such as "this site's code is open source and runs nothing external without consent".
Each judgement is attached to a content identity, never to a domain name: a site without DDOC has
no stable identity, so nothing can be said about it.

The standard is `orivon-web3-score/1`.

## The provider address

A provider is any address Orivon can open: `https://scores.example/score`,
`http://127.0.0.1:7860/score`, `ipfs://bafy…/score`, `scores.eth/score`. Orivon resolves the
address exactly as its address bar resolves the same text, so a protocol Orivon learns to open is
a protocol a provider can be published on, with no change here.

Below, `P` is that address with any trailing `/`, query and fragment removed. Every file a client
fetches is a path under `P`.

## What a client fetches

Two kinds of file, both JSON in UTF-8, each at most 1 MiB.

### `P/provider.json`

```json
{
  "standard": "orivon-web3-score/1",
  "name": "Orivon test provider",
  "bucketHexChars": 2,
  "about": "https://scores.example/about"
}
```

| Field | Required | Meaning |
|---|---|---|
| `standard` | yes | Exactly `orivon-web3-score/1` |
| `name` | yes | 1 to 80 characters. Shown beside every level this provider judges |
| `bucketHexChars` | yes | 1 or 2: how many hex characters name a bucket (16 or 256 buckets). A client refuses any other value, for the reason §What the provider learns gives |
| `about` | no | An address where a person reads who runs the provider and how it judges |

### `P/<subject>/<bucket>.json`

`<subject>` is `website`, `operation` or `connection`. `<bucket>` is the first `bucketHexChars`
characters of the lowercase hex SHA-256 of the identifier's UTF-8 bytes, the whole identifier
including its type prefix.

```json
{
  "standard": "orivon-web3-score/1",
  "subject": "website",
  "bucket": "4c",
  "entries": [ { "id": "sha256:26054c51…", "name": "ASGARDEX", "…": "…" } ]
}
```

`subject` and `bucket` repeat the path; a client rejects a file where they differ from what it
asked for. `entries` holds every evaluation whose identifier falls in that bucket. The client
finds its identifier there itself.

**No entry is not an error.** A provider answers 404 for a bucket it has nothing in, or serves
the file with an empty `entries`; both mean "no score". Any other failure (an unreachable host, a
status other than 200 or 404, a malformed file) means "this provider did not answer", which a
client shows as such and never as "no score".

### Test vectors

| Identifier | SHA-256 starts | Bucket at 2 |
|---|---|---|
| `sha256:26054c511f3394b66c6a022a48d82e559d637ac4b111657482ec6b7a7447fbcf` | `4c965259` | `4c` |
| `sha256:b6761c9738dab8dae6c3ac00c9d048e26992ebbd5f095601f1b8e4782ee24cb2` | `daf1e649` | `da` |
| `cid:bafybeieqer67ojhi6q3eiatmrcu3r3mqjehn7hwit2satqjfnljo65fb4q` | `c6256e78` | `c6` |

## Identifiers

An identifier is `<type>:<value>`, ASCII with no whitespace.

| Type | Value | Subject | Looked up by Orivon in this build |
|---|---|---|---|
| `sha256` | 64 lowercase hex: an Orivon bundle hash ([bundle-hash.md](bundle-hash.md)) | `website` | yes |
| `cid` | A CIDv1 in lowercase base32: the root of IPFS content | `website` | yes |
| `caip10` | A CAIP-10 account, such as `eip155:1:0xab…`: the contract an operation calls | `operation` | no |
| `caip2` | A CAIP-2 chain, such as `eip155:1`: a network a connection reaches | `connection` | no |
| `origin` | An `https://host[:port]` origin: a service a connection reaches | `connection` | no |

A provider may publish operation and connection subjects now; this build of Orivon reads only
`website` buckets, and reads a website's operations and connections from inside its evaluation.

## The evaluation

```json
{
  "id": "sha256:26054c511f3394b66c6a022a48d82e559d637ac4b111657482ec6b7a7447fbcf",
  "name": "ASGARDEX",
  "version": "1.45.3",
  "evaluated": "2026-10-03",
  "trustlessity": { "level": 3, "privacy": false },
  "summary": "Open source, and runs only its own bundled code.",
  "operations": [
    { "name": "Send from the keystore wallet", "trustlessity": { "level": 3, "privacy": false }, "note": "Signed locally." }
  ],
  "connections": [
    { "name": "Blockchain data APIs", "trustlessity": { "level": 1, "privacy": false }, "note": "Answers are not checked against the chain." }
  ],
  "evidence": ["https://github.com/asgardex/asgardex-desktop"]
}
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | The identifier this evaluation is about. It falls in the bucket it is listed in |
| `name` | yes | 1 to 80 characters |
| `version` | no | At most 40 characters: the release that was evaluated |
| `evaluated` | yes | `YYYY-MM-DD`: when |
| `trustlessity` | yes | `{ "level": n, "privacy": bool }` on the subject's scale below. `privacy` may be left out, meaning false |
| `summary` | no | At most 600 characters, for a person |
| `operations` | no | Website only: at most 32 parts on the operation scale |
| `connections` | no | Website only: at most 32 parts on the connection scale |
| `evidence` | no | At most 10 addresses a person can check the judgement against |

A part is `{ "name", "trustlessity", "note"?, "id"? }`: `name` 1 to 80 characters, `note` at most
300, and `id` an identifier of the part's own subject when it has one.

### Scales

| Subject | Levels | `privacy: true` allowed at |
|---|---|---|
| `website` | 1 to 4 | 4 |
| `operation` | 1 to 5 | 4 and 5 |
| `connection` | 1 to 3 | 3 |

The meaning of each level is the canonical page's. A client rejects an evaluation whose level is
off its scale, or which claims privacy where the scale does not allow it, and treats the bucket as
holding no evaluation for that identifier.

The canonical page also names a Security score, with no levels defined yet. This standard has no
field for it: once the levels exist, a new optional field carries them, and a version 1 reader
ignores it.

## Compatibility

A reader ignores fields it does not know. A writer never changes the meaning of an existing
field; a change a version 1 reader would misread is a new `standard` value, and a client that
does not know that value treats the provider as not answering.

## What the provider learns

A client never asks for the identifier itself. From one lookup, the provider learns the bucket:
one of 16 or 256, which every site whose identifier hashes there shares. It also sees whatever
any server sees of a request: the address it came from, and when.

A bucket hides a site only among the sites the provider can tell apart in it. The set of sites a
client asks about is small and can be listed in advance (every `.eth` name's content hash is
public), so at 4,096 buckets or more most buckets hold at most one known site and the request
names it. That is why `bucketHexChars` stops at 2. Even at 256 buckets, a provider that knows only
a few sites can guess which one a bucket means. At about 1 KB per evaluation, 256 files of 1 MiB
hold about 250,000 evaluations.

A page that holds the `trust.score` grant can have Orivon ask about other sites
([How Orivon uses an answer](#how-orivon-uses-an-answer)). From those lookups the provider learns the
same thing it learns from a person's own browsing, a bucket, but for every site the page asks about,
whether or not the person opened it. It therefore learns that this person opened a page that asks
about this set of sites: the pattern of buckets one page load produces, such as the roughly sixty a
directory of sites asks for at once. It still never sees an identifier, a name or an address, and the
grant is the person's consent to that pattern.

## How Orivon uses an answer

What follows bounds this build of Orivon, not the standard.

- **Off until chosen.** Settings, Web3, "Web3 Score provider". Empty asks nothing of anyone.
- **Only over DDOC.** A site is looked up only when its observed Website level is 2, so the files
  shown are the files the identifier names: an installed app's bundle hash, or the CID a `.eth`
  name or an `ipfs://` address resolved to. On a local origin in developer mode, the bundle hash
  in the tree that origin serves stands in, and the page says it is developer mode.
- **Named, never merged into what was observed.** The shield and the Web3 Score page show a
  judged Level 3 or 4 with the provider's name; the page keeps what Orivon itself observed beside
  it. Levels 1 and 2 are observed, so a website evaluation at 1 or 2 only marks 3 and 4 as not
  met, and the shown level stays the observed one.
- **Never silences a grant warning.** A judged Level 4 leaves every capability warning in place
  (`ADR-0054`, which narrows `ADR-0037` to the developer override).
- **Fetched with no credentials**, a 10 second limit per file, answers kept for 10 minutes, and
  "did not answer" kept for 1 minute. While a slow provider (a cold IPFS fetch) is still loading,
  the shield and the page show the lookup as under way and ask again every 2 seconds until it
  answers.
- **A page can ask, with a grant.** `orivon.trust.websiteScore(address)` answers the provider's name and
  the level it judged for the content an `ipfs://` address or a `.eth` name (bare or over `https`) names,
  for a page that declared and was granted `trust.score` (`ADR-0058`). Without the grant it rejects
  `denied`. The level is the provider's raw judgement for that content, 1 to 4, with none of the shield's
  display rules applied: the page applies those itself. Any address that names no content (a web address,
  a name that does not resolve, content the provider has not evaluated), a provider that does not answer,
  and a provider description that cannot be read all answer `level: null`, naming the provider by its
  address in the last case; with no provider chosen it answers `provider: null` and asks nothing.
- **A page's lookups are its own.** Each calling origin has its own answers kept, and a `.eth` name is
  resolved in a verifier partition of that origin's own, so one page cannot learn from timing a lookup
  which sites the person opened or which another page asked about. Lookups are limited per origin to a
  burst of 128 refilling at 2 a second; past that the call rejects `limit`.
