# Glossary

One canonical term per concept. Where the existing corpus disagrees, the disagreement is
recorded and a canonical form chosen.

---

## Terms needing an owner decision

### DDOC — **three expansions currently in circulation**

| Expansion | Where |
|---|---|
| Domain Data Ownership **Confirmation** | `orivon.mdx` — **published** |
| Domain Data Ownership **Certification** | `Posts/Technical Specifications` |
| **Data Domain** Ownership Certification | `Old-Private-Plan/Glossario` |

**Recommendation: "Domain Data Ownership Confirmation."** It is what is already published, so
it needs no correction to the live docs, and *Confirmation* is the more honest word —
*Certification* implies an authority issuing a certificate, which is not what the mechanism
does. It verifies that received data matches what the domain owner published.

→ **Owner decision needed.** Once chosen, correct the other two documents.

### `+Privacy` bonus placement
Attaches to **L4** in the published `web3-score.md`, and to **L5** in the private
`Web3 Verification levels`. Needs one canonical answer.

---

## Product

**Orivon** — the idea and the standard. Per `orivon.mdx`, the project is *The Orivon Project*;
Orivon itself is not owned by it.

**Web4** — the era Orivon aims to open: easy interfaces to *use* Web3, as Web2 was easy
interfaces to *read and write* Web1 (`OrivonBook/Web3 Potential.md`).

**WASM Orivon Execution Layer** — current name for what earlier documents called "Advanced
WASM" or "programs on-fly". In the MVP this capability is delivered by the **broker**, not by
WASM (`ADR-0002`).

**Web3 Accounts** — the no-setup identity system: silent **per-origin app keys**, plus
**named identities** (e.g. the Nostr identity) that are cross-origin by explicit consent
(`capability-api.md`). **Not** a wallet: no funds, no seed phrase shown, no send or receive.

**Web3 Green mark** — the site-facing incentive marking to adopt trustless technology; the
inverse of the yellow "you are in Web2" badge.

## Architecture

**Shell** — the Electron browser UI: tabs, omnibox, navigation. **Explicitly disposable**
(`ADR-0002`).

**Broker** — the main-process component enforcing manifests and grants, and the sole path from
app code to OS resources. Also the source of the trust indicator's behavioural data
(`ADR-0006`).

**Capability** — an ability an app may hold: `net`, `fs`, `id`. Declared in the manifest,
granted by the user.

**Grant** — a user's authorisation of a declared capability. Manifest declares; grant
authorises; absence means denial.

**Manifest** — the JSON declaring an app's identity, entry point and requested capabilities.
Fetched and pinned with the bundle.

**Origin** — the isolation key. Keys storage, session partition, grant ledger and derived
identity key. Standard web origin for HTTPS-delivered apps (`ADR-0003`).

**Bundle** — an app's manifest plus frontend assets, addressed by URL, cached locally, hash-pinned.

**`orivon-node-shim`** — implements Node's `net`, `dgram` and `fs` over `orivon.*`, so existing
Electron apps port mechanically. Load-bearing for the flagship (`ADR-0005`).

**`orivon-runtime`** — the deferred Wasmtime host. Purpose: containment for untrusted code, and
mobile portability. **Not cancelled** (`ADR-0002`).

**`orivon-core`** — in the published docs, the client wrapping `orivon-runtime`. The MVP's
broker occupies this role; the name is not yet used in the MVP codebase.

**Developer mode** — off by default; loads unpacked, unsigned apps at the user's risk, with a
reduced capability set.

## Trust

**Trustlessity** — Orivon's term for how little trust an operation requires. Three ladders:
sites, connections, operations.

**Security score** — distinct from Trustlessity; how *risky* an operation is, as opposed to how
much trust it requires. Levels remain unspecified (`web3-score.md`: "Work in progress").

**Web3 Score** — the umbrella for Trustlessity plus Security.

**Web3 Score provider** — an entity issuing judged scores. The user may choose several. Never
required for the automatic ladders.

**Attestation** — a provider's **signed statement over a bundle hash** ("hash X is Level 4").
Verified locally and offline, so a provider cannot track users (`ADR-0006`).

**Observed behaviour** — what the broker actually saw an app do. The basis of the MVP's
indicator. Always reported as *observed*, never *guaranteed*.

**TOFU** — trust on first use. The delivery host is trusted once at install; the bundle is then
pinned, so later host compromise cannot silently swap code (`ADR-0006` D2).

## Compatibility tiers
**Tier 1** already a web app · **Tier 2** Electron/Node · **Tier 3** native/JVM/Qt ·
**Tier 4** does not exist yet. See `architecture/app-compatibility.md`.

---

## Deprecated usages
- **"Special extensions"** (`orivon.mdx`) → say **apps**.
- **"Wallet"** for the no-setup identity → say **Web3 Account**; reserve *wallet* for
  funds-bearing, setup-requiring accounts.
- **"Advanced WASM"** → say **execution layer**; in the MVP it is not WASM.
