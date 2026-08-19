# ADR-0003: Local-first storage with per-app isolation

- **Status:** accepted
- **Date:** 2026-08-18
- **Type:** architecture
- **Decided by:** AI recommendation, accepted by owner

## Decision
All application data is stored **on the user's machine**. Orivon operates **no server for
application data**, in the MVP or after it. Each app receives an isolated storage domain
keyed by its origin, and identity secrets live outside every app's reach.

Four storage tiers, deliberately distinct:

| Tier | What | Where | Who can read it |
|---|---|---|---|
| **App code cache** | manifest + frontend assets fetched per ADR-0005 | `<userData>/apps/<origin>/code/` | broker only; apps cannot write here |
| **App files** | app-managed data — torrent payloads, caches, resume state | `<userData>/apps/<origin>/files/` | that app, via `orivon.fs` |
| **App web storage** | localStorage, IndexedDB, cookies, cache | a dedicated Electron `session` partition per origin | that app's renderer only |
| **Browser secrets** | identity seed, grant ledger, settings | `<userData>/`, encrypted via Electron `safeStorage` (OS keychain) | **no app, ever** |

## Context
The owner asked directly whether data for apps opened by URL is stored locally or remotely.
The question matters more here than in an ordinary browser because Orivon's product claim is
trustlessness, and remote storage is by definition a party the user must trust.

## Alternatives considered
- **Orivon-operated sync/backup service.** Rejected. It would introduce exactly the
  centralised dependency the project exists to remove, would score badly on Orivon's own
  Trustlessity ladder, and would impose hosting cost and operational burden on a solo
  developer with a ~€50 budget.
- **Shared storage between apps** (one common data directory). Rejected: an app could read
  another app's data, breaking the permission model before it starts.
- **Storing identity keys inside the app sandbox.** Rejected: apps must never hold key
  material. They receive per-origin *derived* keys and signatures, never the seed.
- **Letting apps write to their own code cache.** Rejected: an app that can rewrite its own
  code can escape the manifest the user granted capabilities against. Code is broker-managed
  and read-only to the app.

## Reasoning
Local-first is not a close call — four independent arguments converge:
1. **Trustlessness.** Local data requires trusting nobody. This is the product thesis.
2. **The flagship demands it.** Torrent payloads, DHT routing tables and resume state are
   inherently local.
3. **Nostr fits it exactly.** Keys must be local; relay content is re-fetchable from any
   relay, so caching is convenience rather than dependency.
4. **It costs nothing to run.** No servers means no hosting bill and no operational surface.

Per-app isolation reuses mechanisms that already exist rather than inventing any: the app
files directory *is* the `orivon.fs` root from ADR-0002, and Electron `session` partitions
give renderer-side isolation essentially for free.

**Origin is the isolation key**, which ties this ADR to ADR-0005: a URL-addressed app's origin
determines its storage domain, its session partition, its grant ledger entry, and its derived
key from `orivon.id`. Origin must therefore be defined precisely *before the first grant is
persisted*, because changing the definition later invalidates every stored grant and orphans
every app's data. This is the single most consequential detail in the storage model.

## Consequences
- **No cross-device continuity.** A user's torrents and Nostr identity do not follow them to
  another machine. Accepted for the MVP; sync is out of scope.
- When sync is eventually built, the honest design is a **user-chosen backend** — their own
  server, Nostr relays, or IPFS — never an Orivon-operated one. Recorded now so a future
  contributor does not reach for the easy centralised option.
- **Disk usage becomes a first-class UI concern**, because torrent payloads are large. The
  MVP needs a visible per-app disk usage view and a way to delete data — a real, small scope
  item that follows directly from the flagship choice.
- **Uninstalling an app must remove all four tiers** for that origin. Partial deletion would
  leave a tracking surface behind.
- Identity keys being OS-keychain-backed means a user who loses their machine loses their
  Nostr identity. Identity export/backup is **not** in the MVP; it is the first thing to add
  if identity becomes valuable to users.
- The code cache needs integrity verification (ADR-0005), otherwise a compromised host can
  silently replace an app that already holds capability grants.

## Reversibility
- **Cost to reverse:** cheap in one direction (adding optional user-chosen sync later),
  expensive and values-breaking in the other (moving app data to an Orivon server).
  The origin-key definition is the expensive part — see Reasoning.
- **What would make us revisit:** users asking for cross-device continuity in numbers — at
  which point the answer is user-chosen backends, not an Orivon service.
