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
  "publisherKey": "ed25519:…",       // pinned at install; updates must be signed by it
                                     // (ADR-0005 amendment: publisher-key continuity)

  "capabilities": {
    "net": {
      "tcp": {
        "connect": ["*:*"],           // host:port patterns, "*" wildcard
        "listen":  ["6881-6889"]      // port ranges
      },
      "udp": { "bind": ["6881-6889"], "send": ["*:*"] }
    },
    "fs": { "quotaBytes": 53687091200 },
    "id": { "curves": ["secp256k1"] },
    "protocols": ["magnet"]            // shell routes magnet: links to this app
                                       // (first registrant is default; conflicts → user chooses)
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

// --- identity: app keys (silent, per-origin) ---
orivon.id.publicKey({ curve })       // => Promise<Uint8Array>   derived per origin, no prompt
orivon.id.sign({ curve, payload })   // => Promise<Uint8Array>

// --- identity: named identities (cross-origin BY CONSENT) ---
orivon.id.requestIdentity({ kind })  // => Promise<IdentityHandle | null> — connect prompt
// IdentityHandle.publicKey() / .sign(payload): the SAME identity on every site the user
// connects it to; revocable per origin in settings
```

### Two kinds of identity — correction found in validation

The original v0 draft (and ADR-0002's rules) said `id` yields per-origin keys *only*, with no
cross-origin linkage. **That cannot support Nostr**: an npub must be the *same* across every
client site, or follows/posts/identity fragment per client — per-origin keys would issue a
different Nostr identity to snort.social and noStrudel. The earlier claim that NIP-07 was the
ideal consumer of per-origin identity was wrong. Recorded here rather than silently fixed.

| | **App keys** | **Named identities** |
|---|---|---|
| Scope | one origin, silent | cross-origin **by design** |
| Consent | none needed — cannot link users across apps | explicit connect prompt per site, revocable |
| Backing | `derive(seed, "app", origin)` | `derive(seed, "identity", identityId)` |
| Consumer | app-internal crypto | `window.nostr` (NIP-07), future wallet connect |

`window.nostr` semantics: injected in ordinary tabs; first `getPublicKey()` per site triggers
the connect prompt; after connecting, signing is silent for that site (per-event prompts would
make Nostr unusable). Presence of `window.nostr` is fingerprintable — true of every NIP-07
extension; the *data* is what sits behind consent (`security-model.md` T16).

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
- `id` app keys derive per origin silently; **named identities** are cross-origin only through
  the explicit connect prompt. In both modes the seed is never exposed and raw key export is
  not a capability at any tier.
- The app's **code cache is read-only to the app** (ADR-0003). An app that could rewrite its
  own code would escape the manifest its grants were issued against.

## How a URL becomes an app

Previously unspecified anywhere — found in validation. A normal page stays a normal page. An
origin becomes an app when the shell finds a manifest at:

```
https://<origin>/.well-known/orivon.json
```

On detection the omnibox offers **"Open as app"**; accepting runs the ADR-0005 flow (grant
prompt → fetch → cache → pin). v0 supports the well-known path only; a `<link rel>`
alternative can come later. Protocol routing (`"protocols": ["magnet"]`) is what lets a magnet
link pasted in the omnibox reach the torrent app at all.

## Throughput — the open risk

Per-message Electron IPC is too slow for torrent-rate data. Sockets therefore carry their
data over a dedicated **`MessageChannelMain` port** per handle, rather than through the main
IPC channel. Control operations (open, close, options) use normal IPC; bulk bytes use the
port. Video is delivered to `<video>` via MediaSource.

**This is unproven and is the subject of the week-1 spike in ADR-0005.** If throughput is
inadequate, the fallback is running `webtorrent` privileged in the main process for the MVP,
recorded as known debt.

Media delivery: **prefer MediaSource over webtorrent's localhost HTTP server.** A localhost
server is reachable by every local process and every other app (`security-model.md` T15); if
one proves unavoidable, it binds 127.0.0.1 and requires a random per-session token in the URL.

## Why this survives the engine swap

Apps call `orivon.net.connect`. Underneath, that is:

| phase | implementation |
|---|---|
| month 1 | Node `net.Socket` in the main process |
| later | a Wasmtime host function |
| later | Mojo IPC in a Chromium fork |

None of those transitions is visible to an app already written. That property — not Electron,
not Wasmtime — is what keeps the path to a Chromium fork open.

## Open items — AI-proposed defaults, awaiting owner confirmation

These are `open-questions.md` A9. Each has a default below; unless overruled, the build
proceeds on these. All three are decidable during build step 2 and cheap to change before any
third-party app exists.

### 1. Is `net.listen` grantable to unsigned apps? → **Yes, with constraints**
Listening accepts arbitrary internet input into code the user did not vet. But it is not
arbitrary code execution, and it is the same exposure as running any P2P client. Denying it
would make P2P apps second-class in developer mode, which undercuts the permissionless value
that put developer mode in `ADR-0002` in the first place.

**Default:** grantable to unsigned apps, subject to:
- a **declared port range** in the manifest — `"*"` is rejected for `listen`;
- **privileged ports (<1024) denied outright**, at every tier;
- a distinct, more serious prompt than `connect` — the user is opening a service, not making
  an outbound call, and the wording should say so.

### 2. Grants keyed per origin, or per origin + manifest version? → **Per (origin, capability)**
Manifest-versioning every grant is noisier than it is safe, and it duplicates a check that
already exists elsewhere. Two *different* events are being conflated:

| Event | Response | Comes from |
|---|---|---|
| Bundle hash changes | **Security re-consent** — "this app's code changed" | `ADR-0005`, `ADR-0006` D2 (pinning) |
| Manifest requests a capability not yet granted | **Capability prompt** for that capability only | this spec |

A manifest that changes without requesting anything new therefore triggers the pin-break
prompt but no capability re-prompt — which is the correct signal, and already required by the
pinning model. Keying grants on `(origin, capability)` is simpler and loses nothing.

### 3. Is `fs.quotaBytes` enforced or advisory? → **Enforced**
Advisory means a buggy or hostile app fills the user's disk — threat **T11** in
`security-model.md`, and a genuinely bad first-run experience for a torrent-first browser.

**Default:** enforced, cheaply. Maintain a **running per-origin byte counter**, check it on
write, and fail with a quota error when exceeded. Reconcile the counter against the directory
on startup rather than walking the tree on every operation. This is a small amount of work
and it is the difference between a disk-full bug and a disk-full incident.
