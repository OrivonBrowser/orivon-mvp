# `src/shim/http/`: `http` and `https` over a real `net.Socket`

**What lives here.** Node's `http`/`https` client: every request runs over its own real
`net.Socket` (a `TLSSocket` for `https`) and is never pooled. `createServer` refuses by name.

**What it depends on.** [`../../contracts/`](../../contracts/), [`../errors.ts`](../errors.ts),
[`../node-errors.ts`](../node-errors.ts), [`../unimplemented.ts`](../unimplemented.ts),
[`../stream-bytes.ts`](../stream-bytes.ts) and [`../net/`](../net/).

**What it must never import.** `electron`, or [`../../broker/`](../../broker/): see the parent
README's "What it must never import".

**Owner stream.** `shim`, build step 3.
