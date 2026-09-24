# Capability API: v0 specification

> **Status: specified.** Per-method build status is not tracked in this document.
> [`../planning/compatibility-matrix.md`](../planning/compatibility-matrix.md) carries it cell by
> cell, re-derived from the tree, and scores each capability in four columns because a module
> existing is not the same fact as a page being able to reach it. This document says what the
> surface *is*.
>
> Per ADR-0002 this is the highest-care artefact in the repository. The Electron shell is
> disposable; **this interface is not.** Every app ever written for Orivon codes against it,
> and it must survive the swap from Node → Wasmtime → Chromium/Mojo underneath.
>
> `orivonApiVersion: 0` explicitly means unstable: breaking changes are permitted while
> it is 0. Once it reaches 1, breaking changes require a major version bump and an ADR.

## Design rules

1. **Mirror Node's API shapes, at the shim rather than underneath it.**
   > **The rule applies to the shim, not to the capability layer** (`ADR-0008`). The durable
   > interface each handle exposes is a WHATWG stream (`handle-contracts.md`), which is not a
   > Node shape. The rule's *purpose*, making `orivon-node-shim` mechanical and tier-2 porting
   > cheap (`app-compatibility.md`), is served exactly there: the shim is where the Node-shape
   > reconstruction happens, one layer above the stream interface this document's handles
   > present. Deviate only where the IPC boundary forces it.
   **Corollary, found the hard way in the spike (`gate-1b.json`): mirror the *whole* surface a
   dependency touches, not the obvious entry points.** `net.isIP` is not a socket operation and
   is easy to omit, but `bittorrent-dht`'s RPC layer calls it before every send. Its absence
   threw a `TypeError` that was caught nowhere in the dependency's own code, so the DHT bound
   its socket and then sent nothing: no error, no warning, silently inert. A shim that mirrors
   only the methods a design doc anticipated will pass every test written against that same
   anticipation and still fail in production against a dependency's actual call graph. There is
   no shortcut for this beyond reading (or running against) the real dependency source before
   calling a shim complete.
   **Related trap, same incident: a polyfilled `process.nextTick` changes error visibility.**
   Node's `nextTick` surfaces an uncaught exception to the process; a naive
   `queueMicrotask`-based polyfill does not route into the same handlers, so an exception
   thrown from inside a `nextTick` callback vanishes instead of crashing loudly. This is exactly
   backwards from what a security-relevant shim needs: a broker-side error should be *louder*
   than Node's default, not quieter. **Both traps are binding requirements; see `handle-contracts.md` §What the shim must do.**
2. **Network operations are async, with no exception. `fs` gets exactly one narrow,
   deliberate synchronous exception.**
   > **Why the exception is `fs`-only** (`ADR-0016`). The async rule is reasoned entirely from
   > `net`: Node constructs sockets synchronously, and across an IPC boundary we cannot,
   > because a dial cannot complete without a DNS round trip that has no honest synchronous
   > answer. That reasoning does not carry over to `fs`, where a local read is
   > sub-millisecond, so the boundary is drawn at the network rather than across both.

   **`net` stays exactly as before: every `orivon.net.*` entry point returns a Promise, no
   exception.** There is no `connect` event and no observable "connecting" state: the
   resolution of the acquisition promise *is* the connect event. The shim reconciles this by
   buffering.

   **`fs` gains one synchronous entry point, `readFileSync`.** Permitted because what an
   async-only `fs` costs is not speed but presence: `readFileSync`/`existsSync`-shaped calls
   are how a ported Node program reads its own configuration, typically from inside a
   dependency the porting developer does not control, and the app throws before it ever
   renders rather than merely running a few milliseconds slower. The mechanism is the
   runtime's synchronous renderer-to-main channel today; an `Atomics.wait`-in-a-Worker route
   is deferred, not rejected, as a future swap for the identical interface, and an app calling
   `readFileSync` cannot tell which one answered it, and never will be able to.

   This is not a general licence to add more synchronous calls where they would be
   convenient. `readFileSync` is the one call a ported app cannot do without at startup; the
   blocking cost is bounded and visible there, and a chatty use of it is the app's own cost
   to pay, not a reason to widen the exception further.
