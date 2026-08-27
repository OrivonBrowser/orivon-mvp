# `src/shared/` — helpers needed on both sides of a trust boundary

**Empty by design as of 2026-08-27.** It exists so that Rule 3 of
[`code-guidelines.md`](../../docs/development/code-guidelines.md) has a legal answer, not
because anything has moved here yet.

**What lives here.** Pure, dependency-free helpers that **more than one stream genuinely needs**
and that no single stream can own — byte and string utilities, encoding primitives, small
data-structure helpers.

**What it depends on.** Nothing.

**What it must never import.** **Anything.** Not `electron`, not `node:*`, not a package, not
[`src/contracts/`](../contracts/), not another `src/` directory. A helper that needs any of
those belongs to a stream, not here.

**Owner stream.** None — it is **change-controlled**, the way [`src/contracts/`](../contracts/)
is. A change here goes in its **own PR and merges first**, never mixed with an implementation
([`CLAUDE.md`](../../CLAUDE.md) §Parallel work). One edit here can touch every stream at once,
which is the whole reason for the ceremony.

---

## Why it exists

[`src/broker/`](../broker/) must never import [`src/shim/`](../shim/), and `src/shim/` must
never import `src/broker/` — importing the broker would hand renderer-side code main-process
authority. Those boundaries are load-bearing and are not going to be relaxed.

The consequence is that a helper both sides need had **nowhere legal to live**, so whichever
stream wrote it second was forced to write a second copy. That is the one case where Rule 3
("one implementation per idea") could not be followed. This directory is the answer to it.

`src/contracts/` cannot serve the purpose: `npm run check:contracts` deliberately fails the
build if anything there references code outside itself, and runtime helpers are not contracts.

## The bar for putting something here

**Two callers on opposite sides of a boundary.** Not one. Not two callers in the same stream —
those belong in that stream, next to their use.

Moving a helper here is not free: it becomes change-controlled, it gains a second stream that
can break, and it is harder to delete. Weigh that against the duplication it removes.
[`CLAUDE.md`](../../CLAUDE.md) Rule 7 still applies — no abstractions for elegance alone.

**Same shape is not the same reason.** Two functions that look alike but answer to different
requirements are not duplicates, and merging them here creates a coupling that has to be undone
later. Extract when the *reason* is shared.

## Known candidates

Not yet moved — the refactor is a separate, owner-scheduled job.

| Helper | Current copies | Note |
|---|---|---|
| `concat(parts)` | [`derive.ts:256`](../broker/policy/derive.ts#L256), [`bundle-hash.ts:337`](../broker/policy/bundle-hash.ts#L337) | Byte-for-byte identical |
| `encodeField(value)` | [`derive.ts:215`](../broker/policy/derive.ts#L215), [`bundle-hash.ts:324`](../broker/policy/bundle-hash.ts#L324) | Same `uint32`-BE length-prefix framing; one takes a string and validates it first |

**Both pairs are inside `src/broker/policy/` — same directory, same stream.** They do not
actually need this directory, and consolidating them within the broker is the simpler fix. They
are listed because they are the concrete evidence that the duplication is real, and because
`encodeField` is a **wire format**: two copies that drift mean two subsystems disagreeing about
an encoding that hashes and derived keys depend on.
