# Glossary

One canonical term per concept. Where the existing corpus disagrees, the disagreement is
recorded and a canonical form chosen.

---

## Terms the corpus spells more than one way

### DDOC is **Domain Data Ownership Confirmation**

Canonical everywhere. Three expansions are still in circulation:

| Expansion | Where |
|---|---|
| Domain Data Ownership **Confirmation** | `orivon.mdx` (published) |
| Domain Data Ownership **Certification** | `Posts/Technical Specifications` |
| **Data Domain** Ownership Certification | `Old-Private-Plan/Glossario` |

*Confirmation* is what is already published, so the live docs need no correction, and it is the
honest word: *Certification* implies an authority issuing a certificate, which is not what the
mechanism does. It verifies that received data matches what the domain owner published, on the
owner's own say-so. That distinction matters here specifically: in this build the published tree
sits on the site's own host, a `.eth` name's contenthash anchors its content off the host
(`ADR-0029`), and `open-questions.md` C1 records that the vision's DNS trust root is forgeable on
ICANN domains without DNSSEC, so *Certification* would oversell precisely the weakest link.

**Action outstanding:** correct the other two documents (`Posts/Technical Specifications`,
`Old-Private-Plan/Glossario`) to match. Not blocking the MVP.

### `+Privacy` attaches to the top rung of each ladder

It is a consequence of the ladders, not a separate choice. `+Privacy` attaches to the top rung,
not to a fixed number: the published `web3-score.md` reads "Level 4 + Privacy" for websites,
"Level 4/5 + Privacy" for operations and "Level 3 + Privacy" for connections, each being that
ladder's own top. The private `Web3 Verification levels` reads L5 for websites only because its
website ladder carries one extra rung, *"full stack runs entirely locally"*, which the public
version dropped.

`ADR-0006` and `open-questions.md` B3 already reinstate that rung. Reinstating it makes the
website ladder five rungs, and `+Privacy` lands on L5 with no separate decision required.
The action is B3's existing public-docs correction, not a new choice.

---

## Product

**Orivon**: the idea and the standard. Per `orivon.mdx`, the project is *The Orivon Project*;
Orivon itself is not owned by it.

**Web4**: the era Orivon aims to open, meaning easy interfaces to *use* Web3, as Web2 was easy
interfaces to *read and write* Web1 (`OrivonBook/Web3 Potential.md`).

**WASM Orivon Execution Layer**: current name for what earlier documents called "Advanced
WASM" or "programs on-fly". In the MVP this capability is delivered by the broker, not by
WASM (`ADR-0002`).

**Web3 Accounts**: the no-setup identity system. Silent per-origin app keys, plus
named identities (e.g. the Nostr identity) that are cross-origin by explicit consent
(`capability-api.md`). Not a wallet: no funds, no seed phrase shown, no send or receive.

**Web3 Green mark**: the site-facing incentive marking to adopt trustless technology; the
inverse of the yellow "you are in Web2" badge.

## Architecture

**Shell**: the Electron browser UI (tabs, omnibox, navigation). Explicitly disposable
(`ADR-0002`).

**Broker**: the main-process component enforcing manifests and grants, and the sole path from
app code to OS resources. Also the source of the trust indicator's behavioural data
(`ADR-0006`).

**Capability**: an ability an app may hold (`net`, `fs`, `id`). Declared in the manifest,
granted by the user.

**Grant**: a user's authorisation of a declared capability. Manifest declares; grant
authorises; absence means denial.

**Manifest**: the JSON declaring an app's identity, entry point and requested capabilities.
Fetched and pinned with the bundle.

**Origin**: the isolation key. It keys storage, session partition, grant ledger and derived
identity key. Standard web origin for HTTPS-delivered apps (`ADR-0003`).

**Bundle**: an app's manifest plus frontend assets, addressed by URL, cached locally,
hash-pinned. The manifest is a hashed leaf, not served or pinned separately, so a manifest
change alone changes the bundle hash (`ADR-0009`, `architecture/bundle-hash.md`).