3. **Handles, not ambient authority.** `connect()` returns a handle; later operations
   reference the handle. Capability is checked once, at acquisition. This avoids TOCTOU and
   avoids re-authorising on every call.
   **A handle must never be transferable.** `MessagePort` is a
   transferable object and `port.on('message')` carries *no sender identity*, so a transferred
   port is a bearer capability: an app could hand a live socket to any origin and the broker
   would see nothing. Handle tables are therefore **per-origin with an ownership check on every
   operation**, and the raw port never leaves the isolated world (see Throughput).
4. **Declare statically, grant dynamically.** The manifest declares what an app *may* ask
   for; the user grants what it *actually gets*. An app can never obtain a capability absent
   from its manifest, even with user consent.
5. **No capability is implicit.** Absence from the manifest means absence, not default-allow.

## Origin: the isolation key

An app's **origin** keys everything: its storage domain, its session partition, its grant
ledger entry, and its derived identity key (ADR-0003, ADR-0005).

- HTTPS-delivered apps use the **standard web origin**: scheme + host + port. Deliberately
  the web's definition, not a new one.
- IPFS- and ENS-delivered apps will key on CID / ENS name. Deferred until trustless
  resolution exists

> **This definition must be settled before the first grant is persisted.** Changing it later
> invalidates every stored grant and orphans every app's data.

## Manifest

Served alongside the app's frontend assets and fetched before first run. An unknown top-level
field is ignored, and the loader logs a warning naming it. An unknown field anywhere inside
`capabilities` rejects the manifest, and `orivonApiVersion` must match exactly.

```jsonc
{
  "orivonApiVersion": 0,
  "id": "app.orivon.torrent",        // reverse-DNS, informational; origin is the real key
  "name": "Orivon Torrent",
  "version": "0.1.0",
  "entry": "index.html",
  "assets": ["style.css", "app.js"],  // every other frontend file; omit if entry is the whole app
  // NOTE: "publisherKey" is CUT from v0. See "Signing is not in
  // v0" below. Every month-1 app is unsigned; integrity rests on hash-pinning, with
  // the site's published hash tree (/.well-known/orivon-ddoc.json) shown as DDOC evidence.

  "capabilities": {
    "net": {
      "tcp": {
        "connect": ["*:*"],           // host:port patterns, "*" wildcard
        "listen":  ["6881-6889"]      // port ranges
      },
      "udp": { "bind": ["6881-6889"], "send": ["*:*"] },
      "https": { "connect": ["*:*"] }   // TLS terminated by the broker (ADR-0017); "*:*" is
                                         // UNLIMITED HTTPS and must render as visibly wide as
                                         // tcp.connect's own "*:*" does (A100)
    },
    "fs": { "quotaBytes": 53687091200 },
    "id": { "curves": ["secp256k1"] },
    "media": { "camera": true, "microphone": true },  // ADR-0030; omit a flag to not ask for it
    "clipboard": { "read": true },                    // ADR-0030
    "secrets": {},                                    // ADR-0031; presence alone is the ask
    "protocols": ["magnet"]            // shell routes magnet: links to this app
                                       // (first registrant is default; conflicts → user chooses)
  },

  "consentGranularity": "all-or-nothing"  // omitting this line has the same effect; see below.
                                           // "per-capability" lets the person accept some of the
                                           // capabilities above and refuse others.
}
```

### `consentGranularity`: who decides whole-or-part, and why it defaults closed

Whether a person may accept only *part* of what an app requests (grant its network access,
refuse its filesystem access) is **the app's own declaration to make**, not the browser's.
`Manifest.consentGranularity` is that declaration, `'all-or-nothing'` or `'per-capability'` (`src/contracts/manifest.ts`'s
`ConsentGranularity`).

**`'all-or-nothing'`** presents the whole declared capability set as one accept/decline choice.
The app either runs with everything it asked for, or does not run; there is no state where it
holds part of what it declared. **`'per-capability'`** lets the person decide each declared
capability on its own, and the app finds out what it actually got from `orivon.app.grants()`,
which may report less than its manifest declared.

**The app declares this, not Orivon**, for a concrete reason, not a preference: only the app's
own author knows which their code can survive. Code ported from Node or Electron was never
written to handle a capability being refused, since it assumes what it asked for exists, the way
Node's own `fs`/`net` do, so a person refusing one of several requested capabilities is not a
smaller version of that app working, it is a crash wearing a different shape. An app written for
Orivon from the start can check `orivon.app.grants()` on purpose and degrade a missing
capability gracefully, so its author is free to offer real per-item control instead.

