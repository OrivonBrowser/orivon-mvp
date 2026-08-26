# `src/nostr/` — `window.nostr` (NIP-07)

**What lives here.** The NIP-07 injection, backed by `orivon.id`'s **named identities**.

**What it depends on.** [`src/contracts/`](../contracts/).

**What it must never import.** [`src/broker/`](../broker/) internals.

**Owner stream.** `nostr` — build step 7.

**Named identities, not app keys.** An npub must be the **same** across every client site, or
follows, posts and identity fragment per client. App keys are per-origin and cannot support
this — a correction recorded in
[`capability-api.md`](../../docs/architecture/capability-api.md) §Two kinds of identity after
the original draft got it backwards.

**No raw signing oracle.** `signEvent` takes a structured object; the broker serialises and
screens `kind`. Kinds 1/6/7 sign silently after the connect prompt; 0, 3, 5, 22242 and any
delegation prompt every time. `ADR-0003` excludes key export, so a user cannot rotate away
from a mistake here.

**Verify against real clients early** ([`open-questions.md`](../../docs/open-questions.md) C4).
The release checklist requires the displayed npub to be **byte-identical across two pinned
clients**.
