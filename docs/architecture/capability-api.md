# Capability API — v0 specification

> **Status: DRAFT, needs owner review before any code is written.**
>
> Per ADR-0002 this is the highest-care artefact in the repository. The Electron shell is
> disposable; **this interface is not.** Every app ever written for Orivon codes against it,
> and it must survive the swap from Node → Wasmtime → Chromium/Mojo underneath.
>
> `orivonApiVersion: 0` explicitly means **unstable** — breaking changes are permitted while
> it is 0. Once it reaches 1, breaking changes require a major version bump and an ADR.

## Design rules

1. **Mirror Node's API shapes.** Not because they are elegant, but because it makes
   `orivon-node-shim` mechanical and tier-2 porting cheap (see `app-compatibility.md`).
   Deviate only where the IPC boundary forces it.
2. **Everything is async.** Node constructs sockets synchronously; across an IPC boundary we
   cannot. All entry points return Promises. The shim reconciles this by buffering.
3. **Handles, not ambient authority.** `connect()` returns a handle; later operations
   reference the handle. Capability is checked once, at acquisition. This avoids TOCTOU and
   avoids re-authorising on every call.
4. **Declare statically, grant dynamically.** The manifest declares what an app *may* ask
   for; the user grants what it *actually gets*. An app can never obtain a capability absent
   from its manifest, even with user consent.
5. **No capability is implicit.** Absence from the manifest means absence, not default-allow.

## Origin — the isolation key

An app's **origin** keys everything: its storage domain, its session partition, its grant
ledger entry, and its derived identity key (ADR-0003, ADR-0005).

- HTTPS-delivered apps use the **standard web origin** — scheme + host + port. Deliberately
  the web's definition, not a new one.
- IPFS- and ENS-delivered apps will key on CID / ENS name. Deferred until trustless
  resolution exists.

> **This definition must be settled before the first grant is persisted.** Changing it later
> invalidates every stored grant and orphans every app's data.

## Manifest

Served alongside the app's frontend assets and fetched before first run.

```jsonc
{
  "orivonApiVersion": 0,
  "id": "app.orivon.torrent",        // reverse-DNS, informational; origin is the real key
  "name": "Orivon Torrent",
  "version": "0.1.0",
  "entry": "index.html",

  "capabilities": {
    "net": {
      "tcp": {
        "connect": ["*:*"],           // host:port patterns, "*" wildcard
        "listen":  ["6881-6889"]      // port ranges
      },
      "udp": { "bind": ["6881-6889"], "send": ["*:*"] }
    },
    "fs": { "quotaBytes": 53687091200 },
    "id": { "curves": ["secp256k1"] }
  }
}
```

**Honesty note on P2P apps.** The torrent app genuinely needs `tcp.connect: ["*:*"]` and
`udp.send: ["*:*"]` — DHT and peer exchange reach arbitrary hosts. That is close to
unrestricted network access, and the grant prompt must say so in plain words
(*"connect to any computer on the internet"*), not hide it behind a pattern string. This is a
real property of P2P software, and understating it would be the kind of dishonesty the trust
indicator exists to prevent.

## v0 surface

```ts
orivon.version                       // => 0

// --- app introspection ---
orivon.app.manifest()                // => Manifest
orivon.app.grants()                  // => Grant[]  (what was actually granted)
orivon.app.requestGrant(cap)         // => Promise<boolean>  (may prompt the user)

// --- net ---
orivon.net.connect({ host, port })   // => Promise<TcpSocket>
orivon.net.listen({ port })          // => Promise<TcpServer>   // emits 'connection'
orivon.net.udpBind({ port })         // => Promise<UdpSocket>

// --- fs, rooted at the app's files directory ---
orivon.fs.readFile(path, opts)
orivon.fs.writeFile(path, data, opts)
orivon.fs.open(path, flags)          // => Promise<FileHandle>
orivon.fs.mkdir / readdir / stat / rm / rename
orivon.fs.userSelected(opts)         // => OS file picker; user's choice IS the consent

// --- identity ---
orivon.id.publicKey({ curve })       // => Promise<Uint8Array>   per-origin derived
orivon.id.sign({ curve, payload })   // => Promise<Uint8Array>
```

### Deliberately **not** in v0
- **`subprocess`** — no tier-3 app is in the MVP (Bisq is cut), so it buys nothing and costs
  the largest attack surface in the design.
- **`hid` / USB** — no wallet app in the MVP.
- **Raw sockets / ICMP** — no use case, and unreachable from WASM later anyway.

> **Recorded narrowing:** ADR-0002 says `subprocess` and `hid` are "not grantable to unsigned
> apps". This spec narrows further — they are absent from v0 entirely, for signed apps too.
> Noted here rather than silently diverging from the ADR.

### Rules that apply to every app, signed included
- `fs` is confined to the app's files directory. `..` traversal is rejected. Outside access
  exists only via `fs.userSelected`.
- `net` requires manifest-declared patterns, surfaced verbatim in the grant prompt.
- `id` returns per-origin **derived** keys. The seed is never exposed and raw export is not a
  capability at any tier.
- The app's **code cache is read-only to the app** (ADR-0003). An app that could rewrite its
  own code would escape the manifest its grants were issued against.

## Throughput — the open risk

Per-message Electron IPC is too slow for torrent-rate data. Sockets therefore carry their
data over a dedicated **`MessageChannelMain` port** per handle, rather than through the main
IPC channel. Control operations (open, close, options) use normal IPC; bulk bytes use the
port. Video is delivered to `<video>` via MediaSource.

**This is unproven and is the subject of the week-1 spike in ADR-0005.** If throughput is
inadequate, the fallback is running `webtorrent` privileged in the main process for the MVP,
recorded as known debt.

## Why this survives the engine swap

Apps call `orivon.net.connect`. Underneath, that is:

| phase | implementation |
|---|---|
| month 1 | Node `net.Socket` in the main process |
| later | a Wasmtime host function |
| later | Mojo IPC in a Chromium fork |

None of those transitions is visible to an app already written. That property — not Electron,
not Wasmtime — is what keeps the path to a Chromium fork open.

## Open questions before this leaves draft
- Should `net.listen` be grantable to unsigned apps? It opens a port to the internet: high
  blast radius, but not arbitrary code execution. Currently proposed as grantable with a
  distinct, more serious prompt.
- Does the grant ledger record grants per origin permanently, or per origin + manifest
  version? Manifest-versioned grants are safer (a new manifest re-prompts) but noisier.
- Is `fs.quotaBytes` enforced by the broker, or advisory? Enforcement is more work but a
  torrent app can otherwise fill the disk.