**Omitting the field means `'all-or-nothing'`.** Every manifest written before this field
existed was written with no knowledge that a partial grant could ever happen, which describes a
ported app exactly, so the safe reading of silence is the one that can never hand an unprepared
app a state it has no code path for. This costs the generous case (a person who wants the app
but not its filesystem access has only the choice to decline the whole thing) to avoid the
unsafe one (an app crashing mid-run on a refusal it cannot interpret). A person who wants finer
control over an app that has not opted in still has the settings-list revoke path (A101) once
the app is running, narrower than a row in the install prompt but real.

**One flag for the whole manifest, not one per capability.** The question this answers, can the
app's own code cope with an incomplete grant, is a property of the app as a whole: a ported app
has no code path for a missing filesystem grant any more than for a missing network one, so
splitting the choice per capability would ask an author to answer a question their code does not
actually distinguish.

`docs/open-questions.md` A138 carries the fuller argument. The loader
parses the field (`src/loader/manifest.ts`), and the install-time consent dialog reads it:
`src/main/consent/install-consent.ts`'s `requestInstallConsent` branches its whole staged Allow-all /
Choose-individually / Deny-all sequence on `manifest.consentGranularity === 'per-capability'`.
Three update-time prompts (reconsent, capability-widening, rollback) do not yet honour it; see
`docs/open-questions.md` A162.

### `version`: semver, ordering, and what an unparseable one costs

`Manifest.version` is a **semver core plus optional prerelease**, build metadata stripped and
ignored (per semver, `1.2.3+a` and `1.2.3+b` are the same version and neither is a rollback of the
other). Two versions compare by release components in order (missing trailing components are
zero, so `1.2` and `1.2.0` are equal), then by prerelease per semver §11.3-11.4 (a prerelease
sorts below its release; numeric identifiers sort below alphanumeric ones).

This is not a new rule; it transcribes what `src/broker/policy/update.ts`'s `compareVersions`
already implements, because it backs a security control: `security-model.md` T19's per-origin
**version floor**, which flags any update below the highest version ever installed, so a
validly-hash-pinned *older* bundle is never installed unnoticed (`ADR-0009`).

**A version string that does not parse as semver is treated as below the floor, and fails closed.**
"We cannot prove this is not a replayed older bundle" and "this is a replayed older bundle" must
reach the same outcome, or the floor is bypassed by publishing a version string the parser cannot
order. Consequently: **the app loader must reject a non-semver `version` at first install**, not
only on update: a publisher who ships `"2026-08-26"` needs to find out immediately, not on their
first update when every install is already stuck below an unreachable floor.

**Reaching the floor is a user decision, never a silent one** (`ADR-0013`). A below-floor
version is warned and offered as a **choice** (proceed with the older version, or keep what is
cached) the first time for a given origin, then an ongoing, non-blocking notice on every later
visit once the user has said yes once. The floor itself (`GrantLedger.versionFloor`, A57) only
ever rises, and it is what decides whether an update counts as a rollback at all. The non-semver
case above lands on the same restrictive path: a choice or a notice, never a silent
installation.

**Honesty note on P2P apps.** The torrent app genuinely needs `tcp.connect: ["*:*"]` and
`udp.send: ["*:*"]`, because DHT and peer exchange reach arbitrary hosts. That is close to
unrestricted network access, and the grant prompt must say so in plain words
(*"connect to any computer on the internet"*), not hide it behind a pattern string. This is a
real property of P2P software, and understating it would be the kind of dishonesty the trust
indicator exists to prevent.

## v0 surface

> **`TcpSocket`, `TcpServer`, `UdpSocket`, `FileHandle` and `IdentityHandle` are fully
> specified in `handle-contracts.md`**: read/write shape, event model, backpressure,
> close/half-close, error taxonomy, revocation. This document names them; that one defines
> them.

