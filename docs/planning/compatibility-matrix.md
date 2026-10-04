# Compatibility matrix

**What is wired up right now, and the cheapest next lever, across apps, extensions and the
browser around them.** [`../architecture/app-compatibility.md`](../architecture/app-compatibility.md)
owns *why the tiers exist*; this file owns *what works today*. If they disagree, that one is the
design and this one is stale.

**Five contract entries have no implementation behind them:** `id.requestIdentity`, `protocols`,
`media.camera` and `media.microphone`, `clipboard.read`, and reopening a picked path. Two more
stop short of the page: `FileHandle.readable()`/`writable()`, and the `closed` promise of a file or
folder handle. Every other member of `orivon.*` is built Spec'd → Broker → Page. `hid` and
`subprocess` are excluded from v0.

**An app qualifies by running in the Node environment, not by being JavaScript**
([`ADR-0036`](../decisions/ADR-0036-an-app-qualifies-by-running-in-the-node-environment.md)):
WebAssembly runs in an app exactly as it runs in Node. Every gap in these tables is a limit of this
build, taken case by case as a real app reaches it, never a rule about which apps may exist.

Two axes, and they fail in completely different ways:

- **Table 1 is authority**: what is an app *allowed* to do. Missing it, the app runs and every
  privileged call returns `'denied'`.
- **Tables 2 and 3 are ability**: can the app's code *execute* at all. Missing it, the app is
  allowed to do everything and crashes on line 1.

**Table 3 is not a third axis.** It is an inventory over ground Table 2 already covers, at a
finer grain: many of its rows are Table 2's families itemised member by member, and closing one
closes the other: the same item, listed twice, not two blockers. Its `Class` column says which rows
are that duplication and which are genuinely elsewhere. **Completing Tables 1 and 2 closes every
`dup` row automatically**; the `needs T1` and `outside` rows survive it, and the `outside` ones were
never shim work.

**Every area has a row; the detail is one link away.** The tables below cover everything a Node
or Electron app can need, one row per topic, in plain words: what works, what does not, and what
the app sees when it meets the gap. Each section links the page in [`compatibility/`](compatibility/)
that lists every member, permission or protocol one by one, checked against the code; those pages
are for looking up a single name. Counts such as "49 of 80" come from a source search over 80
open-source Electron apps and 56 Node apps with a web front end: they say how common a need is,
never that a given app runs.

**Legend, for this page and the pages under [`compatibility/`](compatibility/).** ✅ built |
⚠️ partial | ❌ missing | 🚫 excluded by design | ➖ not applicable. **⚠️ differs** marks the
dangerous case: the call runs with no error and gives a different result than Node or Electron.
When an app reaches a gap, one of four things happens, and the rows say which:

- *throws a clear "not supported" error* (the detail pages say **refuses by name**): the member
  exists, so `typeof x === 'function'` still says it is there, and a call throws an error that
  names it;
- *is missing, so calling it crashes* (**reads `undefined`**): a bare `TypeError`;
- *the build fails* (**fails the build**): the app's bundler rejects the import;
- *runs but differs* (**differs**): a result comes back, and it is not Node's or Electron's.

A Table 1 row whose route is a web-platform API has ➖ in its four columns and a note that starts
"Web platform:", giving the permission gate's answer.

## Table 1: the capability surface (authority)

**Spec'd** = in [`src/contracts/`](../../src/contracts/) | **Broker** = implemented in
[`src/broker/`](../../src/broker/) and returned by `createBroker` | **Page** = reachable from `window.orivon` |
**Node shim** = a Node-shaped equivalent exists in [`src/shim/`](../../src/shim/)

Every member, limit and error code is in [Table 1](compatibility/table-1-capabilities.md).

### What exists

