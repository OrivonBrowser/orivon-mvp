# Nym tunnel module

Nym's `smolmix` WebAssembly client with raw TCP and UDP added, built for Orivon from
`nymtech/nym` at tag `nym-binaries-v2026.20-glasgow` (commit `28904698fd68337cc722d51ab21f29f4fd6c56ce`).
It is the Nym mixnet client that Orivon runs as the built-in tunnel for installed apps.

| File | What it is |
|---|---|
| `smolmix_wasm_bg.wasm` | The client, compiled to WebAssembly |
| `smolmix_wasm.js` | Its wasm-bindgen glue (an ES module) |
| `smolmix_wasm.d.ts` | The glue's types |
| `LICENSE` | Apache-2.0, Nym's licence for all of it |

**Exports beyond Nym's.** `connectTcp(host, port)` resolves the name through the mixnet and
returns `read()` (a chunk, or `null` at the end), `write(bytes)` and `close()`. `bindUdp()` returns
`sendTo(host, port, bytes)`, `recv(timeoutMs?)` and `close()`. Nym's own `mixFetch`, `mixWebSocket`
and `mixDNS` are unchanged.

**It needs** `WebSocket` (to Nym's gateways), `fetch` (Nym's directory), `indexedDB`,
`crypto.getRandomValues` and timers. One tunnel per module instance.

**Where the source and the patch are.** `vendor/nym-smolmix/` in the Orivon repository
(`UPSTREAM.md`, the patch, and `scripts/build-nym-tunnel.mjs`, which rebuilds these files).