```ts
orivon.version                       // => 0

// --- app introspection ---
orivon.app.manifest()                // => Manifest
orivon.app.grants()                  // => Grant[]  (what was actually granted)
orivon.app.requestGrant(cap)         // => Promise<boolean>  (may prompt the user)

// --- net ---
orivon.net.connect({ host, port })       // => Promise<TcpSocket>
orivon.net.connectSecure({ host, port, ...tls }) // => Promise<SecureTcpSocket>  TLS terminated
                                          //   in the broker (ADR-0017) under the app's own
                                          //   Node TLS options; connect()'s handle plus the
                                          //   handshake; a SEPARATE grant (https.connect)
orivon.net.listen({ port })          // => Promise<TcpServer>   // .connections: ReadableStream<TcpSocket>
orivon.net.udpBind({ port })         // => Promise<UdpSocket>

// --- fs, rooted at the app's files directory ---
orivon.fs.readFile(path)             // => Promise<Uint8Array>  byte-oriented, no encoding option (A12)
orivon.fs.writeFile(path, data)      // => Promise<void>
orivon.fs.readFileSync(path)         // => Uint8Array  the one synchronous call (ADR-0016); genuinely blocks
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

// --- secrets: one origin-bound, keyring-backed secret (ADR-0031) ---
orivon.secrets.available()           // => Promise<boolean>  false if ungranted, or the seed is session-only
orivon.secrets.encrypt(plaintext)    // => Promise<Uint8Array>  bytes in, bytes out, no encoding option
orivon.secrets.decrypt(ciphertext)   // => Promise<Uint8Array>  'invalid' for bytes this origin's key did not produce
```

> **`media.camera`, `media.microphone` and `clipboard.read` (ADR-0030) have no `orivon.*` entry
> point of their own.** They are Chromium platform permissions (`getUserMedia`,
> `navigator.clipboard.readText`/`read`), not broker calls: the manifest declares them and the
> grant ledger governs them for an app exactly as it governs any other `CapabilityKind`, but the
> app *reaches* them through the ordinary web platform API, the same way it always would on
> plain Chrome. An ordinary website, with no manifest, asks for the identical two web-platform
> APIs and gets a per-site browser prompt instead of a grant -- see `security-model.md` and
> `src/main/sessions/README.md` for the mechanism.

> **No raw signing oracle for named identities.** Signing arbitrary bytes
> silently after one connect prompt would let a compromised client wipe the follow list
> (kind 3), delete posts (kind 5), replace the profile (kind 0), or authenticate as the user to
> relays (NIP-42, kind 22242), and `ADR-0003` excludes export/backup, so the user cannot
> rotate. `signEvent` is also what NIP-07 clients actually call.
> Decrypt (`nip04`/`nip44`), if offered at all, is a **separate grant** from signing.
> Derive a distinct secret per `(label, curve)` with length-prefixed HKDF: one scalar reused
> across two schemes voids the security argument for both.

### `connectSecure`'s TLS options

`connectSecure` takes Node's own `tls.connect` options, and `handle-contracts.md` §TcpSocket
defines the `SecureTcpSocket` it returns. By default the broker validates the certificate chain
against the runtime's built-in roots and the certificate against `host`, and checks `host`
against the `https.connect` grant by name: that verification is what binds the name to whoever
answered. An option that removes the binding (`rejectUnauthorized: false`, the app's own `ca`, a
`servername` other than `host`) makes the broker also resolve `host` once, require every answer
to pass `connect()`'s address rule (`security-model.md` T12), and dial only the address it
checked, so no option widens what a grant reaches.

```ts
/**
 * `orivon.net.connectSecure`'s argument. Every field past `port` is
 * optional and carries Node's own `tls.connect` meaning under Node's own
 * name, except `alpnProtocols` (Node's `ALPNProtocols`). PEM values are
 * strings and binary ones `Uint8Array`, and each is bounded in size: an
 * oversized or malformed option rejects the call with `'invalid'` naming it.
 * Key material serves this one connection only: it is never written to disk
 * and never logged.
 */
interface SecureConnectOptions {
  readonly host: string
  readonly port: number
  /**
   * Default true. `false` completes the handshake whatever the certificate
   * says, and the connection is then ENCRYPTED BUT UNAUTHENTICATED: anyone
   * on the network path can impersonate the server, read everything and
   * change it. That is the app's own choice, made in its own code (Electrum
   * servers, LND nodes and LAN services commonly present self-signed
   * certificates), and nothing the person granting the app was shown.
   * `SecureTcpSocket.authorized`/`authorizationError` still report what
   * verification found.
   */
  readonly rejectUnauthorized?: boolean
  /**
   * Trust anchors in PEM, one per string or several concatenated. They
   * REPLACE the runtime's built-in roots for this one connection, exactly as
   * Node's `ca` does; an app that wants both passes both.
   */
  readonly ca?: string | readonly string[]
  /** A client certificate chain in PEM, presented when the server asks for one. Paired with `key`; `pfx` is the alternative. */
  readonly cert?: string
  /** The private key for `cert`, in PEM. */
  readonly key?: string
  /** A PKCS#12 bundle holding a client certificate and its key. */
  readonly pfx?: Uint8Array
  /** Decrypts `key` or `pfx`. */
  readonly passphrase?: string
  /**
   * The name sent as SNI and verified against the certificate, when it
   * differs from `host`. Absent, it is `host` when that is a name; `''`
   * sends no SNI and verifies against `host`. Never an address literal.
   * What the connection reaches is decided by `host` alone.
   */
  readonly servername?: string
  /** Protocols offered through ALPN, most preferred first (`['h2', 'http/1.1']`). The one agreed is `SecureTcpSocket.alpnProtocol`. */
  readonly alpnProtocols?: readonly string[]
}
```