| Capability | Spec'd | Broker | Page | Node shim | Note |
|---|:--:|:--:|:--:|:--:|---|
| `app.manifest()`, `app.grants()`, `window.orivon` itself | ✅ | ✅ | ✅ | ➖ | `window.orivon` is a frozen object in the top document of every ordinary tab. An iframe, a `web.context` document and a `<webview>` page have none. A frame with no authenticated origin, or a caller whose stack shows extension code, gets `denied`. `manifest()` backs Electron's `app.getVersion` |
| `net.connect` (TCP out) | ✅ | ✅ | ✅ | ⚠️ | Both stream halves work, matched against `tcp.connect` patterns after resolution, and verified in a real launch. The Node shim's `connect()` reads `host` and `port` only: `localAddress`, `family`, `lookup` and `hints` are ignored without an error, and `path` throws a clear "not supported" error. Node shape in [`net/socket.ts`](../../src/shim/net/socket.ts) |
| Outbound patterns (`tcp.connect`, `udp.send`, `https.connect`) | ✅ | ✅ | ✅ | ➖ | `host:port`, at most 256 per grant. `*:*` means every public address and `*:6697` every public address on that port (`tcp.connect` and `https.connect`; `udp.send` takes `*` only as `*:*`); `localhost` means both loopbacks. A private or LAN address is reachable only when the manifest writes it as a literal. Ports 23, 25, 53, 139, 445, 465, 587, 3389, 6667 and 6697 need a pattern that spells that exact port, which `*:6697` does. Every denial is the same `denied` error |
| `net.connectSecure` (TLS out) | ✅ | ✅ | ✅ | ⚠️ | TLS ends on the trusted side ([ADR-0017](../decisions/ADR-0017-orivon-owns-the-app-http-path.md)), matched by hostname against `https.connect`. It takes `ca`, `cert`, `key`, `rejectUnauthorized`, `servername` and ALPN, and reports the handshake on the socket. The Node shim drops `minVersion`, `ciphers` and `session` without an error, and `tls.connect({ socket })` (STARTTLS) throws a clear "not supported" error (A226) |
| `net.listen` (TCP in) | ✅ | ✅ | ✅ | ⚠️ | IPv4 only, ports 1024 and up inside a declared range, each accepted socket a real handle. Node's `http.createServer` and `ws` ride it, verified in a real launch. The Node shim's `net.Server` throws a clear "not supported" error on `listen(path)`, and a single non-loopback address is refused. Node shape in [`net/server.ts`](../../src/shim/net/server.ts) |
| `scope` on `listen` and `udpBind` (`tcp.listen.local`, `tcp.listen.network`, `udp.bind.*`) | ✅ | ✅ | ✅ | ⚠️ | `'local'`, the default, binds `127.0.0.1` and needs the `.local` grant or the `.network` one. `'network'` binds every interface and needs the `.network` grant alone ([ADR-0034](../decisions/ADR-0034-listening-is-local-unless-the-app-declares-the-network.md)). Bind patterns are bare port ranges of 1024 or more; port 0 picks a random port inside them. The Node shim asks for `'network'` when no host is given, then retries as `'local'` |
| `net.udpBind` (UDP) | ✅ | ✅ | ✅ | ⚠️ | IPv4 only. One chunk is one datagram (at most 65507 bytes). Each send is checked against `udp.send`, so sending needs a bound socket. A refused send never throws: it is counted. The Node `dgram` shim reports a refused send as success, drops `type` and `reuseAddr`, and omits 15 `Socket` members. Node shape in [`net/dgram-socket.ts`](../../src/shim/net/dgram-socket.ts) |
| `net.lookup` (and Node's `dns.lookup`) | ✅ | ✅ | ✅ | ⚠️ | There is no `orivon.dns`. `lookup` answers A and AAAA records, public addresses only, for a host named by a held `tcp.connect` or `udp.send` pattern; `https.connect` does not authorise it. The Node shim offers `dns.lookup` only and answers an IP literal and `localhost` itself. Node shape in [`net/dns.ts`](../../src/shim/net/dns.ts) |
| Handles and error codes | ✅ | ✅ | ⚠️ | ⚠️ | Every handle has `id` and an idempotent `close()`; most have a live `closed` promise, but the page's file and folder handles do not. There are 12 `OrivonError` codes. The shim maps them to Node errnos, except `denied`, which stays `'denied'` and never becomes `EACCES` |
| `fs.readFile`, `writeFile` | ✅ | ✅ | ✅ | ⚠️ | Whole files, rooted at the app's own directory; `writeFile` creates missing parent folders and charges the quota. The Node shim puts cwd, homedir, tmpdir and `userData` under the virtual `/orivon/app`, and ignores `mode`, `flush` and `signal`. Node shape in [`fs/fs.ts`](../../src/shim/fs/fs.ts) |
| `fs.readFileSync` and the other `*Sync` calls | ✅ | ✅ | ✅ | ⚠️ | `readFileSync` and `existsSync` work on the main thread ([ADR-0016](../decisions/ADR-0016-synchronous-file-reads-are-permitted.md)), but a file over 2 MiB is refused. In a Worker of a cross-origin isolated app every implemented `*Sync` works; in any other Worker 22 of the 44 throw a clear "not supported" error. The in-flight budget is not shared with the async path (A112) |
| `fs.mkdir`, `readdir`, `stat`, `rm`, `rename` | ✅ | ✅ | ✅ | ⚠️ | All work. `readdir` returns names only, ignores `recursive` and cannot list the app root. `stat` returns `size`, `isFile`, `isDirectory` and `mtimeMs` and nothing else, so 19 of Node's 25 `Stats` members are missing and read as `undefined` |
| `fs.open` (`FileHandle`) | ✅ | ✅ | ⚠️ | ⚠️ | Every Node open flag except `as`, `as+` and numeric flags, with positional `read`, `write`, `stat`, `truncate`, `sync`. `createReadStream` and `createWriteStream` run over it in the shim. A handle's own `readable()` and `writable()` are built in the broker but not on the page, so they throw a clear error (A184) |
| Path confinement, quota and handle limits | ✅ | ✅ | ➖ | ⚠️ | Every path is relative to the app's root: `..`, absolute paths, backslashes, drive prefixes and Windows device names are `denied`, even on Linux. `fs.quotaBytes`, when declared, is charged on writes; exhaustion is `limit`, not `ENOSPC`. 64 open handles per origin. A symlink swapped in between check and open can escape (A283) |
| `fs.userSelected` (file and folder pickers) | ✅ | ✅ | ⚠️ | ➖ | The only route outside the app directory, and the picker choice is the consent. It needs a user click. A file comes back as a `FileHandle`, a folder as a `DirectoryHandle` with nine members. Home, filesystem roots and system folders are refused. The folder handle's member set awaits the owner (A195). The Node `fs` shim never reaches a picked path |
| Reopening a picked path | ✅ | ⚠️ | ❌ | ➖ | The contract says a pick lasts across restarts. The broker records each pick, and the permissions panel lists it and can revoke it, but no page call reopens one, so the app shows the dialog on every launch |
| `id.publicKey`, `id.sign` | ✅ | ✅ | ✅ | ➖ | P-256 only: a per-origin key that signs silently with ECDSA/SHA-256. The curve must be in the grant or the manifest's `id.curves`. A declared `secp256k1` fails `internal` and any other name fails `invalid` |
| `id.requestIdentity` | ✅ | ❌ | ❌ | ➖ | Specified, not built: the call reads `undefined` on the page, and the connect prompt does not exist. The Nostr provider in [`nip07.ts`](../../src/nostr/nip07.ts) calls it and cannot reach a page (A111) |
| `secrets` (`available`, `encrypt`, `decrypt`) | ✅ | ✅ | ✅ | ➖ | [ADR-0033](../decisions/ADR-0033-an-app-may-hold-an-origin-bound-secret-in-the-os-keyring.md): an origin-bound AES-256-GCM key derived from the identity seed, never the seed itself. `available()` is `false` with no grant or a session-only seed. The Node shim backs Electron's async `safeStorage`; the synchronous `encryptString` and `decryptString` throw "not built" |
| `app.requestGrant` | ✅ | ✅ | ✅ | ➖ | A page's call opens a consent dialog and resolves `true` or `false`; an accepted answer persists a grant later calls use. It refuses anything the manifest did not declare, and `web.context` and `web.embed`. A first-ever visit can see an early call denied before the dialog resolves. Unit tests cover it; no real-launch test calls it from a page |
| How a grant is made, lasts and is revoked | ✅ | ✅ | ➖ | ➖ | Install consent asks once for the whole declared set (or per capability), before the app's own code runs. A loopback origin is asked once at its first visit and the grant lasts the session. The person revokes from the permissions panel or the site-info popover, and revoking closes every handle the grant opened. Picked paths outlive an `fs` revoke |
| `web.context` (`orivon.web.openContext`) | ✅ | ✅ | ✅ | ➖ | An isolated, never-displayed document at an origin the manifest names, plus one script run in it. No `orivon.*`, no cookies and no network of its own: every request is authorised against the opening app's `https.connect` grant. The one thing a page cannot do itself. Broker in [`capabilities/web.ts`](../../src/broker/capabilities/web.ts). **Provisional:** [ADR-0019](../decisions/ADR-0019-an-app-may-run-code-at-an-origin-the-user-named.md) is `proposed` |
| `web.embed` (`<webview>`, `setEmbedScript`) | ✅ | ✅ | ✅ | ➖ | [ADR-0039](../decisions/ADR-0039-an-app-may-show-a-site-inside-its-own-page.md): a site shown inside the app's own page under one warning-level grant whose patterns are exact origins or `*`. The shown page is sandboxed, has no `orivon.*`, and may load documents only from granted origins. The app's own script runs first in every shown page, whatever its CSP. Broker in [`capabilities/embed.ts`](../../src/broker/capabilities/embed.ts) |
| `web.embed` local pattern, `orivon-popup` and `orivon-download` events | ✅ | ✅ | ✅ | ➖ | A pattern such as `http://*.localhost:<port>` shows pages the app serves itself, loading only while the app holds a listener on that port. A popup a shown page asks for opens nothing and a download is cancelled; the app hears both as events and decides what to load. **Provisional:** the shapes await the owner (A305) |
| Manifest `crossOriginIsolated` | ✅ | ✅ | ➖ | ➖ | `true` serves the app with `COOP: same-origin` and `COEP: credentialless`. That gains `SharedArrayBuffer` and `Atomics.wait` in Workers (WebAssembly threads, synchronous `fs` in a Worker) and costs `window.opener` from popups |
| Manifest fields and the capability list | ✅ | ✅ | ➖ | ➖ | The loader pins the bundle hash tree, refuses a version below the highest installed, and re-asks consent when any pattern widens. It accepts `net`, `fs`, `id`, `web`, `secrets` and `protocols` under `capabilities`; 12 of the 15 capability kinds are built, and `media` and `clipboard` are contract only |
| `protocols` (scheme routing) | ✅ | ❌ | ❌ | ➖ | Declared in the manifest and validated by the loader, then used by nothing: it is not a capability kind, nothing registers a scheme with the operating system, and how a routed address would reach the app is unspecified. Loader in [`manifest/capabilities.ts`](../../src/loader/manifest/capabilities.ts) |
| `media.camera`, `media.microphone`, `clipboard.read` | ✅ | ❌ | ❌ | ➖ | Contract only for an app ([ADR-0032](../decisions/ADR-0032-camera-microphone-and-clipboard-read-join-the-grant-model.md), `proposed` for the app door). The loader rejects `capabilities.media` and `capabilities.clipboard`, and the permission gate refuses camera, microphone and clipboard read to every registered app. An ordinary website is asked once per site instead ([ADR-0049](../decisions/ADR-0049-a-website-is-asked-once-per-site-for-each-powerful-permission.md)) |
| Limits and quotas (`LIMITS`) | ✅ | ✅ | ➖ | ➖ | 19 per-origin bounds. Past 512 sockets (64 by default) or 64 file handles, a call fails `limit` at once; past 256 operations in flight it queues for up to 10 s, then fails `limit`. Control calls share a bucket of 200 that refills at 100 a second. Three bounds (`embeds`, `embedEventUrlBytes`, `secretBytes`) carry numbers the owner has not confirmed (A305) |
| `hid` / USB, serial, Bluetooth pairing | 🚫 | 🚫 | 🚫 | 🚫 | Cut from v0 for every tier. The permission gate denies `hid`, `serial` and `usb` and pre-grants no device, so Ledger and Trezor transports, `serialport`, `node-hid`, smart cards and security keys do not work |
| `subprocess` (a native program) | 🚫 | 🚫 | 🚫 | 🚫 | Never a native process: one holds its user's whole authority, so no grant can bound it ([ADR-0040](../decisions/ADR-0040-native-shaped-node-features-run-as-webassembly.md)). `spawn` of a native file fails `ENOEXEC`, so apps that call `git`, `ffmpeg` or `python` need a WebAssembly build of the program. A child process is a WebAssembly program or an app module in a Worker of the app's own tab |

### What no capability covers

Authority an app can need that no `orivon.*` member gives. "Shim alone" means a Node-shim change
could answer it with no new contract member. "Web platform" rows are answered by Chromium and the
shell's permission gate, not by `orivon.*`.

| Authority | Spec'd | Broker | Page | Node shim | Note |
|---|:--:|:--:|:--:|:--:|---|
| Reach a LAN peer chosen at run time | ❌ | ❌ | ❌ | ❌ | A private, link-local or CGNAT address is reachable only when the manifest spells it as a literal. A server on a reserved port the person types in is reachable over `tcp.connect` or `https.connect` when the manifest declares `*:<port>` for that port (`*:6697`); over `udp.send` it is not (A304) |
| STARTTLS, TLS protocol settings, socket options | ❌ | ❌ | ❌ | ⚠️ | `connectSecure` is TLS from the first byte, so PostgreSQL, SMTP and IMAP upgrades throw a clear "not supported" error (A226). The shim accepts `minVersion`, `ciphers`, `localPort` and `reuseAddr` and ignores them, so a TLS 1.3 pin is not enforced. A new operation on `TcpSocket` or a wider `SecureConnectOptions` would settle it |
| UDP multicast, broadcast, and sending without a listener | ❌ | ❌ | ❌ | ❌ | mDNS, SSDP, Wake-on-LAN and LAN discovery cannot work: a multicast or `255.255.255.255` destination is refused and no group can be joined. Every UDP send needs a bound socket, hence the heavier network bind. A new contract member with a scope would settle it |
| Unix sockets, named pipes, raw sockets, ICMP | ❌ | ❌ | ❌ | ❌ | `net.connect({ path })` throws a clear "not supported" error, so Docker, `ssh-agent` and local database sockets are out of reach. Raw sockets and packet capture are listed as deliberately not in v0. A new capability would be needed |
| Proxies, Tor and a system proxy | ❌ | ❌ | ❌ | ⚠️ | While a system proxy applies to the destination every `orivon.net` call is `denied`; the page's own `fetch` uses the proxy. No capability names a proxy, and `.onion` names cannot be authorised. A proxy handshake spoken by hand over `net.connect` to a declared `localhost` port should work (not measured) |
| HTTP/2 and HTTP/3 (QUIC) | ❌ | ❌ | ❌ | ❌ | `http2` loads and every function throws a clear error, so gRPC clients do not work; QUIC has no route. An HTTP/2 client over `connectSecure` would be shim work alone |
| Sockets from a Worker, an iframe or a `<webview>` | ❌ | ❌ | ❌ | ❌ | Only a tab's top document has `window.orivon`, so networking moved into a Worker must be proxied through the page |
| WebRTC and WebTransport | ➖ | ➖ | ➖ | ➖ | Web platform: both work as in Chromium, and no grant bounds them |
| IPv6 listening, TLS servers, NAT traversal | ❌ | ❌ | ❌ | ❌ | Servers and UDP sockets bind IPv4 only: `listen(port, '::1')` binds `127.0.0.1` without an error. `tls.createServer` and `https.createServer` throw a clear error, since `listen` hands out plain sockets. UPnP needs multicast, and NAT-PMP cannot find the gateway (A218) |
| DNS records other than A and AAAA, names that resolve only to a private address | ❌ | ❌ | ❌ | ❌ | `dns.resolve*`, `Resolver`, `reverse` and 17 more throw a clear "not supported" error, so SRV, TXT and MX lookups fail. `lookup` rejects a `.local` or NAS name even though `connect` to the same name works under a declared literal. DNS over HTTPS to a granted host is the workaround |
| Missing Node `fs` calls: `copyFile`, `cp`, `mkdtemp`, `opendir`, `glob`, `readv` | ➖ | ➖ | ➖ | ❌ | Throw a clear "not supported" error. Each composes from `readFile`, `writeFile`, `readdir`, `stat` and `open`, so the Node shim alone could answer it. Build tools and editors need them |
| Links, permissions, file times, locking, free space | ❌ | ❌ | ❌ | ❌ | `symlink`, `link`, `chmod`, `utimes`, advisory locks and `statfs` throw a clear error; `stat` has no `atime`, `mode` or `uid`. Package managers, SQLite and sync tools need them. `chmod` and `chown` have no permission model behind them by design. A contract change would settle the rest |
| Watching files (`fs.watch`, `watchFile`) | ❌ | ❌ | ❌ | ❌ | Throw a clear "not supported" error because the contract has no change event. `chokidar`, dev servers, editors and sync clients need it. A contract member would settle `watch`; the shim alone could poll `stat` for `watchFile` |
| Paths outside the app's folder | 🚫 | 🚫 | 🚫 | 🚫 | Every absolute path is `denied`. `app.getPath` throws for Documents, Desktop and Downloads; only `userData` answers. A mounted volume is reachable by picking a folder on it, with `fs.userSelected` |
| Opening a file in the OS default app, revealing it, moving it to the trash | ❌ | ❌ | ❌ | ❌ | The `shell` module throws a clear "not supported" error and no `orivon.*` call exists. Document apps need it. A permission decision would cover open and reveal, as it does for `openExternal`; trash needs a new member |
| WebAssembly children, `fork`, `worker_threads`; no shell, `cluster` or terminal | ➖ | ➖ | ➖ | ⚠️ | A WASI program or an app module runs in a Worker of the app's own tab, under the app's grants. `exec` parses one command line and runs one program: there is no shell, pipe or redirect. `cluster`, `inspector`, `repl`, `v8` and `utilityProcess` are missing. Shim work, with a WASI shell for terminal apps |
| Controlling the OS: input synthesis, window lists, the registry, drives, process list, machine IDs, GPIO pins | ❌ | ❌ | ❌ | ❌ | No member exists and no ADR names them. A native library cannot run, and a WebAssembly build has no OS to ask. Such a member would hold the user's whole authority. Being a browser extension's native-messaging host falls here too, since the host manifest lives outside the app's folder |
| Signing keys other than P-256: `secp256k1`, Ed25519, Schnorr | ⚠️ | ❌ | ❌ | ➖ | The contract's own example is `secp256k1`, but the broker implements P-256 only, so a `secp256k1` app fails `internal` and any other name fails `invalid`. Bitcoin, Ethereum and Nostr apps need it. A broker change covers ECDSA on `secp256k1`; the others need a contract decision |
| Client certificates, the OS trust store, biometrics, passkeys, a keyring adapter | ❌ | ❌ | ❌ | ➖ | A website gets a client-certificate chooser and a local password store, and no `orivon.*` capability exposes either to an app; trust roots are the runtime's built-in list. Touch ID and Windows Hello throw a clear error and passkeys are unwired. `orivon.secrets` returns ciphertext the app stores itself, so no `keytar`-shaped module exists; the seed is never readable. Shell or contract work |
| Camera, microphone, screen capture | ➖ | ➖ | ➖ | ➖ | Web platform: a website is asked once per site for the camera and microphone ([ADR-0049](../decisions/ADR-0049-a-website-is-asked-once-per-site-for-each-powerful-permission.md)); a registered app is refused, and no screen-source picker exists. QR scanners and calls need them in an app. A grant kind is specified and unbuilt (`media.camera`, `media.microphone`); a picker in the shell would settle screen capture |
| Bluetooth, NFC, MIDI, sensors, geolocation, printing | ➖ | ➖ | ➖ | ➖ | Web platform: a website is asked once per site for MIDI and for location (location is then told no, since Orivon has no provider); the gate denies speaker selection and every registered app is refused MIDI and location; Bluetooth has no chooser, so a request should be cancelled (not measured). Printing is not measured, and sensors are measured for four APIs only (Table 8). Bluetooth needs a chooser in the shell |
| Clipboard read | ➖ | ➖ | ➖ | ⚠️ | Web platform: a website is asked once per site for `clipboard-read` and `deprecated-sync-clipboard-read`; a registered app is refused, and Electron's `clipboard` module throws. The grant kind `clipboard.read` for an app is specified and unbuilt ([ADR-0032](../decisions/ADR-0032-camera-microphone-and-clipboard-read-join-the-grant-model.md)). Clipboard write works through the web API after a user click |
| Notifications, external links, popups, fullscreen, system dialogs | ➖ | ➖ | ➖ | ⚠️ | Web platform: notifications ask once per site in Orivon's own prompt; `mailto:` and `magnet:` ask each time and 32 schemes are refused; a popup keeps `window.opener`, and a website's popup opened with no click is blocked; fullscreen is allowed with a notice. `dialog.showOpenDialog` throws "not built" and the other dialog calls throw a clear error (A187) |
| OS and machine information | ➖ | ➖ | ➖ | ⚠️ | Deliberately virtual: `os.platform()` is `'browser'`, `os.cpus()` is an empty list, memory reads `Number.MAX_VALUE`, `process.env` holds only the virtual directories and `os.networkInterfaces()` returns `{}` with no error. Nothing about the host is disclosed. Shim choices, not capabilities |
| Tray, menus, dock badge, extra windows, global shortcuts, autostart | 🚫 | 🚫 | 🚫 | 🚫 | `Tray`, `Menu` and `BrowserWindow` throw "desktop shell"; `globalShortcut`, `powerMonitor`, `screen` and `nativeTheme` throw a clear error, and `setLoginItemSettings` is missing. The app runs in a tab. A decision in the gate plus the shell would settle shortcuts, autostart and single-instance hand-off |
| Registering a URL scheme or file type | ✅ | ❌ | ❌ | ❌ | The manifest's `protocols` list is validated and used by nothing, and file-type associations do not exist. The browser registers itself for http and https from a packaged Linux install, which is not an app's registration. Torrent, mail and wallet-link handlers need them. Shell plus contract work |
| Cookies, request interception, custom URL schemes, `webContents` | ❌ | ❌ | ❌ | ❌ | No cookie API exists, and `webRequest`, `protocol.handle` and `session` throw a clear error, so ad blockers and scrapers have no route. A shown page's script can read non-HttpOnly `document.cookie`. `webContents` (zoom, history, `printToPDF`) belongs to the shell |
| Running after the tab or the browser closes, at login, on a schedule | ❌ | ❌ | ❌ | ❌ | Sockets, listeners and file handles close with the origin's last document, a child lives until the app's last page closes ([ADR-0046](../decisions/ADR-0046-an-app-s-children-live-until-its-last-page-closes.md)), and closing the browser ends everything. Seeding, relay and mail apps need more. A background-lifetime rule in the shell would settle it |
| App data export, syncing, sharing between apps, the app's own update | ❌ | ❌ | ❌ | ❌ | No app-data export exists; sync and cross-app sharing are excluded; only `app.manifest().version` is visible, with no update event, and `autoUpdater` throws a clear error. Storage itself (`localStorage`, IndexedDB, cookies) is ordinary Chromium storage per origin |
| Wallet providers: `window.ethereum`, `window.nostr` | ❌ | ❌ | ❌ | ❌ | Neither is injected. A Nostr provider exists in [`nip07.ts`](../../src/nostr/nip07.ts) and waits on `id.requestIdentity` (A111); a design for Ethereum providers is written, and a funds-bearing wallet is out of this build's scope |

**Only prefixes of ✅ are legal.** A call travels Spec'd, then Broker, then Page, so a cell may
never be better than the one before it. The valid shapes are ❌❌❌, ✅❌❌, ✅✅❌ and ✅✅✅, and
their ⚠️ variants. Anything else is a defect or a mislabel: Broker ✅ with Spec'd ❌ means the
implementation ran ahead of the contract, which [ADR-0002](../decisions/ADR-0002-capability-api-is-the-durable-asset.md)
exists to prevent. `➖` and `🚫` are their own categories. The Node shim column is independent.

**What is proven end to end.** A real Electron launch proves a granted `net.connect` round-trips
bytes and a call outside the pattern is `denied`, and it drives `connectSecure`, `listen`, `udpBind`,
the `fs` calls, `id`, `web.context` and `web.embed` through the real IPC pipe. Five surfaces have no
real-launch test that calls them from a page's own script: `app.requestGrant`, both `fs.userSelected`
shapes, `secrets`, `net.lookup` and `fs.open`; unit tests over the real wiring cover them. No test
drives the whole chain from a real public HTTPS origin through the real install-time consent dialog,
because the loader admits only public origins and no hermetic fixture can pass. Each link is proven
for real; that is a limit of CI, not a gap in the mechanism.

## Table 2: the four adapter families

An app never calls `orivon.*` directly unless it was written for Orivon. Something has to present a familiar interface on top. There are four such layers. Each has a section below; the detail pages hold every module and every export.

| Family | What it presents | Backed by | Status |
|---|---|---|:--:|
| **Node stdlib** | The 72 module names of Node 24's `builtinModules`: `net`, `dgram`, `fs`, `http`, `https`, `tls`, `buffer`, `stream`, `process`, `node:sqlite`... | `net.*`, `fs.*`, `orivon.net.lookup`, npm polyfill packages, hand-written modules, Web Workers, the web platform | ⚠️ partial: [`module-map.ts`](../../src/shim/module-map.ts) maps 40 of the 72, and none of the 40 has every Node export behaving as Node's. The other 32 are missing and left to the app's own bundler, so the build fails or the app gets an empty object. A few refusals are by design: `https.createServer`, STARTTLS, HTTP/2 sessions |
| **`electron` module** | `app`, `ipcRenderer`/`ipcMain`, `dialog`, `BrowserWindow`... | `app.*`, `fs.userSelected`, `secrets.*` | ⚠️ partial, in [`src/shim-electron/`](../../src/shim-electron/): of the 48 names `require('electron')` exports, none is complete. `app`, `ipcMain`, `ipcRenderer` and `safeStorage` work in part, `nativeTheme` answers wrongly, 18 throw a clear "not supported" error when called and 25 are missing |
| **Web ecosystem** | `window.nostr` (NIP-07), `window.ethereum` | `id.*` | ❌ missing: no page receives either. The NIP-07 object is built ([`nip07.ts`](../../src/nostr/nip07.ts)) and waits for `id.requestIdentity` (A111); `window.ethereum` is not built. A wallet extension can inject a provider into a granted, network-served tab |
| **The app's own preload surface** | whatever that app's preload exposed: `window.ftElectron` for FreeTube | any capability its calls happen to map to | ➖ **Not Orivon's to ship.** One file per ported app, living with the app |

### How a port gets these families

The shim reaches a port only through an esbuild plugin ([`esbuild-plugin.ts`](../../src/shim/bundler/esbuild-plugin.ts)) that applies the module map to the port's own build, and only The Lounge's server uses it. The other four ports in `orivon-ports` bring their own polyfills or empty stubs: FreeTube empties eleven modules the shim maps, ASGARDEX and AirGap Vault take `stream-browserify` and `crypto-browserify`, and Element empties four. No port's renderer imports `electron`. No webpack or Vite preset of the module map exists. Whether those four should bundle against the shim instead is A313.

### Node's standard library

[Table 2a](compatibility/table-2a-node-modules.md) has one row per module name, with every export and the apps that use it. A mapped module that lacks a Node member does one of two things: it throws a clear "not supported" error naming the member, or the member reads `undefined` and a call is a bare `TypeError` (`events`, `stream` and `process` do this). A missing module name gives an empty object in Vite, where a named import then fails the build, and fails the build in esbuild and webpack.

| Modules | Status | What works, and what does not |
|---|:--:|---|
| `fs`, `fs/promises` | ⚠️ partial | Reading, listing, deleting and async writing files inside the app's own data folder work, and `watch` hears the app's own writes. Links, `cp`, `glob`, file times and the stream classes throw a clear error. Most synchronous calls work only in a Worker of a cross-origin-isolated app. `fs/promises` lacks 16 names, so naming one in an import fails the build |
| `path`, `path/posix`, `os` | ⚠️ partial | `path` behaves as Node's POSIX `path`, apart from `format` and missing error codes; `path.win32` is an empty function. `os` answers with browser values: `platform()` is `'browser'`, `homedir()` is `/orivon/app`, memory and CPU figures are placeholders, and `userInfo` and `version` throw a clear error |
| `net`, `dgram`, `dns`, `dns/promises` | ⚠️ partial | TCP clients and servers, UDP sockets and `dns.lookup` work under a grant, over IPv4. A server binds loopback or every interface; another address or a Unix-socket path throws. `BlockList`, `dns.resolve` and the other `dns` lookups throw a clear error, and `dns/promises` holds only `lookup` |
| `http`, `https`, `tls`, `http2` | ⚠️ partial | The `http` client and server (keep-alive, chunked bodies, upgrade), the `https` client and `tls.connect` work. `https.createServer`, `tls.createServer`, STARTTLS and a prebuilt `secureContext` throw a clear error, and TLS options the capability has no field for are dropped without one. `http2` loads, so libraries that read its constants evaluate, but `connect` and `createServer` throw |
| `crypto`, `zlib`, `buffer` | ⚠️ partial | `crypto` covers hashes, HMAC, PBKDF2, common ciphers, Diffie-Hellman, sign and verify, RSA and WebCrypto; 35 names throw a clear error, among them `scrypt`, `hkdf`, `randomInt`, `timingSafeEqual` and `KeyObject`. `zlib` does gzip and deflate; Brotli and Zstd throw. `Buffer` lacks a few methods and the `base64url` encoding |
| `stream`, `stream/promises`, `events` | ⚠️ partial | `Readable`, `Writable`, `Duplex`, `Transform`, `pipeline` and `EventEmitter` work. Newer additions (`compose`, `addAbortSignal`, `events.on`, `getEventListeners`) read `undefined`, so calling one is a `TypeError`. The default buffer limit is 16 KiB where Node uses 64 KiB, and `stream/promises` rejects generator stages and `{ signal }` |
| `url`, `querystring`, `string_decoder`, `assert`, `timers`, `timers/promises`, `util`, `util/types` | ⚠️ partial | Everyday helpers work: `URL`, `fileURLToPath`, `querystring`, `StringDecoder`, `assert`, `util.promisify`, `util.format`, `util.types`. Missing names throw a clear error (`util.parseArgs`, `util.styleText`, `assert.ifError`). `util.inspect` misprints `Map`, `Set` and class names, and timer handles are numbers, so `.unref()` throws a `TypeError` |
| `assert/strict`, `sys`, `punycode`, `constants`, `domain`, `path/win32`, `stream/consumers`, `stream/web` | ❌ missing | No alias exists. Several would be one line: `assert/strict` and `sys` are aliases of modules that work, and `stream/web` only re-exports web globals |
| `child_process`, `worker_threads` | ⚠️ partial | `fork`, `spawn` and `exec` run JavaScript or WebAssembly (WASI) programs in Web Workers, never an OS process ([ADR-0040](../decisions/ADR-0040-native-shaped-node-features-run-as-webassembly.md)). A system binary fails with `ENOENT`, a native one with `ENOEXEC`. `Worker`, `MessageChannel` and `workerData` work; `eval: true` and nested threads throw |
| `vm`, `module`, `wasi` | ⚠️ partial | `vm.runInThisContext` and `Script` run code in the page's own context, which needs the served `'unsafe-eval'`; `createContext` and `runInNewContext` throw. `module.createRequire` loads the app's own CommonJS files and shim modules, and a bare package name throws `MODULE_NOT_FOUND`. `wasi.WASI` runs WASI preview1 programs, and its `start()` returns a promise where Node's does not |
| `process`, `console` | ⚠️ partial | `require('process')` and `require('console')` return the page's own globals. The shim's `process` has about a quarter of Node's members (22 of 83 on an app tab); a missing one reads `undefined`, so a call is a `TypeError`. `console` has the usual methods, and its `Console` class exists only as a named import |
| `tty`, `readline`, `readline/promises` | ⚠️ partial | An app has no terminal. `tty.isatty` returns `false`, so `debug` and `supports-color` skip colour. `readline` loads, so a library that only requires it evaluates, but `createInterface` and the cursor functions throw a clear error. `readline/promises` is missing |
| `async_hooks`, `perf_hooks`, `diagnostics_channel` | ⚠️ partial | `AsyncLocalStorage` gives its value to callbacks bound inside `run`; after an `await`, or in a timer nothing bound, it reads `undefined` where Node carries it, with no error. `createHook` never fires. `performance` and the entry classes are Chromium's, `monitorEventLoopDelay` throws, and `diagnostics_channel` has all six names |
| `cluster`, `v8`, `inspector`, `inspector/promises`, `trace_events`, `repl`, `node:sea`, `node:test`, `node:test/reporters` | ❌ missing | Server or runtime modules with little meaning in a tab, or that no port has asked for. A stub would satisfy feature detection (`cluster.isPrimary` true, `isSea()` false); `node:test` would need a page-side runner. For a `node:` name esbuild fails on the scheme |
| `node:sqlite` | ⚠️ partial | `DatabaseSync` and `StatementSync` run over a SQLite WebAssembly build and are compared with Node's own in tests. `:memory:` works anywhere; a database file works only in a forked child or Worker of a cross-origin-isolated app, with no WAL. `backup`, `Session` and user-defined functions throw. Import it under its `node:` name |
| `_http_agent`, `_http_client`, `_http_common`, `_http_incoming`, `_http_outgoing`, `_http_server`, `_tls_common`, `_tls_wrap`, `_stream_duplex`, `_stream_passthrough`, `_stream_readable`, `_stream_transform`, `_stream_wrap`, `_stream_writable` | ❌ missing | Deprecated aliases of `http`, `tls` and `stream` internals, with no alias of their own. The shim's own `http`, `tls` and `stream` hold the classes, so most could be backed by them |

### The electron module

[Table 2b](compatibility/table-2b-electron.md) has one row per export and per group of members. A ported app does not run its Electron main process ([ADR-0005](../decisions/ADR-0005-apps-are-url-addressed-not-bundled.md)); its renderer bundle imports `electron` and reaches the package in [`src/shim-electron/`](../../src/shim-electron/). An API the package does not build shows in one of three ways:

- **A clear "not supported" error.** The call throws an error that names the API and the reason. Eighteen exports are present as stand-ins that do this.
- **Reads `undefined`.** `app`, `ipcMain` and `ipcRenderer` are plain objects with a handful of members; every other member is missing, so calling it is a bare `TypeError`.
- **The build fails.** Twenty-five exports (`Notification`, `net`, `utilityProcess`, `BaseWindow`...) are not in the package, so `import { Notification } from 'electron'` fails the build in a bundler that checks named imports.

Seven calls that real apps make at start-up end the app at launch: `app.on`, `app.requestSingleInstanceLock`, `app.commandLine.appendSwitch`, `Menu.setApplicationMenu`, `crashReporter.start`, `powerMonitor.on` and `new Tray`. Their rows say so.

| Electron API | What backs it | This package |
|---|---|---|
| `app.whenReady()`, `app.getVersion()`, `app.getPath('userData')` | `orivon.app.manifest()` for the version; the app's own confined `fs` root (`/orivon/app`) for `userData` | ⚠️ partial: they work once `whenReady()` has resolved; `getVersion` and `getPath` throw a clear error before that. `isReady()` is `false` until then. `getPath` for any other name (`home`, `downloads`, `temp`...) throws a clear error, because the host file system is excluded |
| The rest of `app`: events, `quit`, `isPackaged`, `getAppPath`, `getName`, `commandLine`, `dock`, single-instance lock, login items, badges | nothing; the shell owns lifecycle, focus and windows. `pagehide` and `beforeunload` stand in for quitting | ❌ missing: 111 of `app`'s 115 members read `undefined`. `app.on`, `app.requestSingleInstanceLock` and `app.commandLine.appendSwitch` are start-up lines in many mains, so the app stops at launch; `app.isPackaged` is falsy, so every app looks like a development build |
| `BrowserWindow` | nothing for a window of its own; the tab is the window, and `window.open` is the substitute | 🚫 excluded by design: `new BrowserWindow`, `getAllWindows` and `getFocusedWindow` throw a clear error ([`desktop-shell.ts`](../../src/shim-electron/desktop-shell.ts)); its other statics are missing, so `BrowserWindow.fromWebContents(event.sender)` is a `TypeError` |
| `BaseWindow`, `BrowserView`, `WebContentsView`, `View`, `ImageView` | the `<webview>` element for a remote page, `<iframe>` and `<div>` for the app's own content | ❌ missing: the build fails. Off the default export, `new` on any of them throws a clear error |
| `window.open` | the shell adopts a popup as a tab that keeps `window.opener` | ✅ built: the return value is the browser's own `Window`, with `opener`, `postMessage` and `close()`. Size features such as `width` and `height` are ignored, there is no `parent` or modal window, and a tab is limited to 5 new windows a minute |
| `webContents`, `webFrameMain`, `Debugger`, `NavigationHistory` | nothing for the app's own page: no `WebContents` can be obtained. A `<webview>` carries the methods of the page it shows | ❌ missing: the five `webContents` statics throw a clear error, every instance member is unreachable, and `webFrameMain` fails the build |
| `session`, cookies, `webRequest`, downloads, `ServiceWorkers` | one storage partition per installed app, chosen by the shell; an app cannot make or choose one. The routed `fetch` covers stripping CORS and setting `Origin` and `User-Agent` for granted hosts | ❌ missing: `session.fromPartition` throws a clear error, and `session.defaultSession.cookies.get` or `.webRequest.onBeforeSendHeaders` is a `TypeError`. `will-download` is unreachable; `<a download>` and `fetch` plus `orivon.fs.userSelected` save files |
| `protocol` | nothing for an app that answers its own scheme ([ADR-0047](../decisions/ADR-0047-an-app-shows-pages-it-serves-itself-and-hears-a-shown-page-s-popups-and-downloads.md)); an app serves pages from its own `net.listen` listener and shows them in a `<webview>` | ❌ missing: every member throws a clear error |
| `ipcMain`, `ipcRenderer`, `MessageChannelMain` | a local message bus shared by both objects, in one page, with no broker round trip. The page's own `MessageChannel` covers message ports | ⚠️ partial: `invoke`/`handle` and `on`/`send` work between page code and code a port moved into the page. Handlers receive the same object references, not copies; `on` returns `undefined`, where Electron returns the emitter. `sendSync`, `postMessage`, `sendToHost`, `addListener` and `off` are missing. `MessageChannelMain` fails the build |
| `utilityProcess`, `parentPort` | `child_process.fork` (an app module in a Web Worker) or `worker_threads.Worker` | ❌ missing: the build fails and `utilityProcess.fork('x.js')` is a `TypeError`. The substitutes work |
| `contextBridge`, `webFrame`, `webUtils` | the app's preload never runs; a port's bridge script assigns `window.<name>` before the bundle does. A dropped or picked `File` is read with `file.stream()`, since no host path is exposed | ❌ missing: `contextBridge` and the 20 `webFrame` methods throw a clear error, `webFrame`'s properties read a function instead of a frame, and `webUtils` fails the build |
| `dialog` | `orivon.fs.userSelected` or `showOpenFilePicker` for one file; `alert()` and `confirm()` for simple boxes | ❌ missing: all 8 methods throw a clear error. `showOpenDialog` returns host paths while `userSelected` returns a handle that carries none, so it cannot be mapped as it is ([A187](../open-questions.md)) |
| `shell` | an anchor click or navigation to a non-http scheme asks the person before opening ([ADR-0027](../decisions/ADR-0027-an-external-link-opens-only-when-the-person-allows-it.md)); `window.open` opens an `https:` target | ❌ missing: all 7 methods throw a clear error, synchronously, so a `.catch` chain on `openExternal` never attaches. `openPath` and `showItemInFolder` act on host paths, which are excluded |
| `clipboard`, `ClipboardItem` | `navigator.clipboard`: writing is allowed after a click ([ADR-0022](../decisions/ADR-0022-the-permission-gate-allows-clipboard-write.md)); reading on its own is denied | ❌ missing: every `clipboard` call throws a clear error, and `ClipboardItem` fails the build |
| `Notification` | the page's own `Notification`, which asks the person once per site | ❌ missing: the build fails and `new Notification()` on the default export throws a clear error. The page's `Notification` works |
| `Menu`, `MenuItem`, `Tray`, `TouchBar`, dock | nothing; the shell owns the menu and the tray, and a port draws in-page menus | 🚫 excluded by design: `new Menu()`, `Menu.buildFromTemplate`, `Menu.setApplicationMenu` and `new Tray` throw a clear error. `Menu.setApplicationMenu(null)` and a tray made at start-up stop the app at launch. `MenuItem` and `TouchBar` fail the build |
| `nativeTheme` | `matchMedia('(prefers-color-scheme: dark)')` and the other colour and contrast queries | ⚠️ partial: each property (`shouldUseDarkColors`...) reads a truthy function instead of a boolean, and `nativeTheme.on` throws a clear error |
| `screen`, `systemPreferences`, `powerMonitor`, `powerSaveBlocker`, `globalShortcut` | `window.screen` for one display; `navigator.wakeLock` for `powerSaveBlocker`; `keydown` handlers while the tab is focused | ❌ missing: `screen`, `systemPreferences`, `powerMonitor` and `globalShortcut` throw a clear error on every call, and `powerSaveBlocker` fails the build. `powerMonitor.on('suspend', f)` and `screen.getPrimaryDisplay()` (called by window-state packages) stop an app at launch |
| `safeStorage` | `orivon.secrets`, which is asynchronous only ([ADR-0033](../decisions/ADR-0033-an-app-may-hold-an-origin-bound-secret-in-the-os-keyring.md)) | ⚠️ partial: `isAsyncEncryptionAvailable`, `encryptStringAsync` and `decryptStringAsync` work with the `secrets` grant and a reachable keyring. The synchronous trio cannot be backed: `isEncryptionAvailable` answers `false`, so a port's own non-keyring fallback takes over, and `encryptString` and `decryptString` throw a clear error |
| `nativeImage`, `desktopCapturer` | canvas, `createImageBitmap` and `Blob` for images; `getDisplayMedia` is refused and has no picker | ❌ missing: every call throws a clear error, so `nativeImage.createFromPath(p)` and `createEmpty()` throw |
| `autoUpdater`, `crashReporter`, `contentTracing`, `netLog` | nothing for an app: Orivon updates an installed app itself, and a native crash report or a trace would cover every tab | ❌ missing: `crashReporter` throws a clear error (`crashReporter.start({})` stops the app at launch); the other three fail the build |
| Electron's `net` | the page's routed `fetch`, `XMLHttpRequest` and `WebSocket` for granted hosts, and Node's `http` and `https` clients | ❌ missing: the build fails, and `net.request(...)` or `net.fetch(...)` on the default export is a `TypeError`. `electron-updater` and `electron-serve` import it |
| `inAppPurchase`, `pushNotifications`, `ShareMenu`, `sharedTexture`, `IpcMainServiceWorker`, Electron's `WebSocket` | nothing; most are macOS-only, and the page's own `WebSocket` covers the last | ❌ missing: the build fails; a member read off the default export is `undefined` |
| `<webview>` | Electron's own element, enabled for a registered app tab and gated by the `web.embed` grant ([ADR-0039](../decisions/ADR-0039-an-app-may-show-a-site-inside-its-own-page.md)) | ⚠️ partial: 90 of its 113 members work as Electron's own. A granted site loads, the app's script runs first and talks to the element both ways, and ungranted sites and `file:` URLs are refused. Nine attributes (`preload`, `partition`...) are rewritten or dropped and the 12 DevTools members differ. An app-authored guest preload and a `WebContents` for a guest are unavailable |
| Electron's additions to `process` | nothing; `process.platform` is `'browser'` and `versions` is `{}` | ❌ missing: `process.type` and `process.versions.electron` read `undefined` and the methods are a `TypeError`, so a package that tests `process.type === 'renderer'` takes its other branch |
| The subpath specifiers `electron/main`, `electron/renderer`, `electron/common`, `electron/utility`, `original-fs`, and `@electron/remote` | nothing; code a port moves into the page shares one realm with the renderer, so `require('electron')` reaches its objects directly | ❌ missing: not in the module map. `@electron/remote` needs `ipcRenderer.sendSync`, which is missing. `require('electron')` outside an Orivon tab throws a plain `Error` that names `window.orivon` |

### Packages that wrap Electron

[Table 2c](compatibility/table-2b-electron.md#table-2c-packages-that-wrap-electron) has one row for each of 28 such packages, read from their published source against the rows above; the verdicts are not measured in a tab. Most fail for one of five causes: `app` has 4 members, `process.type` is missing, synchronous file writes throw, `screen`, `Menu` and `BrowserWindow` throw, or the package needs a native addon.

| Packages | What they need | On Orivon |
|---|---|---|
| `conf`, `electron-store`, `electron-settings`, `electron-json-storage` | `app.getPath('userData')` and synchronous file writes | ⚠️ partial: reads work, but every write is synchronous and throws a clear error on the page. `electron-json-storage`'s async `get`, `set` and `has` work; `electron-store` 11 takes its main-process branch and fails at the write |
| `electron-is-dev`, `electron-util`, `electron-squirrel-startup`, `auto-launch` | `app.isPackaged`, `process.type`, `process.platform`, `versions.electron` | ⚠️ partial: they load. `electron-is-dev` reports every app as a development build, `electron-squirrel-startup` is a harmless no-op, and `auto-launch` throws because autostart is not offered |
| `electron-updater`, `update-electron-app` | `app`, `autoUpdater`, `net`, `process.platform` | ⚠️ partial: inert at best, because Orivon updates an installed app itself and `autoUpdater` and `net` fail the build |
| `menubar`, `electron-progressbar`, `custom-electron-titlebar`, `electron-acrylic-window`, `electron-window-state`, `electron-localshortcut` | a real `BrowserWindow`, `Tray`, `Menu` or `screen` | ❌ missing: each throws a clear error the moment it makes a window or tray. An in-page `<progress>` element or a `keydown` handler replaces some |
| `electron-context-menu`, `electron-dl`, `electron-debug`, `electron-devtools-installer`, `electron-reload`, `electron-serve`, `electron-unhandled` | `app.on`, `app.getAppPath`, `BrowserWindow`, `Menu`, `session` | ❌ missing: each stops at its first line, because `app.on` and `app.getAppPath` are missing. Most are development tools with no job in a tab |
| `electron-log`, `@sentry/electron` | `app`, `ipcMain`, `net`, `autoUpdater`, `crashReporter` | ⚠️ partial: `electron-log` logs to the console and writes no file. `@sentry/electron`'s main entry fails the build, and its renderer entry resolves to the browser SDK |
| `keytar`, `node-notifier` | a native addon; `os.type()` and a desktop notifier | ❌ missing: `keytar` has no WebAssembly build ([ADR-0040](../decisions/ADR-0040-native-shaped-node-features-run-as-webassembly.md)), and `orivon.secrets` is the substitute. `node-notifier` shows nothing; the page's `Notification` is the substitute |
| `@electron/remote` | `ipcRenderer.sendSync` and main-process `app` and `webContents` | ❌ missing: `ipcRenderer.sendSync` is missing, so it throws. A tab does not need it |

### Providers a page expects

[Table 2d](compatibility/table-2b-electron.md#table-2d-web-ecosystem-providers) has one row for each family of provider that a web page, a wallet dapp or an app's own preload expects to find.

| Provider | Backed by | Status |
|---|---|---|
| `window.nostr` (NIP-07), with `nip04` and `nip44` | `orivon.id` named identities, through [`nip07.ts`](../../src/nostr/nip07.ts) | ❌ missing: no page receives it. The object is built for `getPublicKey`, `signEvent` and `getRelays`; it waits for `id.requestIdentity` (A111), and `nip04` and `nip44` are not defined |
| `window.ethereum` (EIP-1193) and EIP-6963 discovery | nothing: Orivon reads Ethereum only to resolve `.eth` names, for itself | ❌ missing: nothing injects it or answers a discovery request. A dapp reads chain data through the routed `fetch` and `WebSocket` for a granted host, and has no signer |
| Providers an installed extension injects (`window.ethereum`, EIP-6963, `window.nostr`, `window.solana`) | extensions the person installed through the shell | ⚠️ partial: a provider reaches a granted, network-served app tab and an open-web tab, never a pinned-copy app tab, and works as a page object only. Extension code cannot call `window.orivon` ([ADR-0045](../decisions/ADR-0045-window-orivon-refuses-extension-code-a-filter-not-a-sandbox.md)) |
| WalletConnect v2 | the page's routed `WebSocket` and `fetch` to a granted relay host | ⚠️ partial: the transport runs from the page's top frame, without `permessage-deflate`. A Worker, iframe or service worker uses the browser's own `WebSocket`, which the served policy refuses |
| Solana, Cosmos, Bitcoin, Lightning and other chains' page globals | nothing | ❌ missing: Orivon injects none of them, and no Wallet Standard event is dispatched; an extension can inject them |
| WebAuthn, passkeys, Credential Management and FedCM | Chromium's own stack | ⚠️ partial: not measured. Whether the stack answers in this Electron build is unknown |
| `window.orivon` | the shell's preload, in the main world of a registered app tab | ✅ built: the object exists there. Code an extension runs is refused at every call |
| The app's own preload surface: FreeTube's `window.ftElectron`, Element's `window.electron`, ASGARDEX's `api*` objects; The Lounge and AirGap Vault have none | one classic bridge script per port in `orivon-ports`, which assigns the window property before the bundle runs | ➖ **Not Orivon's to ship.** One file per ported app, living with the app |

## Table 3: the runtime environment (ability)

**What the app is capable of doing in the browser environment.** The capability-backed part is
the small part.

**`Class` answers one question: if I complete Tables 1 and 2, is this row still open?**

- **`dup`**: **no.** This row *is* Table 2 at a finer grain. Implement it there and it closes
  here. Pure shim work: write JavaScript in `src/shim/`, no decision needed first.
- **`needs T1`**: **yes**, until Table 1 grows an entry it does not have. The adapter sits
  inside Table 2's family, but there is nothing underneath to build it on, so the work lands in
  [`src/contracts/`](../../src/contracts/): own PR, merges first.
- **`outside`**: **yes.** Neither table covers it. No Node module, `electron` call or web API
  expresses the problem, so no amount of shim work touches it.

### Globals and process

Member lists: [`table-3a-globals-and-process.md`](compatibility/table-3a-globals-and-process.md).

| Surface | Class | Needed by | Status | Where the answer comes from |
|---|:--:|---|:--:|---|
| `process`, `global`, `Buffer`, `nextTick`, `setImmediate` (the Node-only globals a page needs) | `dup` | everything | ✅ built | [`shim/globals.ts`](../../src/shim/globals.ts) installs them before the app's own scripts run. `process` answers what libraries read without claiming to be Node (A223), so most of Node's own `process` names are missing. `nextTick` is a microtask, `setImmediate` a message-channel task, and an uncaught error in either reaches a `process` `'uncaughtException'` listener or the page's `reportError` |
| Where those globals exist | `outside` | every ported app; sign-in popups; apps that host frames or workers | ⚠️ partial | They exist in the main frame of a registered app tab, in a popup to a registered origin, in an origin granted without installing, and in a forked child or thread (a spawned WASI program's Worker gets only `process` and `setImmediate`). They are missing in subframes, plain Workers, `<webview>` guests, unregistered sites and `orivon:` pages. The first document of a first visit runs without them and the tab reloads once after consent |
| `process` identity: `platform`, `arch`, `version`, `versions`, `release`, `pid`, `argv`, `cwd()` | `dup` | `semver` gates, `env-paths`, `open`, `commander`, every `platform === 'win32'` guard | ⚠️ partial | Present but gives different answers than Node: `platform` is `'browser'`, `version` is `''` and `versions` is `{}`, so `versions.node.split('.')` throws. `argv` is `[]`, `pid` is `1` in every tab, and `cwd()` is `/orivon/app`, the root of the app's confined `fs`. A forked child reports a Node-style version and `argv` |
| `process.env` | `dup` | every configuration library | ⚠️ partial | A plain object holding only `HOME`, `USERPROFILE`, `APPDATA` (all `/orivon/app`) and `TMPDIR`, `TMP`, `TEMP`. Every other variable (`PATH`, `USER`, `LANG`, proxy and `XDG_*` names) reads `undefined`, so `env.PATH.split(...)` throws. `NODE_ENV` is `undefined` unless the bundler replaces it at build time, so a library takes its development branch |
| The rest of `process`: `kill`, `chdir`, `getuid`, `execPath`, `binding`, `cpuUsage`, `report`, `features`, `config` and about 50 more | `dup` | `proper-lockfile`, `graceful-fs`, `cross-spawn`, `detect-libc`, `node-gyp-build` | ❌ missing | Each reads `undefined`, so calling it crashes with a `TypeError` and a `typeof process.getuid === 'function'` guard takes its non-Unix branch. The six `EventEmitter` methods `process` lacks (`setMaxListeners`, `prependListener` and four more) are in this group. `process.dlopen` exists only in a bundle that includes the addon loader |
| `process` events, `process.exit()` and quitting | `dup` | shutdown hooks, `signal-exit`, editors that flush on exit, Sentry-style capture | ⚠️ partial | `'exit'` fires only when the app calls `process.exit()`, which emits the event and then throws an "an app tab cannot end its own process" error. It never fires on tab close or reload, and signal handlers such as `SIGINT` are accepted and never run. `'uncaughtException'` sees only errors from `nextTick` and `setImmediate` callbacks; `'beforeExit'` and `'unhandledRejection'` never fire on the page |
| Stdio and the terminal: `process.stdout`, `stderr`, `stdin`, `isTTY` | `dup` | `pino`, `winston`, `debug`, `ora`, `chalk`, `readline`, `inquirer` | ⚠️ partial | `stdout` and `stderr` have `write` and `isTTY: false` only, and each write becomes one DevTools console line, so `\r` progress output is garbage and colour switches off. `.on`, `.end`, `.columns` and `.pipe(process.stdout)` are missing and throw. `process.stdin` is `undefined` on the page; a forked child gets a real stream |
| `process.hrtime`, `uptime`, `memoryUsage`, `umask`, `emitWarning`, `exitCode` | `dup` | benchmarks, `pino`, `mkdirp`, `util.deprecate`, `depd`, CLI-style ports | ⚠️ partial | They exist with browser-backed values. `hrtime` and `uptime` read the page's high-resolution clock (about 0.1 ms resolution). `memoryUsage` reads Chromium's non-standard `performance.memory` and reports `0` where that is missing. `umask` stores a value and affects nothing. `emitWarning` emits `'warning'` or calls `console.warn`, with no deduplication |
| Timers: `setTimeout`, `setInterval`, `queueMicrotask`, ordering | `outside` | `agentkeepalive`, `pino`, `node-cache`, `p-timeout`, schedulers | ⚠️ partial | These are Chromium's own. `setTimeout` returns a number, not a `Timeout` object, so an unguarded `setTimeout(f, n).unref()` throws. `setImmediate(f).unref()` throws the same way, and `util.promisify(setTimeout)` never resolves. Nested timers are clamped to 4 ms and a hidden tab's timers slow to about once a second |
| Environment-detection idioms (is this Node, Electron, a browser, a TTY, production?) | `outside` | `is-node`, `detect-node`, `is-electron`, `electron-log`, `debug`, UMD wrappers | ✅ built | An app sees a plain browser: `process.versions.node` is `undefined`, `process.release.name` is `'browser'`, `process.browser` is `true`, `process.type` is `undefined` and the User-Agent has no `Electron/` token. The exceptions are a forked child, where `typeof window` is `'undefined'` and some tests say Node, and `electron-is-dev`, which reports development for every app |
| Electron's additions to `process`: `type`, `versions.electron`, `contextIsolated`, `resourcesPath`, `crash` and about 20 more | `outside` | `is-electron`, `electron-log`, `electron-updater`, `electron-store` | 🚫 excluded by design | All read `undefined` on purpose, so the app is meant to see a browser and `process.type === 'renderer'` is false. `path.join(process.resourcesPath, 'x')` throws a `TypeError`. The shim leaves `versions` empty so a check for Node or Electron takes its browser branch (A223) |
| The standard JavaScript and web-platform globals Node also has | `outside` | everything | ✅ built | Chromium supplies the ECMAScript names, `WebAssembly`, `Intl`, `AbortController`, `Blob`, `URL`, `TextEncoder`, the WHATWG stream classes, `structuredClone`, `BroadcastChannel`, `EventSource` and `localStorage`. They match Node's public shape. The `crypto` global needs a secure origin and differs from `require('crypto')`. `CompressionStream` handles gzip and deflate. `gc` is absent, since Orivon sets no `--expose-gc` |
| Web globals that behave differently from Node's: `Atomics`, `SharedArrayBuffer`, `MessagePort`, `performance`, `console`, `navigator` | `outside` | wasm threads, worker pools (`piscina`, `comlink`), benchmarks, loggers | ⚠️ partial | `SharedArrayBuffer` exists only when the manifest sets `crossOriginIsolated: true`, and `Atomics.wait` throws on the main thread. A page `MessagePort` has no `.on` or `.unref`. `performance` lacks `timerify` and `eventLoopUtilization`; `console` writes to DevTools and has no `console.Console`. `Error.stack` frames name `https:` script URLs, never file paths |
| Orivon's own globals and how the shim installs them | `outside` | apps written for Orivon; libraries that shadow a global | ✅ built | `window.orivon` is the one locked global. Everything else Orivon installs can be replaced, deleted or shadowed by the app ([ADR-0021](../decisions/ADR-0021-page-globals-carry-the-platform-descriptor.md)). `npm run check:page-globals` fails the build on any other locked global. It does not check which globals are installed or `process`'s values; unit and e2e tests hold those |

### Module system and delivery

Member lists: [`table-3b-modules-and-delivery.md`](compatibility/table-3b-modules-and-delivery.md).

| Surface | Class | Needed by | Status | Where the answer comes from |
|---|:--:|---|:--:|---|
| `require` at run time, and its members (`require.resolve`, `require.cache`, `require.main`, `module.paths`) | `outside` | every CommonJS package; CLI-and-library entries | 🚫 excluded by design | `typeof require` is `'undefined'` at page scope, because tabs run sandboxed with no Node integration. Inside a bundle the bundler rewrites `require`, but a computed `require(name)` fails at run time, `require.resolve` and `require.cache` differ per bundler, and `require.main === module` is silently `false` under esbuild. A forked child has a real global `require`; at page scope `module` is `'undefined'`, so a UMD wrapper takes its global branch |
| `module.createRequire` and `module.builtinModules` | `dup` | ESM packages that load CommonJS or addons; `is-core-module`, `resolve` | ⚠️ partial | `createRequire(import.meta.url)` loads a native addon's WebAssembly build and throws a clear "not supported" error for every other id, builtins included. `builtinModules` lists the 40 modules the shim maps and leaves out the other 32 Node builtins. `process.getBuiltinModule` is missing, so an optional call `process.getBuiltinModule?.('fs')` is safe |
| `__dirname`, `__filename`, `import.meta` | `outside` | packages that read sibling files; ESM packages that locate their own assets | ⚠️ partial | `import.meta.url` is the served script's `https:` URL and works. `__dirname` is a `ReferenceError` under esbuild and Vite (webpack substitutes `'/'`). `import.meta.dirname`, `filename` and `main` are `undefined`, and `dirname(fileURLToPath(import.meta.url))` throws because `fileURLToPath` refuses an `https:` URL |
| The alias table and bundlers (how `require('fs')` reaches the shim) | `outside` | every bundler that applies the shim; every future port of a Node library | ⚠️ partial | [`module-map.ts`](../../src/shim/module-map.ts) holds one alias per specifier, bare and with `node:`. Vite and the shim's esbuild plugin honour `node:`; webpack 5 needs a `NormalModuleReplacementPlugin`. No webpack or Vite preset exists, and the four older ports apply neither the plugin nor the `electron` package. A Worker bundle calls `installGlobals` itself |
| A Node module with no alias (the 32 unmapped builtins, such as `cluster`, `v8`, `worker_threads` subpaths) | `dup` | FreeTube, Element and AirGap Vault (webpack); this repository's esbuild fixtures; `npm run dev` | ❌ missing | The result depends on the bundler. Vite production gives an empty module, so `cluster.fork(...)` throws a `TypeError`; the Vite dev server throws on any property read; esbuild and webpack fail the build. A named import from an unmapped module fails the build even where a default import succeeds, as does a named import of a missing member of a mapped one (`import { cp } from 'fs/promises'`). An npm package named like a builtin (`punycode`, `process`) wins over the alias |
| Package conditions: `browser` versus `node`, and `main`, `module`, `exports` | `outside` | every isomorphic library (`ws`, `node-fetch`, `debug`, `iconv-lite`) | ⚠️ partial | The app's bundler resolves these at build time and the shim reads none. A web build silently swaps a dependency for its `browser` build, which does not use the shim's `net` or `fs`. Setting `resolve.conditions: ['node']` in Vite bundles the Node entry and the shim instead. All five ports build with web defaults; no page says which to choose |
| Other kinds of import: dynamic `import()`, JSON, CSS and text, `.wasm`, `.node`, top-level `await` | `outside` | code splitting, `style-loader`, wasm-bindgen, `sql.js`, native-addon dependencies | ⚠️ partial | JSON and top-level `await` work in an ES-module bundle, and a `.wasm` file loads through `WebAssembly.instantiateStreaming`. A dynamic `import()` must name a declared asset, CSS from JavaScript comes out as a separate file the HTML must link, and a `.node` import loads a sibling WebAssembly build. `format: 'iife'` fails on top-level `await` |
| Reading the app's own packaged files: `fs.readFileSync(path.join(__dirname, 'x'))`, `process.resourcesPath`, asar, `extraResources` | `outside` | Electron apps with data files, updaters and asset loaders | ❌ missing | Cannot work: the shim's `fs` root is the app's writable data directory, and the bundle lives apart from it. There is no asar layer. The replacement is `fetch(new URL('./x.json', import.meta.url))` or a bundler asset import, with the file listed in the manifest's `assets` |
| The manifest: location, fields and extras | `outside` | every app | ✅ built | Found at `/.well-known/orivon.json` through a `<link rel="orivon-manifest">` hint. Five fields are required (`orivonApiVersion`, `id`, `name`, `version`, `entry`), plus `capabilities`; `assets`, `consentGranularity` and `crossOriginIsolated` are optional. An unknown field such as `$schema` or `icons` is ignored with a warning |
| The files the origin serves: types, limits, ranges and headers | `outside` | apps with many small files; media, wasm and Unity builds; service-worker apps | ⚠️ partial | 41 extensions get a real content type; any other is `application/octet-stream`, so a module script under `.node` or `.glb` fails. Limits are 64 MiB per file, 512 MiB per bundle and 4096 entries. One byte range works. `Cache-Control`, `ETag` and `Content-Encoding` are never sent, so precompressed `.br` and `.gz` builds are not decoded. A `.map` file is served only if declared |
| Routing and paths the bundle does not list | `outside` | history-routed single-page apps; apps with a same-origin API or uploads | ⚠️ partial | An installed app serves the entry document for a reload on a route with no dot in its last segment; `/user/john.doe` is a `404`. A `.eth` or IPFS origin that is not installed has no such fallback. A same-origin `fetch('/api/x')` returns `404` because the origin's own server is never reached, and a `POST` is answered as a `GET`. An entry in a subdirectory makes `/` redirect to it |
| Loading a UI from `file://`, inline scripts and third-party scripts | `outside` | Electron apps that load `index.html` from disk; Emscripten and Unity shells, analytics snippets | 🚫 excluded by design | `location` is always a real `https:` URL, so a UI built for `file://` or a custom scheme needs relative URLs. The served rules refuse inline `<script>` blocks, event-handler attributes, `javascript:` URLs, `blob:` and `data:` scripts and any third-party script. The bundle ships every script as a same-origin file; relative URLs and `<base href>` work |
| The first visit, updates and two versions across an update | `outside` | every ported app, the first time it is opened | ⚠️ partial | The first document runs before consent, without the Node globals, routed `fetch` or the served CSP, and the tab reloads once afterwards, losing in-memory state. An installed app checks for an update at most hourly; a new release under a byte-identical manifest is not picked up (A236). A lazy chunk of the previous build loads in a page that has not reloaded. Whether Chromium caches compiled code for a large wasm module is not measured |
| The delivery modes compared: installed, granted without installing, developer mode, `.eth` and IPFS | `outside` | apps tested in one mode and shipped in another | ⚠️ partial | All four give the app the Node globals, routed networking, a real `https:` or loopback origin and the same manifest. They differ in the pin, `404` for undeclared paths, the cookie jar, isolation headers on workers, the routing fallback and `Cache-Control`. A grant on a loopback or plain-`http` origin lasts for the session only, and a granted-without-install origin gets isolation headers on documents only |
| Installing a real built frontend (static-host redirects, extra manifest fields, large assets, client-side routes) | `outside` | every installed app | ⚠️ partial | The loader follows a host's same-origin redirects, ignores an unknown top-level manifest field with a warning, and takes assets up to 64 MiB in bundles up to 512 MiB, streamed to and from disk in constant memory, single Range requests included. Reloading a dot-free client-side route serves the entry document; any other unpinned path is a `404`. An unchanged app costs one conditional manifest request (a 304) an hour (A236) |
| Delivery from a `.eth` name (IPFS content under an ENS name) | `outside` | apps published on IPFS rather than an HTTPS host | ✅ built | `https://<name>.eth` loads as an ordinary origin ([ADR-0030](../decisions/ADR-0030-a-eth-name-is-an-origin-served-by-a-verifier.md)): the Helios light client proves the contenthash (IPFS CID, IPNS key or DNSLink, CCIP-Read included), every block is hashed against its CID, and a failure is an error page, never unverified bytes. It installs through the same hint and dialog and runs from its pin with every server gone. Shown as `ipfs://<name>`. **Named limits:** no Swarm or Arweave, no internationalised names, and one keyless beacon API (A253) |
| Delivery from an `ipfs://` or `ipns://` address | `outside` | IPFS content linked or shared by its address | ✅ built | Typed, linked or opened in a new window, shown as itself in the address bar and on every consent surface, and served at an ordinary https origin, `https://<cid>.ipfs.orivon` ([ADR-0038](../decisions/ADR-0038-an-address-scheme-is-shown-as-itself-and-served-over-https.md)), every block checked as for a `.eth` name. `ipns://` takes an IPNS key or a DNSLink name. **Named limits:** an `ipfs://` subresource inside a page does not load (A260), and a new release under `ipfs://` is a new origin, so apps that keep grants ship under `ipns://` or `.eth` |

### Files

Member lists: [`table-3c-files.md`](compatibility/table-3c-files.md).

| Surface | Class | Needed by | Status | Where the answer comes from |
|---|:--:|---|:--:|---|
| `fs` (async, sync, `fs.open` and `FileHandle`) as a whole | `dup` | every ported app | ⚠️ partial | Node shapes over [`orivon.fs`](../../src/contracts/capability-api.ts): 51 of `fs`'s 104 members exist and take Node's arguments. The other 53 throw a clear "not supported" error when called (reading the name never throws). `createReadStream` and `createWriteStream` run over the shim's own cursor; `FileHandle#createReadStream` and `createWriteStream` throw (A184) |
| Synchronous `fs` (`readFileSync`, `existsSync`) | **`needs T1`** | ported apps, at startup | ⚠️ partial | [ADR-0016](../decisions/ADR-0016-synchronous-file-reads-are-permitted.md). On the page only `readFileSync` (files up to 2 MiB) and `existsSync` run; 19 more (`statSync`, `writeFileSync`, `mkdirSync`, `readdirSync` and others) throw "use the async form" and 20 more throw a clear "not supported" error. In a Worker of a cross-origin isolated app the 19 work too, with no 2 MiB cap. The sync path skips the async path's fairness budget (A112) |
| Calls that work: `readFile`, `writeFile`, `appendFile`, `mkdir`, `rm`, `rename`, `unlink`, `stat`, `access`, `realpath`, `open`, `read`, `write` (callback and `fs.promises`) | `dup` | everything; `write-file-atomic`, `fs-extra`, loggers, `nedb` | ⚠️ partial | They run with Node's arguments and results, and `fs.promises` has 17 of its 33 members. Some options are accepted and ignored without an error: `mode`, `flag` on `readFile`, `signal`, `bigint`, `maxRetries`. Only the five-argument `fs.read` works, 12 of Node's open flags are accepted, and a callback call without a callback raises an unhandled `TypeError`. A `FileHandle` passed to `readFile`, and a named import of the 16 missing `fs/promises` members, fail |
| `Stats` and `Dirent` objects, `fs.constants` | `dup` | `fs-extra`, `graceful-fs`, `send`, `glob`, directory walkers | ⚠️ partial | `stat` returns all 25 `Stats` members, but `orivon.fs` reports only `size`, `mtimeMs`, `isFile` and `isDirectory`; the rest are fixed answers (`mode` `0o600` or `0o700`, `uid` 0, every time equal to `mtimeMs`). `bigint` is ignored. `instanceof fs.Stats` is `false`. `fs.constants` has `F_OK`, `R_OK`, `W_OK`, `X_OK` and nine `O_*` open flags; the `S_*` names and the other `O_*` names read `undefined`. `opendir` and the `Dir` class throw |
| `FileHandle` and file streams | `dup` | async I/O libraries, `send`, `nedb`, `sonic-boom`, archivers | ⚠️ partial | `fs.promises.open` returns a handle whose `read`, `write`, `stat`, `truncate`, `sync`, `chmod` and `close` work. `readFile`, `writeFile`, `readLines`, `appendFile` and six more read `undefined`, so calling them crashes with a `TypeError`. `read()` with no argument fails. A real `Readable` and `Writable` come from `fs.createReadStream` and `createWriteStream`, with `highWaterMark` and `autoClose` ignored and no `fs.ReadStream` class |
| Behaviours that differ silently from Node | `dup` | `glob`, `fast-glob`, `rimraf`, loggers, apps that branch on `err.code` | ⚠️ partial | `writeFile` creates missing parent folders where Node fails `ENOENT`. `readdir` ignores `recursive` and returns the top level only, and under heavy use `withFileTypes` answers wrong kinds with no error. `readdir('.')` on the app root fails `EACCES`. Errors have `code` and `errno` but no `path` or `syscall`, and quota and handle limits are `limit`, not `ENOSPC` or `EMFILE` |
| Links, permissions and times: `symlink`, `link`, `chmod`, `chown`, `utimes` and the rest of that family | `dup` | `fs-extra`, archivers, installers, `pnpm`-style layouts, `touch` | ❌ missing | Link and time calls throw a clear "not supported" error, because `orivon.fs` has no primitive for them. `chmod` checks its arguments and the path and then does nothing, and `chown` throws. A symlink already inside the app's files is followed as the file, and one that leaves it is refused |
| Watching files (`fs.watch`, `fs.promises.watch`, `watchFile`) | `dup` | `chokidar`, dev servers, sync tools | ⚠️ partial | `fs.watch` works by notice: every write made through the shim is announced to the watchers of the same app, in every tab, Worker and forked child. A write from outside the shim or from another app is not heard. `watchFile` and `unwatchFile` throw a clear "not supported" error, because polling would see what the shim cannot |
| Copying, temp folders, truncate, `glob`, `exists`, `statfs`, file locks | `dup` | `fs-extra`, `tmp`, `multer`, `glob`, `proper-lockfile`, download managers | ❌ missing | `copyFile`, `cp`, `mkdtemp`, `truncate`, `glob`, `exists`, `statfs`, `readv` and `writev` throw a clear "not supported" error. Only `copyFileSync` and `mkdtempSync` work, and only in a Worker of an isolated app. A lock built on exclusive create (`wx`) works; `flock`-style locks and memory-mapped files do not exist |
| Path semantics and the virtual root | `outside` | every app; CLIs, `env-paths`, `path.resolve` callers | ⚠️ partial | Every path is relative to one per-origin folder shown as `/orivon/app`, which `process.cwd()`, `os.homedir()` and `$HOME` all return. Absolute paths outside it (`/etc/passwd`) and a numeric descriptor or `/dev/stdin` fail. The app's own bundle is not in this folder, and a picked file is reachable only through `orivon.fs.userSelected`. All tabs, Workers and children of one origin share the folder |
| Limits on `fs` | `dup` | servers, bulk copies, directory walkers, torrent storage | ⚠️ partial | 64 open handles per origin, and the 65th fails with `limit`. 256 operations in flight plus a queue of 256. A bucket of 200 path-based calls refilling at 100 a second, so 1000 `stat` calls in one tick fail from the 201st. One call times out after 15 s. A declared `fs.quotaBytes` is enforced; undeclared means unlimited (A216). Windows device names such as `CON` and `NUL` are refused on every host |
| `os` | `dup` | `env-paths`, `conf`, `piscina`, `electron-store`, telemetry, LAN discovery | ⚠️ partial | `EOL`, `endianness()`, `availableParallelism()`, `homedir()` and `tmpdir()` answer. `platform()` is `'browser'`, `arch()` is `'javascript'`, `freemem()` and `totalmem()` are `Number.MAX_VALUE`, `loadavg()` is `[]` and `networkInterfaces()` is `{}`. `userInfo`, `version`, `machine` and `os.constants` are missing; `os.constants.signals.SIGINT` throws |
| `path` | `dup` | everything | ⚠️ partial | `path` is the POSIX flavour (`path-browserify`), and its 13 members match Node's `path.posix`. `path.format` drops the dot when `ext` has none. `path.win32` has no members, so `path.win32.join` throws, and `matchesGlob` throws. The `path/win32` specifier has no alias: esbuild and webpack fail the build |
| Ambient FS (`~/.bitcoin`) | **`outside`** | migrating an installed app | 🚫 excluded by design | A refusal, not a gap. `fs` is rooted; `userSelected` is a picker, not a mount. [`src/shim-electron/app.ts`](../../src/shim-electron/app.ts)'s `getPath` enforces the identical boundary for any name but `'userData'` |

### Network

Member lists: [`table-3d-network.md`](compatibility/table-3d-network.md).

| Surface | Class | Needed by | Status | Where the answer comes from |
|---|:--:|---|:--:|---|
| `net` TCP client (`net.connect`, `createConnection`, `net.Socket`) | `dup` | every ported app that opens a socket: `ssh2`, `mqtt`, `ioredis`, Electrum clients, IRC libraries | ⚠️ partial | [`src/shim/net/`](../../src/shim/net/) returns a real `stream.Duplex` over `orivon.net.connect` with Node's events and errno-shaped errors (`ECONNREFUSED` with `syscall`, `address`, `port`). A host outside the grant fails with code `denied`. Source-address, `family` and `lookup` options are ignored, `isIP` differs on a few odd forms, and 29 stream members (`closed`, `map`, `toArray`) read `undefined` |
| `net` server (`net.createServer`, `Server#listen`) | `dup` | test servers, OAuth loopback catchers, dev servers | ⚠️ partial | A real `net.Server` over `orivon.net.listen` that needs a declared port from 1024. Listening on every interface under a network grant works; under a local-only grant the socket quietly binds `127.0.0.1` instead, and `::1` also binds IPv4. Binding one specific address (`192.168.1.5`) throws "not supported". `close()` also closes accepted sockets, where Node only stops accepting |
| What `net` cannot reach: Unix sockets and pipes, `new Socket({ fd })`, `BlockList`, `SocketAddress` | `dup` | `dockerode`, `pg` over a socket file, `node-ipc`, peer-blocklist code in `webtorrent`, `libp2p` | ❌ missing | `connect({ path })` fires an `'error'` and `listen(path)` throws, because the capability reaches TCP and UDP peers only. `{ fd }` throws since a renderer holds no descriptors. `BlockList` and `SocketAddress` throw a clear "not supported" error; both are plain computation and could be written in the shim |
| `dgram` (UDP) | `dup` | `bittorrent-dht`, `k-rpc-socket`, `webtorrent`, STUN, DNS and NTP clients | ⚠️ partial | `createSocket`, `bind`, `send`, `close` and the `message` event work over `orivon.net.udpBind`, with real Buffers and Node's argument checks. Multicast, broadcast (`addMembership`, `setBroadcast`) throw a clear "not supported" error, and 15 members (`connect`, `setTTL`, buffer sizes) are missing. `reuseAddr` is ignored, so two sockets cannot share a port |
| `dns` and `dns/promises` | `dup` | `k-rpc-socket`, `nodemailer`, `libp2p` and IPFS (`dnsaddr`), `mongodb+srv` | ⚠️ partial | Only `lookup` works, and it needs a held `tcp.connect` or `udp.send` pattern for the name; private, loopback and reserved answers are filtered. `localhost` and IP literals answer locally. `resolve*`, `reverse`, `lookupService` and `Resolver` throw "not supported" because the capability has no record queries. `dns/promises` holds `lookup` alone, and the `dns` error-code constants read as functions, not strings |
| TLS and `https` (Node's `tls` over `connectSecure`) | **`needs T1`** | nearly every app | ⚠️ partial | [ADR-0017](../decisions/ADR-0017-orivon-owns-the-app-http-path.md): the broker ends the handshake on the trusted side, so a grant and a prompt can name the true hostname. `tls.connect` honours `ca`, `rejectUnauthorized`, `cert`/`key`/`pfx`, `servername`, ALPN and a custom `checkServerIdentity`. It drops `minVersion` and `ciphers` silently; STARTTLS and TLS servers cannot work (A226) |
| TLS sockets, servers and constants | `dup` | SCRAM channel binding, certificate pinning, local HTTPS servers, MQTT brokers, `got` | ⚠️ partial | `getPeerCertificate`, `authorized` and `servername` come from the handshake report. `getCipher`, `exportKeyingMaterial` and 14 other `TLSSocket` members read `undefined`. `tls.createServer` and `https.createServer` throw, because `orivon.net.listen` yields plaintext sockets. `createSecureContext` throws, and `tls.rootCertificates` and the `DEFAULT_*` names read as functions |
| The Node HTTP client (`http.request`, `https.get`, `Agent`) | `dup` | `axios` (Node adapter), `superagent`, `got`, `ws`, `node-fetch` | ⚠️ partial | HTTP/1.1 written in the shim over `net` and `tls`, with Node's options, events (`upgrade`, `connect`, 1xx), abort signals, and `CONNECT` tunnelling. Every request uses its own connection with `Connection: close`: `Agent` pooling options are stored and never enforced, and a proxy agent's `createConnection` is never called, so proxies have no effect. Response trailers come back empty |
| The Node HTTP server (`http.createServer`) | `dup` | `express`, `koa`, `fastify`, `next`, `socket.io`, dev servers | ⚠️ partial | An `http.Server` is a `net.Server` with an HTTP/1.1 request loop, so the `listen` rules above apply. A real-Electron test serves a GET, a chunked POST and a HEAD to clients outside the browser; no test runs the frameworks themselves. Pipelined requests wait, and after `close()` the port keeps accepting and then dropping connections |
| `http2` | `dup` | `@grpc/grpc-js` (Firebase, LND), APNs, `got` with `http2: true` | ⚠️ partial | The module loads and exports `constants` and `sensitiveHeaders`; `connect`, `createServer` and the other nine exports throw "no HTTP/2 session exists over `orivon.net`". A client that catches the error can fall back to HTTP/1.1; a gRPC client cannot connect |
| Silent differences in networking | `dup` | `dockerode`, SSDP and mDNS libraries, LAN discovery, hardened TLS clients, IPv6-only peers | ⚠️ partial | These accept the call and do something else, with no error. `http.request({ socketPath })` dials `localhost:80`. A UDP send the grant refuses reports success and is dropped, so an app cannot tell a refused send from a lost datagram. `udp6` and `::` give IPv4 sockets, `order: 'ipv4first'` is ignored, and `http` joins duplicate `content-type` headers with a comma |
| HTTP client: the page's `fetch`, `XMLHttpRequest` and `EventSource` | `dup` | trackers, web seeds, any REST, FreeTube | ⚠️ partial | Routed through the capability for granted hosts ([`routed/fetch.ts`](../../src/preload/routed/fetch.ts), [`routed/xhr.ts`](../../src/preload/routed/xhr.ts)): redirects followed, responses streamed, requests queued at the socket allowance. A host the app holds no grant for takes the browser's own `fetch`, which the served policy then refuses. Neither webtorrent nor bittorrent-tracker uses Node's HTTP client, and FreeTube is 32 `fetch` calls with zero Node builtins, so **routed `fetch` is the path both flagship candidates take**. No keep-alive (A208) |
| How routed `fetch` differs from a browser's | `dup` | apps that rely on ambient cookies, streaming uploads or `Response.type` checks | ⚠️ partial | There is no CORS check, cookie jar or HTTP cache, and `credentials`, `cache`, `integrity` and `referrer` are accepted and ignored. A request body is read whole before sending, so uploads do not stream. `Response.type` is `'default'`, mixed content is not blocked for a granted host, and `dispatcher` is ignored. Synchronous XHR takes the native path, where CORS applies |
| WebSocket client | `dup` | dapps, wallets (RPC subscriptions, price feeds, WalletConnect relays), `socket.io-client` | ⚠️ partial | The page's own `WebSocket` is routed for granted hosts: `wss:` over the secure-connect capability, `ws:` over TCP connect, an RFC 6455 client in the page, no `permessage-deflate`. An ungranted host keeps the native socket, which the served CSP refuses for any third-party host. A Node `ws`-style second argument (`{ headers }`) makes the constructor throw. A routed socket holds a socket-allowance slot while it is open (A240) |
| Networking from a Worker, an iframe or a service worker | `dup` | apps that move networking into a Worker; embedded widgets | ⚠️ partial | Routing exists in a tab's top frame only, so all four APIs are the browser's own elsewhere (A211). A Worker's `fetch` to a host granted on `https.connect` is served by the app's request handler; `WebSocket` from a Worker is refused by the served CSP even for a granted host. A service worker never sees a routed request. A host with no grant is refused by the served CSP |

### Crypto, compression and buffers

Member lists: [`table-3e-crypto-compression-buffers.md`](compatibility/table-3e-crypto-compression-buffers.md).

| Surface | Class | Needed by | Status | Where the answer comes from |
|---|:--:|---|:--:|---|
| `crypto` as a whole | `dup` | everything that hashes, signs or encrypts | ⚠️ partial | `crypto-browserify` plus the platform's WebCrypto: 34 of Node's 69 exports exist, in pure JavaScript. The other 35 (`scrypt`, `hkdf`, `randomInt`, `timingSafeEqual`, `sign`, `createPublicKey`, `KeyObject`) throw a clear "not supported" error, but `typeof` reports `'function'`, so `if (crypto.randomInt)` passes and the call then fails. Errors carry no Node `code` (`ERR_CRYPTO_*`), and `crypto.constants` has 12 of Node's 56 keys |
| Hashes and `createHmac` | `dup` | content addressing, JWT HS256, API signing, `bittorrent-protocol`, wallets | ⚠️ partial | `md5`, `sha1`, `sha224`, `sha256`, `sha384`, `sha512` and `ripemd160` give Node's digests byte for byte, but 10 to 55 times slower, so a 1 GB `sha256` blocks the page for minutes. The other 44 names (`sha3-*`, `shake*`, `blake2*`, `sha512-256`) throw a plain `Error`. `hash.copy()` is missing, and `getHashes()` lists names `createHash` rejects. `@noble/hashes` is the synchronous stand-in |
| Ciphers (`createCipheriv`, `createDecipheriv`) | `dup` | encrypted storage, keystores, session cookies, AEAD protocols | ⚠️ partial | 27 of 134 cipher names work and match Node: AES in `cbc`, `cfb`, `ctr`, `ofb` and `gcm`, and 3DES. The other 102 (`chacha20-poly1305`, `aes-ccm`, `aes-ocb`, `aria`, `camellia`, `sm4`) throw `invalid suite type`. `authTagLength` is ignored, so only the 16-byte GCM tag interoperates, and ECB with a `null` IV throws. Bulk AES runs at 1 to 8 MB/s |
| Key derivation and randomness: `pbkdf2`, `scrypt`, `hkdf`, `argon2`, `randomBytes`, `randomUUID` | `dup` | password managers, wallets (BIP39), end-to-end messengers, tokens | ⚠️ partial | `randomBytes`, `randomFill`, `randomUUID` and `getRandomValues` work, and callback `pbkdf2` runs natively through WebCrypto (600,000 `sha256` rounds in about 120 ms). `pbkdf2Sync` is correct but about 40 times slower. `scrypt`, `hkdf`, `argon2`, `randomInt`, `generatePrime` and `timingSafeEqual` throw a clear "not supported" error |
| Keys and signatures: RSA, ECDSA, Diffie-Hellman, Ed25519, `KeyObject`, X.509 | `dup` | JWT libraries (`jose`, `jsonwebtoken`), SSH, libp2p, Nostr, certificate pinning | ⚠️ partial | RSA PKCS#1 signing and encryption, ECDSA on four curves (DER form) and ECDH on six curves interoperate with Node. RSA-PSS, `ieee-p1363` ECDSA (JWT ES256), Ed25519, `crypto.sign`, `createPublicKey`, `generateKeyPair` and `X509Certificate` do not exist. `oaepHash` is ignored, and the plain digest name `'sha1'` throws in `createSign`. RSA-2048 signing is about 30 times slower than Node |
| WebCrypto and what it cannot stand in for | `dup` | modern libraries that already use `crypto.subtle`; libraries that call `createHash().digest()` with no `await` | ⚠️ partial | `crypto.webcrypto` is the page's own `globalThis.crypto`, so `subtle` is fast but asynchronous, and it needs a secure origin. It cannot back Node's synchronous calls (`createHash().digest()`, `pbkdf2Sync`, `generateKeyPairSync`). Those need synchronous JavaScript such as `@noble/*`, which is not bundled. Which algorithms Electron 44 offers (Ed25519, SHA-3) varies by Chromium version and is not measured |
| `zlib` gzip and deflate | `dup` | fetch and HTTP payloads, tar and zip tooling, PNG | ⚠️ partial | `gzip`, `gunzip`, `deflate`, `inflate`, raw and `unzip`, in sync, callback and stream forms, round-trip with Node (`pako`). Input must be a string or a `Buffer`; a `Uint8Array` or `ArrayBuffer` throws. `maxOutputLength` is ignored, so nothing caps decompressed size. `zlib.constants` is a function, so `zlib.constants.Z_SYNC_FLUSH` reads `undefined` |
| `zlib` brotli, zstd and `crc32` | `dup` | `content-encoding: br`, `.br` assets, newer archives, zip and PNG writers | ❌ missing | All 17 names throw a clear "not supported" error, and `DecompressionStream('brotli')` is not in Electron 44 (A209). A WebAssembly codec such as `brotli-wasm` could back the sync forms; `crc32` is a short loop. `CompressionStream` could back the stream forms of gzip |
| `Buffer` and the `buffer` module | `dup` | everything; `bl`, `bencode`, binary parsers, JWT and WebAuthn code | ⚠️ partial | The `buffer` package, also the page global, so `instanceof` agrees. Reads, writes and most encodings match Node, but `'base64url'` throws `Unknown encoding`. `equals`, `indexOf` and `copy` reject a plain `Uint8Array`, and `kMaxLength` is 2 GiB. 18 members (`readBigUint64LE`, `utf8Slice`) are missing. `transcode` throws, and encoding runs about 25 times slower than Node |
| Bundler-dependent results | `dup` | any app whose bundler applies the alias table | ⚠️ **unspecified** | The measurements come from esbuild and Vite 7, not webpack or the dev server. A Vite 7 bundle of `crypto` throws `ReferenceError: Cannot access 'crypto' before initialization` when loaded, because a dependency requires `crypto` back into the shim. An esbuild bundle of `zlib` throws `assert2 is not a function` on every codec call |

### Streams, events and utilities

Member lists: [`table-3f-streams-events-utilities.md`](compatibility/table-3f-streams-events-utilities.md).

| Surface | Class | Needed by | Status | Where the answer comes from |
|---|:--:|---|:--:|---|
| `stream` (`Readable`, `Writable`, `Duplex`, `Transform`, `PassThrough`, `pipeline`, `finished`) | `dup` | every dependency tree | ⚠️ partial | `stream-browserify` over `readable-stream` 3. The eight core names work. 15 newer names (`addAbortSignal`, `compose`, `isDestroyed`, `promises`) and the Node 24 conveniences (`Readable.fromWeb`, `.toWeb`, `map`, `toArray`, `Symbol.asyncDispose`, `writableEnded`) are missing, so they read `undefined` and a call crashes with a `TypeError`. `pipeline` accepts streams only, not generator stages or `{ signal }` |
| How `stream` behaves differently from Node's | `dup` | `ws`, `bittorrent-*`, `simple-peer`, anything that waits for `'close'`; `fs.createReadStream` clones | ⚠️ partial | `autoDestroy` is `false`, so a finished stream never emits `'close'`. The default `highWaterMark` is 16 KiB, not 64 KiB. `destroy(err)` called twice emits `'error'` twice, and the `construct`, `signal` and `readableObjectMode` options are ignored. `Readable.from` of a string or Buffer emits one character or byte at a time. `stream/promises` has the same limits as `pipeline` |
| Module specifiers with no alias: `stream/web`, `stream/consumers`, `assert/strict`, `sys`, `punycode`, the `_stream_*` names | `dup` | `node-fetch` 3, `undici`, `whatwg-url`, `tr46`, old `readable-stream` consumers, Node 15+ test files | ❌ missing | Under esbuild the build fails; under Vite the import becomes an empty stub and a named import fails the build. Two are cheap to add: all 17 `stream/web` names already exist as page globals, and `assert/strict` is `require('assert').strict`. `punycode` resolves only if the app installs the npm package |
| `events` (`EventEmitter`) | `dup` | everything; `undici`, `ws`, `AbortSignal`-aware libraries | ⚠️ partial | npm `events` 3.3: `EventEmitter`, `once`, `listenerCount` and `defaultMaxListeners` work, and every instance method is there. Ten static names (`on`, `getEventListeners`, `errorMonitor`, `captureRejections`, `setMaxListeners` and more) read `undefined`, so `ee.on(events.errorMonitor, f)` listens on an event named `"undefined"`. `once({ signal })` ignores the signal, and an unhandled `'error'` has no `ERR_UNHANDLED_ERROR` code |
| `util` | `dup` | nearly every dependency tree (`inherits`, `promisify`, `inspect`, `types`) | ⚠️ partial | The `util` package, with [`polyfills/util.ts`](../../src/shim/polyfills/util.ts) replacing `promisify`, `inherits`, `isDeepStrictEqual` and `TextEncoder`/`TextDecoder`. 13 names work and match Node; `format` and `inspect` are an older algorithm that prints a `Map`, `Set` or class instance as `{}`. `inspect.custom` is missing, and `util.types` answers wrong for `isProxy`. `styleText`, `parseArgs` and 18 more throw a clear "not supported" error while `typeof` says `'function'` |
| `url`, `querystring`, `string_decoder`, `timers`, `assert` | `dup` | ported apps' dependency trees | ⚠️ partial | Hand-written in `src/shim/`. `URL` and `URLSearchParams` are Chromium's; `fileURLToPath` refuses an `https:` URL, so the `import.meta.url` idiom throws. `url.parse` keeps brackets on an IPv6 host, and `querystring` matches Node on 58 of 62 cases. `timers` forwards to the page's functions, and `timers/promises` has no `setInterval`. `assert` has 17 of 22 names |
| Silent differences worth a porter's attention: `assert`, `StringDecoder`, `util.format`, `promisify(setTimeout)` | `dup` | test suites, `iconv-lite`, loggers, `debug`, delay helpers | ⚠️ partial | `assert.throws(fn, new Error('abc'))` passes when `fn` throws `Error('abd')`, and `match(5, /5/)` and `rejects` of a sync throw also pass. `assert` failure text has no diff. `StringDecoder` strips a UTF-8 BOM, which Node keeps. `util.format('%s', obj)` prints `[object Object]`. `util.promisify(setTimeout)` never resolves; `timers/promises` is the working form |

### Running code

Member lists: [`table-3g-running-code.md`](compatibility/table-3g-running-code.md).

| Surface | Class | Needed by | Status | Where the answer comes from |
|---|:--:|---|:--:|---|
| `spawn`, `exec`, `execFile` of a system or native program (`git`, `ffmpeg`, `tor`, `ssh`, `node`, a Go or Rust executable the app ships) | `outside` | FreeTube's external player, ffmpeg wrappers, tor and ssh tunnellers, the `open` package | 🚫 excluded by design | No operating-system process ever runs ([ADR-0040](../decisions/ADR-0040-native-shaped-node-features-run-as-webassembly.md)). `spawn('git')` emits an `ENOENT` error, so an "is it installed" check takes its usual branch; a native executable the app ships emits `ENOEXEC`. `process.execPath` is missing, so `spawn(process.execPath, ...)` throws a `TypeError`: use `fork`. A shell line with a pipe, `&&` or a redirect throws a clear error telling the caller to use `execFile` |
| `spawn` of a WebAssembly program (`wasm32-wasip1`), and Node's `wasi` module | `dup` | Rust, C, Zig and TinyGo tools, `ripgrep`, the SQLite command line | ⚠️ partial | [`src/shim/wasi/`](../../src/shim/wasi/) runs the program in a Worker and needs JSPI (row below). Pipes, the exit code and `kill` work. The program sees the app's files (`orivon.fs`) as `/`, has one thread, and gets no links, file times or sockets. A build that needs threads fails with `ENOEXEC`. `new WASI().start()` returns a promise where Node's is synchronous. 63 of the 72 preview1 conformance programs pass |
| `spawn` of a WASI 0.2 component (`wasm32-wasip2`) | `dup` | Rust on `tokio`, componentised daemons | ⚠️ partial | Runs only as `jco transpile` output shipped beside the program ([`src/shim/wasi-p2/`](../../src/shim/wasi-p2/README.md)); a raw component is refused with the exact `jco` command to run. Sockets reach `orivon.net` and files `orivon.fs`, under the app's grants, so a Rust `tokio` program works. `wasi:http`, threads and WASI 0.3 are missing: such a component fails with `ENOEXEC` |
| `fork(module)` | `dup` | Electron main-process helpers, language servers written in JavaScript | ⚠️ partial | [`fork.ts`](../../src/shim/child-process/fork.ts) runs the module in a Web Worker with a Node-shaped `process`, IPC over `postMessage` and the page's `orivon.*`. The module must be an already-bundled ES module served from the app's own origin and listed in `manifest.assets`. `module`, `__dirname` and `process.execPath` are missing inside |
| `worker_threads` | `dup` | validation-heavy work, `piscina`, `workerpool` | ⚠️ partial | [`thread.ts`](../../src/shim/child-process/thread.ts): `new Worker(path)` runs a module as a thread with `workerData`, `postMessage`, `terminate` and Node's events, under the same bundling rule as `fork`. `eval: true` and a thread started from a thread throw a clear error; `resourceLimits` is accepted and not enforced; `receiveMessageOnPort` and `moveMessagePortToContext` refuse |
| `spawnSync`, `execSync`, `execFileSync`, and what a child is like (options, signals, pids, lifetime) | `dup` | config loaders, build tooling, `tree-kill`, daemons an app keeps | ⚠️ partial | The sync forms work only inside a forked child or thread of an app whose manifest sets `crossOriginIsolated: true`; elsewhere they throw a clear error pointing to `spawn`. `cwd`, `env`, `stdio` as `pipe`, `ignore` or `inherit`, `timeout` and `signal` work. `pid` is an invented counter, every signal ends the Worker at once, and a socket passed through `send` is dropped silently. A child lives until its app's last page closes ([ADR-0046](../decisions/ADR-0046-an-app-s-children-live-until-its-last-page-closes.md)). No memory, CPU or child-count limit exists |
| `cluster` | `dup` | `express` cluster wrappers, `pm2`-style servers | ❌ missing | Not mapped, so the build fails (esbuild, `Could not resolve "cluster"`) or Vite builds a stub whose every property is `undefined`. `fork` and `worker_threads` give CPU parallelism; a listening socket cannot be shared between Workers |
| `vm` | `dup` | template engines (`ejs`, `lodash.template`), code loaders, `vm2`, `jsdom`, `jest` | ⚠️ partial | [`polyfills/vm.ts`](../../src/shim/polyfills/vm.ts): `runInThisContext`, `new Script().runInThisContext()` and `compileFunction` run in the page's own context, which the served policy's eval allowance admits. `createContext`, `runInNewContext` and `runInContext` throw a clear error, because a context of its own needs a second JavaScript realm |
| `module`, `createRequire` and a run-time `require(variable)` | `dup` | plugin loaders, `bindings`, `node-gyp-build`, `require-in-the-middle`, `ts-node`; `npm` is spawned at run time in 9 of 80 open-source Electron apps scanned | ⚠️ partial | `createRequire(import.meta.url)` returns a `require` that loads the app's own relative files, the shim's Node modules and a `.node` addon's WebAssembly build; any other bare name throws `MODULE_NOT_FOUND`. The internals libraries patch (`_load`, `_resolveFilename`, `register`) refuse when called or accept an assignment that is never run. A `require(variable)` in the app's bundle fails at run time in every bundler, and `spawn('npm')` is `ENOENT`: bundle the plugin set at build time |
| Native addons that have a WebAssembly build | `dup` | `better-sqlite3`, `sharp`, `argon2` and other napi-rs and emnapi addons | ⚠️ partial | [`src/shim/addon/`](../../src/shim/addon/README.md): `process.dlopen` and `createRequire(...)('x.node')` load the `.wasm` build beside the path, through emnapi. 149 of the 158 Node-API functions are present; async work runs on the calling thread, not in parallel. File calls work only in a forked child of an isolated app; sockets and threaded builds are not served. A napi-rs package's published WebAssembly build runs through its own browser loader in an isolated app (one package measured) |
| Native addons with no WebAssembly build (`nan`, neon, `ffi-napi`, `koffi`), and the loaders that find them (`bindings`, `node-gyp-build`) | `outside` | `keytar`, `node-pty`, `node-hid`, `usb`, `sodium-native` | 🚫 excluded by design | The load fails with `ERR_DLOPEN_FAILED`, naming the three paths tried; the `.node` binary is never consulted ([ADR-0040](../decisions/ADR-0040-native-shaped-node-features-run-as-webassembly.md)). The loaders scan the disk and read `process.platform` as `'browser'`, so they find nothing: a port aliases the package to a WebAssembly build. [Table 5](#table-5-the-native-module-question-per-library) names the substitute per library |
| WebAssembly threads: `SharedArrayBuffer`, shared `WebAssembly.Memory`, `Atomics.wait` in a Worker | `outside` | Emscripten pthreads, `wasm-bindgen-rayon`, `ffmpeg.wasm` multi-thread, `onnxruntime-web` threads | ⚠️ partial | Only a cross-origin isolated page has them; a manifest with `crossOriginIsolated: true` turns that on ([`serve/csp.ts`](../../src/loader/serve/csp.ts)). An installed app has it on documents and Worker scripts. An origin granted without installing has it on documents only, so its own server must send the isolation headers on Worker scripts, or the Worker does not load; no end-to-end test covers that path. `Atomics.wait` throws on the main thread |
| JS Promise Integration (`WebAssembly.Suspending`, `promising`) | `outside` | Emscripten `-sJSPI`, the WASI hosts | ✅ built | Present on the page and in a Worker, about a microsecond per suspending call, no isolation needed. `spawn` of a WebAssembly program and `new WASI()` need it: without it they fail with a named error. `fork`, `worker_threads` and the addon loader do not |
| A plain Web Worker the app starts (`new Worker(url)`, a `blob:` Worker, a bundler-made one), a `SharedWorker`, a service worker | `outside` | `comlink`, `pdf.js`, `sql.js`, `ffmpeg.wasm` | ⚠️ partial | Starts under the served `worker-src 'self' blob:`. It has no `window.orivon`, and no shim `process` or `Buffer` unless its bundle installs them, so a Node module that reaches `fs` or `net` from it throws "window.orivon is not present"; a `SharedWorker` is the platform's. Whether a service worker can intercept fetches on an installed origin is not measured |
| The WebAssembly engine itself | `outside` | every WebAssembly library | ✅ built | Chromium's WebAssembly compiles under the served `'wasm-unsafe-eval'`, for installed and granted apps alike, and `instantiateStreaming` works on an installed app because `.wasm` is served as `application/wasm`. A synchronous compile of over 8 MB is refused on the main thread: use the async path. Newer features (SIMD, WasmGC, memory64) are not measured |
| Toolchains and libraries built on WebAssembly (Emscripten, Rust `wasm-bindgen`, Go, .NET, Pyodide, `sql.js`, `ffmpeg.wasm`) | `outside` | SQLite, image and document tools, wallet cores, Go and Python ports | ⚠️ partial | A build for the web works if every file it loads is same-origin: the usual default of loading from a CDN is a blocked third-party script, and so is an inline `<script>`. Builds for Node (`-sENVIRONMENT=node`, `wasm-bindgen --target nodejs`) fail. Go's `net` and Emscripten sockets never reach `orivon.net`. Most toolchains are documented, not run, in this repository |

### The page

Member lists: [`table-3h-the-page.md`](compatibility/table-3h-the-page.md).

| Surface | Class | Needed by | Status | Where the answer comes from |
|---|:--:|---|:--:|---|
| Origin and secure context (`location`, `crypto.subtle`, `crypto.randomUUID`, `navigator.clipboard`) | `outside` | every app; routers, OAuth `redirect_uri` checks, WebCrypto users | ✅ built | An installed app runs at its host's real `https://<host>` origin, a granted-only app at its own host's origin, a `.eth` or IPFS app at `https://<name>.eth` or `https://<cid>.ipfs.orivon`. `location` is never `file:`, `app:` or a custom scheme, so code that tests for `file:` takes its web branch, and a `<base href="./">` breaks the assets of nested routes. `isSecureContext` is `true` on every path ([ADR-0007](../decisions/ADR-0007-cached-bundles-served-at-their-own-origin.md)) |
| Scripts the served policy refuses: inline `<script>`, `onclick=` attributes, `javascript:` URLs, a third-party `<script src>`, a `blob:` or `data:` script | `outside` | ports with an inline bootstrap or config, analytics snippets, Emscripten and Unity HTML shells, CDN loaders | 🚫 excluded by design | None of them runs, and no `*` grant changes that: the policy is fixed and the app cannot add a nonce or hash. A bundler that emits every script as an external same-origin file is the substitute ([`serve/csp.ts`](../../src/loader/serve/csp.ts)). A test asserts the third-party refusal |
| Code made at run time: `eval`, `new Function`, `setTimeout('code')`, `WebAssembly.compile`, `instantiateStreaming` | `outside` | `ajv`, `protobufjs`, template compilers, WebAssembly libraries | ✅ built | The served policy carries `'unsafe-eval'` and `'wasm-unsafe-eval'`, so all of them run, for an installed app and for one granted without installing. `instantiateStreaming` needs `application/wasm`, which Orivon sends for `.wasm`. On a granted app the policy is added to the server's own, so a server policy without `'wasm-unsafe-eval'` still blocks compiling |
| Remote styles, frames and plugins: a stylesheet from another origin, a third-party `<iframe>`, `<object>`, `<embed>`, a `<meta>` policy | `outside` | hosted CSS and icon fonts, embedded widgets and sign-in frames, PDF viewers that use `<embed>` | ⚠️ partial | Inline `<style>`, `style=` attributes and same-origin, `data:` and `blob:` frames work. A stylesheet from another origin, a third-party `<iframe>` (use `<webview>` with `web.embed`) and any `<object>` or `<embed>` are refused, grant or no grant. A `<meta>` policy can only narrow the served one. Forms may post to any origin, and any page may frame the app |
| What a grant widens, and a request to a host with no grant | `outside` | apps calling third-party APIs, fonts, avatars, tiles, video hosts; dapps opening a WebSocket from a worker | ⚠️ partial | An `https.connect` or `tcp.connect` grant widens exactly four places: `fetch`/XHR, images, fonts and media. A `*` host admits any `https` subresource, re-authorised per request, never loopback or private addresses. Without a grant the request is blocked by the policy (`TypeError: Failed to fetch`), not by CORS. A native `WebSocket` to a third-party host is refused; the top frame's is routed instead ([`connect-src.ts`](../../src/broker/policy/connect-src.ts)) |
| Response headers, and paths the bundle does not list | `outside` | service-worker apps, cache-header code, apps with a backend on their own origin | ⚠️ partial | A pinned asset carries `Content-Type`, `Content-Length`, range support, the policy, `nosniff` and, if asked, the two isolation headers; it never sends `Cache-Control`, `ETag`, `Content-Encoding`, `X-Frame-Options`, `Permissions-Policy` or `Referrer-Policy`. A same-origin request for a path the bundle does not list is a `404`: an installed app's own server is never reached, so its backend must be a granted host ([ADR-0007](../decisions/ADR-0007-cached-bundles-served-at-their-own-origin.md)) |
| Cross-origin isolation (`crossOriginIsolated: true` in the manifest) | `outside` | `SharedArrayBuffer` users, WebAssembly threads (`wasm-bindgen-rayon`, Emscripten pthreads, `ffmpeg.wasm` multi-thread) | ✅ built | An installed app serves every asset with the two isolation headers, so `crossOriginIsolated` is `true` and `SharedArrayBuffer` exists; without the flag it does not. A granted-without-install origin gets the headers on documents only, so its server must send them on worker scripts. The price: a popup the app opens loses `window.opener`, and cross-origin loads carry no credentials. 20 of 80 open-source Electron apps scanned use WebAssembly or `SharedArrayBuffer` |
| Cookies | `outside` | session-cookie APIs, apps that set `document.cookie` | ⚠️ partial | `document.cookie` works in the app's own session. A routed `fetch` sends and stores no cookie. An installed app's cookies sit in a jar shared with nothing; a granted-without-install app uses the default session's jar, as in Chromium ([ADR-0044](../decisions/ADR-0044-a-grant-no-longer-gives-an-origin-its-own-session.md)). An app tested in one mode and shipped in the other sees different cookies |
| Storage: `localStorage`, `sessionStorage`, IndexedDB, the Cache API, the Origin Private File System | `outside` | every web app; SQLite-in-the-browser libraries; 18 of 80 scanned apps use IndexedDB | ✅ built | Chromium's own, per origin and per session. `sessionStorage` survives a reload and a sign-in that leaves the tab and returns. Two installed apps share nothing, not even with an ordinary tab. The Origin Private File System is a separate store from `orivon.fs`. WebSQL is not applicable |
| Storage limits, clearing, and moving between install and grant | `outside` | apps whose IndexedDB is the only copy of the data; "sign out and forget me" | ⚠️ partial | No quota is set, so Chromium's limits and eviction apply (not measured). "Cookies and site data" clears the default session, and "app data" clears an installed app; neither clears the other's. There is no uninstall. Data written while an origin was granted-only does not move to its installed partition. A private window or a second profile starts with no apps, grants or site data |
| Workers, worklets and frames | `outside` | `comlink`, `sql.js`, `pdf.js`; previews, sandboxed renderers; chat clients that show a hosted page | ⚠️ partial | A dedicated, `blob:` or shared Worker starts; it has no `window.orivon` and no Node globals, because the preload runs only in a tab's top frame ([Table 3g](compatibility/table-3g-running-code.md)). A `blob:` or `data:` worklet module is refused. A same-origin, `data:` or `blob:` frame loads with no `orivon` of its own. A `<webview>` under `web.embed` shows another site, sandboxed ([ADR-0039](../decisions/ADR-0039-an-app-may-show-a-site-inside-its-own-page.md)). Service-worker interception is not measured |
| WebRTC (`RTCPeerConnection`, data channels, STUN and TURN) | `outside` | webtorrent, PeerJS, call apps; 12 of 80 scanned apps | ⚠️ **unspecified** | Chromium's own, not bounded by the page's policy or by grants and not routed through `orivon.net`, so an app tab reaches STUN, TURN and peers with no grant (A41). Camera and microphone tracks need the media permission: a website is asked once, and a registered app is refused |
| Referrer, mixed content and leaving the app's origin | `outside` | OAuth and payment redirects; LAN and localhost services from an `https` page | ⚠️ partial | No `Referrer-Policy` is set, so Chromium's default applies (not measured). A native `http:` request from the `https` page is blocked; a granted `http://` or `ws:` host is reached by the routed path. `location.href = otherOrigin` leaves the app, and an installed app's view is restored on return |
| The user agent and what the page reads about its environment | `outside` | sites and sign-in pages that check for Chrome; code that detects Electron; i18n libraries | ✅ built | Every tab reports a plain Chrome `User-Agent` with no `Electron/` or `orivon/` token, so Electron-detecting code takes its browser branch ([`user-agent.ts`](../../src/main/shell/user-agent.ts)). Client hints are present without a "Google Chrome" brand; on the two Google sign-in hosts the request identity is Firefox's. Locale, time zone and CPU count are the machine's |
| Audio and video codecs, and DRM | `outside` | video and music apps, streaming services | ⚠️ partial | H.264, AAC, MP3, FLAC, Opus, Vorbis and PCM decode, in MP4, WebM, Ogg and the usual containers. HEVC, AC-3, E-AC-3 and DTS have no decoder. No Widevine CDM ships, so protected (EME) content does not play |

### Windows, lifecycle and the desktop around the app

Member lists: [`table-3i-windows-and-lifecycle.md`](compatibility/table-3i-windows-and-lifecycle.md).

| Surface | Class | Needed by | Status | Where the answer comes from |
|---|:--:|---|:--:|---|
| The Electron main process (`main.js`, `app.whenReady().then(createWindow)`), and code that reaches it (`ipcRenderer.sendSync`, `@electron/remote`) | `outside` | every Electron app; 38 of 80 use `ipcRenderer.sendSync` and 34 of 80 `@electron/remote` | 🚫 excluded by design | The main process does not run ([ADR-0005](../decisions/ADR-0005-apps-are-url-addressed-not-bundled.md)). The renderer bundle is kept, and what main did moves into the page, into a `fork`ed Worker, into the port's own bridge, or is dropped. `ipcMain` and `ipcRenderer` are one in-page bus; `sendSync` and `@electron/remote` have nothing to answer them |
| The app's own preload surface (`window.<name>`, `contextBridge.exposeInMainWorld`) | `dup` | every app ported from Electron | 🚫 excluded by design | The app's preload is never loaded and `contextBridge` refuses. A port supplies one classic synchronous script that assigns `window.<name>` before the bundle runs. It is one file per app, in `orivon-ports`, and not in `src/` |
| The `electron` module | `dup` | every tier-2 app | ⚠️ partial | [`src/shim-electron/`](../../src/shim-electron/) backs `app` (four members), `safeStorage`, `ipcRenderer` and `ipcMain`. `BrowserWindow`, `Menu` and `Tray` throw a clear "not supported" error, and so do 15 more names. Every `dialog` method refuses. [Table 2](#table-2-the-four-adapter-families) has every export |
| One window is one tab, and what a page can do to its window | `outside` | 46 of 80 build two or more `BrowserWindow`s; apps that size or place their window | 🚫 excluded by design | An app runs in a tab and `new BrowserWindow` refuses. `parent`, `modal`, `alwaysOnTop` and `setBounds` have no equivalent. `window.resizeTo`, `moveTo` and the `width`/`height` of `window.open` do nothing. A second view of the app is a popup or a link. The tab shows the page's own title and favicon, not the manifest's name and icons |
| `window.open()` popups that keep `window.opener` | `outside` | OAuth and wallet sign-in | ✅ built | A popup the page can talk to becomes a tab in its opener's session ([`popups.ts`](../../src/main/shell/popups.ts)); `noopener` and plain links open ordinary tabs; a popup into a cross-origin isolated app loses its opener. Popups cannot be intercepted by the app (`setWindowOpenHandler` has no effect) |
| Two tabs of one app | `outside` | apps that assume one instance | ⚠️ partial | Both tabs share one partition, so `storage` events, `BroadcastChannel`, IndexedDB and `navigator.locks` behave as in two browser tabs. No single-instance lock exists for an app page; an app that wants one takes a Web Lock itself |
| Quitting, closing, reloading and crashing: `beforeunload`, `pagehide`, `app.on('before-quit')` | `outside` | editors and sync engines with unsaved work | ⚠️ partial | `beforeunload` asks Leave or Stay in the question panel on reload and navigation (A231). Closing a tab or the browser asks nothing, so unsaved work is lost. `app.on` is missing on the shim's `app`, so registering `before-quit` or any of the 30 `app` events crashes with a `TypeError`. A crashed tab shows nothing and is not restored. Reload loses everything in memory |
| Hidden-tab throttling | `outside` | seeding, syncing and polling loops that ran in the main process | ⚠️ partial | A tab out of the person's sight (behind another tab, or in a minimized or hidden window) reads `visibilityState` `'hidden'` and gets one `visibilitychange`, because the shell tells its page ([`tab-visibility.ts`](../../src/main/shell/tab-visibility.ts), [`page-visibility.ts`](../../src/preload/page-visibility.ts)); a subframe keeps the browser's own `'visible'`. Chromium's own background throttling does not apply to such a tab (its view is detached from the window), so a page slows down only if it backs off when `document.hidden` is true. A Worker or the app's child host is the way out for a loop that must not slow: the host runs with throttling off ([`child-host.ts`](../../src/main/children/child-host.ts)) |
| Background lifetime (after the tab closes, after the browser closes, at login) | `outside` | seeding, syncing, pinning, tray apps, downloaders | ❌ missing | Nothing runs once an app's last tab closes, or once the browser quits. No autostart, scheduler or push service exists: `app.setLoginItemSettings` is missing, and 20 of 80 scanned apps call it. `scope.md` counts `backgroundSec` in the metric, and no grant gives an app background time |
| Keys the browser takes before the page | `outside` | apps with their own `Ctrl+T`, `Ctrl+W`, `Ctrl+L`, `F5`, `F11` or `Ctrl+1` to `Ctrl+9`: terminals, editors, remote desktops | ⚠️ partial | The browser sees each key first and swallows a matched chord, so the page never gets its `keydown` (35 default chords; a person can rebind them). Editing keys (`Ctrl+C`, `Ctrl+V`, `Ctrl+Z`) and `Ctrl+F`, `Ctrl+S`, `Ctrl+K` always reach the page; a `Ctrl+F` the page does not use then opens the browser's find bar. In fullscreen the page keeps every key ([`commands.ts`](../../src/main/shortcuts/commands.ts)) |
| The right-click menu | `outside` | copy, paste, open a link | ✅ built | In tabs and the address bar ([`context-menu.ts`](../../src/main/shell/context-menu.ts)): open a link in a new tab, copy a link or image, cut, copy, paste, select all, Inspect. A page that cancels `contextmenu` opens no menu. No spelling suggestions, Back or Save image. The menu is a native one: on Linux X11 it scrolls for a right-click inside a primary-monitor work area the desktop reports shorter than the menu (A347) |
| `prompt()`, and `alert()` and `confirm()` | `outside` | apps that ask for text or a yes this way | ✅ built | All three are asked in the question panel of the page's tab, headed with the asking frame's own origin ("An embedded page on <origin> says" for a frame inside the page), and the page waits for the answer as it does for a native box. `alert()` and `confirm()` are taken from Electron's own dialog event, which Chromium raises per frame only after its own checks, so a dialog Chromium ignores (a sandbox without `allow-modals`, a call while the page is being left) stays ignored; `prompt()` is caught in the top frame by the tab's preload, and a subframe's keeps Electron's behaviour and throws. A document's third dialog offers to stop the rest, a navigation of the tab, or a frame removed by its page, answers any still open as dismissed, and a page an app shows in a `<webview>` is asked in the app's tab the same way. `prompt()` returns the typed text, or `null` on Cancel (`src/main/shell/page-dialogs.ts`, `ADR-0052`) |
| Drag and drop, downloads, printing, zoom, find in page, spell check | `outside` | importers and file managers (46 of 80 read a dropped file's path); export buttons; invoice apps | ⚠️ partial | A dropped file reads normally but `File.path` is missing (a folder drop is refused). A download the page starts is saved by the shell into the Downloads folder and listed at `orivon://downloads`, and the page hears no result. `Ctrl+F` opens the find bar; in an app's tab, when the app leaves the key unhandled. `Ctrl+P` opens the system print dialog. Zoom per origin works from the keyboard; `webFrame.setZoomFactor` refuses. Media autoplays without a gesture, and `F12` opens developer tools |
| The desktop shell: tray, application menu, dock, badges, autostart, protocol handlers, file types, global shortcuts, power events | `outside` | tray-resident apps (50 of 80 build a `Tray`), wallet and torrent links (38 of 80 register a URL scheme), chat badges | ❌ missing | `Tray` and `Menu` throw a clear "not supported" error; `globalShortcut`, `powerMonitor` and `nativeTheme` refuse; `app.dock`, `setAsDefaultProtocolClient`, `setBadgeCount` and `setLoginItemSettings` are missing. The manifest's `protocols` is checked and registers nothing. A second launch opens `http` and `https` URLs only ([`desktop-shell.ts`](../../src/shim-electron/desktop-shell.ts)) |
| What the packager and the running executable provide: `process.execPath`, `app.relaunch`, `autoUpdater`, `crashReporter`, command-line switches, `webPreferences` | `outside` | `process.execPath` in 51 of 80, `app.relaunch` in 52, `electron-updater` in 41, `appendSwitch` in 55 | ❌ missing | There is no executable and no installer. `process.execPath` is missing, `app.relaunch` and `app.commandLine` read `undefined`, `crashReporter` refuses, and no app can change a tab's `webPreferences` (the shell fixes `sandbox` and `contextIsolation`). Updates happen through the loader, with no event for the app. Bundled files are `assets` fetched from the app's origin |
| A sign-in that sends the tab away and back (OIDC, OAuth redirects) | `outside` | Matrix clients and any app behind an OIDC provider | ⚠️ partial | The tab gets the app's own view back on return, with its `sessionStorage` and back history ([`tab-parking.ts`](../../src/main/shell/tab-parking.ts)). A form `POST` back across the app boundary arrives as a `GET` (A233). A provider that accepts only a loopback redirect needs a loopback origin. Google's sign-in hosts are shown a Firefox identity; not confirmed against a real account |

### Permissions, devices and secrets

Member lists: [`table-3j-permissions-devices-secrets.md`](compatibility/table-3j-permissions-devices-secrets.md).

| Surface | Class | Needed by | Status | Where the answer comes from |
|---|:--:|---|:--:|---|
| Clipboard write (`navigator.clipboard.writeText`, `write`) | `outside` | any app with a copy button; 49 of 80 scanned apps call `clipboard.writeText` | ✅ built | Allowed for every page by [`permission-gate.ts`](../../src/main/sessions/permission-gate.ts) ([ADR-0022](../decisions/ADR-0022-the-permission-gate-allows-clipboard-write.md)), bounded by the platform's own click and focus rules rather than by a grant. Nothing is declared in a manifest. The `electron` `clipboard` module refuses |
| Clipboard read (`navigator.clipboard.readText`, `read`, `document.execCommand('paste')`) | `outside` | paste buttons; AirGap Vault's "Paste from clipboard", one of its two ways to receive a transaction to sign | ⚠️ partial | A website is asked once per site, in the prompt under the address bar, and the answer is kept ([ADR-0049](../decisions/ADR-0049-a-website-is-asked-once-per-site-for-each-powerful-permission.md)); a registered app is refused, and no manifest field or answer from the person lifts it. A paste the person makes (`Ctrl+V`, the right-click menu) needs no permission. Making it a grant for an app is proposed in [ADR-0032](../decisions/ADR-0032-camera-microphone-and-clipboard-read-join-the-grant-model.md) |
| File System Access, one file (`showOpenFilePicker`, `showSaveFilePicker`, a dropped file) | `outside` | any app that imports or exports a file | ✅ built | Allowed for a single file the person picked or dropped, to read or to write ([ADR-0024](../decisions/ADR-0024-the-permission-gate-allows-one-chosen-file.md)). The person's choice of file is the consent, as for `fs.userSelected`. Writing back to an opened file and reusing a stored handle go without the prompt Chrome shows ([A205](../open-questions.md)) |
| File System Access, a folder (`showDirectoryPicker`, a dropped folder) | `outside` | web IDEs, photo organisers | 🚫 excluded by design | Refused: a directory handle reaches every file beneath it, and Electron decides this synchronously, so there is no point at which to ask. An app written for Orivon has `fs.userSelected`'s folder shape instead. Whether a folder prompt is ever built is [A205](../open-questions.md) |
| Fullscreen (`requestFullscreen`) | `outside` | video players, games | ✅ built | Allowed on every page from a click ([ADR-0025](../decisions/ADR-0025-the-permission-gate-allows-html-fullscreen.md)). The tab fills the window, "Press Esc to exit full screen" shows for four seconds, and Escape always leaves. Fullscreen without a click (from a timer or a popup) is refused |
| Pointer lock (`requestPointerLock`) | `outside` | games, 3D viewers, remote desktops | ✅ built | Allowed on every page ([ADR-0026](../decisions/ADR-0026-the-permission-gate-allows-pointer-and-keyboard-lock.md)); Chromium requires a click. Escape releases it, and "Press Esc to show your cursor" says so |
| Keyboard lock (`navigator.keyboard.lock`) | `outside` | fullscreen games, remote desktops | ✅ built | Allowed on every page ([ADR-0026](../decisions/ADR-0026-the-permission-gate-allows-pointer-and-keyboard-lock.md)); it acts only in fullscreen. A page holding Escape gets a single press, and holding Escape leaves fullscreen |
| External protocol links (`mailto:`, `magnet:`, `bitcoin:`) | `outside` | mail, torrent and payment links | ✅ built | Opened by the OS's default app only after the person allows it in a dialog naming the site and the URL, every time ([ADR-0027](../decisions/ADR-0027-an-external-link-opens-only-when-the-person-allows-it.md)). The browser's own schemes and known-dangerous OS handlers are never offered. A page shown in an app's `<webview>` is never offered one. `shell.openExternal` refuses |
| Notifications (`Notification.requestPermission`) | `outside` | chat, mail, transaction alerts | ✅ built | The site is asked once, in Orivon's own prompt under the address bar; Allow and Block are remembered per site and can be reset from site info or Settings > Site settings ([ADR-0028](../decisions/ADR-0028-a-site-shows-notifications-only-after-the-person-allows-it.md), [ADR-0049](../decisions/ADR-0049-a-website-is-asked-once-per-site-for-each-powerful-permission.md)). An undecided site reads `Notification.permission === 'denied'`, and a registered app is refused. Only a main-frame request asks. The Electron `Notification` export is missing |
| Camera and microphone (`getUserMedia`); `media.camera`, `media.microphone` in a manifest | `outside` | QR scanners, video calls, camera or microphone entropy; AirGap Vault's QR scan, its other way to receive a transaction to sign | ⚠️ partial | A website is asked once per site, camera and microphone in one question when a page asks for both ([ADR-0049](../decisions/ADR-0049-a-website-is-asked-once-per-site-for-each-powerful-permission.md)); a registered app is refused, and the manifest's `media` keys fail validation. A page's cross-origin frame never borrows its embedder's answer. Making them grants for an app is proposed in [ADR-0032](../decisions/ADR-0032-camera-microphone-and-clipboard-read-join-the-grant-model.md); there is no in-use indicator on the tab, and blocking does not stop a stream already running. 22 of 80 scanned apps use the camera or microphone |
| Other permissions: location, screen capture, MIDI, idle detection, speaker selection, storage access, DRM, multi-screen, installing as a web app | `outside` | maps, screen sharing (15 of 80 scanned apps), music apps, chat presence, streaming services, PWAs | ⚠️ partial | A website is asked once per site for MIDI, idle detection, multi-screen window placement and location ([ADR-0049](../decisions/ADR-0049-a-website-is-asked-once-per-site-for-each-powerful-permission.md)), and a registered app is refused; location is then told no, since Electron ships no geolocation key. Screen capture, speaker selection, DRM and installing as a web app are denied with no decision written, and storage access follows the cookie choice. `desktopCapturer`, `powerMonitor` and `screen` refuse in the `electron` shim. No Widevine module ships, so protected media does not play |
| USB, HID, serial and Bluetooth devices (WebUSB, WebHID, Web Serial, Web Bluetooth) | `outside` | hardware wallets, `node-hid`, `usb` and `serialport` ports, flashing tools; 9 of 80 scanned apps use a hardware transport | 🚫 excluded by design | Denied, and the device handler answers `false`, so a request for a device should not complete and the device lists should be empty (not measured). The `hid`, `serial` and `usb` capabilities are cut from the first release for every tier ([Table 1](#table-1-the-capability-surface-authority)). Web Bluetooth is cancelled for lack of a chooser |
| Permissions and APIs Electron has no name for: wake lock, sensors, battery, local fonts, persistent storage, Web Share, payments, WebXR, Picture-in-Picture, speech, gamepads | `outside` | video players and call apps (FreeTube and Element call the wake lock and swallow a denial), games, checkout flows | ⚠️ **unspecified** | No Electron permission exists for these, so the gate never decides and Chromium's default in this build applies. Measured on Linux for four: the wake lock rejects, `persist()` answers `false`, `queryLocalFonts()` returns no fonts and `Accelerometer` fails (`devicemotion` still fires). The rest are not measured. Gamepads and the eyedropper need no permission. Web NFC is missing, and no share sheet, payment UI or XR runtime is built |
| WebAuthn and passkeys; saved-credential sign-in; biometric unlock | `outside` | passwordless sites; 14 of 80 scanned apps use biometrics, Windows Hello or WebAuthn; wallets and password managers | ❌ missing | `app.configureWebAuthn` is never called, so the platform authenticator reports unavailable and platform requests are not served. A roaming key over USB or NFC is not measured. The browser's local password store has no page-visible API, so `navigator.credentials.get({ password })` has nothing to return, and `systemPreferences.promptTouchID` refuses. A wallet that unlocks with a biometric needs main-process work first |
| Secure seed storage (OS keyring, `safeStorage`) and `orivon.secrets` | `dup` | `orivon.id` surviving a restart, `window.nostr` behind it; AirGap Vault, Element and The Lounge, which keep key material | ✅ built | The identity seed sits behind Electron's `safeStorage` and no app ever reads it ([ADR-0003](../decisions/ADR-0003-local-first-storage.md)). An app may hold its own secret derived from the seed and bound to its origin, with a grant ([ADR-0033](../decisions/ADR-0033-an-app-may-hold-an-origin-bound-secret-in-the-os-keyring.md)). Where the OS keyring is unreachable, and in a private window, the seed lasts for the session only, is never written in plaintext, and `secrets.available()` is `false` |
| `safeStorage` and a `keytar`-shaped keyring, as a ported app calls them | `dup` | Element wraps its pickle key with `safeStorage`; 23 of 80 scanned apps use it and 12 use `keytar` | ⚠️ partial | The async trio (`isAsyncEncryptionAvailable`, `encryptStringAsync`, `decryptStringAsync`) works for an app holding the `secrets` grant. `isEncryptionAvailable()` answers `false`, and the sync `encryptString` and `decryptString` refuse. No module has `keytar`'s `getPassword`, `setPassword` and `deletePassword`: an adapter over `orivon.secrets` and `fs` is the substitute ([Table 5](#table-5-the-native-module-question-per-library)) |

### Protocols

Member lists, and the 58 network primitives each protocol is built from: [`table-3k-protocol-stacks.md`](compatibility/table-3k-protocol-stacks.md). 178 protocols in seven families are listed there, each with the grants it needs.

| Surface | Class | Needed by | Status | Where the answer comes from |
|---|:--:|---|:--:|---|
| Peer-to-peer and file sharing: BitTorrent, libp2p, IPFS, Hyperswarm, Syncthing, Nostr, Matrix, ActivityPub | `needs T1` | webtorrent, IPFS and libp2p apps, Syncthing-style sync, chat and social clients | ⚠️ partial | Of 34 protocols, 14 run and 10 run with a named condition. Work: HTTP and WebSocket trackers, WebRTC, libp2p over WebSockets, the Matrix and Nostr clients. Missing: finding peers on the LAN (multicast), uTP and Hyperswarm (native packages), and a home server reachable from the internet (no inbound TLS, no port mapping) |
| Blockchains and wallets: Bitcoin, Electrum, Lightning, Ethereum, Monero, Solana, WalletConnect, hardware wallets | `needs T1` | wallets, dapps, light clients; AirGap Vault, ASGARDEX | ⚠️ partial | Of 34, 20 run: every JSON-RPC and WebSocket chain API, Electrum (with a self-signed certificate), the Helios and smoldot light clients, WalletConnect, gRPC-web. Missing: gRPC over HTTP/2 (LND, Core Lightning, Zcash lightwalletd), Core Lightning's Unix socket, and Bitcoin ZMQ. Hardware wallets over USB, HID, serial and Bluetooth are excluded |
| Anonymity networks: Tor, I2P, Nym, VPNs | `outside` | privacy apps, Monero and Bitcoin over Tor | ⚠️ partial | Of 13, 1 runs plainly. A hand-written SOCKS5 handshake to a Tor daemon the person runs on `localhost:9050` should work, but `socks-proxy-agent` has no effect and nothing starts a native daemon. Tor in WebAssembly (Arti) is possible in principle. Lokinet, Yggdrasil and system-wide VPNs need a TUN device, which no capability offers |
| Messaging and mail: IRC, XMPP, SMTP, IMAP, Signal, Telegram, Discord, Slack, SIP, MQTT, Kafka | `needs T1` | chat and mail clients, call apps, IoT dashboards | ⚠️ partial | Of 31, 15 run: IMAP and IMAPS, JMAP, Telegram, Discord, Slack, Mattermost, XMPP over WebSocket, MQTT over WebSocket, AMQP and everything on WebRTC. Missing: anything that starts plain and upgrades to TLS on the same socket (SMTP on 587, IMAP on 143, XMPP STARTTLS), and a mail or chat server on a reserved port: SMTP over TLS, SMB and IRC are reached for a server the person types in only when the manifest declares the wildcard host at that exact port (`*:465`, `*:445`, `*:6697`) |
| Databases and services an app dials: PostgreSQL, MySQL, Redis, MongoDB, LDAP, SSH, FTP, S3, WebDAV, Docker, Kubernetes, gRPC, DNS | `needs T1` | database clients, admin and developer tools, backup tools | ⚠️ partial | Of 40, 16 run: plain PostgreSQL and MySQL, Redis, MongoDB with TLS, Memcached, WebDAV, Git over HTTPS, Docker over TCP, gRPC-web, DNS over HTTPS. Missing: TLS that upgrades an open socket (PostgreSQL `sslmode=require`, MySQL TLS), Unix sockets (Docker, local PostgreSQL), `mongodb+srv`, and gRPC over HTTP/2 |
| Home, media and device protocols: mDNS, SSDP, HomeKit, Matter, Chromecast, AirPlay, printers, NTP, SNMP, RTSP | `needs T1` | smart-home and media apps, network tools | ⚠️ partial | Of 17, none run without a condition. Talking to a device whose address is given works over `net` or `dgram` (9 do, in part). Discovery does not: mDNS, SSDP, broadcast and multicast are missing, so HomeKit, Matter, DLNA, AirPlay and Wake-on-LAN do not work. Zigbee and Z-Wave serial coordinators are excluded |
| Sign-in and web integration: OAuth, OpenID Connect, SAML, webhooks, push | `dup` | any app behind an identity provider | ⚠️ partial | Of 9, 3 run: OAuth in a popup or redirect, the device-code flow and OpenID Connect (the Element port uses it). SAML and the loopback OAuth redirect run with a condition. Webhooks from the internet and receiving web push are missing |

The single missing primitives that would unblock the most protocols are these. UDP multicast and broadcast would start 11 (peer discovery, mDNS, HomeKit, Matter, Chromecast, AirPlay, Wake-on-LAN). Upgrading an open socket to TLS would start 8 (SMTP on 587, IMAP on 143, PostgreSQL and MySQL TLS, XMPP STARTTLS, explicit FTPS). Unix sockets would start 6 (Docker, local PostgreSQL and MySQL, Core Lightning, ssh-agent), an HTTP/2 client 4 (every gRPC wallet backend), and reaching a port behind a NAT 5. Reaching a private address without writing it in the manifest blocks none but limits about 25, because a declared literal is the route today.

## Table 4: open blockers, and the cheapest lever for each

Ordered by reach per unit of effort. **The ordering is a recommendation, not a schedule.** Only
open blockers are listed; a resolved one is deleted, not struck through.

| # | Blocker | Cheapest lever | Cost shape |
|---|---|---|---|
| 1 | No named identities: `id.requestIdentity` is unbuilt, so `window.nostr` cannot reach a page | Build it; no decision blocks it | A111 |
| 2 | `DirectoryHandle`'s method set is unconfirmed | Confirm the shape the folder picker is already built against; no new build work | A167 item 2, A195 |
| 4 | `dialog.showOpenDialog` cannot map onto `fs.userSelected`: one returns host paths, the other an opaque handle | A shim-side shape decision | A187 |
| 5 | `FileHandle.readable()`/`writable()` are not page-reachable, so a handle's own `FileHandle#createReadStream`/`createWriteStream` refuse (the module-level `fs` streams work) | Deliver a byte stream over a dedicated port, the mechanism `net.connect` already uses | A184 |
| 6 | No background lifetime | Unfiled; needs a decision first | Contracts + shell; touches the metric directly |
| 7 | `protocols` is declared and validated but unbuilt on both sides | Unfiled; needs a decision first on how a routed URI reaches the app | Contracts + shell + prompt UX |
| 8 | Camera, microphone and clipboard read are refused to every registered app, so AirGap Vault can create and hold keys but never receive a transaction to sign (a website is asked per site, so the blocker is the app door) | The manifest kinds of ADR-0032's app door, offered at install consent like the app's other capabilities; camera also needs a tab indicator and a reset that stops a running stream. Needs a decision first: whether either is allowed at all for an app | Shell + prompt UX; A202 for clipboard read |
| 9 | `hid`/USB, the wallet cluster | `orivon.hid.*` + device chooser | Contracts + prompt UX + security argument |
| 10 | A native addon's WebAssembly build that is threaded and loaded through `process.dlopen` rather than a napi-rs package's own loader | Threads as emnapi workers over `worker_threads`, once an addon build needs them. An addon that runs a network node runs that node as a WASI 0.2 component the app spawns and reaches over loopback, which works today (`d-0216`); an addon with no WebAssembly build: substitute per library (Table 5) | Shim work; threads need `crossOriginIsolated` |
| 11 | Tier 3, no HTML frontend | Container + xpra ([doc](container-apps-opportunity.md)) | Parked; reopens `subprocess` in a narrow shape |
| 14 | Four of the five ports in `orivon-ports` do not bundle against the Node shim: the alias table and the page globals reach a port only through an esbuild plugin ([`bundler/esbuild-plugin.ts`](../../src/shim/bundler/esbuild-plugin.ts)) that The Lounge's server uses, so each of the others brings its own polyfills or empties the modules, and what Tables 2 and 3 say the shim offers reaches only that one port | A preset for each other bundler the ports use, webpack among them: the aliases of [`module-map.ts`](../../src/shim/module-map.ts), the `node:` handling webpack needs, and the globals entry; each port moved over when it is next touched | Shim + `orivon-ports`; A313 (owner) |
| 15 | 32 of Node's 72 builtin specifiers have no alias row, so an import fails the build or yields an empty object ([Table 2a](compatibility/table-2a-node-modules.md)) | An alias row with an honest answer for each cheap one: `assert/strict`, `sys`, `punycode`, `stream/web`, `stream/consumers`, `path/win32`, `constants`, and an inert `cluster` stub | Shim only |
| 16 | A missing member does not always refuse by name: `process` (the global, which `require('process')` returns), the `electron` package's `app` and IPC objects, the unwrapped `stream` and `events` packages, 15 `dgram.Socket` members, the subpath modules' named exports, and data members typed as functions | Wrap each with the refusal the other modules already use (`refusingProxy`, generated stand-ins), and give data members real values | Shim only; A310 |
| 17 | Options a shim function accepts and never reads change the result with no error ([Tables 3c](compatibility/table-3c-files.md) to [3e](compatibility/table-3e-crypto-compression-buffers.md)) | Refuse by name where the option changes the result, warn once where it does not | Shim only; A311 |
| 18 | Calls a ported Electron app makes at start-up throw: `app.on`, `app.requestSingleInstanceLock`, `app.commandLine.appendSwitch`, `Menu.setApplicationMenu`, `crashReporter.start`, `powerMonitor.on`, `new Tray` ([Table 2b](compatibility/table-2b-electron.md)) | Inert answers for lifecycle and desktop calls that mean nothing in a tab, refusals kept for calls whose result the app relies on | Shim only (`src/shim-electron/`) |
| 19 | A peer on the local network is reachable only by an address literal written in the manifest: no LAN-scoped pattern ([Table 3k](compatibility/table-3k-protocol-stacks.md) ranks it first) | A local-network connect pattern, asked as its own grant | Contracts + broker policy + prompt UX |
| 20 | No UDP multicast or broadcast: mDNS, SSDP, UPnP port mapping and LAN discovery cannot run | A multicast grant naming the group and port | Contracts + broker + adapters |
| 21 | No TLS upgrade of an open socket (STARTTLS): PostgreSQL and MySQL with TLS, SMTP on 587, IMAP on 143, XMPP, LDAP | Upgrade a connected socket on the trusted side, with the grant check the upgrade needs | Contracts + broker; A226 |
| 22 | `http2` loads and every function refuses by name, so a gRPC client cannot connect | An HTTP/2 client in the shim over `net.connectSecure`, whose `alpnProtocols` option can ask for `h2` | Shim only |

Rows 1 and 2 are the top of the list: neither needs anything but the work itself or one
confirmation. Row 6 sits behind them despite touching the metric, because it needs
a decision before it is even build-shaped. Rows 14 to 22 are the widest gaps the enumeration
of Tables 1 to 3 exposed, listed after rows 1 to 11 rather than ranked among them; rows 15 to 18
and 22 are shim work with no decision first. **Unfiled:** rows 6 and 7, row 8's camera and
microphone half, rows 15, 18, 19, 20 and 22, plus declarability (what a grant prompt can honestly
say for runtime-chosen hosts) and per-syscall IPC cost on a chatty workload.

## Table 5: the native-module question, per library

*Could native binaries be preinstalled to reach these?*

**The mechanical answer first.** App code runs with `sandbox: true, nodeIntegration: false`, and no native module runs for an app ([ADR-0040](../decisions/ADR-0040-native-shaped-node-features-run-as-webassembly.md)): a child process is a WebAssembly program or a Worker, never an operating-system process. An app reaches what a native package does in one of two ways. Either the package has a WebAssembly build that the addon loader or the package's own browser loader runs (Table 3, Running code), or the app's bundler picks a substitute written in JavaScript or WebAssembly. Orivon's alias table holds Node built-ins and `electron` only, so every `✅` below that names a substitute assumes the port aliases the package.

**What the question is really pointing at** is a place to run non-renderer code, and WebAssembly is that place: it covers what has a WebAssembly build or substitute, and the verdicts below name what does not. An addon with no WebAssembly build fails with `ERR_DLOPEN_FAILED` and names no substitute, so this table is where one is named. Counts of the form "N of 80" are open-source Electron apps scanned; [`table-5-native-modules.md`](compatibility/table-5-native-modules.md) holds the other packages.

| Library | Why an app wants it | Renderer answer that exists today | Verdict |
|---|---|---|---|
| `better-sqlite3`, `sqlite3` | A local relational database (7 of 80 apps use `better-sqlite3`, 3 use `sqlite3`) | `node:sqlite` over SQLite as WebAssembly, with a database file in a forked child of a cross-origin isolated app; `better-sqlite3`'s API is an adapter over it, which the bundler plugin selects; on a page, `sql.js` or `wa-sqlite` | ⚠️ `better-sqlite3` runs unchanged and `sqlite3` changes shape; a database file needs a Worker of an isolated app. A page keeps its data in IndexedDB or exports it by hand |
| `leveldown`, `classic-level` | An embedded key-value store: IPFS and Ethereum datastores, wallets | `browser-level` (IndexedDB) or `memory-level`; the Level API is asynchronous already, so the swap changes little | ⚠️ The data lives in IndexedDB, which the browser may evict |
| `secp256k1`, `tiny-secp256k1` | Bitcoin and Ethereum signatures | `@noble/secp256k1` and `@noble/curves`, pure JavaScript; version 2 of `tiny-secp256k1` loads its own WebAssembly | ✅ Needs nothing from Orivon. `orivon.id.sign` signs P-256 only, so it cannot stand in |
| `bcrypt`, `argon2` | Password hashing | `bcryptjs`, `hash-wasm` or `argon2-browser`; `@node-rs/argon2` runs as its own WebAssembly build in an app that sets `crossOriginIsolated: true` | ✅ Hash in a Worker, because pure JavaScript takes tens of milliseconds |
| `sodium-native` | NaCl and libsodium primitives for wallets and Hypercore-style apps | `libsodium-wrappers` (WebAssembly; wait for `sodium.ready`), or `tweetnacl` | ✅ Needs nothing from Orivon |
| `keytar` | The OS credential store (12 of 80 apps, the most of any native package) | `orivon.secrets` and the async `safeStorage` keep an origin-bound secret; nothing has `keytar`'s `getPassword` shape | ❌ Blocked on a small adapter over `orivon.secrets`, not a new capability |
| `node-pty` | A terminal inside the app (5 of 80 apps) | `@xterm/xterm` as the screen over a WebAssembly shell | 🚫 No host shell runs, because no operating-system process does. The app draws its own terminal |
| `sharp` | Image resize and conversion (3 of 80 apps) | `wasm-vips`, `@jsquash/*`, or Canvas with `createImageBitmap` | ⚠️ A different API. `wasm-vips` is multi-threaded by default and needs `crossOriginIsolated: true` |
| `node-hid`, `usb` | Hardware wallets and other USB devices (2 of 80 apps each) | WebHID and WebUSB through the vendors' web transports | 🚫 Cut from the first release: the browser denies WebHID and WebUSB, so the app has no route to the device |
| `serialport` | Microcontroller tools, printers, flashers (2 of 80 apps) | Web Serial | 🚫 Cut from the first release with the USB and HID capabilities |
| `node-datachannel`, `wrtc` | WebRTC inside Node | The renderer's own `RTCPeerConnection` and data channels | ✅ Works for data channels. A camera or microphone track waits on the camera permission, which is denied |
| `fsevents`, `@parcel/watcher` | File-change events for editors, dev servers and sync clients (3 of 80 and 1 of 80 apps) | Nothing: `orivon.fs` has no watch member and `fs.watch` throws a clear error. An app can poll `stat` and `readdir` | ❌ Blocked on file-change notification over `orivon.fs` |
| `bufferutil`, `utf-8-validate` | Optional speed-ups that `ws` loads inside a `try` (2 of 80 apps each) | Nothing is needed: `ws` falls back to JavaScript, and the page's `WebSocket` is routed | ✅ Nothing to do |
| `ffmpeg-static`, `fluent-ffmpeg` | Transcoding (1 of 80 apps) | `@ffmpeg/ffmpeg` (one thread, or multi-thread with `crossOriginIsolated: true`), or WebCodecs for plain transcoding | ⚠️ Much slower than native. The app passes same-origin core, WebAssembly and worker URLs, because the documented CDN and blob loads are refused |
| `esbuild` | Bundling inside an app: playgrounds and plug-in builders | `esbuild-wasm` in a Worker, given a same-origin `wasmURL` | ✅ Runs from its WebAssembly build |
| `robotjs`, `uiohook-napi`, `active-win` | Desktop automation, global input capture, the focused window | Nothing | ❌ Blocked on `orivon.*` members that do not exist and are not decided, since they would hold the person's whole authority |
| `zeromq` | A message queue over TCP: wallet nodes, robotics | Nothing is published; a pure JavaScript client over `orivon.net.connect` would fit | ❌ Blocked on a JavaScript or WebAssembly implementation that nobody publishes |
| `@signalapp/libsignal-client` | The Signal protocol core, a Rust addon | No WebAssembly build is published | ❌ Blocked on a WebAssembly build of the library |

Every other package in the detail page has its own row, in seven families: databases, cryptography, compression, media and machine learning, system and devices, networking and build tools: [`table-5-native-modules.md`](compatibility/table-5-native-modules.md).

## Table 6: how to update this

Check the code, do not trust the tables above.

| Cell | Recipe |
|---|---|
| Table 1, Spec'd | Read [`capability-api.ts`](../../src/contracts/capability-api.ts). A PROVISIONAL doc comment means ⚠️, not ✅ |
| Table 1, Broker | `grep -n "async function" src/broker/index.ts`, **then** check the object returned by `createBroker`: a function that exists but isn't returned is not reachable. The broker is split: `net`'s five entry points (`connect`/`connectSecure`/`udpBind`/`listen`/`lookup`) live in `capabilities/net.ts`, `fs`'s nine (including `open`) in `capabilities/fs.ts`, and `id`'s two in `capabilities/id.ts`, each returned from its own factory and re-exported through `createBroker`'s own returned object, so check those files too, not just `index.ts` |
| Table 1, Page | `grep -n "call('" src/preload/surface/orivon.ts`, plus `src/preload/surface/main-world-socket.ts` for what the main-world wrapper builds. A real-Electron e2e test is the strongest proof a real page can call it; where none exists, a test exercising the real `installOrivon` wiring rather than a hand-built stub is the fallback: weaker, but still a real dispatch/preload path, not just a file that exists |
| Table 1, Node shim | `ls src/shim/` |
| Table 1a, the list | Every `interface`, method and `type` in [`src/contracts/`](../../src/contracts/): `grep -nE "^export (interface\|type\|const)\|^  [a-zA-Z]+\??[(:]" src/contracts/*.ts`. `CapabilityKind` in `manifest.ts` and `LIMITS` in `limits.ts` are closed lists: count them |
| Table 1b | No mechanical list. Walk the fourteen class headings and ask, for a new kind of app, which authority it needs that has no row. A row leaves 1b for 1a when a capability covers it |
| Table 2a, the list | `node -p "require('module').builtinModules.join('\n')"` on the Node line Electron bundles (`ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron -p process.versions.node`). Every specifier has a row. A module's counts: `node -p "Object.keys(require('<m>')).length"` against the module's `generated/<name>.ts`, which lists each member that refuses |
| Table 2b, the list | The `const` declarations of `namespace CrossProcessExports` and the classes of `namespace Main` in `node_modules/electron/electron.d.ts`. What the package exports: `grep -n "^export" src/shim-electron/index.ts`. A member that is not wrapped by `refusingProxy` reads `undefined` |
| Table 2c, 2d | The helper packages in a port's `package.json`; [`src/nostr/`](../../src/nostr/) and the preload for providers |
| Table 3a, the list | `node -p "Object.getOwnPropertyNames(globalThis).length"` and `node -p "Object.getOwnPropertyNames(process)"`; what the shim installs is [`globals.ts`](../../src/shim/globals.ts) and [`globals-types.ts`](../../src/shim/globals-types.ts) |
| Table 3b | [`manifest.ts`](../../src/contracts/manifest.ts) for the fields, [`content-type.ts`](../../src/loader/serve/content-type.ts) for the MIME table, [`path.ts`](../../src/loader/serve/path.ts) for routing; module-system rows are measured by bundling a two-line entry with each bundler |
| Tables 3c to 3g | As Table 2a, per module, then the module's own files under [`src/shim/`](../../src/shim/). An option that a function accepts and never reads is a `differs` row: grep the option name in the implementing file |
| Table 3h | [`csp.ts`](../../src/loader/serve/csp.ts) and [`granted-origin-csp.ts`](../../src/main/install/granted-origin-csp.ts) for every directive; [`asset.ts`](../../src/loader/serve/asset.ts) for every header |
| Table 3i | [`src/main/shell/`](../../src/main/shell/) and [`src/main/shortcuts/`](../../src/main/shortcuts/); a behaviour with no e2e test says "not measured" |
| Table 3j, the list | The permission union of `setPermissionRequestHandler` in `electron.d.ts`, against [`permission-gate.ts`](../../src/main/sessions/permission-gate.ts): every string has a row |
| Table 3k | The primitives are Table 1's network rows; a stack's status is the weakest primitive it needs |
| Table 2 | Node family: `src/shim/`. Electron family: `src/shim-electron/`. Web family: `src/nostr/`. Fourth family: not in this repository at all -- it is each app's own bridge, one file per app in `orivon-ports`, and a missing one is that app's gap, never Orivon's |
| Table 3, Status | Mostly absence; verify by looking for the module, not for a mention of it |
| Table 3, Class | Not observable in the tree; derived. `dup` if Table 2's families name the surface at all, `needs T1` if they do but Table 1 has no entry the adapter could be built on, `outside` if no Node/`electron`/web API expresses the problem. Re-derive the row when Table 1 or the shim README's declared scope changes, not when a status flips |
| Table 4 | When a blocker is resolved, **delete the row**. This table lists only what is still open |
| Table 7a/7b | `ls src/main/extensions/` for lifecycle (Orivon's own code); `src/broker/policy/extension-manifest.ts` for manifest-key handling, split with `vendor/electron-chrome-extensions` |
| Table 7c | `grep -rn "handle('" vendor/electron-chrome-extensions/src/browser/api/` for what a namespace's own handler registers, plus a real load's own `typeof chrome.<namespace>` check -- a namespace can exist and still be a no-op, so read the handler body, not just its presence |
| Table 7d | `src/main/extensions/extension-host.ts` for session wiring, popup and toolbar behaviour; `docs/decisions/ADR-0044-*.md`/`ADR-0045-*.md` for the granted-app carve-out |
| Table 8 | Grep the area's own directory under `src/main/` or `src/renderer/`; a feature's absence is confirmed by an exhaustive keyword search, not by reading one file |
| Every cell | **State the current state and nothing else.** No "what changed since the last derivation", no "moved from ❌ to ✅", no PR numbers, no struck-through rows, no "this pass". A reader needs to know what works now; what changed and when is git history and [`../decisions/decision-log.md`](../decisions/decision-log.md) |

**Do not let this grow into a second copy of `app-compatibility.md`.** If an entry starts
explaining *why a tier exists*, it belongs there.

## Table 7: Extensions

What an extension gets in this build. Measured two ways: five real extensions (uBlock Origin
Lite, Dark Reader, Bitwarden, MetaMask, and the optional full uBlock Origin) through
`test/e2e-extensions-real.test.ts`, and a sixth
(Volume Master, opt-in via `ORIVON_VOLUME_MASTER_DIR`) through
`test/e2e-extensions-offscreen-capture.test.ts`; plus a full `chrome.*` namespace sweep across a
service worker, popup, options page, a `side_panel`-declared tab, a sandboxed page and content
scripts (isolated and MAIN world, MV2 and MV3), run with the Chromium sandbox on.

### Table 7a: Install, update and lifecycle

| Part | Works | Note |
|---|---|---|
| Install: unpacked folder | ✅ | `orivon://extensions` Developer mode (`install-runner.ts`) |
| Install: `.zip` | ✅ | Symlink entries and path-traversal entries refused |
| Install: `.crx` (CRX3) | ✅ | Needs the developer's own signature; Orivon's own verifier, not the library's |
| Install and update from the Chrome Web Store | ✅ | The store's own "Add to Chrome" button; developer signature and the store's publisher proof both checked before any bytes are kept (`ADR-0043`) |
| A held-back update that would widen host access or add a warned permission | ✅ | Shown as pending, not installed silently (T19 subset rule) |
| Stable id across updates | ✅ | Every loaded copy carries a `key` |
| Enable / disable | ✅ | Registry entry toggle |
| Uninstall | ✅ | |
| Reload (Developer mode) | ✅ | |
| File access (`--allow-file-access`) | 🚫 | Never granted to any extension |
| Incognito access | ➖ | Moot: no private window runs any extension (Table 7d) |
| An extension's own errors/crash log page | ❌ | No error log; the extensions page has no errors view |
| Load warning for a permission this build actually provides (`bookmarks`, `contextMenus`, `cookies`, `history`, `notifications`, `search`, `topSites`, `webNavigation`, others in 7c) | ✅ | Loads without the "Permission '\<name\>' is unknown" line; a permission this build does not provide still logs it (`extension-known-permissions.ts`) |
| Install prompt: what an extension may later ask for | ✅ | Lists up to six optional permissions and sites under "It may later ask for" (`src/broker/policy/extension-manifest.ts`) |
| Install in a private or guest window | ❌ | Every install route refuses and nothing loads there (`install-private.ts`) |

### Table 7b: Manifest keys

| Key | Works | Note |
|---|---|---|
| `manifest_version` (2 or 3) | ✅ | Both load; Orivon's own policy layer also reads it |
| `name`, `version`, `description`, `icons` | ✅ | |
| `content_scripts`: `matches`, `js`/`css` | ✅ | `<all_urls>` and scoped matches both measured |
| `content_scripts`: `"world": "MAIN"` | ✅ | Runs; no real extension API leaks into it (confirmed: `window.chrome` there is Chromium's ordinary non-extension shim, not this extension's surface) |
| `content_scripts`: `all_frames` | ✅ | Confirmed in a same-origin `<iframe>`, MV2 and MV3 alike |
| `content_scripts`: `match_about_blank` | ✅ | Confirmed in an `about:blank` `<iframe>`, MV2 and MV3 alike |
| `content_scripts`: `run_at` | ✅ | `document_idle` measured |
| `background.service_worker`, `"type": "module"` | ✅ | The worker's first start after a fresh load is reloaded once to receive events it raced (Table 7d) |
| `background.scripts` (MV2 persistent page) | ✅ | Loads (a deprecation warning only, does not block); reachable with the same full extension-page API surface as MV3's service worker |
| `action` (MV3) / `browser_action` (MV2): `default_popup`, `default_icon`, `default_title` | ✅ | Toolbar button when pinned, badge and popup; an unpinned extension runs from the Extensions menu |
| `options_page` | ✅ | Opens in a tab |
| `options_ui` | ⚠️ | Opens in a tab, same as `options_page`; the embedded (`open_in_new_tab: false`) mode is not implemented |
| `chrome_url_overrides` (`newtab`, `history`, `bookmarks`) | ❌ | Not honoured: a new tab shows Orivon's own dashboard, History and Bookmarks their own pages; an extension's page can still be opened as a tab with `chrome.tabs.create` |
| `devtools_page` | ✅ | Runs in the DevTools frame and `chrome.devtools.panels.create` calls back (`vendor/electron-chrome-extensions/UPSTREAM.md`, `test/e2e-extensions-sweep.test.ts`) |
| `web_accessible_resources` | ✅ | Tracked for the install prompt; Chromium enforces the resource list itself |
| `externally_connectable` | ✅ | Chromium's own: a page whose address matches gets `chrome.runtime.sendMessage` and `connect`, and the extension's `onMessageExternal` and `onConnectExternal` fire; no Orivon code; the sender's `tab` carries `windowId` 0 |
| `commands` | ✅ | Suggested keys are bound when free; `_execute_action` activates the extension; rebinding at `orivon://extensions/shortcuts`; Orivon's own shortcuts win; macOS key names are not run on a Mac (`extension-commands.ts`, `extension-commands-runner.ts`) |
| `omnibox` | ❌ | Orivon's own address bar is unrelated code |
| `side_panel` | ❌ | `chrome.sidePanel` is a no-op stub (Table 7c); the key drives no real panel surface |
| `host_permissions` | ✅ | Gates `chrome.cookies`/`chrome.tabs`/`insertCSS`/`webNavigation` API access; an optional site the person allowed counts at once (`granted-host-rule.ts`) |
| `optional_permissions` / `optional_host_permissions` | ✅ | Asked in an Orivon sheet, only for what the manifest declares (`permissions-api.ts`); kept in `prefs.json` across restarts; `remove` takes it back; Orivon's own checks follow at once, Chromium's own at the extension's next quiet reload (`manifest-stage-granted.ts`) |
| `incognito` (`spanning`/`split`/`not_allowed`) | ➖ | Moot: no private window runs any extension |
| `storage.managed_schema` | ❌ | No enterprise policy delivery in this build |
| `declarative_net_request` (ruleset key) | ✅ | Each `rule_resources` ruleset is read and applied by Orivon, enabled or not as the manifest says (`dnr/dnr-runner.ts`, `extensions-dnr.ts`) |
| `content_security_policy` | ✅ | Chromium enforces an `extension_pages` policy (measured: inline script, `eval` and remote scripts blocked); a policy with `'unsafe-eval'` makes the load fail |
| `sandbox` (sandboxed pages) | ⚠️ | No `chrome.*` from the library and Chrome's own CSP `sandbox`, an opaque origin (`d-0208`); a doubled-slash spelling of the page still answers `chrome.tabs.query` (A303) |
| `file_browser_handlers`, `file_handlers` | ➖ | ChromeOS / native file-handler surfaces with no equivalent here |
| `default_locale`, `_locales/*/messages.json` (`__MSG_...`) | ✅ | The extensions page resolves a name/description/icon reference the same way Chrome does |
| `oauth2` | ❌ | No `chrome.identity` (Table 7c), so this key drives nothing |
| `key` | ✅ | Read the way Chromium reads it, used to keep an id stable; refused if it does not parse |
| `minimum_chrome_version` | ❌ | Not read or enforced |
| `update_url` | ✅ | Tracked as a manifest fact; a Chrome Web Store install's own updater is Orivon's path, not this key |
| `homepage_url`, `short_name`, `version_name` | ❌ | Not read |
| `export` / `import` (shared modules) | ❌ | Not read |
| `tts_engine` | ❌ | No `chrome.tts`/`chrome.ttsEngine` (Table 7c) |
| `cross_origin_embedder_policy` / `cross_origin_opener_policy` | ⚠️ | Chromium's own enforcement; not separately measured |
| `mime_types_handler`, `chrome_settings_overrides`, `requirements` | ❌ | Not read |
| A top-level `orivon` key | 🚫 | Refused outright: the whole manifest is rejected rather than partly honoured |
| An unknown key or permission | ✅ | Loads; an unknown permission only logs a console warning, never fails the load |

### Table 7c: `chrome.*` API namespaces

Ordinary (non-ChromeOS, non-enterprise) surface, grouped by status. A namespace object existing
is not the same as it doing anything: read the note, not just the symbol.

**Present, with real behaviour:**

| API | Works | Note |
|---|---|---|
| `action` (MV3) / `browserAction` (MV2) | ✅ | Toolbar button, badge, title, icon, popup, and `getUserSettings` answering the real pin state with `onUserSettingsChanged` firing; `enable` and `disable` are no-ops (`action-pins-runner.ts`, `preload/extension-apis/action-settings.ts`) |
| `alarms` | ✅ | `create` + `onAlarm` measured firing |
| `bookmarks` | ✅ | The tree as Chrome shapes it (bar `1`, other `2`), search, create, update, move, remove and the four change events derived from the store; writes count against Chrome's quota; the reading root is never visible; `javascript:` and `data:` addresses are refused; `onChildrenReordered`, `onImportBegan` and `onImportEnded` never fire (`api/bookmarks-api.ts`) |
| `commands` | ✅ | `getAll` with the live shortcut, `onCommand` and `onChanged` through the shortcut dispatcher; a command key counts as an invocation on that tab (`extension-commands-runner.ts`, `api/commands-api.ts`) |
| `contextMenus` | ✅ | `create`/`remove`/`removeAll`/`onClicked` work; `update` is a no-op (`vendor/electron-chrome-extensions/src/renderer/index.ts`) |
| `cookies` | ✅ | `get`/`getAll`/`set`/`remove`/`getAllCookieStores`/`onChanged`, gated on the `cookies` permission and per-URL host access |
| `devtools.inspectedWindow`, `devtools.network`, `devtools.panels` | ✅ | Native to Electron |
| `dns` | ⚠️ | `chrome.dns.resolve` exists as a real function, not exercised in measurement; dev-channel-only in real Chrome too |
| `downloads` | ⚠️ | Every method and event is a declared no-op stub; nothing downloads, cancels or reports |
| `extension` | ⚠️ | `isAllowedFileSchemeAccess`/`isAllowedIncognitoAccess` always answer `false`; `getViews` always `[]` |
| `history` | ✅ | `search` (24 hours by default), `addUrl`, `deleteUrl`, `deleteRange`, `deleteAll`, `onVisited` and `onVisitRemoved` over Orivon's history; `getVisits` returns one visit per address; `onVisitRemoved` covers the newest 200 pages; a registered app's pages are never listed or deleted (`api/history-api.ts`) |
| `i18n` | ✅ | `getMessage` resolves the real `_locales` string; `getUILanguage` and `getAcceptLanguages` answer from the system locale (measured: `en-GB`) |
| `idle` | ✅ | `queryState()` measured returning `"active"` |
| `management` | ⚠️ | Only `getPermissionWarningsByManifest`/`getSelf`/`uninstallSelf` are real; `getAll` is not a function |
| `notifications` | ⚠️ | `create` builds an OS notification (measured with a stand-in class: `priority` and `requireInteraction` map to urgency and timeout, `buttons` are ignored); `clear`/`getAll`/`update` and three events present; `onPermissionLevelChanged` and `onShowSettings` are missing |
| `offscreen` | ✅ | `createDocument`/`closeDocument`/`hasDocument`; one document per extension, in no window, with no `window.open` and no navigation off the extension |
| `permissions` | ✅ | `contains`/`getAll`/`request`/`remove`, `addHostAccessRequest`/`removeHostAccessRequest` and `onAdded`/`onRemoved`; a request is asked in a sheet and `remove` takes a grant back (`permissions-api.ts`, `preload/extension-apis/permissions.ts`) |
| `power` | ✅ | `requestKeepAwake`/`releaseKeepAwake` callable; not independently verified to keep the OS awake |
| `printerProvider` | ⚠️ | Exists as an object; no working members measured |
| `privacy` | ⚠️ | Inert `ChromeSetting` placeholders; a `get` call triggers a native "Unknown Extension API" log |
| `proxy` | ⚠️ | Exists as a namespace; `settings.get` explicitly rejects `"Access to extension API denied."` |
| `browser` global | ✅ | The same object as `chrome` for every namespace Orivon provides, so an extension that takes `self.browser \|\| self.chrome` gets `permissions`, `webRequest` and the rest (measured with a fixture) |
| `runtime` | ⚠️ | `id`/`getManifest`/`getURL`/`connect`/`sendMessage`/`openOptionsPage` work; `onMessageExternal` and `onConnectExternal` fire for a matching page (Table 7b); `getContexts` lists the worker, popup, tab pages and offscreen document; `connectNative`/`disconnectNative`/`sendNativeMessage` throw by design (below); `onInstalled` fires once in a service worker after an install or update, with `reason` and, for an update, `previousVersion` (Electron never fires its own); `getManifest` still carries the `declarative_net_request` the extension shipped, which a blocker reads at start-up |
| `scripting` | ✅ | `registerContentScripts` with `world: 'MAIN'` measured running in the page's own world, and an isolated one staying out of it; `executeScript` measured running a real function in a tab and returning its result; it needs host access, and `activeTab` alone is refused (Table 7d) |
| `search` | ✅ | `query` opens the default engine's results in the current tab, a new tab or a new window (`api/search-api.ts`) |
| `sidePanel` | ⚠️ | Every method resolves as a no-op; no panel surface opens |
| `storage.local` | ✅ | Native to Electron |
| `storage.sync` | ⚠️ | Alias `local`; no real multi-device sync |
| `storage.managed` | ⚠️ | Empty and read-only, as in Chrome with no policy set; no policy delivery |
| `storage.session` | ✅ | Measured round-tripping in a service worker/popup/options/tab; present as a real function in an MV3 isolated content script, absent in MV2's |
| `system.cpu`, `system.display`, `system.memory`, `system.storage` | ✅ | `system.cpu.getInfo()` measured returning real hardware data (actual CPU model, core count, per-core usage) |
| `tabCapture` | ✅ | `getMediaStreamId`/`getCapturedTabs`/`onStatusChanged`; needs the extension invoked on that tab, by its toolbar icon, its row in the Extensions menu or its command key; only an http(s) tab of no app holding grants; the tab is muted locally while captured |
| `tabs` | ⚠️ | A rich working set, filtered by permission/host access; `pinned` comes from the tab's record; `update({ muted })` mutes the tab and `update({ pinned })` is ignored; `mutedInfo` can lag a mute made from Orivon's own strip; `captureVisibleTab`, `duplicate`, `move`, `highlight`, `discard` and `group` are not functions; a sleeping tab reads `discarded: true` with the address and title it wakes to, and `groupId` is always -1 (`src/main/extensions/extension-tab-details.ts`) |
| `topSites` | ✅ | The most visited web addresses from history, up to ten, one per site (`api/history-api.ts`) |
| `userScripts` | ⚠️ | Every method resolves as a no-op; no user-script world runs |
| `webNavigation` | ✅ | `getFrame`/`getAllFrames` and the full event set work |
| `webRequest` | ✅ | All nine events, served by Orivon from the session's own handlers (`ADR-0053`): blocking `onBeforeRequest`/`onBeforeSendHeaders`/`onHeadersReceived` (cancel, redirect, header changes) for a manifest version 2 extension holding `webRequestBlocking`, observing for any holder of `webRequest`; full uBlock Origin blocks with it (measured). An extension sees a page's requests in the default session it has host access to, never Orivon's own, an `orivon:` page's, another extension's, the Chrome Web Store's or a registered app's; a blocking answer is waited for 10 seconds at most, and `Host` cannot be changed. `onAuthRequired` never fires, `requestBody` has raw bytes only, a worker's listeners hear events only while it runs, and a page's `fetch()` cannot follow a redirect to the extension's own file (A350) |
| `declarativeNetRequest` | ✅ | Static, dynamic and session rules, applied by Orivon (`ADR-0051`); `responseHeaders` conditions are refused; websites' worker requests are not matched. Static rules past 30,000 per extension draw on a shared pool of 300,000, and its constants and enums (the `MAX_NUMBER_OF_*` rule limits, `GETMATCHEDRULES_QUOTA_INTERVAL`, `ResourceType`, `UnsupportedRegexReason` and the rest) are present, the quota constants holding Chrome's values while the engine enforces no unsafe-rule quota and no `getMatchedRules` call limit; `RuleConditionKeys` lists only the keys the engine evaluates, so it has no `TOP_DOMAINS` |
| `windows` | ⚠️ | A rich working set, filtered the same as `tabs` |

**Not there** (`typeof === 'undefined'` in every context measured, including the most privileged):

| API | Works |
|---|:--:|
| `browsingData`, `contentSettings`, `debugger`, `declarativeContent`, `desktopCapture`, `dom`, `fontSettings`, `gcm`, `identity`, `instanceID`, `mimeHandler`, `omnibox`, `pageCapture`, `processes` (dev-channel-only in Chrome itself too), `publicSuffix`, `readingList`, `sessions`, `tabGroups`, `tts`, `ttsEngine`, `types`, `webAuthenticationProxy` | ❌ |

**Excluded by design:**

| API | Works | Note |
|---|---|---|
| `nativeMessaging`, `runtime.connectNative`/`disconnectNative`/`sendNativeMessage` | 🚫 | Present only to throw "Native messaging is not supported in Orivon"; starting a desktop program is native code outside the broker |

**Not applicable** (ChromeOS-only or enterprise-policy-only in Chrome itself):

`accessibilityFeatures`, `audio`, `certificateProvider`, `documentScan`,
`enterprise.deviceAttributes`, `enterprise.hardwarePlatform`, `enterprise.login`,
`enterprise.networkingAttributes`, `enterprise.platformKeys`, `fileBrowserHandler`,
`fileSystemProvider`, `input.ime`, `loginState`, `platformKeys`, `printing`, `printingMetrics`,
`systemLog`, `vpnProvider`, `wallpaper` -- all ➖, none apply outside ChromeOS or an enterprise
policy source this build has no equivalent of.

### Table 7d: Extension pages and behaviour

| Behaviour | Works | Note |
|---|---|---|
| Extension pages: popup | ✅ | A child `BrowserWindow` |
| Extension pages: options tab | ✅ | Both `options_page` and `options_ui` open a tab; the embedded mode of `options_ui` is not implemented |
| Extension pages: an extension's own full page opened as a tab | ✅ | Same URL policy as any extension-initiated navigation |
| Extension pages: offscreen documents | ✅ | `chrome.offscreen`; one per extension, never shown (Table 7c) |
| Extension popup: closes on focus loss elsewhere in Orivon, on tab switch and navigation | ✅ | |
| Extension popup: paints its theme colour before first paint | ✅ | |
| Extension popup: a `chrome.*` call on its first line | ✅ | No longer fails with "unknown extension context" |
| Service worker: starts at boot for every enabled entry | ✅ | Into the default session |
| Service worker: wakes on `tabs`/`webNavigation`/etc. events | ✅ | Measured with real extensions, sandboxed |
| Service worker: first-start race | ⚠️ | A fresh load's first worker can miss its own preload registration on the first attempt; Orivon detects the miss and reloads once, which recovers every measured case |
| Messaging: `runtime.sendMessage`/`connect` (same extension) | ✅ | Sender-id checked against the caller's own `chrome-extension://<id>/` origin, so one extension cannot read or trigger another's handlers by claiming its id |
| Messaging: `tabs.sendMessage` | ✅ | |
| Messaging: `externally_connectable` (web-page-initiated) | ✅ | Chromium's own (Table 7b) |
| Messaging: native messaging | 🚫 | Refused (Table 7c) |
| Storage: `local` | ✅ | Native to Electron |
| Storage: `sync`/`managed` | ⚠️ | Alias `local`, not real sync or policy delivery (Table 7c) |
| Storage: `session` | ✅ | Confirmed round-tripping (Table 7c) |
| Storage: quotas | ✅ | `local` holds 10 MiB (`QUOTA_BYTES` 10485760) and a write past it rejects with Chrome's quota error; `session` rejects past its own quota; `sync` and `managed` report the same limit |
| i18n / `_locales` | ✅ | Name/description/icon resolution on the extensions page; `chrome.i18n` answers from Electron's own implementation (Table 7c) |
| Toolbar: pin/unpin, badge, icon, title | ✅ | Pinned per extension from the Extensions menu or the icon's right-click menu; a new extension is pinned by default (`extensions.pinNew`); an unpinned extension runs from the menu and its badge shows on its row (`action-pins-runner.ts`, `extensions-menu-overlay.ts`) |
| Toolbar: the Extensions button and its menu | ✅ | Lists every extension with its badge, pin and a More list (options, pin, manage, remove); shown when an extension is loaded, always or never as chosen in Appearance; never in a private window (`extensions-button.ts`, `extensions-menu-overlay.ts`) |
| Toolbar: enable/disable a button per tab | ❌ | `action.enable` and `action.disable` do nothing, so a button is never greyed out for a tab (`vendor/electron-chrome-extensions/src/renderer/index.ts`) |
| Site access controls: "on click" / "on specific sites" / "on all sites" picker | ❌ | Not modelled; host access is the manifest's declared patterns, decided at install or update, plus the sites the person allows an extension to ask for (Table 7b) |
| Site access controls: `activeTab` (temporary grant on click) | ❌ | Refused: `scripting.executeScript` with only `activeTab` is rejected with "Cannot access contents of the page", before and after a toolbar click, and `tabs.query` keeps hiding the tab's address; only `tabCapture` honours an invocation (Table 7c) |
| Incognito / private windows | ❌ | A private or guest session loads no extensions and every install route refuses; the `incognito` manifest key drives nothing; the extensions page says so (`install-private.ts`) |
| Updates from the Web Store | ✅ | Table 7a |
| Install from CRX/zip/unpacked | ✅ | Table 7a |
| Enabling/disabling/uninstalling | ✅ | Table 7a |
| Errors page | ❌ | Table 7a |
| Details page | ✅ | `orivon://extensions/details?id=` shows the id, source, who updates it, site access, where it runs, the permissions Orivon does not provide, and the optional access the person allowed, each removable (`views/details-about.ts`, `details-optional.ts`) |
| Keyboard shortcuts page | ✅ | `orivon://extensions/shortcuts` lists, records, clears and moves the keys of extension commands; a details section links to it (`views/shortcuts.ts`, `shortcuts-page.ts`) |
| Extension devtools/inspect views | ⚠️ | `chrome.devtools.*` and a manifest's `devtools_page` work; nothing lists an extension's worker and pages to inspect |
| Running without the Chromium sandbox | ❌ | The service-worker preload that injects most `chrome.*` APIs is silently never invoked for any worker when Electron launches `--no-sandbox`; every automated launch here runs sandboxed instead (`A289`) |
| Apps a person has granted permissions to | ✅ | One instance, in the default session (`ADR-0044`); extension code is refused at `window.orivon`, a filter rather than a session split (`ADR-0045`). An app served from its pinned copy keeps its own partition and runs none |

## Table 8: The browser around the apps

The traditional-browser feature set, checked against Chrome, Firefox, Edge, Brave and Safari as
the reference set, and whether this build has it.

### Navigation and address bar

| Feature | Orivon | Note |
|---|---|---|
| Back / forward | ✅ | `webContents.goBack/goForward` (`src/main/shell/tabs.ts`), `Alt+Left`/`Alt+Right` |
| Reload / stop | ✅ | `nav.reload`/`nav.hardReload`; the reload button always reads Reload, and a click while a page loads restarts that load (for a navigation that has not answered yet, the address it was going to, `src/main/shell/tab-navigation.ts`); Escape in the page stops a load (`src/main/shell/signals/stop-key.ts`) and `nav.stop` stops it from the command list |
| Home button | ✅ | A toolbar button (`toolbar.home`, off by default; `src/renderer/chrome/home-button.ts`) and `nav.home` (`Alt+Home`) open the home page in the current tab; a middle or Ctrl click opens a background tab |
| Omnibox: address-or-search classification | ✅ | `src/main/browsing/omnibox.ts` classifies typed text as an address, a search or a refusal: `javascript:`, `data:`, `file:` and `about:` are refused, except `about:<name>` and `chrome://<name>`, which open the Orivon page of the same purpose (`src/main/pages/internal-aliases.ts`); a leading `?` always searches |
| Search suggestions (live dropdown) | ✅ | Off by default: Settings > Search turns on the default engine's own suggestions under the typed text, for DuckDuckGo, Startpage, Ecosia, Qwant, Bing and Google (Brave Search, Mojeek and a custom engine give none); never in a private window, requested without cookies or a referrer, and only for text that would be searched as typed (`src/main/omnibox/suggest-fetch.ts`) |
| History/bookmark autocomplete in the bar | ✅ | Typing lists matching history, bookmarks and open tabs under the bar (`src/main/omnibox/`, overlay `omnibox`) and finishes the typed text inline from a page that is bookmarked, was typed in full or was visited twice; Settings > Search turns the finishing off |
| Default search engine choice | ✅ | Eight built-in engines (DuckDuckGo default), each with a keyword (`src/main/browsing/search-engines.ts`) |
| Custom search engines / keywords | ✅ | Settings > Search lists the built-in engines and the site engines (Wikipedia, YouTube, GitHub, OpenStreetMap), adds, edits and removes the person's own, and a keyword and a space before the text searches that engine (`src/main/browsing/search-engine-store.ts`, `search-resolve.ts`, `src/renderer/pages/settings/engines.ts`) |
| URL display / eliding | ✅ | The unfocused address bar shows the site name at full strength and the rest dim, hides `https://`, `http://` and `www.`, shows an `ipfs://<name>` address as itself, and keeps the real value in the input; Settings > Search shows full addresses (`src/renderer/chrome/address-format.ts`, `address-display.ts`) |
| Security indicator / padlock | ✅ | A "Not secure" warning marks plain http to a public host; a live https connection draws no mark of its own, and the site button's title and popover say it is secure; localhost, protocol addresses, cache-served apps, shell pages and a failed load get no mark; the Website Level trust indicator (`src/trust/`) is separate (`src/main/browsing/connection.ts`, `src/renderer/chrome/address-display.ts`) |
| Site info panel | ✅ | The connection row, a Permissions section with one choice per kind the site may ask for, the site's cookies and stored data, and a Certificate row for https pages (`src/main/permissions/site-info.ts`, `popover-view.ts`, `site-info-panel.ts`, `src/renderer/site-info/`) |
| Copy URL | ✅ | Native input field behaviour |
| Paste-and-go | ✅ | The address bar's context menu has Paste and Go: main reads the clipboard and the address form submits it as typed (`src/main/shell/paste-and-go.ts`, `chrome-context-menu.ts`) |
| QR code share of current page | ✅ | Share > Create QR code in the main menu, or the page menu, opens a sheet with the code, Copy link and Download as PNG (`src/main/qr/`, `src/renderer/overlay/qr/`) |
| `view-source:` | ✅ | `page.viewSource` (`Ctrl+U`) and the page menu open `view-source:<address>` in a tab beside the page, for an http(s) page in an ordinary tab (`src/main/page-tools/view-source.ts`); typing `view-source:` and an http(s) address in the bar does the same, and anything else after it is searched (`src/main/pages/internal-aliases.ts`, `src/main/shell/tab-navigation.ts`) |
| `data:` / `file:` typed in the address bar | 🚫 | `DANGEROUS_SCHEMES` refuses `javascript:`, `data:`, `file:` and `about:` typed or pasted; `about:<name>` for a page Orivon has is the one exception |
| `file://` browsing (via a link, not typed) | ⚠️ | A `file:` link on a web page loads nothing and a typed `file:` address is refused, leaving a blank tab; the behaviour is Chromium's (measured in `test/e2e-address-bar.test.ts`) |

### Tabs

| Feature | Orivon | Note |
|---|---|---|
| New tab | ✅ | `tab.new` (`Mod+T`) |
| Close tab | ✅ | `tab.close` (`Mod+W`) |
| Reopen last closed tab | ✅ | `tab.reopen` (`Ctrl+Shift+T`) puts back the last closed tab where it was, or the last closed window with its tabs; 25 entries, in memory (`src/main/session-restore/closed-stack.ts`, `reopen.ts`) |
| Restore previous session on launch | ✅ | `startup.mode` "Continue where you left off" reopens the windows in `session.json` (`src/main/startup/startup-plan.ts`); after a run that did not end cleanly a bar offers them back; a private session and a kiosk do neither |
| Pin tab | ✅ | `tab.pin` (unbound) and the tab menu; pinned tabs lead the strip, are 36px wide with no title or close button (`src/main/shell/tab-pin.ts`, `tab-order.ts`) |
| Mute tab | ✅ | `tab.mute` (unbound), the tab menu and the speaker badge on the tab; the mute belongs to the tab and follows it to another window (`src/main/shell/signals/audio.ts`) |
| Audio-playing indicator | ✅ | A speaker badge on the tab from `audio-state-changed`; a muted tab keeps it, and a pinned tab shows it as a mark on its icon (`src/renderer/chrome/tab-badges.ts`) |
| Duplicate tab | ✅ | `tab.duplicate` and the tab menu open a copy, with its back and forward list, right of its source; not offered for the new-tab page or a shell page (`src/main/shell/tab-commands.ts`, `tab-history.ts`) |
| Drag to reorder | ✅ | `tab-drag.ts`, `tab-order.ts`; a pinned tab stays in the leading run, and a split refuses a pinned tab |
| Tear off into a new window | ✅ | `tear-drag.ts`; on a native Wayland session, where a window cannot read the screen, the preview is a view inside the window the drag started in and the target is found from where the pointer shows up (`tab-drag-actions.ts`, `local-tab-drag.ts`); the compositor places the new window |
| Move tab to another open window | ✅ | `tab-menu.ts`, `tab-move.ts` |
| Tab groups (named/coloured) | ✅ | `tab.group` and the tab menu add a tab to a new or an existing group; a chip heads each group and opens a bubble to name, colour, collapse, move or close it; groups are per window and are kept in `session.json`, never in a private window (`src/main/tab-groups/`, `src/renderer/chrome/tab-groups.ts`) |
| Vertical tabs | ❌ | Tab strip is horizontal only |
| Tab search (Ctrl+Shift+A style) | ✅ | `tab.search` (`Ctrl+Shift+A`), More tools and the strip's button list every open tab of every window and the recently closed ones, filtered by title and address as you type (`src/main/tab-search/`, overlay `tab-search`) |
| Hover preview / thumbnail | ❌ | Not found |
| Tab discarding / memory saver | ✅ | A tab out of front for 15 minutes to 4 hours (30 minutes by default, `performance.sleepAfter`; when the computer is low on memory, up to three tabs out of front for 5 minutes sleep each minute regardless) closes its page and keeps its address, title, icon and history, and wakes where it was, scroll included, when opened; a pinned, audible, captured, typed-into, prompt-waiting, app, other-session or kept-site tab stays awake, and a restored session brings its unpinned background tabs back asleep (`src/main/memory-saver/`, `tab.sleep`) |
| Split view (two tabs side by side) | ✅ | `split-controller.ts`, `split-model.ts`, `split-frame.ts` |
| Window size and move | ⚠️ partial | A window stops at 500 by 400, and below 640 px wide the toolbar drops its two placeholders and shows one extension button and clips the rest (`window-frame.ts`, `toolbar.css`). The empty end of the tab strip is a native drag region, so the window manager moves the window; a middle click there opens no tab (A292) |
| Close other tabs | ✅ | `tab.closeOthers` and the tab menu close every unpinned tab but the one chosen (`src/main/shell/tab-commands.ts`) |
| Close tabs to the right | ✅ | `tab.closeRight` and the tab menu close the unpinned tabs right of a tab, or of its split pair (`src/main/shell/tab-commands.ts`) |
| Next/previous tab, go to tab N | ✅ | `tab.next`/`tab.previous`/`tab.goto1..9`/`tab.gotoLast` |
| Open a link in a new tab (`target=_blank`, `window.open`) | ✅ | Every such request reaches `setWindowOpenHandler`; ctrl+shift+click and `target=_blank` open it in the foreground |
| Open a link in a background tab (keeps the current tab focused) | ✅ | A middle click or a plain ctrl+click opens a background tab; the current tab stays in front (`popups.ts`) |
| Open a link in a new window (Shift+click) | ✅ | Opens a real new window; a private window's shift+click opens a private window (`popups.ts`) |
| Middle-click a tab to close it | ✅ | `auxclick`/`mousedown` guard on each tab element |
| Middle-click the empty end of the tab strip to open a tab | ❌ | The empty end is a native drag region, which hands the page no event of any button, so no tab opens on any platform; on Linux the desktop's own middle-click title-bar action applies there (`docs/open-questions.md` A292) |
| Tab loading spinner | ✅ | `.loading` class on the favicon element |
| Tab title tooltip on hover | ✅ | Title, host, and whether the tab is playing audio, muted, in a split view or crashed (`src/renderer/chrome/tab-badges.ts`, `tab-crashed.ts`) |
| Tab close button appears on hover | ✅ | `.tab:hover .close`; a pinned tab has none, and an inactive tab too narrow for one shows none |
| Tab crashed indicator | ✅ | `src/main/shell/signals/crashed.ts` keeps the renderer's death on the tab; the strip shows a warning icon in place of the favicon and a tooltip line (`src/renderer/chrome/tab-crashed.ts`) |

### Windows and profiles

| Feature | Orivon | Note |
|---|---|---|
| Multiple windows | ✅ | `window-registry.ts` |
| Private/incognito window | ✅ | Empty-on-open, deleted-on-close session (`private-session.ts`) |
| Guest mode | ❌ | No guest-session concept distinct from a private window |
| Profiles | ✅ | `orivon://profiles`, `profile-store.ts`: a separate browser instance/data directory |
| Full screen (browser chrome, F11) | ✅ | `fullscreen.ts` |
| Kiosk mode | ✅ | `--orivon-kiosk` opens full-screen windows with no tab strip or toolbar that run only back, forward, reload, zoom, find, print and quit; quit is the only way out, and a page's own `window.open` still opens a tab (`src/main/window-state/kiosk.ts`) |
| Always on top | ✅ | `window.alwaysOnTop` (More tools, unbound) keeps the focused window above others; per window, not remembered |
| Window state (size/maximized) restored on relaunch | ✅ | The first window of a launch opens at the last-used window's size, position and maximised state, clamped to a visible display (`src/main/window-state/`); a private session records nothing; on Wayland the position is the compositor's |
| Multiple monitors, HiDPI, touch, IME input | ➖ | Chromium's own default support applies |

### New tab page and start-up

| Feature | Orivon | Note |
|---|---|---|
| Custom new-tab page | ✅ | A dashboard replacing `about:blank` (`src/renderer/newtab/`) |
| Homepage setting | ✅ | `home.url` (Settings, On start-up): any address the address bar would load; empty means the new tab page (`src/main/shell/home.ts`) |
| Startup pages ("open these pages") | ✅ | `startup.mode` "Open specific pages" and `startup.pages`: up to eight addresses, each checked as the address bar checks one (`src/main/startup/`, `src/renderer/pages/settings/controls/page-list.ts`) |
| Continue where you left off | ✅ | `startup.mode` "Continue where you left off" reopens the last session's windows, tabs, pins and places from `session.json`; the addresses on the command line open in front (`src/main/startup/startup-plan.ts`) |
| First-launch welcome/intro screen | ✅ | Shown once per profile (`intro-view.ts`, `intro-state.ts`) |
| White flash avoided on window open, new tab, internal pages and popovers | ✅ | Every such view's `backgroundColor`/theme colour is set before it has a pixel to show (`theme-colors.ts`, `popover-view.ts`); the main menu's own view is kept built between opens rather than recreated |

### Bookmarks

| Feature | Orivon | Note |
|---|---|---|
| Bookmarks bar | ✅ | Nested folders open as drop-down menus with Open all, an overflow chevron, a right-click menu on the bar and on the rows inside a folder menu (open in tab, window or private window, edit, rename, add folder, copy link, move to the bar, delete; Delete or `Ctrl+Backspace` also deletes a focused row) and drag to reorder or into a folder; `appearance.bookmarksBar` (`auto`/`always`/`never`) and `bookmarks.toggleBar` (`Mod+Shift+B`) show or hide it (`src/renderer/chrome/bookmarks-bar.ts`, `src/main/shell/bookmarks-bar/`) |
| Bookmark manager page | ✅ | `orivon://bookmarks` (`Mod+Shift+O`): folder tree, list, search, inline edit, move by dialog or drag, delete with undo (`src/renderer/pages/bookmarks/`, `src/main/browsing/bookmarks-domain.ts`) |
| Folders | ✅ | Nested folders in `bookmarks.json` (stable ids, roots `bar`, `other` and `reading`, at most 20,000 nodes and 12 levels); the bar, the manager and the edit bubble file into them (`src/main/browsing/bookmark-tree.ts`, `bookmark-file.ts`) |
| Import/export as HTML | ✅ | Export writes the Netscape bookmark file from the manager through the save dialog (`src/main/browsing/bookmarks-html-export.ts`); import reads one at `orivon://import` (`src/main/import/bookmarks-html-import.ts`) |
| Bookmark all open tabs | ✅ | `Mod+Shift+D`, the Bookmarks menu and the tab menu open a sheet that saves a dated folder with one bookmark per tab that has a site, in strip order (`src/main/shell/bookmark-bubble/`) |
| Reading list | ❌ | Not built: no page, button or command; the bookmark file keeps a root for it that nothing fills (`src/main/browsing/bookmark-tree.ts`) |
| Star/unstar current page | ✅ | The star and `bookmark.toggle` (`Mod+D`) save the page and open an edit bubble (name, folder, new folder, Remove); on a saved page they only open it, and Remove is the bubble's button (`src/main/shell/bookmark-bubble/`, `src/renderer/chrome/bookmark-star.ts`) |

### History

| Feature | Orivon | Note |
|---|---|---|
| History page | ✅ | `orivon://history`: by day or by session (pages visited within 30 minutes of each other), sorted by most recent, most visited or name, a site icon on each row, multi-select with open and delete, and a Recently closed card (`src/renderer/pages/history/`) |
| Search history | ✅ | A search box over titles and addresses (`src/main/history/history-domain.ts`, `history-list.ts`) |
| Delete individual entries | ✅ | One row, or every selected row (up to 500 a request), with a second press for several (`history-domain.ts`, `history-ids.ts`) |
| Clear by range (hour/day/week/all) | ✅ | `clear-data.ts`'s `HISTORY_RANGES` |
| Retention setting | ✅ | 7/30/90/forever, on/off toggle |
| "Journeys" / grouped browsing sessions | ⚠️ | History can be grouped by session (pages visited within 30 minutes of each other, `src/renderer/pages/history/sessions.ts`); there are no navigation chains |
| Favicons shown in history / sortable columns | ✅ | History rows show the site's icon, kept per host in `history.db` and cleared with history (`src/main/history/history-favicons.ts`), and the list sorts by most recent, most visited or name (`history-order.ts`) |
| Updates live when history changes | ✅ | `services.history.onChange` pushes `history.changed`/`privacy.changed` to the open page (`start-internal-pages.ts`) |

### Downloads

| Feature | Orivon | Note |
|---|---|---|
| Download manager UI | ✅ | `orivon://downloads` (`Mod+J`, main menu): list by day, every state, live rows, Clear list; a toolbar button with a progress ring and a bubble with the six latest, which peeks when a download starts (`downloads.showBubble`) (`src/renderer/pages/downloads/`, `src/renderer/overlay/downloads/`, `src/main/downloads/`) |
| Download progress | ✅ | Bytes, speed and time left with a progress bar on the page, and a ring on the toolbar button with a turning arc when the size is unknown (`src/renderer/pages/downloads/row.ts`, `src/renderer/chrome/downloads-button.ts`) |
| Pause / resume / cancel | ✅ | Through the download item by id, plus Retry, which resumes an interrupted item and otherwise asks for the address again (`src/main/downloads/download-service.ts`) |
| Open containing folder | ✅ | Show in folder for each file and Open downloads folder, through the system file manager (`download-service.ts`, `folder-runner.ts`) |
| Ask where to save each file | ✅ | Settings > Downloads "Ask where to save each file" uses Electron's own save dialog; not tested end to end, since the dialog is native (`download-service.ts`) |
| Default download folder setting | ✅ | Settings > Downloads "Change..." and "Use the default folder" (`downloads.folder`, empty means the operating system's Downloads folder) (`folder-runner.ts`, `src/renderer/pages/settings/sections/downloads.ts`) |
| Dangerous-file warnings | ✅ | A file whose name or content type runs code is written as `Unconfirmed <id>.download` and held until Keep (renamed) or Discard (deleted), in the bubble and on the page, and Orivon never opens it (`danger-hold.ts`, `dangerous-file.ts`, `download-service.ts`) |
| Safe Browsing check on downloads | ❌ | No reputation service; only the name and content type decide whether a file is held |
| Downloads from ordinary browsing tabs | ✅ | Every tab's session is handled, the default session at start and each other the first time a tab is created in it; the file goes to the Downloads folder with no dialog unless "Ask where" is on; app tabs are covered by unit tests, not an end-to-end test (`src/main/downloads/install-downloads.ts`) |

### Passwords and identity

| Feature | Orivon | Note |
|---|---|---|
| Password manager | ✅ | Logins kept in `passwords.json`, each password encrypted through the operating system's keyring with `safeStorage`; Settings > Passwords lists, reveals, copies, deletes, imports and exports them as CSV; nothing is kept without a real keyring or in a private window (`src/main/passwords/encrypted-vault.ts`, `passwords-domain.ts`) |
| Save-password prompt | ✅ | Offered under the address bar after a sign-in that worked: save, update, Not now, or never for the site; only a tab's top frame is watched, so a sign-in started from a frame or by a script alone is not seen (`src/main/passwords/save-offer.ts`, `window-forms.ts`, `src/preload/form-watch.ts`) |
| Password autofill | ⚠️ | Fills the account the person picks in Orivon's chooser, under the password button or a focused sign-in box, into a form of the tab's main frame at the same origin; nothing fills by itself, and frames and shadow DOM are not covered (`src/main/passwords/chooser-overlays.ts`, `fill-login.ts`, `src/preload/form-watch.ts`) |
| Password generator | ✅ | 20 characters from Settings > Passwords, and a "Use a strong password" row in the chooser on a sign-up form (`src/main/passwords/generate-password.ts`, `chooser-overlays.ts`) |
| Breach/leak check | ❌ | Not found |
| Passkeys / WebAuthn | ❌ | No code calls `app.configureWebAuthn`. Per Electron's typings, until it is called `PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()` resolves `false` and platform-authenticator requests are not serviced. A roaming security key is not measured |
| Platform authenticator (Windows Hello/Touch ID) | ❌ | Not found |
| Security keys (FIDO2/U2F) | ❌ | Not found |
| FedCM | ❌ | Not found |
| Google account sign-in (on any site) | ⚠️ | Google's sign-in hosts are shown a Firefox identity (`src/main/shell/sign-in-identity-headers.ts`); not yet confirmed against a real account, and a sign-in page in another site's iframe is not covered |
| Basic-auth (HTTP 401) dialog | ✅ | A sign-in sheet names the asking server, warns that a password goes unencrypted over plain http and that a request comes from a server other than the page's own, handles a proxy's 407, and offers a saved login (`src/main/auth/login-handler.ts`, `auth-sheet-overlay.ts`) |
| Client certificate picker | ⚠️ | A chooser lists the certificates a server accepts, warns when the asking host is not the page's host, marks an expired one and never preselects a row; unit and end-to-end tested with fake certificates, not against a real certificate store (`src/main/auth/client-certificate.ts`, `ask-chooser.ts`) |
| Sign-in / account sync | ➖ | Explicit non-goal: no sync, no Orivon-operated server for user data |
| Origin-bound app identity (`orivon.id`) | ✅ | Orivon's own substitute: a derived signing key per app origin, held in the OS keyring |

### Autofill

| Feature | Orivon | Note |
|---|---|---|
| Address autofill | ❌ | Not built in this build; `src/main/autofill/` holds an installer that does nothing |
| Payment card autofill | ❌ | Not found |
| Generic form-field autofill/memory | ❌ | Not found |
| Form validation bubbles, native `<select>`/date/color pickers | ➖ | Chromium's own default applies |

### Sync across devices

| Feature | Orivon | Note |
|---|---|---|
| Bookmarks/history/settings sync | ➖ | Explicit non-goal |

### Import from other browsers

| Feature | Orivon | Note |
|---|---|---|
| Import bookmarks/history/passwords from Chrome/Firefox/etc. | ⚠️ | Bookmarks and history import from Chrome, Chromium, Edge, Brave and Firefox profiles in their default places, and bookmarks from an HTML file, at `orivon://import` (`src/main/import/`, `src/renderer/pages/import/`); no profile's password store is read, and a CSV file another browser exports imports at Settings > Passwords (`src/main/passwords/passwords-csv.ts`) |

### Privacy and security

| Feature | Orivon | Note |
|---|---|---|
| Clear browsing data dialog | ✅ | History range, site data, cache, zoom, per-app data and, when ticked, per-site settings and permissions; Ctrl+Shift+Delete and More tools open it in Settings (`src/main/privacy/clear-data.ts`, `src/main/shortcuts/run-command.ts`) |
| Cookie controls (block third-party, etc.) | ✅ | Settings > Privacy > Cookies: allow all, or block third-party cookies; the default session only (`src/main/privacy/cookie-policy.ts`, `net-handlers.ts`) |
| Third-party cookie blocking | ⚠️ | The `Cookie` header of a cross-site request and the `Set-Cookie` header of its response are removed, WebSocket handshakes included; `document.cookie` inside a cross-site frame is not covered (`src/main/privacy/cookie-policy.ts`, `net-handlers.ts`) |
| Tracking protection / ad blocking | ❌ | Not built in; reachable only via a content-blocking extension |
| Fingerprinting protection | ❌ | Beyond the generic per-origin isolation the capability model gives apps |
| Do Not Track / Global Privacy Control | ✅ | Two Settings > Privacy switches send `DNT: 1` and `Sec-GPC: 1` on every http(s) request of the default session; `navigator.globalPrivacyControl` is not defined, so the header is the only signal (`src/main/privacy/privacy-headers.ts`, `net-handlers.ts`) |
| Safe Browsing / phishing & malware warnings | ❌ | Not found |
| HTTPS-only / upgrade mode | ✅ | Settings > Privacy > Always use secure connections upgrades a main-frame `http:` navigation; loopback, private addresses, single-label and local-suffix names, `*.localhost`, verifier-routed names and a named host with an explicit port are exempt; a failed upgrade shows a sheet with Continue (this run only) and Go back; subresources follow Chromium's mixed-content rules. An installed app and a production `.eth` or `ipfs://` origin are served over `https:` by construction, and a loopback origin runs over `http:` (`src/main/privacy/https-only.ts`, `https-warning-overlay.ts`) |
| Mixed-content blocking | ➖ | Chromium's own default applies to a page's native requests. A routed request from an app tab to a granted `http://` or `ws:` host is not blocked, because the manifest named that host and the person granted it |
| Secure DNS / DoH (general browsing) | ✅ | Settings > Privacy > Secure DNS: off, automatic, Cloudflare or Quad9, through `app.configureHostResolver`; names mapped by host-resolver rules, `.eth` included, never reach the provider; `.eth` resolution itself keeps its fixed resolvers (`src/main/privacy/secure-dns.ts`) |
| Certificate viewer | ✅ | From the site info Certificate row or More tools > View certificate: the chain, validity, serial and SHA-256 fingerprint, and Copy certificate (PEM); read in the one verify process (`src/main/auth/certificate-overlay.ts`, `note-certificate.ts`) |
| Certificate error interstitial | ✅ | A page that fails on its certificate gets a sheet with the reason and only Go back; there is no proceed and no exception store (`src/main/auth/cert-error-overlay.ts`, `cert-error-watch.ts`) |
| Custom CA management | ❌ | Not found |
| HSTS | ➖ | Chromium applies the HSTS headers it is sent and its preload list in every tab; Electron has no API to list or clear the stored entries, so no Orivon page shows them |
| Site isolation | ➖ | Chromium's own default; also load-bearing to the capability model |
| Sandbox | ✅ | `sandbox: true, nodeIntegration: false` for every app tab |
| Proxy settings (user-configurable) | ❌ | The only proxy code checks whether the OS proxy interferes with the verifier's own fetches |

### Site settings and permissions

| Feature | Orivon | Note |
|---|---|---|
| Camera | ✅ | A website is asked once per site in a prompt under the address bar (camera and microphone together when a page asks for both), the answer is remembered and changeable from the address bar, site info and Settings > Site settings; a registered app is refused (`src/main/site-settings/site-asks-engine.ts`, `site-prompt-overlay.ts`) |
| Microphone | ✅ | The same prompt and store as the camera; one question when a page asks for both, each answer stored |
| Location / geolocation | ⚠️ | Asked once per site and remembered, with a note that Orivon has no location service; an allowed page is still told no (`PERMISSION_DENIED`), so no position is ever delivered (`src/main/site-settings/site-asks-engine.ts`) |
| Notifications | ✅ | Asked once per site in the same prompt, remembered in `notification-decisions.json` and changeable from site info and Settings > Site settings (`src/main/sessions/site-notifications.ts`, `src/main/site-settings/site-settings-controller.ts`; ADR-0028) |
| Clipboard write | ✅ | Allowed outright, bounded by transient activation (`ADR-0022`) |
| Clipboard read | ✅ | `clipboard-read` and `deprecated-sync-clipboard-read` asked once per site in the same prompt, remembered and changeable from the chip, site info and Settings > Site settings; `sites.clipboardRead = block` refuses without asking |
| Clipboard image paste (into a page) | ➖ | An ordinary OS paste event, not routed through the permission gate |
| MIDI | ✅ | Asked once per site and remembered; Chromium reports plain and system-exclusive MIDI as one request, so the prompt names the stronger one and Allow covers both (`src/main/site-settings/electron-names.ts`) |
| USB (WebUSB) | ❌ | Device-permission handler refuses unconditionally |
| Serial (Web Serial) | ❌ | Same device-permission denial |
| HID (WebHID) | ❌ | Same denial; also excluded by design for apps (`hid` is 🚫) |
| Bluetooth (Web Bluetooth) | ❌ | No `select-bluetooth-device` listener exists, and Electron's typings say every Bluetooth request is then cancelled (not measured). The device-permission handler does not cover Bluetooth |
| Sensors (motion/orientation/ambient light) | ⚠️ | No Electron permission name exists for them; measured on Linux: `Accelerometer` fails with `NotAllowedError`, `devicemotion` still fires and `AmbientLightSensor` is undefined; no prompt and no store (`test/e2e-site-asks.test.ts` prints the probe) |
| Pop-ups | ✅ | A window a page opens with no click, touch or key press from the person in that tab in the last five seconds is blocked and listed under an address-bar chip, one window per input; per-site Allow and a default for every site; the rule is a recency test on browser-side input, since Electron reports no gesture flag (`src/main/site-settings/popup-policy.ts`, `tab-interaction.ts`) |
| Redirects | ➖ | Chromium's own default navigation handling applies |
| Automatic downloads | ✅ | A second download a page starts without a click on one page load is paused and asked about; Block cancels it and Allow is remembered; a file small enough to finish before the pause is already on disk; a download the person clicked for is never held (`src/main/site-settings/auto-downloads.ts`) |
| Protocol handlers (`registerProtocolHandler`) | ❌ | Not found; unrelated to the app-install manifest hint mechanism |
| File System Access, one file | ✅ | Allowed for a picked or dropped file, read or write (`ADR-0024`) |
| File System Access, a folder | ➖ | Refused by design on both handlers |
| Idle detection | ✅ | Asked once per site, remembered and changeable from the chip, site info and Settings > Site settings |
| Window management (multi-screen) | ✅ | Asked once per site, remembered and changeable from the chip; `getScreenDetails()` resolves after Allow |
| Storage access API (cross-site) | ⚠️ | An asker answers `storage-access` and `top-level-storage-access` from the cookie choice and never prompts; Chromium decides `requestStorageAccess()` itself in this build and does not route it through the handlers (`src/main/privacy/storage-access.ts`) |
| Payment handlers | ⚠️ | No Electron permission name exists for them and no payment UI is built; Chromium's default in this build applies (not measured) |
| JavaScript on/off per site | ✅ | Per site and for every site, from Settings and site info; switched off by a second `script-src 'none'` response header on the page and its frames, so it applies from the next load, covers a cached page, and leaves a PDF and a registered app alone (`src/main/site-settings/content-rules.ts`, `install-content-settings.ts`) |
| Images on/off per site | ✅ | Per site and for every site; the page's image requests are cancelled and alt text shows, from the next load, in the default session only; the browser's own favicon fetch is not one of them (`src/main/site-settings/content-rules.ts`) |
| Sound per site | ✅ | Per site and for every site; a tab on a blocked site is silent at once, its speaker badge reads "Muted by site settings", and the tab's own mute never overrides it (`src/main/site-settings/site-sound.ts`, `src/main/shell/signals/audio.ts`) |
| Zoom per site | ✅ | Remembered per origin (`src/main/zoom/`) |
| Local fonts (Local Font Access API) | ❌ | No Electron permission name exists for it; measured on Linux: `queryLocalFonts()` resolves with no fonts; no prompt (`test/e2e-site-asks.test.ts` prints the probe) |
| Screen/window sharing (`getDisplayMedia`) | ❌ | Left unset (Electron's own default refusal) |
| Persistent storage (`navigator.storage.persist`) | ❌ | No Electron permission name exists for it; measured on Linux: `persist()` resolves `false`; no prompt (`test/e2e-site-asks.test.ts` prints the probe) |
| AR/VR (WebXR) | ⚠️ | No Electron permission name exists for it; Chromium's default in this build applies (not measured) |
| Fullscreen (`requestFullscreen`) | ✅ | Allowed from a click on every page (`ADR-0025`) |
| Pointer lock | ✅ | Allowed, click-gated by Chromium (`ADR-0026`) |
| Keyboard lock | ✅ | Allowed in fullscreen only (`ADR-0026`) |

### Site data management

| Feature | Orivon | Note |
|---|---|---|
| View/delete cookies per site | ✅ | Site info lists a site's cookies by name, never value, and deletes one or all; Settings > Privacy lists every site with cookies and deletes one cookie or one site (`src/main/privacy/cookie-list.ts`, `site-data-domain.ts`, `src/renderer/pages/settings/site-data/`) |
| View/delete storage/cache per site | ✅ | Any site's cookies and storage can be cleared from site info or Settings > Privacy; Settings finds sites from cookies and IndexedDB folders, so a site that keeps only local storage or cache is not listed there (`src/main/privacy/site-data-inventory.ts`) |
| Storage usage display | ⚠️ | Site info shows the open site's whole storage estimate; Settings shows the cache plus IndexedDB total and IndexedDB size per site; local storage, service workers and Cache Storage are not measured per site (`src/main/privacy/site-data-inventory.ts`) |

### Page content tools

| Feature | Orivon | Note |
|---|---|---|
| Find in page | ✅ | `find.open` (`Ctrl+F`), `find.next` (`Ctrl+G`, `F3`), `find.previous`: a bar with a live count, match case and Enter/Shift+Enter, per tab; `Ctrl+F` and `Ctrl+G` go to a registered app's tab first, and a `Ctrl+F` the app's page leaves unhandled opens the bar (`src/main/find/`, `src/main/shortcuts/page-key-ipc.ts`, overlay `find`) |
| Zoom (page) | ✅ | `zoom.in`/`zoom.out`/`zoom.reset`, per-origin; a tab zooms per webContents (`isolated` mode) so the page's pixels scale and `innerWidth` follows (`src/main/zoom/attach-zoom.ts`) |
| Print / print preview | ⚠️ | `page.print` (`Ctrl+P`, menu, More tools) opens the system print dialog with backgrounds on, and with no printer goes straight to Save as PDF; no in-browser preview (`src/main/page-tools/print.ts`) |
| Save page as | ✅ | `page.save` (`Ctrl+S`) saves complete HTML, a single-file `.mhtml` by extension, and downloads an image, PDF or text page as it is; `page.pdf` saves the page as PDF (`src/main/page-tools/save-page.ts`, `save-pdf.ts`) |
| View source | ✅ | `page.viewSource` (`Ctrl+U`) opens `view-source:` beside the page for an http(s) page that is not an app's tab (`src/main/page-tools/view-source.ts`) |
| Reader mode | ✅ | `page.reader` (`F9`), the address bar's book button, More tools and the page menu open an article in `orivon://reader`, a tab beside it, drawn from a validated block model taken in an isolated world with `@mozilla/readability`; font, size, width and colours are set in the page's bubble (`src/main/reader/`, `src/renderer/pages/reader/`) |
| Translate | ❌ | Not found |
| Spellcheck | ⚠️ | `spellcheck.enabled` (on by default) checks text in every tab; the menu offers up to five suggestions, Add to Dictionary and a Check Spelling switch; no language picker, and Chromium downloads each dictionary once (`src/main/spellcheck/`) |
| Dictionary / look up word | ❌ | Not found |
| PDF viewer | ✅ | A served PDF opens in an ordinary tab in Chromium's built-in viewer with no `plugins` flag and no setting (`test/e2e-page-tools.test.ts`) |
| Image viewer | ➖ | Chromium's own default applies |
| Picture-in-picture | ✅ | `page.pip` (More tools, the video's menu) pops out the video under the pointer, or the playing or largest one, and puts it back on a second run (`src/main/page-tools/pip.ts`) |
| Media controls / global media hub | ❌ | Not found |
| Casting (Chromecast/AirPlay) | ❌ | Not found |
| Screenshots / page capture | ✅ | `page.screenshot` (`Ctrl+Shift+S`): the visible area or the whole page, to the clipboard or a PNG file; a page longer than 16,384 device pixels is cut there (`src/main/page-tools/screenshot.ts`, overlay `screenshot`) |
| Text-to-speech / read aloud | ⚠️ | The reader page reads the article with the system's voices (`speechSynthesis`) with play, pause, paragraph steps, speed and voice; the button is hidden where no voice is installed, and the page's own `speechSynthesis` call is ungated (`src/renderer/pages/reader/speech.ts`) |
| Forced dark mode for light-only sites | ⚠️ | `appearance.theme` flips OS-level `prefers-color-scheme`; no forced repaint of a site with no dark styles |
| Page fonts / minimum font size | ❌ | Not found |
| Text encoding override | ❌ | Not found |
| Alert / confirm / prompt dialogs | ✅ | Drawn in the tab's question panel under the asking frame's own origin, with a "do not let this page show more dialogs" tick from a document's third dialog. `alert` and `confirm` come from Electron's own dialog event and `prompt` from the tab's top-frame preload (a subframe's `prompt` throws, as in Electron). Electron's native box is not drawn for a tab or a `<webview>` guest. A call Chromium ignores (a sandbox without `allow-modals`, a handler running because the page is being left) is ignored here too |
| Pinch zoom, smooth scrolling, autoscroll (middle-click drag on a page) | ➖ | Chromium's own default applies to page content |
| Drag-and-drop of links/images/files into the page | ➖ | Chromium's own default applies |
| Network / DNS / certificate error pages ("can't be reached") | ✅ | Overlay `load-error` (`src/main/sad-tab/load-error-watch.ts`) over a tab whose page failed to load: a sentence per network error, the address, Chromium's short error name and Try again; a certificate failure gets the `cert-error` sheet instead, and a failed HTTPS-only upgrade its own (`test/e2e-load-error.test.ts`) |
| "Aw, snap" crash page / sad-tab reload | ✅ | Overlay `sad-tab` (`src/main/sad-tab/`) over a crashed active tab with Reload and Close tab; an unresponsive page gets the same card with Wait and Reload; a background crash shows only the strip icon until the tab is activated |
| `beforeunload` guard | ✅ | Asks Leave/Stay in the question panel while the page stays; Leave runs again a navigation the shell started, and a page's own navigation is repeated by the person (`leave-page-prompt.ts`) |

### Context menus

| Feature | Orivon | Note |
|---|---|---|
| Link: open in new tab | ✅ | Opens in a background tab (`src/main/shell/context-menu-groups.ts`) |
| Link: open in new window | ✅ | Open Link in New Window opens a real window (`context-menu-groups.ts`) |
| Link: open in private window | ✅ | Starts a private session on the address; hidden inside a private window and in a kiosk (`context-menu-groups.ts`, `ProfilesService.openPrivate`) |
| Link: copy link address | ✅ | |
| Link: save link as | ✅ | `webContents.downloadURL` through the downloads service: the Downloads folder with no dialog, or Electron's save dialog when "Ask where" is on (`context-menu-groups.ts`, `src/main/downloads/`) |
| Link: open in split view | ✅ | Orivon-specific addition |
| Link: copy link text | ✅ | `context-menu-groups.ts` |
| Image: open image in new tab | ✅ | Shown for http(s) images; opens in a background tab |
| Image: save image as | ✅ | `webContents.downloadURL` through the downloads service as a link is; not offered for `data:` or `blob:` images |
| Image: copy image | ✅ | |
| Image: copy image address | ✅ | Shown for http(s) images |
| Image: search image | ❌ | Not found |
| Selection: copy | ✅ | |
| Selection: search selected text | ✅ | The engine chosen in Settings searches for the selection, in a tab in front; the text is sent only on the click, at most 1,000 characters (`context-menu-groups.ts`, `context-menu-text.ts`) |
| Selection: translate selection | ❌ | Not found |
| Page: back/forward/reload in menu | ✅ | Back, Forward and Reload when nothing more specific was clicked; Back and Forward follow the tab's history |
| Page: save page as, print, screenshot, view source | ✅ | In the same group, for a web page; an internal page shows only Back, Forward and Reload |
| Page: inspect element | ✅ | Opens DevTools at the clicked element |
| Page: open in reader view | ✅ | Shown on a page that looks like an article, for the same address the book button in the address bar shows (`context-menu-groups.ts`, `src/main/reader/reader-signal.ts`) |
| Cut/copy/paste/select all (editable fields) | ✅ | Undo, Redo, Cut, Copy, Paste, Paste as Plain Text, Select All and Check Spelling, each enabled from the field's state; a misspelt word adds suggestions and Add to Dictionary; plus the chrome's own edit menu |
| Video/audio: open, save, copy address, picture in picture | ✅ | Open Video in New Tab, Save Video As, Copy Video Address and a Picture in Picture check (`context-menu-groups.ts`) |

### Web platform features that need the browser

| Feature | Orivon | Note |
|---|---|---|
| Notifications API | ✅ | See Site settings |
| Push API | ❌ | No push-service wiring; Electron ships no default push backend |
| Service workers | ➖ | Chromium's own default applies to ordinary web content; extension service workers are separate (Table 7). On an installed app's origin the served policy allows `worker-src 'self' blob:`, and no `Service-Worker-Allowed` header is sent, so a worker's scope is its script's directory (not measured). No end-to-end test registers a service worker on an app origin |
| Background sync | ❌ | Not found |
| Periodic background sync | ❌ | Not found |
| Badging API (`setAppBadge`) | ❌ | Not found |
| Web Share API | ❌ | `navigator.share` is absent in pages and not polyfilled; the Share menu is Orivon's own (see Updates, crash reporting, OS integration) |
| Payment Request API | ⚠️ | No Electron permission name exists for it and no payment UI is built; Chromium's default in this build applies (not measured) |
| `registerProtocolHandler` | ❌ | Not found |
| PWA install / standalone app windows | ❌ | Orivon's own "app" concept is unrelated to a `beforeinstallprompt` PWA path |
| File handlers (web app file associations) | ❌ | Not found |
| DRM / Widevine / EME | ❌ | No CDM wiring; the stock `electron` package ships without Widevine |
| Proprietary codecs (H.264/AAC/HEVC) | ⚠️ | The stock `libffmpeg.so` of Electron 44.0.0 decodes H.264, AAC, MP3, FLAC, Opus, Vorbis and PCM and demuxes MP4 and MOV, Matroska and WebM, Ogg, WAV, MP3, AAC and FLAC. It has no HEVC, AC-3, E-AC-3 or DTS decoder (`MediaSource.isTypeSupported` answers true for H.264 and AAC and false for HEVC). HEVC through a platform hardware decoder is not measured |
| WebRTC | ➖ | Chromium's own default applies. An app tab's WebRTC is not bounded by CSP or by grants and reaches STUN, TURN and peers with no grant (A41); a website's media tracks start only after the camera or microphone prompt is answered Allow |
| WebGL / WebGPU | ➖ | Chromium's own default GPU-accelerated rendering applies |
| WebXR | ⚠️ | No Electron permission name exists for it; Chromium's default in this build applies (not measured) |
| Geolocation provider | ❌ | A site is asked and its answer kept, but told no on every platform: Electron ships no geolocation API key and Orivon has no provider |
| Speech recognition | ⚠️ | No Electron permission name exists for it. Recognition needs the microphone, which a website is asked for once, and Electron ships no recognition backend key (not measured) |
| Speech synthesis | ➖ | Ungated; no browser-level UI uses it |
| Web Bluetooth / USB / Serial / HID | ❌ | USB, Serial and HID: the check handler denies `usb`, `serial` and `hid` and the device-permission handler answers `false`. Bluetooth: no `select-bluetooth-device` listener exists, and Electron's typings say every Bluetooth request is then cancelled (not measured); the device-permission handler does not cover Bluetooth |
| Gamepad API | ➖ | Ungated; Chromium's own default applies |
| Screen Wake Lock API | ❌ | No Electron permission name exists for it; measured on Linux: `wakeLock.request('screen')` rejects with `NotAllowedError`; no prompt (`test/e2e-site-asks.test.ts` prints the probe) |
| EyeDropper API | ➖ | Ungated; Chromium's own default applies |
| File System Access API (single file) | ✅ | See Site settings |
| Clipboard API | ✅ | Write allowed outright; read asked once per site and remembered (see Clipboard read) |

### Developer tools

| Feature | Orivon | Note |
|---|---|---|
| DevTools (console, elements, network, etc.) | ✅ | F12; asks once before opening on an app holding permissions |
| Console panel | ➖ | Part of Chromium's stock DevTools; JavaScript console (`Mod+Shift+J`, `Mod+Alt+J` on macOS, More tools) opens developer tools on it (`src/main/devtools/open-console.ts`) |
| Network panel | ➖ | Part of Chromium's stock DevTools |
| Task manager (Shift+Esc equivalent) | ✅ | `orivon://tasks` (`Shift+Escape`, More tools) lists Orivon's processes with memory and processor use, sorts them, goes to a tab, and ends a tab or app process (`src/main/info/`, `src/renderer/pages/tasks/`) |
| `about:`/internal informational pages (version, gpu, net-internals, flags) | ⚠️ | `orivon://about` shows version and graphics, and `about:<name>` and `chrome://<name>` typed in the bar open the Orivon page of the same purpose (`src/main/pages/internal-aliases.ts`); no net-internals, no flags |
| DevTools dock position setting | ✅ | Right/bottom/undocked |
| Per-tab DevTools toggle | ✅ | Browser-wide setting |

### Extensions and themes

| Feature | Orivon | Note |
|---|---|---|
| Install unpacked / `.crx` / `.zip` | ✅ | Table 7a |
| Install/update from the Chrome Web Store | ✅ | Table 7a |
| Content scripts (isolated + `"world": "MAIN"`, in frames/subframes) | ✅ | Table 7b |
| Service worker with core `chrome.*` APIs | ✅ | Table 7c |
| Toolbar button, badge, popup | ✅ | Extensions button and menu; pinned icons; the popup anchors under the button; a new extension is pinned by default (Table 7d) |
| Options page | ✅ | Opens in a tab, also from the menu and the icon's right-click menu (Table 7b) |
| Extension popup stays open, and closes only on focus loss, tab switch or navigation | ✅ | Table 7d |
| `chrome.offscreen`, `chrome.tabCapture`, `chrome.runtime.getContexts` | ✅ | Table 7c/7d; Volume Master captures a tab it was invoked on |
| `declarativeNetRequest` | ✅ | Static, dynamic and session rules are applied (Table 7c) |
| Extension shortcuts | ✅ | An extension's command keys bind when free, rebind at `orivon://extensions/shortcuts`, and never take a key Orivon uses (Table 7b) |
| Asking for more access later | ✅ | `chrome.permissions.request` asks in a sheet and the person can take a grant back from the details page (Table 7b) |
| Bookmarks, history, top sites and search for extensions | ✅ | Over Orivon's own stores; history and top sites never list an app's pages (Table 7c) |
| `webRequest` | ✅ | Served by Orivon, blocking included for manifest version 2; full uBlock Origin blocks (Table 7c) |
| `sidePanel`, `userScripts` | ⚠️ | Present as no-ops (Table 7c) |
| Native messaging | 🚫 | Off by design: it would start desktop programs outside the broker |
| Extensions inside apps a person has granted permissions to | ✅ | Table 7d |
| Extensions in private windows | ❌ | Table 7d |
| Extensions without the Chromium sandbox | ❌ | Table 7d (`A289`) |
| Browser themes | ❌ | No theme-extension or theme-store support; only `appearance.theme` |

### Accessibility

| Feature | Orivon | Note |
|---|---|---|
| Screen reader support | ➖ | Manual ARIA labelling, not a dedicated subsystem and not tested with a screen reader: the toolbar and the tab strip carry a role and a name, a group chip has `aria-expanded`, and a live region announces the pane entered and the tab reached (`src/renderer/chrome/panes.ts`) |
| Caret browsing | ✅ | `caret.toggle` (`F7`) or Settings > Accessibility turns it on for every tab of the profile, asking first by default; F7 goes to an app's own tab instead (`src/main/focus/caret-runner.ts`, overlay `caret-confirm`) |
| High contrast mode | ❌ | Beyond the system light/dark theme choice |
| Live captions | ❌ | Not found |
| UI zoom (browser chrome zoom, not page zoom) | ❌ | `zoom.*` shortcuts affect page zoom only |
| Keyboard navigation of the chrome (Tab order, F6 pane-cycle) | ✅ | `F6` and `Shift+F6` step through the address bar, toolbar, tab strip, bookmarks bar, the side panel when open, and the page; the toolbar and the strip are one Tab stop each, with arrow keys, Home, End, Enter and Delete, and every control shows a focus ring (`src/main/focus/pane-cycle.ts`, `src/renderer/chrome/roving.ts`) |
| Emoji picker (OS-level, e.g. Win+.) | ➖ | An OS-level input-method feature |

### Customisation

| Feature | Orivon | Note |
|---|---|---|
| Themes | ❌ | See Extensions and themes |
| Dark mode | ✅ | System/light/dark |
| Fonts | ❌ | No font-family or size setting |
| Toolbar customisation | ❌ | Not found |
| Keyboard shortcuts, remappable | ✅ | Full remapping UI |
| Gestures (mouse/trackpad) | ❌ | Not found |
| Side panel | ✅ | Docked beside the page on the right or the left (`sidePanel.side`), 280 to 640 px wide, from `Mod+Alt+B`, the toolbar button or More tools, with Bookmarks, History, a Reading list that stays empty while nothing saves to it, Downloads, and one slot for an extension's view that no extension fills yet; the page narrows rather than being covered, and the panel is hidden below 760 px, in HTML fullscreen and in a kiosk (`src/main/side-panel/`, `src/renderer/overlay/side-panel/`) |
| Settings, History and Profiles update live, without a restart | ✅ | Confirmed across Apps, Privacy, Usage, Updates and Profiles settings, History and the Profiles page, including across separate profile processes (`grant-events.ts`, `start-internal-pages.ts`) |

### Updates, crash reporting, OS integration and misc

| Feature | Orivon | Note |
|---|---|---|
| Self-update check | ⚠️ | Asks GitHub once a day for a newer release; Settings > About then offers a button that opens its release page in a tab, and nothing is downloaded or installed (`src/main/self-update/updates-domain.ts`, `release-url.ts`) |
| Automatic update installation | ❌ | The check above is informational only |
| Crash reporting | ❌ | No `crashReporter` usage; the Node-shim's own export is an explicit stub |
| Default-browser registration | ⚠️ | Settings > About registers Orivon for http and https from the button, from a packaged install only (a Linux .deb); a run from source or an AppImage says it is unavailable, and macOS and Windows packaging do not exist (`src/main/os/default-browser.ts`) |
| Open links from other apps (OS-level URL handling) | ✅ | A link handed to the running app opens as a tab: a second launch on Linux and Windows, an `open-url` event on macOS; only http(s) addresses are taken, at most eight; a cold start is `shell/first-window.ts` (`src/main/os/open-url.ts`, `src/main/launch/launch-context.ts`) |
| "Create shortcut" for a site/app | ⚠️ | A sheet writes a desktop entry (Linux) or a desktop link (Windows) that opens the site in an ordinary Orivon window; not offered on macOS, in a private window or for a page that is not http(s); the Windows link is untested on Windows (`src/main/os/site-shortcut.ts`, `shortcut-overlay.ts`) |
| OS integration: handoff / share sheet | ⚠️ | Share in the main menu and the tab menu copies the link, starts an email after a confirmation, or opens the QR code; there is no operating-system share sheet (`src/main/os/share-commands.ts`) |
| Energy saver / performance mode | ⚠️ | With `performance.energySaver` set to "battery", an idle tab sleeps after 5 minutes on battery, also with the memory saver off; no frame-rate or background-work limit beyond Chromium's own (`src/main/memory-saver/sleep-rules.ts`) |
| Telemetry, with opt-out and disclosure | ✅ | First-run disclosure and a "what was sent" page (`src/telemetry/`) |
| Languages / UI locale switcher | ❌ | No i18n/locale-switching code; UI strings are hard-coded English |
| Enterprise policy support | ❌ | Not found |
| Run from source, no compiler needed (Windows/macOS) | ✅ | Forces a no-native-modules policy on Orivon's own dependencies (Rule 8) |
| Linux packaging (AppImage/deb) | ⚠️ | `electron-builder.yml` and `npm run package:linux` build a `deb` and an AppImage; there is no packaging job in CI and no release workflow, so nothing is built or published automatically |
| External protocol links (`mailto:`, `magnet:`, `bitcoin:`, ...) | ✅ | Opened by the OS's default app only after a per-site, per-URL confirmation dialog (`ADR-0027`) |
| `beforeunload` guard | ✅ | See Page content tools |
| Right-click menu (chrome + page) | ✅ | See Context menus |
| Custom, non-Electron User-Agent string | ✅ | Every tab reports one plain Chrome UA with no `Electron/` or `orivon/` token, except `accounts.google.com` and `accounts.youtube.com`, which are shown a Firefox identity and no `Sec-CH-UA*` headers (`src/main/shell/sign-in-identity.ts`) |
