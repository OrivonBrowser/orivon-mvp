# `src/nostr/`: `window.nostr` (NIP-07)

**What lives here.** The NIP-07 injection, backed by `orivon.id`'s **named identities**.

**What it depends on.** [`src/contracts/`](../contracts/).

**What it must never import.** [`src/broker/`](../broker/) internals.

**Owner stream.** `nostr`, parked: Nostr identity is an idea, not a build step
([`mvp-scope.md`](../../docs/mvp-scope.md) §LATER).

**Named identities, not app keys.** An npub must be the **same** across every client site, or
follows, posts and identity fragment per client. App keys are per-origin and cannot support
this; see [`capability-api.md`](../../docs/architecture/capability-api.md) §Two kinds of
identity.

**No raw signing oracle.** `signEvent` takes a structured object; the broker serialises and
screens `kind`. Kinds 1/6/7 sign silently after the connect prompt; 0, 3, 5, 22242 and any
delegation prompt every time. `ADR-0003` excludes key export, so a user cannot rotate away
from a mistake here.

**Verify against real clients early** ([`open-questions.md`](../../docs/open-questions.md) C4).
The release checklist requires the displayed npub to be **byte-identical across two pinned
clients**.

## Design notes

Why the code here has the shape it has. This is the destination
[`code-guidelines.md`](../../docs/development/code-guidelines.md) Rule 1 names for rationale: a
source comment protects a specific line from a specific mistake; the case for a file's overall
shape belongs here instead.

**`errors.ts` and `hex.ts` each carry a small local duplicate rather than importing across the
broker/nostr trust boundary.** This directory may never import
[`src/broker/`](../broker/) internals, and `src/shared/`, the sanctioned home for a helper
needed on both sides of a boundary, exists but moving either helper there is its own
change-controlled PR (`code-guidelines.md` Rule 3), not something this directory can do
unilaterally. A pure three-line error constructor and a lowercase-hex encoder are cheap enough
to duplicate once rather than block on that change.