### Secure connect, and why routed `fetch` needs no capability of its own

`net.connectSecure` above is the whole of ADR-0017's capability surface. The other two parts
of that decision (the page's own `fetch()` reaching a granted host, and an app being able to
set headers a page normally cannot) are **compatibility-layer work, not a new capability**,
confirmed rather than assumed:

- The FreeTube reconnaissance (`orivon-ports`'s `docs/freetube-recon.md`) found that app's entire
  network layer is 32 ordinary `fetch(` call sites, made to work only because its Electron
  main process rewrites outgoing headers (`Origin`, `Referer`) before they leave the process.
  That rewriting has to happen somewhere trusted; it does not need a new grantable capability
  to do it, because the trust boundary it needs already exists at `net.connectSecure`, where an
  HTTP/1.1 client built over that byte-oriented socket can set any header on the request it
  constructs, the same way `orivon-node-shim`'s `http`/`https` modules will (Phase 3.3,
  `.claude/unattended-build-queue.md`).
- Routing the page's global `fetch` to that HTTP client for granted hosts, and reconstructing
  a `Response` from what comes back, is `orivon-node-shim`/the compatibility layer's job
  (Phase 3.4), the same "bytes and streams underneath, familiar shapes one layer up" split
  ADR-0008 already draws for `net` and `fs`. Nothing about *routing* `fetch` or *choosing a
  header* needs the broker to know what HTTP is; it only needs to hand back a plaintext
  duplex for a hostname it has already verified, which `connectSecure` already does.

**So: no `orivon.*` entry point for `fetch` or for HTTP headers, and none is missing.** This
is a confirmed finding for Phase 1, not an oversight; see this repository's build queue,
Phase 3 items 3.3-3.4, for where the HTTP client and the `fetch` routing are actually built.

### Two kinds of identity

Per-origin keys alone **cannot support Nostr**: an npub must be the *same* across every client
site, or follows, posts and identity fragment per client, and per-origin keys would issue a
different Nostr identity to snort.social and noStrudel. So `id` yields two distinct things.

| | **App keys** | **Named identities** |
|---|---|---|
| Scope | one origin, silent | cross-origin **by design** |
| Consent | none needed, since it cannot link users across apps | explicit connect prompt per site, revocable |
| Backing | `derive(seed, "app", origin)` | `derive(seed, "identity", identityId)` |
| Consumer | app-internal crypto | `window.nostr` (NIP-07), future wallet connect |

**What `origin` and `identityId` are, precisely** (`ADR-0010`). Both
are frozen into a key that the MVP cannot export, back up or migrate (`ADR-0003`), so two
spellings of one of them are two different identities, permanently.

- **`origin`** is the *canonical* origin, as produced by `originFromSenderFrame()` in
  `src/broker/policy/origin.ts`. **Not** `URL.origin`: the two genuinely disagree, since A14
  strips a trailing DNS dot and `URL.origin` does not. And **not** the bare `originFromUrl()`
  underneath it: the frame variant denies when the committed URL and the frame's own origin
  disagree, and skipping that gives a sandboxed opaque-origin document the embedder's grants and
  identity key (T3, T13b).
