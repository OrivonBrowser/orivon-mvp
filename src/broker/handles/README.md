# `src/broker/handles/` — what an origin is currently holding

**What lives here.** The per-origin handle table, the records behind it, and the revocation
cascade. An app receives a handle *id*; the real socket or file lives only in here.

**What it depends on.** [`src/contracts/`](../../contracts/), [`../errors.ts`](../errors.ts),
and [`../policy/origin.ts`](../policy/origin.ts).

**What it must never import.** `electron`, any `node:*` builtin, or anything that owns a real
resource. Everything with a real socket or file descriptor behind it arrives as an **injected
`destroy` callback**. That is what keeps the table testable without a network, and it is why
the table itself depends on no engine primitive — only the callbacks do.

**Owner stream.** `broker` — build step 2.

## The four properties this directory guarantees

Each is a failure that is silent when it goes wrong — see
[`handle-contracts.md`](../../../docs/architecture/handle-contracts.md) for the specification and
this file's own Design notes below for the full reasoning behind each.

1. **Every operation re-checks ownership** (security-model.md T11c). A handle id issued to one
   origin and presented by another is rejected, never ignored. Capability is checked once at
   acquisition; ownership is checked every time.
2. **Every handle records the grant that authorised it**, captured at acquisition — that is what
   revocation walks. A derived handle (e.g. a socket accepted from a server's `connections`
   stream) takes its grant from its parent and cannot be given another by the caller.
3. **Revocation is immediate and abrupt.** Waiting for in-flight work would make the revoke
   button mean "once the app finishes", and completion time is entirely under the app's control —
   a hostile app keeps a connection alive indefinitely by never finishing.
4. **Limits are enforced by rejection, never by queueing** (T11, T11b). An unbounded queue on the
   broker's thread is how one misbehaving origin freezes every tab.

## Design notes

Why the code here has the shape it has. This is the destination
[`code-guidelines.md`](../../../docs/development/code-guidelines.md) Rule 1 names for rationale: a
source comment protects a specific line from a specific mistake; the case for a file's overall
shape belongs here instead.

**Why this directory holds state, unlike [`../policy/`](../policy/).** A handle table is, by
definition, the state a capability check is re-run against — `policy/` is pure by structural
rule, so it cannot be the home for it. [`handles.ts`](handles.ts) still imports no `electron` and
touches no socket, file or fd directly: everything that owns a real resource arrives as an
injected `destroy` callback, which is what keeps the table testable and is why it depends on no
engine primitive — only the callbacks do. `ADR-0002`'s amendment is explicit that the migration
ladder is Node → Mojo, and that Wasmtime would be a different app model rather than a swap
beneath a stable API — that ladder lives in the ADR, not restated here.

**Split across five files** ([`code-guidelines.md`](../../../docs/development/code-guidelines.md)
Rule 2): [`handle-contracts.ts`](handle-contracts.ts) (types), [`../errors.ts`](../errors.ts)
(`OrivonError`), [`handle-store.ts`](handle-store.ts) (`OriginTable`, one origin's state),
[`origin-registry.ts`](origin-registry.ts) (the map of origins), and [`handles.ts`](handles.ts)
itself (the operations run against that map).

**A deviation from the spec is recorded in `handle-contracts.md` and in `open-questions.md`, not
only in source comments** — a code comment is the one place a reader of the specification will
not look ([`CLAUDE.md`](../../../CLAUDE.md) rules 1 and 3).
