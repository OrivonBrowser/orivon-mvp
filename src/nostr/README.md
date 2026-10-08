# `src/nostr/`: `window.nostr` (NIP-07)

**What lives here.** The NIP-07 injection, backed by `orivon.id`'s **named identities**: an npub
must be the same on every client site, which a per-origin app key cannot give
([`capability-api.md`](../../docs/architecture/capability-api.md) section Two kinds of identity).

**What it depends on.** [`src/contracts/`](../contracts/).

**What it must never import.** [`src/broker/`](../broker/) internals.

**Owner stream.** `nostr`, parked: Nostr identity is an idea, not a build step
([`docs/roadmap.md`](../../docs/roadmap.md), Later).

**No raw signing oracle.** `signEvent` takes a structured object; the broker serialises and
screens `kind`. Kinds 1/6/7 sign silently after the connect prompt; 0, 3, 5, 22242 and any
delegation prompt every time. `ADR-0003` excludes key export, so a user cannot rotate away from a
mistake here. Check the injection against real clients before relying on it
([`open-questions.md`](../../docs/open-questions.md) C4).