- **`identityId`** is **opaque and broker-generated, never a user-typed name and never derived
  from one.** The user-visible label is stored beside the identity, not used to derive it.
  Otherwise renaming an identity, or merely changing its case, destroys the npub with nothing to
  restore from.

`window.nostr` semantics: injected in ordinary tabs; first `getPublicKey()` per site triggers
the connect prompt; after connecting, signing is silent for that site (per-event prompts would
make Nostr unusable). Presence of `window.nostr` is fingerprintable, as it is of every NIP-07
extension; the *data* is what sits behind consent (`security-model.md` T16).

### Deliberately **not** in v0
- **`subprocess`.** No tier-3 app is in the MVP (Bisq is cut), so it buys nothing and costs
  the largest attack surface in the design.
- **`hid` / USB.** No wallet app in the MVP.
- **Raw sockets / ICMP.** No use case, and unreachable from WASM later anyway.

> **Narrower than ADR-0002.** That ADR says `subprocess` and `hid` are "not grantable to
> unsigned apps". This spec narrows further: they are absent from v0 entirely, for signed apps
> too.

### Signing is not in v0

`ADR-0002` posits signed and unsigned trust tiers; `ADR-0005`'s amendment keyed silent updates
on a publisher signature. **Both are cut for month 1.** Three reasons, from the audit:

1. **The tiers were already capability-identical in v0.** Their only stated difference was
   `subprocess` and `hid`, and this spec removes both for *every* tier. The distinction cost
   real work and bought nothing.
2. **Nothing specified or scheduled the mechanism.** No signature format, no covered bytes, no
   detached-signature location, no key generation, no tooling, and no build step. As written,
   `publisherKey` was a self-asserted string inside the very document it was meant to
   authenticate, fetched from the host it was meant to defend against.
3. **It would have sabotaged the clip.** With no signing pipeline the flagship is unsigned, and
   `ADR-0002` mandates unsigned apps be marked in the tab *and in every grant prompt*, so the
   distribution asset would show a red UNSIGNED badge beside "connect to any computer on the
   internet."

**What v0 actually ships:** hash-pinning (TOFU on the bundle) as the integrity mechanism, with
**no UNSIGNED badge anywhere**, because "unsigned" is not a distinction when everything is.
Signing returns when a second publisher exists, which is also when prompt fatigue, its stated
justification, first becomes possible.

### Rules that apply to every app, signed included
- `fs` is confined to the app's files directory. `..` traversal is rejected. Outside access
  exists only via `fs.userSelected`.
- `net` requires manifest-declared patterns, surfaced verbatim in the grant prompt.
- `id` app keys derive per origin silently; **named identities** are cross-origin only through
  the explicit connect prompt. In both modes the seed is never exposed and raw key export is
  not a capability at any tier.
- `secrets` derives its own key from that same seed, per origin, with a distinct salt from `id`'s
  (`ADR-0031`); an app never holds, and cannot derive, the seed itself.
- The app's **code cache is read-only to the app** (ADR-0003). An app that could rewrite its
  own code would escape the manifest its grants were issued against.

## How a URL becomes an app

A normal page stays a normal page. An origin becomes an app when a manifest is found at
`https://<origin>/.well-known/orivon.json`, which runs the ADR-0005 flow (fetch → cache → pin).
The site's published hash tree, `/.well-known/orivon-ddoc.json`, is fetched beside the manifest
and kept with the pin as DDOC evidence; it decides nothing about the install (`ADR-0029`).
Consent is then asked once, before the app's own code runs, for the app's whole declared
capability set (`ADR-0012`).

> **Never probe automatically.** Three independent audits flagged this: an unsolicited request
> to every origin the user visits is an active, attributable *"this visitor runs Orivon"*
> signal, sent from a privacy-branded browser to an audience that reads its own traffic. That
> is strictly worse than the `window.nostr` fingerprint accepted in T16, and it costs a request
> per navigation.
>
> **v0 discovery is therefore:** a `<link rel="orivon-manifest">` hint in HTML already
> delivered, with zero extra requests. The well-known path is fetched *only after* seeing that hint
> in a page the browser is already loading, never speculatively.

