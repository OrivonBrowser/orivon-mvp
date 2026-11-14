# `src/`: the browser itself

Everything the Orivon shell is made of. Each subdirectory is one **stream**, a unit of work one
person or agent session owns end to end
([`parallel-work.md`](../docs/development/parallel-work.md) section The ownership map). How a call
travels through them, and which are tied to Electron: [`ARCHITECTURE.md`](../ARCHITECTURE.md).
Each directory's `README.md` is its map: what is here, what it may depend on, what it must never
import. Why the code has its shape is in a `DESIGN.md` beside it, read only when changing a decision there.

Run `node scripts/ai/code-map.mjs <words>` to find the directory a change belongs in (`--depth 1` lists the
directories above): every directory with what it is for, read from the tree, so the list is never out of date.

## The one rule that matters

`contracts/` references nothing outside itself, and every other directory may depend on it
([`ADR-0002`](../docs/decisions/ADR-0002-capability-api-is-the-durable-asset.md);
`npm run check:contracts` enforces it).
