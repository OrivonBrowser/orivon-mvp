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
[`handles.ts`](handles.ts)'s own header for the full reasoning, and
[`handle-contracts.md`](../../../docs/architecture/handle-contracts.md) for the specification.

1. **Every operation re-checks ownership.** A handle id issued to one origin and presented by
   another is rejected, never ignored. Capability is checked once at acquisition; ownership is
   checked every time.
2. **Every handle records the grant that authorised it**, captured at acquisition — that is what
   revocation walks. A derived handle takes its grant from its parent and cannot be given another.
3. **Revocation is immediate and abrupt.** Waiting for in-flight work would make the revoke
   button mean "once the app finishes", and completion time is under the app's control.
4. **Limits are enforced by rejection, never by queueing.** An unbounded queue on the broker's
   thread is how one misbehaving origin freezes every tab.

## Design notes

Why the code here has the shape it has. This is the destination
[`code-guidelines.md`](../../../docs/development/code-guidelines.md) Rule 1 names for rationale: a
source comment protects a specific line from a specific mistake; the case for a file's overall
shape belongs here instead.