> **There is no "open as app" action.** The hint above is the only discovery trigger. A Web3site
> is not a separate category of thing a user "converts" a normal website into; it is the same
> URL, the whole time. Once a manifest is found this way, the browser fetches and caches its
> declared files automatically and silently, with no popup and nothing visible to the user, the
> same way an ordinary browser already caches an ordinary page's own assets with no permission
> dialog, because caching inert files is not itself a capability. `ADR-0012` carries the
> reasoning, including a known, currently-unmitigated gap (no cross-app disk quota, no cleanup
> of superseded versions, `docs/open-questions.md` A57/A58).
>
> A grant is keyed on `(origin, capability, pattern set)` rather than "the whole manifest,
> once", per `Grant`'s own doc comment (`src/contracts/manifest.ts`): the SAME hash can be
> revisited with zero prompts once its capabilities are already granted, and only a changed hash
> (a new version) or newly-requested authority ever asks again.

**The grant prompt must be origin-first.** Any origin can serve a manifest, and `name`/`id` are
self-asserted, so a hostile site can present itself as "Orivon Torrent" with an identical
prompt. Required layout: the **origin** is the largest, primary, non-app-controlled element;
the app-supplied `name` is visibly subordinate and marked as claimed by the site; an `id`
collision with an installed app is surfaced explicitly (`security-model.md` T18).

**Hosting note:** `/.well-known/` is host-scoped, so serving first-party apps from
`<account>.github.io` puts them on **one origin shared with every other repo on that account**:
one grant set, one storage domain, one derived key. First-party apps need a dedicated hostname
that serves nothing else.

Protocol routing (`"protocols": ["magnet"]`) is what lets a magnet link reach the torrent app.
It requires its own user prompt (manifest declaration alone never wins the default), and the
URI is validated against a strict grammar before it touches any other code
(`security-model.md` T23).

## Throughput

Per-message Electron IPC is too slow for torrent-rate data. Sockets therefore carry their
data over a dedicated **`MessageChannelMain` port** per handle, rather than through the main
IPC channel. Control operations (open, close, options) use normal IPC; bulk bytes use the port.

> **Security rule, not an optimisation detail: the raw port never crosses into the main
> world.** The preload holds it in the isolated world and exposes only `contextBridge` closures
> (`socket.write(buf)`, `socket.onData(cb)`). Transferring the port to the page, the obvious
> move when optimising for throughput, hands a raw socket to anything the page can reach
> (`security-model.md` T17). `contextIsolation: true` is what makes this free. **Any throughput
> measurement has to go *through this wrapper***, since that is the path the product ships.

**Throughput is not the constraint.** The wrapper moves ~310 MB/s main to renderer (measured
below) against the 1-5 MB/s 1080p needs. What decides the flagship is whether a renderer bundle
fetches *ordinary* (non-WebRTC) torrents at all, and whether the tree stays free of native
modules; see `build-plan.md` §Week 0. If renderer-side networking cannot carry it, the fallback
is an Electron **`utilityProcess`**, not the main process.

### Measured, 2026-08-25: spike gate 0 (`planning/spike-results/gate-0.json`)

Electron 44.0.0 / Chromium 152, Linux x64, through the `contextBridge` closures rather than a
raw port, so this is the path the product can actually ship.

| | Result |
|---|---|
| Byte fidelity, renderer → main | **Exact** at 64 KB, 256 KB and 1 MB |
| Byte fidelity, main → renderer | **Exact** at all three sizes |
| Throughput, renderer → main | **1134.8 MB/s** |
| Throughput, main → renderer | **313.4 MB/s** |
| **Transferable `ArrayBuffer`, renderer → main** | **UNAVAILABLE** |