**`orivon-node-shim`**: implements Node's `net`, `dgram` and `fs` over `orivon.*`, so existing
Electron apps port mechanically. Load-bearing for every Node.js app (`ADR-0005`).

**`orivon-runtime`**: the deferred Wasmtime host. Purpose: containment for untrusted code, and
mobile portability. Not cancelled (`ADR-0002`).

**`orivon-core`**: in the published docs, the client wrapping `orivon-runtime`. The MVP's
broker occupies this role; the name is not yet used in the MVP codebase.

**Developer mode**: off by default; loads unpacked, unsigned apps at the user's risk, with a
reduced capability set.

## Trust

**Trustlessity**: Orivon's term for how little trust an operation requires. Three ladders:
sites, connections, operations.

**Security score**: distinct from Trustlessity; how *risky* an operation is, as opposed to how
much trust it requires. Levels remain unspecified (`web3-score.md`: "Work in progress").

**Web3 Score**: the umbrella for Trustlessity plus Security.

**Website level**: a site's place on the canonical Web3 scores page's site ladder. Level 1 is a
standard site; Level 2 a site that meets DDOC, which the browser detects itself; Level 3 and above
are judged, and only a Web3 Score provider gives them. The Web3 Score page leads with it
(`ADR-0006`).

**Web3 Score provider**: an entity issuing judged scores. The user may choose several. Never
required for the automatic ladders. In this build a provider need not be trustless, and may run
locally (`ADR-0006`).

**Attestation**: a provider's signed statement over a content identifier, a bundle hash or a CID
("hash X is Level 4").
Verified locally and offline, so a provider cannot track users (`ADR-0006`).

**Observed behaviour**: what the broker actually saw an app do. The basis of the MVP's
indicator. Always reported as *observed*, never *guaranteed*.

**TOFU**: trust on first use. The delivery host is trusted once at install; the bundle is then
pinned, so later host compromise cannot silently swap code (`ADR-0006` D2).

## Names and content

**`.eth` name**: an ENS name, loaded as the origin `https://<name>.eth` and served by the verifier
(`ADR-0030`). A developer-mode name from `orivon-ports` is a different thing: plain HTTP on
loopback, with no verification.

**Contenthash**: the ENS record naming what a name's site is, ENSIP-7: an IPFS CID, an IPNS key,
or a DNS name to follow through DNSLink.

**CID**: an IPFS content identifier, the hash of a block and how to read it. A site's root CID
commits to every file under it, so fetching by CID and hashing what arrives is the whole
verification.

**Trustless gateway**: an HTTP server that returns IPFS blocks as raw bytes, for the client to
hash against their CIDs. It is trusted for availability only.

**DNSLink**: a DNS TXT record (`_dnslink.<domain>`) naming IPFS content. Followed, and shown as an
unproven hop: ordinary DNS can be forged on the path.

**Light client**: a client that verifies Ethereum state from block headers and proofs rather than
trusting an RPC's answer. Here, Helios, started at launch (`ADR-0031`).

**Checkpoint**: the recent finalized beacon block root the light client starts from and trusts.
Shipped with each release, replaced by the newest one verified here, refused past 14 days.

**Verifier host**: the utility process that runs the light client, fetches and hashes IPFS blocks,
and serves `.eth` names on loopback (`src/verifier-host/`).

## Compatibility tiers
**Tier 1** already a web app · **Tier 2** Electron/Node · **Tier 3** native/JVM/Qt ·
**Tier 4** does not exist yet. See `architecture/app-compatibility.md`.

---

## Deprecated usages
- **"Special extensions"** (`orivon.mdx`) → say **apps**.
- **"Wallet"** for the no-setup identity → say **Web3 Account**; reserve *wallet* for
  funds-bearing, setup-requiring accounts.
- **"Advanced WASM"** → say **execution layer**; in the MVP it is not WASM.
