# ADR-0007: A cached app bundle is served at its own origin, inside the app's partition

- **Status:** accepted
- **Date:** 2026-08-25
- **Type:** architecture
- **Decided by:** owner (options and recommendation prepared by AI)

## Decision
Cached app assets are served **under the app's real web origin** — `https://app.example.com` —
by intercepting requests **inside that app's `session` partition only**. The bundle keeps the
origin it was fetched from, whether it is running from the network or from disk. No custom
scheme is introduced for app delivery.

Because the address bar's padlock would otherwise assert a live TLS connection that did not
happen, **the trust indicator must show delivery provenance explicitly** — "running from local
cache, pinned" — rather than a padlock, whenever the bytes came from cache.

## Context
Closes `open-questions.md` **A11**, which recorded that this was *"unspecified anywhere"* and
needed settling **before the first grant is persisted**.

`ADR-0005` decided apps are URL-addressed, fetched, cached, and run from that cache. It never
said what origin the cached copy runs under. `ADR-0003` calls the origin *"the single most
consequential detail in the storage model"*, and `capability-api.md` §Origin states that origin
keys four separate things at once: the storage domain, the session partition, the grant ledger
entry, and the derived identity key from `orivon.id`.

So the question is not cosmetic. It decides whether an app loaded from cache is the *same app*
as the one loaded from the network.

`ADR-0005`'s evening amendment already assumed this answer — it says *"cached assets served at
the app's own origin with a fail-closed rule"* — but assumed it without recording the
alternative or the cost. That is precisely the failure mode CLAUDE.md Rule 1 exists to prevent,
so it is written down here properly.

## Alternatives considered

**A custom scheme, `orivon-app://app.example.com/`.** Rejected. It is honest about the bytes
being local, and it makes the address bar unambiguous, but it changes the origin — and origin is
the isolation key. The consequences are not edge cases:

- The same app fetched live and run from cache would be **two different origins**, and therefore
  two grant ledgers, two storage domains, and **two different derived identity keys**. Since
  `ADR-0003` excludes identity export and backup, a user whose app moved between the two states
  would have no way to recover the key they lost.
- It abandons `capability-api.md`'s deliberate commitment to *"the standard web origin — scheme
  + host + port. Deliberately the web's definition, not a new one."*
- Custom schemes carry their own quirks around cookies, CORS, service workers and secure-context
  eligibility, each of which would need separate handling — and Gate 3 of the week-0 spike
  depends on service workers being available.

**Serve from cache at a synthetic subdomain** (`app-example-com.orivon.local`). Rejected for the
same origin-change reason as above, plus it invents a namespace Orivon would have to own and
defend, and it leaks the app's identity into DNS-shaped strings that look resolvable and are not.

**Do not cache; always fetch.** Already rejected in `ADR-0005` — it breaks offline use, breaks
local executability, and re-introduces per-load trust in a remote server, which is the exact
thing the Trustlessity ladder penalises.

## Reasoning
One origin, one identity. The app's storage, permissions and keys stay stable across the network
and cache states, which is the property everything else in `ADR-0003` and `capability-api.md`
was designed against. Every alternative buys address-bar honesty by paying with key stability,
and key stability is unrecoverable while identity export stays out of scope.

The honesty cost is real but it is **payable elsewhere, and better**. `ADR-0006` already decided
the trust indicator is built from observed behaviour with an evidence-first UI. "Where did these
bytes come from" is exactly the kind of evidence it exists to display, and displaying it there is
strictly more informative than a padlock — which, on an ordinary web page, tells the user only
that *some* TLS connection succeeded.

## Consequences

- **The interception must be partition-scoped, and this is load-bearing.** Only the app's own
  `session` partition intercepts its origin. The same URL opened in an ordinary browsing tab
  must reach the real network normally. A global interception would mean Orivon silently serving
  stale local bytes for a real website, which would be a serious defect.
- **The padlock is now misleading unless the UI corrects it.** This is the unpleasant part. It
  is not optional polish: an indicator that shows a live-TLS padlock for bytes read off disk is
  making a false security claim, from a browser whose entire pitch is honest provenance. The
  cache state must be visible.
- **`ADR-0005`'s fail-closed rule becomes the security boundary.** A same-origin request whose
  path is not in the pinned set is **denied, not fetched**, and the cached tree is re-verified at
  **every load**, not only at fetch. With the origin preserved, this rule is the only thing
  separating "runs the app you approved" from "runs whatever the host serves next".
- **Verify the mechanism before building on it.** The intended implementation is
  `session.fromPartition(...).protocol.handle('https', ...)`, scoped to the partition. That
  Electron can intercept a standard scheme per-session, serve a streaming range-capable
  response, and still leave the origin a secure context for service workers, is **assumed, not
  yet confirmed**. Confirm it in the first task of build step 2, and record the result. If it
  cannot be done per-session, this ADR is the thing that has to change.
- Offline first-run keeps working for pre-cached apps, unchanged from `ADR-0005`.

## Reversibility
- **Cost to reverse:** **one-way door once the first grant is persisted.** Before that, cheap —
  it is a routing decision with no stored state behind it. After that, changing the origin
  invalidates every stored grant, orphans every app's storage, and rotates every derived
  identity key with no export path to recover them.
- **What would make us revisit:** Electron proving unable to intercept a standard scheme within
  a single partition while keeping the origin a secure context — the assumption flagged above.
  That is a mechanism failure, not a change of mind, and it must be settled in build step 2,
  before any grant is written to disk.
