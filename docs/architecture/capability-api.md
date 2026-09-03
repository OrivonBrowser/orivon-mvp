# Capability API — v0 specification

> **Status: specified; partially implemented as of 2026-09-03.** Code has been written against
> most of this document (build step 2, underway) — the "DRAFT, needs owner review before any
> code is written" status this line used to carry was stale, and PR #46 (2026-09-01) left it
> uncorrected on purpose rather than guess at the replacement. This is that correction.
>
> **Reachable from an actual page today**, via `window.orivon` (`src/preload/orivon-surface.ts`,
> wired to `src/broker/index.ts` over `src/broker/ipc.ts`'s control channel): `app.manifest`,
> `app.grants`, `fs.readFile`, `fs.writeFile`. **Implemented in the broker and Electron's
> main-process IPC layer, but not yet exposed to a page**: `net.connect` (TCP only) —
> `orivon-surface.ts`'s own header explains why it stops there: nothing yet lands a socket back
> in a shape a page could ever close. **Named here with no control method wired**:
> `app.requestGrant`, `net.listen`, `net.udpBind`, every `fs.*` method below `readFile`/
> `writeFile` (`open`, `mkdir`, `readdir`, `stat`, `rm`, `rename`, `userSelected`) — none of these
> has any related code anywhere in `src/broker/`. `orivon.id` is a partial exception: no `'id.'`
> case exists in `src/broker/ipc.ts`'s control dispatch, so none of `orivon.id.*` is callable, but
> the P-256 half of the key math it would need is real and tested (`src/broker/policy/derive.ts`'s
> `derivePrivateScalar`, `derive-p256.ts`'s `derivePublicKey`, exercised by `derive.test.ts`'s
> frozen golden vectors) — just not wired to a control method, and secp256k1 (Nostr's curve) has
> no derivation or signing code at all. Each of these is absent from `window.orivon` because its
> build step has not been reached yet, not because it was decided against — see
> `handle-contracts.md`'s own status header for the same distinction drawn per handle type.
>
> **Specified and separately implemented**, even though the v0-surface methods that would
> exercise them end-to-end are not all wired yet: manifest validation (`src/loader/
> manifest.ts`), the semver version-floor comparison this document's §`version` section
> describes (`src/broker/policy/update.ts`'s `compareVersions`, T19), and `fs.quotaBytes`
> enforcement (`src/broker/index.ts`'s `checkFsQuota`, matching the "Enforced" default under
> §Open items below).
>
> §Open items below was already correctly framed — "AI-proposed defaults, awaiting owner
> confirmation" — and needed no correction; it is the one part of this document's status that
> was never stale.
>
> Every `file:line` and function-name claim above was hand-verified against the tree on
> 2026-09-03; nothing keeps it in sync automatically, so it can go stale silently the next time
> the code it describes changes — re-check before trusting it.
>
> Per ADR-0002 this is the highest-care artefact in the repository. The Electron shell is
> disposable; **this interface is not.** Every app ever written for Orivon codes against it,
> and it must survive the swap from Node → Wasmtime → Chromium/Mojo underneath.
>
> `orivonApiVersion: 0` explicitly means **unstable** — breaking changes are permitted while
> it is 0. Once it reaches 1, breaking changes require a major version bump and an ADR.

## Design rules

1. **Mirror Node's API shapes — at the shim, not underneath it.**
   > **Rescoped 2026-08-25 by the A10 owner decision (`ADR-0008`), corrected here rather than
   > smoothed over per CLAUDE.md Rule 3.** This rule originally read as applying to the
   > capability layer itself. It does not: the durable interface each handle actually exposes
   > is a WHATWG stream (`handle-contracts.md`), which is not a Node shape. The rule's
   > *purpose* — making `orivon-node-shim` mechanical and tier-2 porting cheap
   > (`app-compatibility.md`) — is still fully served, because the shim is exactly where the
   > Node-shape reconstruction happens, one layer above the stream interface this document's
   > handles present. Deviate only where the IPC boundary forces it, same as before; the
   > deviation now starts one layer lower than originally written.
   **Corollary, found the hard way in the spike (`gate-1b.json`): mirror the *whole* surface a
   dependency touches, not the obvious entry points.** `net.isIP` is not a socket operation and
   is easy to omit, but `bittorrent-dht`'s RPC layer calls it before every send. Its absence
   threw a `TypeError` that was caught nowhere in the dependency's own code, so the DHT bound
   its socket and then sent nothing — no error, no warning, silently inert. A shim that mirrors
   only the methods a design doc anticipated will pass every test written against that same
   anticipation and still fail in production against a dependency's actual call graph. There is
   no shortcut for this beyond reading (or running against) the real dependency source before
   calling a shim complete.
   **Related trap, same incident: a polyfilled `process.nextTick` changes error visibility.**
   Node's `nextTick` surfaces an uncaught exception to the process; a naive
   `queueMicrotask`-based polyfill does not route into the same handlers, so an exception
   thrown from inside a `nextTick` callback vanishes instead of crashing loudly. This is exactly
   backwards from what a security-relevant shim needs — a broker-side error should be *louder*
   than Node's default, not quieter. **Both traps are now binding requirements, not just
   anecdotes — see `handle-contracts.md` §What the shim must do.**
2. **Everything is async.** Node constructs sockets synchronously; across an IPC boundary we
   cannot. All entry points return Promises. The shim reconciles this by buffering.
3. **Handles, not ambient authority.** `connect()` returns a handle; later operations
   reference the handle. Capability is checked once, at acquisition. This avoids TOCTOU and
   avoids re-authorising on every call.
   **Constraint added 2026-08-25 — a handle must never be transferable.** `MessagePort` is a
   transferable object and `port.on('message')` carries *no sender identity*, so a transferred
   port is a bearer capability: an app could hand a live socket to any origin and the broker
   would see nothing. Handle tables are therefore **per-origin with an ownership check on every
   operation**, and the raw port never leaves the isolated world (see Throughput).
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
  resolution exists

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
  // NOTE: "publisherKey" is CUT from v0 (owner decision 2026-08-25). See "Signing is not in
  // v0" below. Every month-1 app is unsigned; integrity rests on hash-pinning alone.

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

### `version` — semver, ordering, and what an unparseable one costs

`Manifest.version` is a **semver core plus optional prerelease**, build metadata stripped and
ignored (per semver, `1.2.3+a` and `1.2.3+b` are the same version and neither is a rollback of the
other). Two versions compare by release components in order (missing trailing components are
zero, so `1.2` and `1.2.0` are equal), then by prerelease per semver §11.3–11.4 (a prerelease
sorts below its release; numeric identifiers sort below alphanumeric ones).

This is not a new rule — it transcribes what `src/broker/policy/update.ts`'s `compareVersions`
already implements, because it backs a security control: `security-model.md` T19's per-origin
**version floor**, which rejects any update below the highest version ever installed, so a
validly-hash-pinned *older* bundle cannot be replayed to suppress a fix (`ADR-0009`).

**A version string that does not parse as semver is treated as below the floor and rejected —
fails closed.** "We cannot prove this is not a replayed older bundle" and "this is a replayed
older bundle" must reach the same outcome, or the floor is bypassed by publishing a version string
the parser cannot order. Consequently: **the app loader must reject a non-semver `version` at
first install**, not only on update — a publisher who ships `"2026-08-26"` needs to find out
immediately, not on their first update when every install is already stuck below an unreachable
floor.

**Honesty note on P2P apps.** The torrent app genuinely needs `tcp.connect: ["*:*"]` and
`udp.send: ["*:*"]` — DHT and peer exchange reach arbitrary hosts. That is close to
unrestricted network access, and the grant prompt must say so in plain words
(*"connect to any computer on the internet"*), not hide it behind a pattern string. This is a
real property of P2P software, and understating it would be the kind of dishonesty the trust
indicator exists to prevent.

## v0 surface

> **`TcpSocket`, `TcpServer`, `UdpSocket`, `FileHandle` and `IdentityHandle` are fully
> specified in `handle-contracts.md`** — read/write shape, event model, backpressure,
> close/half-close, error taxonomy, revocation. This document names them; that one defines
> them.

```ts
orivon.version                       // => 0

// --- app introspection ---
orivon.app.manifest()                // => Manifest
orivon.app.grants()                  // => Grant[]  (what was actually granted)
orivon.app.requestGrant(cap)         // => Promise<boolean>  (may prompt the user)

// --- net ---
orivon.net.connect({ host, port })   // => Promise<TcpSocket>
orivon.net.listen({ port })          // => Promise<TcpServer>   // .connections: ReadableStream<TcpSocket>
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
// IdentityHandle.publicKey() : the SAME identity on every site the user connects it to
// IdentityHandle.signEvent(obj): STRUCTURED, never raw bytes — the broker serialises and
//   screens `kind`. Kinds 1/6/7 sign silently; 0, 3, 5, 22242 and any delegation PROMPT.
```

> **No raw signing oracle for named identities** (audit, 2026-08-25). Signing arbitrary bytes
> silently after one connect prompt would let a compromised client wipe the follow list
> (kind 3), delete posts (kind 5), replace the profile (kind 0), or authenticate as the user to
> relays (NIP-42, kind 22242) — and `ADR-0003` excludes export/backup, so the user cannot
> rotate. `signEvent` is also what NIP-07 clients actually call.
> Decrypt (`nip04`/`nip44`), if offered at all, is a **separate grant** from signing.
> Derive a distinct secret per `(label, curve)` with length-prefixed HKDF: one scalar reused
> across two schemes voids the security argument for both.

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

**What `origin` and `identityId` are, precisely** (owner decision 2026-08-27, `ADR-0010`). Both
are frozen into a key that the MVP cannot export, back up or migrate (`ADR-0003`), so two
spellings of one of them are two different identities, permanently.

- **`origin`** is the *canonical* origin, as produced by `originFromSenderFrame()` in
  `src/broker/policy/origin.ts`. **Not** `URL.origin` — the two genuinely disagree, since A14
  strips a trailing DNS dot and `URL.origin` does not. And **not** the bare `originFromUrl()`
  underneath it: the frame variant denies when the committed URL and the frame's own origin
  disagree, and skipping that gives a sandboxed opaque-origin document the embedder's grants and
  identity key (T3, T13b).
- **`identityId`** is **opaque and broker-generated, never a user-typed name and never derived
  from one.** The user-visible label is stored beside the identity, not used to derive it —
  otherwise renaming an identity, or merely changing its case, destroys the npub with nothing to
  restore from.

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

### Signing is not in v0 — owner decision, 2026-08-25

`ADR-0002` posits signed and unsigned trust tiers; `ADR-0005`'s amendment keyed silent updates
on a publisher signature. **Both are cut for month 1.** Three reasons, from the audit:

1. **The tiers were already capability-identical in v0.** Their only stated difference was
   `subprocess` and `hid`, and this spec removes both for *every* tier. The distinction cost
   real work and bought nothing.
2. **Nothing specified or scheduled the mechanism** — no signature format, no covered bytes, no
   detached-signature location, no key generation, no tooling, and no build step. As written,
   `publisherKey` was a self-asserted string inside the very document it was meant to
   authenticate, fetched from the host it was meant to defend against.
3. **It would have sabotaged the clip.** With no signing pipeline the flagship is unsigned, and
   `ADR-0002` mandates unsigned apps be marked in the tab *and in every grant prompt* — so the
   distribution asset would show a red UNSIGNED badge beside "connect to any computer on the
   internet."

**What v0 actually ships:** hash-pinning (TOFU on the bundle) as the integrity mechanism, with
**no UNSIGNED badge anywhere**, because "unsigned" is not a distinction when everything is.
Signing returns when a second publisher exists — which is also when prompt fatigue, its stated
justification, first becomes possible.

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

A normal page stays a normal page. An origin becomes an app when a manifest is found at
`https://<origin>/.well-known/orivon.json`, which runs the ADR-0005 flow (fetch → cache → pin),
and permissions are granted the moment the page actually asks for one — not before.

> **Never probe automatically.** Three independent audits flagged this: an unsolicited request
> to every origin the user visits is an active, attributable *"this visitor runs Orivon"*
> signal, sent from a privacy-branded browser to an audience that reads its own traffic. That
> is strictly worse than the `window.nostr` fingerprint accepted in T16, and it costs a request
> per navigation.
>
> **v0 discovery is therefore:** a `<link rel="orivon-manifest">` hint in HTML already
> delivered — zero extra requests. The well-known path is fetched *only after* seeing that hint
> in a page the browser is already loading, never speculatively.

> **Corrected 2026-09-03, owner decision — the "Open as app" menu action is cut.** This section
> previously named a second discovery path: an explicit user action, "Open as app" from a menu,
> alongside the passive HTML hint. There is no such action, and there will not be one — a
> Web3site is not a separate category of thing a user "converts" a normal website into; it is
> the same URL, the whole time. `mvp-scope.md`'s journey 2 and `README.md`'s "Apps come from a
> URL" row said the same thing and are corrected to match.
>
> **What replaces the removed step:** nothing has to. The hint above is now the *only* discovery
> trigger, not one of two — no explicit action was ever load-bearing for privacy (the hint
> already covers the zero-extra-requests case); it only existed because nothing else was
> specified yet. Once a manifest is found this way, the browser fetches and caches its declared
> files automatically — a Web3site is expected to work fully offline by design (a Web3-Score
> requirement, `ADR-0006`), the same way this already works for an ordinary browser and a
> normal page's own cache. **The permission prompt is unaffected by any of this**: it still
> fires only when the page's code actually calls for a capability, never at discovery or fetch
> time — see `Grant`'s own doc comment (`src/contracts/manifest.ts`) on why a grant is keyed on
> `(origin, capability, pattern set)` rather than "the whole manifest, once": the SAME hash can
> be revisited with zero prompts once its capabilities are already granted, and only a changed
> hash (a new version) or newly-requested authority ever asks again.

**The grant prompt must be origin-first.** Any origin can serve a manifest, and `name`/`id` are
self-asserted, so a hostile site can present itself as "Orivon Torrent" with an identical
prompt. Required layout: the **origin** is the largest, primary, non-app-controlled element;
the app-supplied `name` is visibly subordinate and marked as claimed by the site; an `id`
collision with an installed app is surfaced explicitly (`security-model.md` T18).

**Hosting note:** `/.well-known/` is host-scoped, so serving first-party apps from
`<account>.github.io` puts them on **one origin shared with every other repo on that account** —
one grant set, one storage domain, one derived key. First-party apps need a dedicated hostname
that serves nothing else.

Protocol routing (`"protocols": ["magnet"]`) is what lets a magnet link reach the torrent app.
It requires its own user prompt — manifest declaration alone never wins the default — and the
URI is validated against a strict grammar before it touches any other code
(`security-model.md` T23).

## Throughput — the open risk

Per-message Electron IPC is too slow for torrent-rate data. Sockets therefore carry their
data over a dedicated **`MessageChannelMain` port** per handle, rather than through the main
IPC channel. Control operations (open, close, options) use normal IPC; bulk bytes use the port.

> **Security rule, not an optimisation detail: the raw port never crosses into the main
> world.** The preload holds it in the isolated world and exposes only `contextBridge` closures
> (`socket.write(buf)`, `socket.onData(cb)`). Transferring the port to the page — the obvious
> move when optimising for throughput — hands a raw socket to anything the page can reach
> (`security-model.md` T17). `contextIsolation: true` is what makes this free. **The spike must
> measure throughput *through this wrapper*, or week 0 measures something the product cannot
> ship.**

**Throughput was never the real risk** (audit, 2026-08-25). Measured `MessagePort` transfer is
~310 MB/s against the 1–5 MB/s 1080p needs. The genuine week-0 questions are whether a renderer
bundle fetches *ordinary* (non-WebRTC) torrents at all, and whether the tree is free of native
modules — see `build-plan.md` §Week 0. Fallback if it fails: an Electron **`utilityProcess`**,
not the main process.

### Measured, 2026-08-25 — spike gate 0 (`planning/spike-results/gate-0.json`)

Electron 44.0.0 / Chromium 152, Linux x64, through the `contextBridge` closures rather than a
raw port, so this is the path the product can actually ship.

| | Result |
|---|---|
| Byte fidelity, renderer → main | **Exact** at 64 KB, 256 KB and 1 MB |
| Byte fidelity, main → renderer | **Exact** at all three sizes |
| Throughput, renderer → main | **1134.8 MB/s** |
| Throughput, main → renderer | **313.4 MB/s** (the audit's ~310 MB/s estimate was right) |
| **Transferable `ArrayBuffer`, renderer → main** | **UNAVAILABLE** |

**[electron#34905](https://github.com/electron/electron/issues/34905) reproduces, and it is
worse than "can lose its payload".** Passing an `ArrayBuffer` in the transfer list of
`MessagePortMain.postMessage` renderer → main **does not throw and does not corrupt — the
message never arrives at all.** Silent, total loss, at every size tested. The first spike run
hung on it, because an un-timed reply promise waits forever.

Two consequences, both settled rather than open:

1. **Do not use transferables on this path**, and do not treat them as an optimisation held in
   reserve. `build-plan.md` named "day 2 with transferable `ArrayBuffer`s" as the rescue if
   gate 4's throughput failed; **that rescue does not exist.** It does not matter: structured
   clone *copies*, and copying already runs 60–200x faster than the 1–5 MB/s that 1080p
   streaming needs.
2. **Any reply-carrying protocol over `MessagePortMain` needs a timeout**, because the failure
   mode of this transport is silence, not an error.

Still unmeasured and still true: **`MessagePortMain` has no documented backpressure**, so the
shim must implement its own flow control or a fast swarm grows renderer memory without bound.
**Answered 2026-08-26** — `handle-contracts.md` §TcpSocket "Backpressure — a credit window"
specifies the mechanism: a byte-credit window on top of `ReadableStream`/`WritableStream`
(`ADR-0008`), with the broker stopping the underlying OS socket read once credit is exhausted
rather than buffering in the main process.

**Media delivery, revised.** Not MSE, and not a localhost HTTP server. Serve pieces to
`<video>` over a **range-capable custom scheme** (`protocol.handle()` returning a streaming
`Response`), or webtorrent's Service-Worker `createServer({ controller })` — both are
renderer-local and origin-scoped, so **no other local process can reach them**, which is
stronger than T15's token mitigation. Chromium then provides seeking and track selection for
free. MSE was the *worse* option: it needs fMP4 the torrents do not contain, and it forces
hand-implemented seeking.

**v0 plays MP4/H.264 only.** MSE cannot demux Matroska and neither can Chromium's `<video>`, so
MKV has no path at all without a remuxer — deferred post-launch (`libav-wasm`, pure-WASM).
Stock Electron ships H.264/AAC, so nothing extra is needed; HEVC is hardware-decode-only and is
out. The limitation is stated in-product, not hidden.

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

### 2. Grants keyed per origin, or per origin + manifest version? → **Per (origin, capability, pattern set)**
Manifest-versioning every grant is noisier than it is safe. Two *different* events are being
conflated:

| Event | Response | Comes from |
|---|---|---|
| Bundle hash changes | **Security re-consent** — "this app's code changed" | `ADR-0005`, `ADR-0006` D2 (pinning). The hash itself is `ADR-0009`/`bundle-hash.md` — it includes the manifest, so a manifest-only change also lands here |
| Manifest requests a capability not yet granted | **Capability prompt** for that capability only | this spec |

> **Corrected 2026-08-25.** The original default keyed grants on `(origin, capability)` alone,
> where "capability" meant the *kind*. That has a hole: an update changing
> `"connect": ["api.example.com:443"]` to `"connect": ["*:*"]` requests **no new capability
> kind** and would have installed **silently**. The user granted "talk to one host"; the app
> would hold "connect to any computer on the internet" — the exact grant journey 1 puts on
> camera.
>
> **The re-consent trigger is a subset check over the granted pattern set**, not a kind
> comparison: silent only if the new manifest's patterns are a subset of what was granted.
> Additionally, record a per-origin **version floor** and reject any lower version, so a
> validly-hash-pinned *older* bundle cannot be replayed indefinitely to suppress a fix
> (`security-model.md` T19).

### 3. Is `fs.quotaBytes` enforced or advisory? → **Enforced**
Advisory means a buggy or hostile app fills the user's disk — threat **T11** in
`security-model.md`, and a genuinely bad first-run experience for a torrent-first browser.

**Default:** enforced, cheaply. Maintain a **running per-origin byte counter**, check it on
write, and fail with a quota error when exceeded. Reconcile the counter against the directory
on startup rather than walking the tree on every operation. This is a small amount of work
and it is the difference between a disk-full bug and a disk-full incident.
