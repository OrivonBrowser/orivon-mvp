# `src/broker/handles/`: what an origin is currently holding

**What lives here.** The per-origin handle table, the records behind it, and the revocation
cascade. An app receives a handle *id*; the real socket or file lives only in here.

**What it depends on.** [`src/contracts/`](../../contracts/), [`../errors.ts`](../errors.ts),
and [`../policy/origin.ts`](../policy/origin.ts).

**What it must never import.** `electron`, any `node:*` builtin, or anything that owns a real
resource. Everything with a real socket or file descriptor behind it arrives as an **injected
`destroy` callback**, which keeps the table testable without a network.

**Durable.** The table depends on no engine primitive; only the injected callbacks do.

**Owner stream.** `broker`, build step 2.

## The four properties this directory guarantees

Each fails silently when it goes wrong. The specification and the reasoning are
[`handle-contracts.md`](../../../docs/architecture/handle-contracts.md) section Common shape,
section Revocation and section Limits.

1. **Every operation re-checks ownership** (T11c). A handle id presented by another origin is
   rejected, never ignored.
2. **Every handle records the grant that authorised it**, and revocation walks that. A derived
   handle takes its parent's grant and cannot be given another.
3. **Revocation is immediate and abrupt**, never waiting for in-flight work.
4. **Limits are never enforced by an unbounded queue** (T11, T11b). Resource counts refuse at
   once; the in-flight cap lets an operation wait briefly in a bounded queue.

## Design notes

**Why this directory holds state, unlike [`../policy/`](../policy/).** A handle table is the
state a capability check is re-run against, and `policy/` is pure by rule. The split across
files is by concern; each file's header says which.

**A handle that has ended answers its owner with how it ended**: `'revoked'` when a grant, pick
or session was withdrawn, `'closed'` with `platformCode: 'EBADF'` otherwise. Every other origin
still gets the uniform `'denied'`, so this reveals nothing about ids an origin never held.

**The in-flight cap queues briefly instead of refusing** ([`in-flight.ts`](in-flight.ts)).
Node never refuses work for being concurrent, so ported code that fires a few hundred reads or
connects at once treated `'limit'` as a hard error. T11b needs the queue bounded, not absent: it
is bounded in length and in time, a waiting call runs nothing, and the queue is per origin, so
one origin's queue never delays another's. A waiting call is registered with the handle or grant
it needs, so a close or revoke cancels it like a running one.

**An app can abandon a call of its own** (`HandleTable.run`'s `abandon` signal, [`abandon.ts`](abandon.ts), `ADR-0071`).
The call rejects `'closed'` at once and its slot, or its place in the queue, is free whether or not the work notices:
`run` stops waiting for the work, which is why an abandoned dial that ignores the abort still frees its slot.

**Replacing a grant is not revoking it** ([`grant-replacement.ts`](grant-replacement.ts)). A
wider `app.requestGrant`, or install consent after an update, replaces a capability's one live
grant, and revoking every handle then reset every connection an app held the moment it asked for
*more*. Each handle is judged instead by its `stillCovered` predicate: the policy decision that
authorised it, re-run on what it actually reached, never resolving again. An acquisition still in
flight has nothing to judge, so it follows the new grant only when that covers the old one
entirely (the old id becomes an alias; aliases are bounded by the number of replacements and
dropped with the table); otherwise it is cancelled as a revoke would, which fails closed.

**The unlink hook** (`HandleTable.onUnlink`) exists for the socket relay:
[`../transport/README.md`](../transport/README.md), "The unlink hook".

**A deviation from the spec is recorded in `handle-contracts.md` and `open-questions.md`**, not
only in a source comment, which is the one place a reader of the specification will not look.