**[electron#34905](https://github.com/electron/electron/issues/34905) reproduces, and it is
worse than "can lose its payload".** Passing an `ArrayBuffer` in the transfer list of
`MessagePortMain.postMessage` renderer → main **does not throw and does not corrupt; the
message never arrives at all.** Silent, total loss, at every size tested, and an un-timed reply
promise waits on it forever.

Two consequences:

1. **Do not use transferables on this path**, and do not treat them as an optimisation held in
   reserve: they are not a fallback for a throughput shortfall. It does not matter, because
   structured clone *copies*, and copying already runs 60-200x faster than the 1-5 MB/s that
   1080p streaming needs.
2. **Any reply-carrying protocol over `MessagePortMain` needs a timeout**, because the failure
   mode of this transport is silence, not an error.

**`MessagePortMain` has no documented backpressure**, so without flow control of its own a fast
swarm would grow renderer memory without bound. `handle-contracts.md` §TcpSocket "Backpressure:
a credit window" is that flow control: a byte-credit window on top of `ReadableStream`/`WritableStream`
(`ADR-0008`), with the broker stopping the underlying OS socket read once credit is exhausted
rather than buffering in the main process.

**Media delivery.** Not MSE, and not a localhost HTTP server. Serve pieces to
`<video>` over a **range-capable custom scheme** (`protocol.handle()` returning a streaming
`Response`), or webtorrent's Service-Worker `createServer({ controller })`. Both are
renderer-local and origin-scoped, so **no other local process can reach them**, which is
stronger than guarding a localhost server with a token (T15). Chromium then provides seeking and
track selection for free. MSE is the *worse* option: it needs fMP4 the torrents do not contain, and it forces
hand-implemented seeking.

**v0 plays MP4/H.264 only.** MSE cannot demux Matroska and neither can Chromium's `<video>`, so
MKV has no path at all without a remuxer, and is deferred post-launch (`libav-wasm`, pure-WASM).
Stock Electron ships H.264/AAC, so nothing extra is needed; HEVC is hardware-decode-only and is
out. The limitation is stated in-product, not hidden.

## Why this survives the engine swap

Apps call `orivon.net.connect`. Underneath, that is:

| phase | implementation |
|---|---|
| month 1 | Node `net.Socket` in the main process |
| later | a Wasmtime host function |
| later | Mojo IPC in a Chromium fork |

None of those transitions is visible to an app already written. That property, not Electron
and not Wasmtime, is what keeps the path to a Chromium fork open.

## Open items: provisional defaults, not yet confirmed

These are `open-questions.md` A9. Each has a default below, and the build proceeds on it unless
and until it is overruled. All three are decidable during build step 2 and cheap to change before any
third-party app exists.

### 1. Is `net.listen` grantable to unsigned apps? → **Yes, with constraints**
Listening accepts arbitrary internet input into code the user did not vet. But it is not
arbitrary code execution, and it is the same exposure as running any P2P client. Denying it
would make P2P apps second-class in developer mode, which undercuts the permissionless value
that put developer mode in `ADR-0002` in the first place.

**Default:** grantable to unsigned apps, subject to:
- a **declared port range** in the manifest, with `"*"` rejected for `listen`;
- **privileged ports (<1024) denied outright**, at every tier;
- a distinct, more serious prompt than `connect`, because the user is opening a service, not making
  an outbound call, and the wording should say so.

### 2. Grants keyed per origin, or per origin + manifest version? → **Per (origin, capability, pattern set)**
Manifest-versioning every grant is noisier than it is safe. Two *different* events are being
conflated:

| Event | Response | Comes from |
|---|---|---|
| Bundle hash changes | **Security re-consent**: "this app's code changed" | `ADR-0005`, `ADR-0006` D2 (pinning). The hash itself is `ADR-0009`/`bundle-hash.md`, which includes the manifest, so a manifest-only change also lands here |
| Manifest requests a capability not yet granted | **Capability prompt** for that capability only | this spec |

> **Keying on the capability *kind* alone would leave a hole.** An update changing
> `"connect": ["api.example.com:443"]` to `"connect": ["*:*"]` requests no new capability kind,
> so it would install **silently**. The user granted "talk to one host"; the app would hold
> "connect to any computer on the internet", the exact grant journey 1 puts on camera.
>
> **The re-consent trigger is therefore a subset check over the granted pattern set**, not a
> kind comparison: silent only if the new manifest's patterns are a subset of what was granted.
> Additionally, record a per-origin **version floor** and flag any lower version, so a
> validly-hash-pinned *older* bundle is never installed unnoticed (`security-model.md` T19).
> Flagged, not rejected: a below-floor version is warned and offered as a choice, never silently
> blocked. See this document's §`version` section.

### 3. Is `fs.quotaBytes` enforced or advisory? → **Enforced**
Advisory means a buggy or hostile app fills the user's disk, which is threat **T11** in
`security-model.md`, and a genuinely bad first-run experience for a torrent-first browser.

**Default:** enforced, cheaply. Maintain a **running per-origin byte counter**, check it on
write, and fail with a quota error when exceeded. Reconcile the counter against the directory
on startup rather than walking the tree on every operation. This is a small amount of work
and it is the difference between a disk-full bug and a disk-full incident.
