# Changelog

All notable changes to this project are recorded here, at most three lines each; the full
account of a change is in its pull request.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Orivon is published as
pre-releases numbered `0.0.x` on [GitHub Releases](https://github.com/OrivonBrowser/orivon-mvp/releases);
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) applies from the first version that is not a pre-release.
Each section below lists what that release carried; `[Unreleased]` is what has landed on `main` since the last one.

## [Unreleased]

### Changed for apps

What an app that runs on Orivon must now do differently. One line per behaviour, naming its id from
[`test/app-behaviours/catalogue.md`](test/app-behaviours/catalogue.md), what changed, what apps must
now do and which ports to recheck. CI requires a line here for a row of that page that is rewritten or removed, and for a change to the
public surface of `src/contracts/` (named `contracts/<file>`).

### Added

- **A copied Web3 address pastes as a link**: copying a `.eth`, `ipfs://` or `ipns://` address in Orivon (the address bar, Copy link, a link's or image's address, a bookmark, a history row, the QR sheet) also puts a link on the clipboard, so a document or chat that pastes formatted text shows the same text linked to its `eth.limo` or `dweb.link` address. Plain-text fields get the address as before.
- **The tunnels popup has a Browser-wide part**: a control under its heading chooses between the page's own tunnel ("This tab", "This site" or "This app") and the whole browser's, with a switch to send the IPFS and Swarm nodes through it too. Setting a tunnel browser-wide while tabs keep their own asks first, and lists those tabs.
- **A tunnel for one tab, chosen before the first address**: the tunnel button is now on the new tab. Turn on Nym or your proxy there and the address you type, and every site that tab opens until it closes, goes through it from its first request; on a website that goes through the tab's tunnel the button says "Set for this tab". The new-tab page is not kept in the saved session until it navigates. In a window 640 pixels wide or less the toolbar's navigation buttons and the address bar's padding are 2 to 4 pixels tighter, so the address field keeps its room beside the new button.
### Changed

- **The first page of an app no longer waits behind the app's download**: when a published app is opened for the first time, Orivon now holds the background download back until the page has finished loading (at most 10 seconds, and not at all once you press Allow), so the page's own files are no longer queued behind the app's.
- **A magnifying glass on the Web3 / Web2 search switch**: the chip in the address bar now carries a search icon beside its word, so it reads as the control that picks where a search goes.
- **The Swarm and IPFS nodes spend less CPU waiting on their sockets**: a wait over 265 sockets costs about a fifth of what it did, every socket readable in one pass of the event loop is answered together, and the nodes' WebAssembly host no longer reads the environment on each call.
- **Swarm sites opened before load faster**: their chunks are checked on several threads, so the rest of the browser keeps answering while a large page is read back.
- **A Swarm site opened before opens at once after a restart, without waiting for the Swarm node**: when every chunk a page needs is kept on this computer, the page loads while the node is still starting or has failed; the node is waited for only where a chunk has to come from it. With Swarm switched off in Settings, a site on disk still does not open.
- **A Swarm feed site opened before opens at once, even offline; a newer version is used from the next load**: the last update a feed was followed to is kept on this computer, checked against its signature each time, and the page opens from it without waiting for the Swarm node or the network; Orivon looks for a newer update in the background; a reload or a later visit shows it, and a page you are reading keeps the version it opened with for the next two minutes, unless another tab loads the same site.
- **A published app that moved is noticed much sooner, even when the page came from what Orivon had kept**: a visit or a reload now asks the name itself, at most every 30 seconds, instead of reading the answer kept for loading pages, which could be minutes old. An app open in a tab is looked at every 5 minutes instead of every 30, and a check that could not reach the name no longer holds back the next one.
- **An update that keeps its version number now says so**: when an app's files changed but its version did not, Orivon offers "A new build of version 0.24.0.2" instead of "Version 0.24.0.2 is available (you have 0.24.0.2)", and the unverified warning names the same thing.

### Fixed

- **An app whose page starts its main program only after Allow no longer takes so long on the reload**: Orivon downloaded an app's files in the order its manifest lists them, so a large main file that the first page leaves for after Allow came near the last. The download now reads the files the first page leads to first, and the reload finds the main file already read.
- **An app of several large files no longer stalls and loses a file when allowed during its first load**: files the page asked for together could each hold part of the room Orivon keeps for checking them and wait on each other for ten seconds, until one was refused and its script never ran. A site's reads now take turns, so the oldest finishes and frees its room for the next, within the limit every site shares.
- **Bug reports now include what Orivon's background processes log**: the lines the `.eth`, IPFS and Swarm host (page and file timings, name and gateway failures), the IPFS and Swarm node hosts and the Nym tunnel write, and what one prints as it crashes, went to the app's own stderr and past the log a report carries, and a packaged Windows app has no stderr at all. Main now writes each line to its own log, so the report's "Recent log" shows them: at most 60 a minute from each process, a line printed again and again once with a count, the last few of any overflow with the count, and from the Nym tunnel only its own lines, never the library's.

- **An app on an ordinary web host no longer stalls and loses a file when several large files load together**: they could each hold part of the room kept for checking them and wait on each other until one was refused. A file refused part way, or found too large, also gave none of that room back, so later files were refused sooner. The files of an app now take turns, and every file gives its room back.

## [0.0.12] - 2026-10-28

Pre-release, published 2026-10-28. [Release page](https://github.com/OrivonBrowser/orivon-mvp/releases/tag/v0.0.12).

### Changed for apps

- **`swarm-url-opens`**: a Swarm file's leaves are now read over the node's `/bytes` route, each checked against its parent, and fetched over `/chunks` alone only when that answer fails. Apps need no change; a Bee-API endpoint used for testing should serve `/bytes`, or each file is read a chunk at a time. Recheck: nothing.
- **`permission-query-reads-prompt-when-a-request-would-ask`**: new row. `navigator.permissions.query({ name: 'camera' })` (and microphone, geolocation, clipboard-read, midi, idle-detection, window-management) now reads `prompt` for a permission the person has not decided, where it read `denied`, so an app that waited for anything but `denied` before asking can ask. An app that held back a request because it read `denied` needs no change; it can now ask. Recheck: any port that reads a permission before it asks for the camera or microphone.
- **`page-drag-region-never-swallows-a-press`**: new row. A page's `-webkit-app-region: drag` no longer takes a press from the controls inside it, and the page's own regions are no longer reported to the window, so an app that draws its own title bar must not expect to drag Orivon's window by it. Recheck: Fluux Messenger, and any port that sets the property.

### Added

- **Settings > Web3 can ask your own Ethereum servers**: choose Your own servers and name up to four Ethereum RPC addresses and a beacon server; a node on this computer or your home network works. They replace Orivon's, which are never asked in their place, and a key in an address is hidden in the log, on screen and in a bug report.

### Changed

- **Swarm sites open about eight times sooner**: a file's leaves come from Orivon's Swarm node in one request per 512 KB, each still checked against the address its parent lists, up to 4 MB ahead, from a node that keeps 250 peers; a feed with no new update is found in one round. The WebTorrent app's page loaded in 15 to 18 s where it took 141 s, and a first start finds its peers about 10 s sooner.
- **A newer Orivon release is announced inside the browser**: the update check no longer raises an operating-system notification. Once per version, in the window you are using, a question under the address bar offers "Download from GitHub" (the release page, in a new Orivon tab), "Download from latest.orivonstack.eth" (the start page of that name, which downloads the package for your system, in a new Orivon tab) or "Not now", and waits while the window is minimised, full screen or covered by another question. Settings > About shows a release the background check found, and the report log says why a check failed.
- **The newest-release start page asks search engines not to index it**: the `index.html` that `latest.orivonstack.eth` opens now carries `<meta name="robots" content="noindex">`, as its `latest.orivonstack.com` twin does. A visitor sees the same page; the folder's CID changes on the next `sync`, the releases' do not.
- **Orivon's IPFS node is built from public source**: the node now comes from the public `orivon-ipfs-node` repository (MIT or Apache-2.0), built by its workflow and published as one pinned IPFS folder that the app checks by size and sha256. It resolves peers' `/dns` and `/dnsaddr` names over TCP to `1.1.1.1` and `1.0.0.1`, so it sends no datagrams, and its default bootstrap list gains the one peer reached by address alone.
- **Orivon's IPFS node can fetch from a provider behind a relay**: a provider whose only address goes through a circuit relay is now ranked after the direct ones and reached through that relay, so an `ipfs://` address whose only provider sits behind a home router and a relay can open. The relay is the one the provider's record names; it sees the two IP addresses, never the content, which is encrypted end to end.
- **A provider behind a relay has longer to answer**: when the IPFS node asks a peer it fetched from a moment ago and every address of that peer goes through a circuit relay, it waits 8 seconds for the answer instead of 2, since a provider whose idle connection closed needs about 2.5 seconds to be reached again; the next file of a shared folder no longer fails because that provider was passed over.
- **A fresh share's provider is found in seconds**: the IPFS node now keeps the addresses a provider's record carries, so a provider that is reachable only through a circuit relay can be dialled, and its walk through the network asks 10 peers at a time, holds up to 64 connections and ends 250 ms after the first provider it can reach. A share announced a moment ago opened in 4 to 9 minutes on Linux; on GitHub's Linux, macOS and Windows runners its provider was found in 2 to 7 seconds, 20 of 20 times each.

### Fixed

- **A program in WebAssembly that drops sockets no longer runs its app out of them**: a socket it dropped while still connecting kept its dial running and its place in the app's in-flight calls, one it wrote to and dropped stayed counted for as long as its peer kept quiet, and a dial that answered after the program had ended was never closed. Orivon's IPFS node, which drops most sockets it opens, lost its connections and its HTTP API after about half an hour on macOS. A report's technical details now list, for the eight apps holding the most connections, how many each holds and may hold.
- **An onion address is never looked up by a resolver**: with no tunnel on, a website set to go direct, an app that is not routed or a Nym tunnel, `name.onion` was resolved like any name, so a resolver learned the hidden service and an ISP that answers every unknown name with loopback sent the tab to this computer. Only your own SOCKS5 tunnel carries an onion address now; the sheet over the tab says so.
- **An onion address typed with no scheme opens over http**: `name.onion` was sent to `https://name.onion/` and failed with a certificate or tunnel error, because an onion service serves plain http on port 80 and Tor already encrypts the connection. "Always use secure connections" leaves an `http://` onion address alone, and an explicit `https://` one stays https.
- **A release is no longer lost when the system shows no notification**: the version used to count as told before anything was shown, so a system without notifications never told you of it. It now counts as told once the question has been on screen and you answered or dismissed it, so a question that could not be drawn is asked again.
- **A `.eth` name that does not exist says so again under ENSv2**: a missing subname of a name ENS still serves from its first registry (`foo.vitalik.eth`) showed "Cannot check this site right now", because ENSv2's mirror of that registry answers it with an `UnreachableName` revert; Orivon now reads that as a proven absence and shows "Nothing here".
- **A page that checks a permission before it asks no longer reads "denied"**: a camera, microphone, location, clipboard, MIDI, idle-detection or window-management permission nobody has decided now reads `prompt` to `navigator.permissions.query`, on websites and on an extension's own pages, so a wallet extension's webcam check reaches the question instead of saying it has no permission. A stored block and Settings' block still read `denied`.
- **An extension no longer takes a `.eth` page elsewhere when its load fails**: a name-resolution extension (MetaMask's address-bar resolution, for one) answers the error of a top-level `.eth` load by sending the tab to a gateway. Orivon now keeps the error of a load it makes itself from every extension, so a failed or interrupted `.eth` load stays in Orivon; the load's other events and the errors of other sites still reach extensions.
- **A click on a password in the sign-in list fills it**: pressing a saved login, or "Use a strong password", in the list that opens under a password box closed the list and filled nothing, because the press moved the keyboard and the page reported the box as left. The press is now a choice, and the list stays open under its box until one is made.
- **Buttons inside a page's own title bar can be clicked**: a page that marks a header `-webkit-app-region: drag` (Fluux Messenger's "+" buttons, for one) no longer has real mouse presses on the controls inside it taken for a window drag. On a page that re-lays-out every frame this costs about 1.7 ms of main-thread time per frame at 3,000 nodes.

## [0.0.11] - 2026-10-24

- **A Swarm site seen before opens from disk**: the chunks a site's pages read are kept on this computer (up to 256 MB of chunks in all, which take a little over 300 MB of disk; kept apart for each site, each chunk checked against its address again when read back), so a revisit, after a restart too, asks the node for none of them; clearing cached data or all history forgets them.
- **Swarm sites open about eight times sooner**: a file's leaves come from Orivon's Swarm node in one request per 512 KB, each still checked against the address its parent lists, up to 4 MB ahead, from a node that keeps 250 peers; a feed with no new update is found in one round. The WebTorrent app's page loaded in 15 to 18 s where it took 141 s, and a first start finds its peers about 10 s sooner.
- **A newer Orivon release is announced inside the browser**: the update check no longer raises an operating-system notification. Once per version, in the window you are using, a question under the address bar offers "Download from GitHub" (the release page, in a new Orivon tab), "Download from latest.orivonstack.eth" (the start page of that name, which downloads the package for your system, in a new Orivon tab) or "Not now", and waits while the window is minimised, full screen or covered by another question. Settings > About shows a release the background check found, and the report log says why a check failed.
- **Swarm sites open about five times sooner**: a file's leaves come from Orivon's Swarm node in one request per 512 KB, each still checked against the address its parent lists, and a feed with no new update is found in one round; the WebTorrent app's page loaded in 25 s where it took 141 s.
- **The newest-release start page asks search engines not to index it**: the `index.html` that `latest.orivonstack.eth` opens now carries `<meta name="robots" content="noindex">`, as its `latest.orivonstack.com` twin does. A visitor sees the same page; the folder's CID changes on the next `sync`, the releases' do not.
- **`.eth.limo` addresses inside a page load as `.eth`**: an image, script, stylesheet, font, media file or request a page loads from a `<name>.eth.limo` or `.eth.link` address now comes from the `.eth` name, checked on this computer, and a request from another origin can still read it. Frames keep loading through the gateway, since a `.eth` site refuses to be framed by another site; Settings > Web3 turns it off.
- **Orivon's IPFS node is built from public source**: the node now comes from the public `orivon-ipfs-node` repository (MIT or Apache-2.0), built by its workflow and published as one pinned IPFS folder that the app checks by size and sha256. It resolves peers' `/dns` and `/dnsaddr` names over TCP to `1.1.1.1` and `1.0.0.1`, so it sends no datagrams, and its default bootstrap list gains the one peer reached by address alone.
- **Orivon's IPFS node can fetch from a provider behind a relay**: a provider whose only address goes through a circuit relay is now ranked after the direct ones and reached through that relay, so an `ipfs://` address whose only provider sits behind a home router and a relay can open. The relay is the one the provider's record names; it sees the two IP addresses, never the content, which is encrypted end to end.
- **A provider behind a relay has longer to answer**: when the IPFS node asks a peer it fetched from a moment ago and every address of that peer goes through a circuit relay, it waits 8 seconds for the answer instead of 2, since a provider whose idle connection closed needs about 2.5 seconds to be reached again; the next file of a shared folder no longer fails because that provider was passed over.
- **A fresh share's provider is found in seconds**: the IPFS node now keeps the addresses a provider's record carries, so a provider that is reachable only through a circuit relay can be dialled, and its walk through the network asks 10 peers at a time, holds up to 64 connections and ends 250 ms after the first provider it can reach. A share announced a moment ago opened in 4 to 9 minutes on Linux; on GitHub's Linux, macOS and Windows runners its provider was found in 2 to 7 seconds, 20 of 20 times each.

### Added

- **Settings > Web3 can ask your own Ethereum servers**: choose Your own servers and name up to four Ethereum RPC addresses and a beacon server; a node on this computer or your home network works. They replace Orivon's, which are never asked in their place, and a key in an address is hidden in the log, on screen and in a bug report.
- **Node shim: `/` and `/orivon` exist as directories**: a program that makes a folder by walking from `/` (`stat` each ancestor, `mkdir` the missing ones) now reaches the app's files. They list one entry, the next segment toward the files, and every write, removal, rename and open on them, and any path beside the files, still fails `EACCES`.
- **Node shim: `crypto.randomInt`, `fs.mkdtemp`, `fs.cp` and `fs.copyFile`**: `randomInt` draws by rejection sampling over the platform's random values, in both forms; `copyFile`, `cp` (with `recursive`, `force`, `errorOnExist` and `filter`) and `mkdtemp` work on the app's own files and on a folder the person picked, in the callback and promise forms, with Node's errors.

- **Node shim: SQLite user-defined functions and backup**: `better-sqlite3`'s `db.function(name, [options], fn)` and `db.backup(destination)`, and `node:sqlite`'s `DatabaseSync#function`, now work (they threw "not built"); `aggregate`, `table`, `serialize` and `loadExtension` still refuse by name, and a backup cannot start inside a transaction.
- **Node shim: a SQLite database from bytes, and `serialize`**: `better-sqlite3`'s `new Database(buffer)` opens the bytes of a database file as a database in the engine's memory (readable, writable, never written to a file; with `readonly` it refuses writes), and `db.serialize()` returns a database's bytes as a `Buffer`; `aggregate`, `table` and `loadExtension` still refuse by name.
Pre-release, published 2026-10-24. [Release page](https://github.com/OrivonBrowser/orivon-mvp/releases/tag/v0.0.11).

### Changed for apps

- **`sqlite-database-from-bytes`**: new row. An app that opens a database from a `Buffer` (`new Database(buffer)`) or reads one with `db.serialize()` no longer needs a change to run. Recheck: any port that caught the refusal, or that went through a temporary file.

### Added

- **Node shim: a SQLite database from bytes, and `serialize`**: `better-sqlite3`'s `new Database(buffer)` opens the bytes of a database file as a database in the engine's memory (readable, writable, never written to a file; with `readonly` it refuses writes), and `db.serialize()` returns a database's bytes as a `Buffer`; `aggregate`, `table` and `loadExtension` still refuse by name.

### Fixed

- **`.eth` names load on a fresh install again**: the bundled light-client checkpoint is now the first block of a finalized epoch that the beacon server bootstraps from, and a checkpoint that server answers 404 to is replaced in the same run.

## [0.0.10] - 2026-10-23

Pre-release, published 2026-10-23. [Release page](https://github.com/OrivonBrowser/orivon-mvp/releases/tag/v0.0.10).

### Changed for apps

- **`sqlite-user-functions`** and **`sqlite-backup-to-app-files`**: new rows. An app that registers SQL functions on its database, or copies it with `db.backup`, no longer needs a change to run; `backup` cannot run inside a transaction. Recheck: any port that caught the refusal.
- **`node-fs-ancestors-of-the-files-root-exist`**: new row. `fs.stat`, `existsSync` and `mkdir` on `/` and `/orivon` now answer as for directories that exist, and `readdir` lists the one entry toward the app's files; they failed `EACCES` before. Writes on them and any path beside the files still fail `EACCES`. Recheck: any port that walks a folder's ancestors.
- **`file-handle-streams`**: new row. A page's `FileHandle`, from `orivon.fs.open`, a pick or a folder, now has the `readable()` and `writable()` its contract names; they were missing, so calling one threw. Each chunk is an ordinary positional `read` or `write`, counted and refused as one. Recheck: TorSocks.
- **`node-random-int-in-range`** and **`node-fs-copies-files-and-trees-and-makes-temp-folders`**: new rows. `crypto.randomInt`, `fs.copyFile`, `fs.cp` and `fs.mkdtemp` now work (they threw "not implemented"); `cp` does not set file times or follow links, and a copy reads the whole file. Recheck: any port that caught the refusal.
- **`electron-dialog-paths-read-and-write-the-pick`**: also covers `copyFile`, `cp` and `mkdtemp` on a picked folder and between it and the app's files. Nothing for apps to change.
- **`routed-fetch-sends-no-origin-by-default`**, **`routed-fetch-delivers-body-in-pieces`**, **`routed-xhr-puts-binary-body-without-cors`**, **`routed-fetch-loopback-grant-covers-both-spellings`**, **`routed-websocket-wss-carries-origin-and-subprotocol`**, **`routed-websocket-reaches-granted-loopback-port`**, **`web-lock-if-available-follows-the-holder`**, **`user-agent-redefinable-by-head-script`** and **`cache-api-stores-and-reads-back`**: new rows that pin behaviour already documented, each with an end-to-end spec. A routed `fetch` adds no `Origin` or `Referer`, and delivers a chunked body as it arrives; a routed `WebSocket` sends the page's origin and the subprotocol it offered. Recheck: nothing.
- **`routed-fetch-sends-formdata`** and **`routed-fetch-follows-redirects`**: now proven by an end-to-end spec. The first row's sentence also names the multipart body, the file's name and bytes, and a `File` body's type; the second names the bound (forty hops fail). Recheck: Element.

### Added

- **Node shim: `/` and `/orivon` exist as directories**: a program that makes a folder by walking from `/` (`stat` each ancestor, `mkdir` the missing ones) now reaches the app's files. They list one entry, the next segment toward the files, and every write, removal, rename and open on them, and any path beside the files, still fails `EACCES`.
- **Node shim: `crypto.randomInt`, `fs.mkdtemp`, `fs.cp` and `fs.copyFile`**: `randomInt` draws by rejection sampling over the platform's random values, in both forms; `copyFile`, `cp` (with `recursive`, `force`, `errorOnExist` and `filter`) and `mkdtemp` work on the app's own files and on a folder the person picked, in the callback and promise forms, with Node's errors.
- **Node shim: SQLite user-defined functions and backup**: `better-sqlite3`'s `db.function(name, [options], fn)` and `db.backup(destination)`, and `node:sqlite`'s `DatabaseSync#function`, now work (they threw "not built"); `aggregate`, `table`, `serialize` and `loadExtension` still refuse by name, and a backup cannot start inside a transaction.

### Changed

- **`.eth.limo` addresses inside a page load as `.eth`**: an image, script, stylesheet, font, media file or request a page loads from a `<name>.eth.limo` or `.eth.link` address now comes from the `.eth` name, checked on this computer, and a request from another origin can still read it. Frames keep loading through the gateway, since a `.eth` site refuses to be framed by another site; Settings > Web3 turns it off.
- **Releases carry the plain downloads only**: the installer and AppImage copies named for an app are no longer attached to a release or its IPFS folder. A copy renamed for an app still opens it on first run.

### Fixed

- **A page that failed to load opens once its tunnel is turned on**: an onion address opened in a new tab failed, and choosing "Your proxy" from the tunnel button left it on the error; the tab now moves to the tunnel and loads the address.
- **The tunnel test no longer reads as a problem when a proxy takes a sign-in**: Settings and the tunnel menu now say that Orivon signs in for you, with a different name for each app and site.
- **A page's first files from a `.eth` name no tab had opened no longer fail at random**: a stylesheet, image or fetch could be refused with a certificate error when several arrived at once; the first request to a name now connects before the others.
- **One-line installs no longer stop on a blank answer from GitHub**: the Linux, macOS and Windows commands ask again when GitHub's release list comes back empty, instead of saying no release exists yet.

## [0.0.9]

Pre-release. [Release page](https://github.com/OrivonBrowser/orivon-mvp/releases/tag/v0.0.9).

### Changed for apps

- **`contracts/manifest.ts`**: a manifest may carry `support: { issues }`, an absolute `https://` URL where its publisher takes problem reports; a malformed value rejects the manifest and absence is allowed. Older Orivon builds skip the field. Recheck: nothing; ports add it on their next republish.
- **`manifest-support-link-in-site-panel`**: new row. A manifest that names `support.issues` now has "Report a problem with this site" in its site popover, opening that address in a new tab. Ports can name their own tracker there; nothing changes for apps that name none. Recheck: every port, once it republishes with the field.
- **`contracts/handles.ts`**, **`electron-dialog-paths-read-and-write-the-pick`** and **`user-picked-file-and-folder-handles`**: `FileHandle` gains an optional `name`, the basename of the file the handle is open on (never a path), and a picked file now has its real name. `dialog.showOpenDialog` and `showSaveDialog` in the `electron` shim return a stand-in path (`/orivon/picked/<id>/movie.mkv`) that `fs` reads and writes straight through the pick, so `path.basename` and `path.extname` work on it. An app can drop a picker of its own and the copy it made of each picked file; a path lasts until the page reloads and `*Sync` calls on it fail. Treat an absent `name` as unknown. Recheck: WebTorrent (its copy-in picker can go); ASGARDEX and Ledger Wallet answer `electron` with their own objects and can use it only by moving to the shim.
- **`electron-ipc-send-sync-answers-from-the-listener`** and **`electron-power-save-blocker-holds-a-wake-lock`**: new rows. The `electron` shim now has `ipcRenderer.sendSync` (answered by an `ipcMain.on` listener's `event.returnValue`, else a named error), `addListener`, `off` and chainable `on`/`once`, and `powerSaveBlocker` over `navigator.wakeLock`. A port can drop its hand-written `sendSync` and wake-lock code: recheck WebTorrent, whose build bundles this shim, and Ledger Wallet and Element, which answer `electron` with their own objects.
- **`wake-lock-held-on-a-visible-page`**, **`wake-lock-absent-outside-a-secure-context`** and **`wake-lock-released-when-the-tab-goes-behind`**: new rows. `navigator.wakeLock.request('screen')` is now granted to a tab's top frame (it was always refused), and is released when the tab goes behind another or its window is hidden; ask again on `visibilitychange`. FreeTube, Element, Ledger Wallet and WebTorrent need no rebuild.
- **`direct-app-names-resolve-through-chromium`** and **`named-host-resolving-to-loopback-is-refused`**: new rows. The host names an app's `fetch`, `orivon.net.connect`, `connectSecure`, `udp` and `lookup` dial are looked up by the resolver pages use, so Secure DNS applies to them; a host grant that names a host never reaches a loopback or private address the name resolves to. A routed app still sends the name to its tunnel. Recheck: nothing.
- **`tls-connect-honours-reject-unauthorized`**, **`routed-fetch-refuses-untrusted-certificate`**, **`oauth-popup-reaches-the-app-by-channel`**, **`routed-fetch-sends-webdav-methods`**, **`blob-download-saves-without-dialog`** and **`audio-loads-from-granted-https-host`**: new rows that pin behaviour already documented. A sign-in popup that leaves for a provider on another origin and returns to the app's own page arrives with no `window.opener`: report the code over a same-origin `BroadcastChannel`. A routed `fetch` has no TLS option and refuses a self-signed host; `tls.connect` and `connectSecure` honour `rejectUnauthorized: false`. Recheck: apps with a popup sign-in.
- **`orivon:` links**: `orivon:open?u=<name>.eth/path` and `orivon:open?u=ipfs://<address>` open that page in Orivon when clicked in another program; any other `orivon:` link, and any target that is not a `.eth` name or an IPFS or IPNS address, only brings Orivon to the front. Recheck: nothing.

### Added

- **One-line Windows install**: paste a PowerShell command and Orivon installs for your user and opens, with no SmartScreen warning; the README and each release's file table carry it.
- **What's new in this version**: the first start of a newer version opens a page listing what it changed, once; Settings > About has a link to it. Nothing is fetched: the list is part of the download.
- **Start here card on the new tab**: three steps, each ticked once Orivon sees it happen: open an app, see the shield on a `.eth` name, and bring your bookmarks (shown only when another browser's profile is on this computer). A line says when full uBlock Origin is on. Dismiss closes the card for good, and so does finishing every step. A private window never shows it.
- **A download can be tagged for an app**: the Windows installer and the Linux AppImage come as `Orivon-Setup-<version>-x64.<app>.exe` and `Orivon-<version>-x86_64.<app>.AppImage`, and the Mac and Linux one-line installs take the app as an argument. The first time it runs on a new profile, that app opens after the welcome screen, asks what it may do as for any visit, and shows first in Orivon Featured. A plain package behaves as before.
- **Your apps on the new tab**: a row under Orivon Featured lists the apps this profile has allowed to do more than a web page may, the one used most recently first, with a link to Settings > Apps.
- **Hide a tile in Orivon Featured**: a small cross on each tile hides it for the profile, and "Show hidden" under the row brings them all back.
- **`orivon:` links open from other programs**: a link written `orivon:open?u=<name>.eth/path` or `orivon:open?u=ipfs://<address>` opens that page in Orivon on Linux (the .deb), Windows and macOS. Any other `orivon:` link only brings Orivon to the front.
- **Copy web link**: a page at a `.eth`, `ipfs://` or `ipns://` address has "Copy web link (opens in any browser)" beside Copy Link, in a tab's Share menu, the main menu's Share list and a link's right-click menu. It copies an `https` address that a browser without Orivon opens.
- **Report a problem with a site**: the site popover has a "Report a problem with this site" row for a site whose manifest names where its publisher takes problem reports, and it opens that address in a new tab.
- **One-line install on Linux**: a command in a terminal installs the newest release's AppImage for your user, without sudo, with a menu entry, an icon and an `orivon` command, and checks the download against the SHA-256 GitHub reports. Run it again to update.
- **IPFS folders without an index page list their files**: an `ipfs://` folder with no `index.html` shows its sub-folders and files with their sizes, instead of "Nothing here". A link opens a sub-folder or downloads a file.
- **Video and call pages can keep the screen on**: an app's tab or a website in front is now granted the screen wake lock, and releases it when the tab goes behind another or the window is hidden. Before, every request was refused.

### Changed

- **A site's first load waits 45 seconds** instead of 25 before Orivon offers public gateways, since a cold `ipns://` load of an app sometimes took 26 to 40 seconds.
- **The default-browser question comes later**: Orivon asks once, after the first app has opened or on the second day of use, whichever comes first, instead of 30 seconds after the first start. It no longer appears over an app's consent prompt, and "Don't ask again" is on every ask.
- **The first permission question says why it is asked**: one line above its buttons, "This is a desktop app. It needs more than a web page may have, so it asks you once." Later questions are as before.
- **An app can open and save the file you pick**: an app's own Open and Save buttons now work on the file or folder you choose, and edits land in that file instead of a copy; a video you open is no longer copied into the app's storage first. The app sees the file's name, so it can tell its type.
- **A release's page lists what changed** and a table of which file suits which computer.

### Fixed

- **An app's connections look names up with Secure DNS**: the host names an app's `fetch` and network calls dial now use the same resolver as pages, so on a network whose DNS hijacks a host such as an IPFS gateway the app no longer fails with a certificate or refused-connection error.
- **Settings > About "Check now" and the daily update check see a release**: every release is a pre-release, and the check reported that the release could not be read.
- **`.eth` names open on an install whose built-in checkpoint is old**: on the first `.eth` name, Orivon asks two beacon servers for a fresh checkpoint and uses it only if both agree. Settings > Web3 says where the checkpoint came from, and why when it could not be fetched.
- **Swarm sites with zero-padded chunks open**: sites whose chunks are stored padded with zeros to 4096 bytes were refused as malformed; they load now, and a chunk that carries anything but zeros past its length is still refused.

## [0.0.8] - 2026-10-17

Pre-release, published 2026-10-17. [Release page](https://github.com/OrivonBrowser/orivon-mvp/releases/tag/v0.0.8).

### Changed for apps

- **`installed-app-without-grants-is-asked-as-a-website`**: an installed app that holds no grant is now asked for a location, a notification or a clipboard read as a website is, and the person's answer and site rules apply to it. An app that needs such a feature declares the capability instead; recheck apps that call these web APIs with no grant.

### Added

- **Look for updates is on by default**: Orivon asks GitHub once a day whether a newer release exists, and installs nothing; Settings > About turns it off. A profile made before this follows the new default.
- **Secure DNS is on by default, with a fallback**: site names are looked up at Quad9 over HTTPS, and this computer's own DNS answers when Quad9 cannot be reached. Settings > Privacy offers Quad9 or Cloudflare alone, Automatic and Off as before. Sites sent through a tunnel are never looked up here.
- **The "?" marks of the Web3 Score shield are links**: each one, in the site popup's Web3 Score page and in the "Web?" mark of the address bar, opens the Web3 Score guide at `docs.orivonstack.eth` in a new tab.
- **Each site and app picks its own tunnel**: the tunnel menu lists Nym and your own proxy for any website, Web3 site or installed app, so one can go through Nym while another goes through the proxy. A website asks first before it moves into a tunnel's profile, where you sign in to it once; people who already used their own proxy keep their logins on updating.
- **Set and test your proxy from the tunnel menu**: an address field, a Test, and a question first when sites or apps already use the address you change.
- **Choose whether the nodes use the tunnel**: Settings > Tunnels has "Use tunnel to run network nodes (such as IPFS and Swarm)", off by default. With a tunnel on for the whole browser, the IPFS and Swarm nodes and the Ethereum service that checks `.eth` names connect directly, so `ipfs://`, `bzz://` and `.eth` pages load at a normal speed while the sites' own connections stay in the tunnel.

### Changed

- **The Nym logo in the tunnel list is Nym's own mark** (the NymVPN app icon: a dark N on a green square).
- **The welcome screen no longer promises Bitcoin nodes.**
- **Installed apps choose their tunnel as websites do**: from the tunnel menu, or from the same three choices (Off, Nym, Your proxy) on the app's card in Settings > Apps. Settings > Tunnels gains a default tunnel and a Test for each tunnel.
- **Each "Unlimited network access" row says what it is for**: connecting to any computer, sending data to any computer (peer-to-peer and calls), or loading anything from any website, so an app that asks for several shows rows that differ.
- **Orivon no longer reads a public IPFS gateway on its own**: when your node cannot serve a page, the page says why and offers "Load through public gateways" for that one load. The next load asks again.

### Fixed

- **Maximizing the window no longer freezes the loading bar**: opening an `ipfs://` or `.eth` page after maximizing or fullscreening left the tab's loading bar still until another tab was clicked.

## [0.0.6] - 2026-10-15

Pre-release, published 2026-10-15. [Release page](https://github.com/OrivonBrowser/orivon-mvp/releases/tag/v0.0.6).

### Changed for apps

- **`app-hid-device-can-be-forgotten`**, **`scheme-link-always-skips-the-question`** and **`website-hid-chooser-unless-blocked`**: reworded. Nothing an app can observe changes: the person now takes an approved device, a chosen link kind or a granted permission away by switching it off in Settings, where it was a Forget, Stop or Revoke button; the app sees the same refusal and asks again as before. Recheck: nothing.
- **`first-visit-enters-at-once`**, **`first-visit-caches-beside-the-question`**, **`first-visit-deny-stops-caching`** and **`first-visit-deny-is-a-website`**: rewritten; **`first-visit-asks-with-switches`**, **`first-visit-key-dot`** and **`first-visit-review-permissions`**: new rows. The first visit's question is one panel of switches (Grant all, Close) for every app, whatever its `consentGranularity`; closing with some on lets the app in holding only those, with none on refuses it, and the key wears a dot while permissions are off. Apps must work with a subset of what they declare. Recheck: the ports.
- **`tunnelled-website-sends-nothing-direct`**: rewritten. A `.eth`, `ipfs://` or `ipns://` website with the tunnel on is now read entirely through the tunnel (gateway blocks, DNSLink, name proofs, CCIP-Read) and shown as fully tunnelled; a `bzz://` address, or a name whose content is on Swarm, does not open while its tunnel is on. Recheck: any port a person opens by a Web3 name or address through Tor, and any hosted on Swarm.
- **`tunnelled-website-gets-its-own-storage`** and **`tunnelled-website-sends-nothing-direct`**: new rows. A website the person turns the tunnel on for from its site-info popover runs in the tunnel profile, one persistent session shared by every website with an on entry, apart from the default session and behind the profile's tunnel sign-in; the person is told first that it moves to their tunnel profile. An app whose pages are also opened as websites must not assume that a visit in the default session and one through the tunnel share cookies or storage, and every tunnelled website shares one tunnel identity. Recheck: any port a person may open by its address through Tor.
- **`tunnel-everywhere-carries-a-plain-website`**, **`tunnel-everywhere-leaves-a-site-set-to-off-direct`**, **`tunnel-everywhere-moves-no-website`**, **`tunnel-everywhere-sends-nothing-direct`**, **`tunnel-everywhere-on-nym`**, **`tunnel-everywhere-carries-orivons-own-requests`**, **`tunnel-everywhere-app-follows-the-default`** and **`tunnel-everywhere-app-set-to-off-asks-the-system`**: new rows. A person can send all of Orivon's traffic through the tunnel (Settings > Privacy and data): an installed app with no setting of its own then follows it, its `orivon.net` goes through the tunnel with the name unresolved and its own sign-in, and one the person switches off on its card is asked about the system's proxy as before. Websites with no setting are carried by the default session; a site the person turns off lives in the direct profile. Orivon's own requests go through the tunnel or do not happen, and the local IPFS and Swarm nodes are off meanwhile. Recheck: any port that assumes `orivon.net` of an unrouted app is refused whenever the default session has a proxy.
- **`tunnel-everywhere-held-by-unreadable-settings`**: new row. A settings file that cannot be read now leaves the whole browser on the tunnel, with Settings saying why, instead of silently off. Recheck: none.
- **`tunnel-hardening-direct-profile-leaves-through-the-tunnel`** and **`tunnel-hardening-app-set-to-off-leaves-through-the-tunnel`**: new rows. With the whole browser on the tunnel, a page of a site or app the person set to off that links to, redirects to, or opens a sized window onto an ordinary website now reaches it through the tunnel from its first request, where it could commit in the session it left. Apps set to off must not assume their session serves the sites they link to. Recheck: any port a person may use with one site left outside the tunnel.
- **`extensions-run-in-the-profiles`**: new row. The person's extensions run in the tunnel profile and the direct profile as in the default session: the toolbar button, popup, `chrome.tabs`, run-time rules and blocking webRequest listeners (uBlock Origin) work there. Each profile's copies run only while one of its websites is open, and are removed, with their pages and workers, when the last closes. Each profile keeps its own extension settings.
- **`nym-privacy-level-applies`**: new row. Nym tunnels are made at Balanced by default (no steady stream of decoy packets, loop cover traffic kept; much less processor time) and at Strongest, Nym's own defaults, when Settings says so; a change closes the idle tunnel at once. Recheck: none.
- **`nym-settings-test-answers`**, **`nym-tunnel-tries-another-gateway`** and **`nym-dead-tunnel-is-replaced`**: new rows. The Nym host looks names up itself, tries a tunnel that cannot come up again through another gateway, and replaces a tunnel that carries nothing; the Settings test shows that it is working and why it failed. Nothing for apps to do; recheck any port that waited on a Nym connection for longer than a minute.
- **`routed-app-on-nym-sends-nothing-direct`** and **`routed-app-on-nym-fails-closed`**: new rows. The tunnel for installed apps is Nym by default: a routed app's `connect` and datagrams leave through a mixnet tunnel of its own, built into Orivon, with nothing set up; a person can still choose their own SOCKS5 address, and an address saved earlier stays the choice. Nothing to do for apps; recheck ports that tell a person to run Tor.

### Added

- **"Orivon Featured" on the new tab shows Explore, WebTorrent, ASGARDEX, Ledger Wallet and The Lounge**, each with its icon. The Extensions menu and page no longer point people to the Chrome Web Store.
- **Nym privacy**: Settings > Privacy and data offers Balanced (the default, a fraction of the processor time) or Strongest (Nym's steady decoy traffic, about a third of a core for each open tunnel). Tunnels now start at Balanced unless you choose Strongest.
- **A website can go through the tunnel too**: the key in the address bar offers "Use the tunnel for this site". The site then gets its own
  storage, kept apart from the rest of your browsing (you are told first, and sign in to it again once), and Settings lists the sites and apps with a setting of their own (ADR-0082).

### Fixed

- **The default Secure DNS keeps its promise from the first second.** Chromium's automatic mode answered from this computer's DNS for the first tens of seconds, so on a network that hijacks DNS a page or app opened early kept the hijacked addresses. Orivon now starts with Quad9 alone, falls back to this computer's DNS only when Quad9 does not answer, and checks again every five minutes and when the network returns.
- **An app's direct connections follow Secure DNS.** The host names an app's `fetch` and `orivon.net` calls dial were looked up by the system's resolver, so on a network whose DNS hijacks a host the app failed with a certificate or refused-connection error and the name leaked to that network; they now use the same resolver as pages, and the address checks are unchanged. A routed app still sends the name to its tunnel. This includes `https` fetches and `connectSecure`, which handed the bare name to Node's own resolver.
- **A middle-click on a tab no longer pastes into the address bar on Linux.** The release of the middle button pasted the selection into the focused field before the tab closed; it is cancelled everywhere but over a field, so pasting into one still works.
- **Nym is much faster to load pages and no longer leaves every page failing.** The Nym host looked names up one at a time inside the module, so each new site waited a second behind the one before it and a lost datagram stalled all of them for 30 s; about one tunnel in six came up unable to answer any lookup and was never replaced. The host now looks names up itself, all at once, tries a tunnel that cannot come up again through another gateway, and replaces a tunnel that carries nothing. The Settings test says that it is testing and why it failed, and the tunnel it opens is closed after its answer instead of burning a third of a core for ten minutes.
- **Web3 through a tunnel waits as long as a mixnet needs.** With a tunnel carrying the verifier, a `.eth` load waits up to 60 s for the light client to sync (8 s before) and a name's proof is given 100 s (25 s), and the light client starts when a `.eth` name needs it or three minutes after the verifier starts, so its two-megabyte sync does not crowd out an `ipfs://` page.

### Security

- **A website that moves into its own session keeps every setting it had**: the privacy signals, third-party cookie blocking, HTTPS-only, the per-site
  content blocks, the sign-in headers and the verifier's stamps are installed on every session a website runs in, through one seam, and a session missing one is refused (ADR-0082).

## [0.0.5] - 2026-10-13

Pre-release, published 2026-10-13. [Release page](https://github.com/OrivonBrowser/orivon-mvp/releases/tag/v0.0.5).

### Changed for apps

- **`routed-app-sends-nothing-direct`**, **`routed-app-keeps-its-loopback-listens`** and **`routed-app-refuses-what-the-route-cannot-carry`**: new rows. An installed app the person routes through their tunnel, a SOCKS5 server (Settings > Privacy and data sets it, the app's card in Apps turns it on) sends everything through it: `connect`, `connectSecure`, datagrams and the page's own network use the tunnel with the name unresolved, `lookup` and a `network`-scope `listen` are `denied`, and WebRTC and the app's update checks are off. An app must not rely on `dns.lookup`, a LAN listener or a direct route while routed. Recheck: any port a person may run through Tor.
- **`routed-app-asks-before-opening-a-website`**: new row. A routed app's page that navigates its tab, opens a window or follows a `target=_blank` link to an address outside its own sessions now asks the person first, each time: through their tunnel (a temporary in-memory session, kept apart from the app's), directly, or not at all. `window.open` to such an address returns `null` whatever the answer, because it is answered after the call returns, so an app must not wait on that window's `opener`; a popup that asks for a window of its own (sized, `popup`) is unchanged. Recheck: any port a person may run through Tor that opens links to other sites.
- **`routed-app-sends-nothing-direct`**, **`routed-app-keeps-its-loopback-listens`** and **`routed-app-refuses-what-the-route-cannot-carry`**: new rows. An installed app the person routes through their tunnel, a SOCKS5 server (Settings > Privacy and data sets it, the app's card in Apps turns it on) sends everything through it: `connect`, `connectSecure`, datagrams and the page's own network use the tunnel with the name unresolved, `lookup` and a `network`-scope `listen` are `denied`, and WebRTC and the app's update checks are off. The page's requests to the local network, link-local addresses included, go through the tunnel too; only this machine stays direct. An app must not rely on `dns.lookup`, a LAN listener or a direct route while routed. Recheck: any port a person may run through Tor.

### Added

- **An installed app can send everything through a tunnel**: set your own SOCKS5 address (Tor on `127.0.0.1:9050`, say) as the tunnel under Privacy and data, then
  turn it on for an app on its card in Apps. Its connections, datagrams, shown pages and image loads leave through the tunnel, what the tunnel
  cannot carry is refused, and the app stops when the tunnel does. Its updates are not checked, and WebRTC is off, while it is on (ADR-0080).

## [0.0.4] - 2026-10-13

Pre-release, published 2026-10-13. [Release page](https://github.com/OrivonBrowser/orivon-mvp/releases/tag/v0.0.4).

### Changed for apps

- **`routed-app-asks-before-opening-a-website`**: an address Orivon loads itself (`ipfs://`, `ipns://`, `bzz://`, a `.eth` name) that a routed app's page opens is now asked about too, with *Directly* and *Cancel* only; and while a question from the app is open its other requests are cancelled unasked, so `window.open` returns `null` for them. An app must not wait on such a window or loop on a cancelled open. Recheck: any port a person may run through Tor that links to `ipfs://` or `.eth` pages.
- **`eth-name-shown-by-network`**: a `.eth` name is shown as `bzz://<name>` or `ipfs://<name>` from the moment its records resolve, on the loading screen and in the address bar, and as its plain origin (`https://<name>.eth`) until this install has learned which network it is on; it is never shown under a network it may not live on. The name's origin, grants and storage are unchanged, so an app needs no change. Do not read the address bar to learn which network an app came from: it can read `https://<name>.eth` on a first visit. Recheck: any port that opens by a `.eth` name.

### Added

- **`bzz://` addresses and `.eth` names on Swarm**: every chunk is checked against its address and a feed's update against its owner's signature.
  Chunks are read only from a Bee node on this machine, and this build configures none yet, so Swarm content opens only in tests.

### Changed

- **A gateway that stalls costs `ipfs://` and `.eth` pages less**: a block that one gateway is slow to send is asked of the
  next after about three times a typical answer (0.5 to 2 s), instead of after a flat 2 s.

## [0.0.3] - 2026-10-12

Pre-release, published 2026-10-12. [Release page](https://github.com/OrivonBrowser/orivon-mvp/releases/tag/v0.0.3).

### Changed for apps

- **`first-visit-loads-as-a-website-while-asking`** (replacing `first-visit-asks-before-any-file`), **`consent-question-holds-the-page`**, **`first-visit-enters-at-once`**, **`first-visit-pins-in-the-background`**, **`first-visit-background-mismatch-blocks`**, **`first-visit-deny-is-a-website`**, **`first-visit-blocks-a-file-that-differs-from-the-declaration`** and **`first-visit-bad-first-document-never-shows`**: a published app's page no longer waits for the person's answer. It loads at once as an ordinary website (the default session, no grants, no Node globals, no `orivon` grants) while Orivon asks and caches the app beside the question; Allow reloads the tab as the app with its grants, Deny leaves the website and stops the caching, and a file that differs from the declared tree stops the page with the security warning, even before any answer. An app must not assume its first load is the app: state written by that first load stays in the default session and does not reach the app. New rows: `first-visit-caches-beside-the-question`, `first-visit-deny-stops-caching`, `first-visit-bad-file-found-before-allow-stops-the-page`. Recheck: Ledger Wallet and every `ipfs://`/`.eth`/https port.
- **`first-visit-asks-before-any-file`**, **`first-visit-enters-at-once`**, **`first-visit-pins-in-the-background`**, **`first-visit-background-mismatch-blocks`**, **`first-visit-blocks-a-file-that-differs-from-the-declaration`**, **`first-visit-bad-first-document-never-shows`** and **`first-visit-unreadable-declaration-offers-retry`** (replacing `first-visit-verifies-before-entering`, `first-visit-blocks-files-that-differ-from-the-declaration` and `first-visit-download-failure-offers-retry`): a published app is no longer downloaded whole before it opens. Allow grants and opens the app at once; each file it loads is checked against the leaf of `/.well-known/orivon-ddoc.json` as it is served, and one that differs (or a bad first document) is never delivered, with every grant removed and a security warning shown; the rest of the bundle is pinned in the background and a later visit is served from the pin. Publish the declared tree to be checked, and list in `assets` every file the page loads: a file the manifest does not list answers 404 until the pin, as after it. An https app is served and checked the same way, and an app allowed but not yet pinned is served again, checked, after a restart. A republished name or a deployed site is followed to its new version, never blocked, and a block keeps what the app stored. New rows: `first-visit-follows-a-new-version`, `first-visit-resumes-after-a-restart`, `first-visit-service-worker-is-checked`, `first-visit-https-app-is-checked-as-it-is-served`. Recheck: Ledger Wallet and every `ipfs://`/`.eth`/https port.
- **`consent-question-holds-the-page`**, **`first-visit-asks-before-any-file`**, **`first-visit-verifies-before-entering`**, **`first-visit-deny-is-a-website`**, **`first-visit-blocks-files-that-differ-from-the-declaration`** and **`first-visit-download-failure-offers-retry`**: a published app's first visit now asks before any file comes down, downloads and checks the files before its page runs (never run before consent), and Deny opens a plain website with no `orivon`; files that differ from `/.well-known/orivon-ddoc.json` are never entered, and nothing is granted before the files are checked. An app that relied on its page running before the question, or on an install after Deny, must not. Publish the declared tree to be checked. Recheck: Ledger Wallet and every `ipfs://`/`.eth` port.
- **`process-is-node-shaped`**: an app's `process` and `os` now present as Node on Linux: `process.version` is `v24.11.1`, `versions` holds
  `node`, `process.browser` is gone, `platform` is `linux` and `arch` `x64` on every host (it was `''`, `{}`, `true`, `'browser'` and `'javascript'`). A
  library that detects Node takes its Node path; a port that compiled these values into its bundle can drop them. Recheck: webtorrent, rebuilt with its bridge that compiles in an Electron development run's `execPath`; without it upstream reads the app as a production install and starts its telemetry.
- **`scheme-link-offers-declared-apps`**, **`scheme-link-opens-in-chosen-app`**, **`scheme-link-held-until-the-app-listens`**, **`scheme-link-always-skips-the-question`**, **`scheme-link-malformed-is-refused`** and **`scheme-app-asks-to-be-default`**: new rows. An app that lists a scheme in `protocols` and holds a grant is offered when a page opens a link of it; it hears the link through `orivon.app.onOpenUrl` (or `app.on('open-url')` in the `electron` shim), and the `electron` shim's `app.on` now exists for `open-url` alone and throws `unimplemented` for any other event, where it read `undefined`. Apps that polled or bridged links by hand: use these. Recheck: webtorrent.
- **`contracts/app.ts`, `contracts/capability-api.ts`, `contracts/index.ts`, `contracts/manifest.ts`**: `orivon.app` gains `onOpenUrl`, `requestSchemeHandler` and `isSchemeHandler`, so a link of a scheme the manifest lists in `protocols` (first `magnet:`) can open in the app the person chooses. Nothing existing changes; an app that wants links declares the scheme and registers a listener. Recheck: webtorrent.
- **`fs-open-create-in-place`**: `fs.open` with `O_CREAT` and no `O_TRUNC`, `O_APPEND` or `O_EXCL` (`O_RDWR | O_CREAT`) now
  creates a missing file and keeps an existing one, where it failed `EINVAL`. Apps that opened such files by another
  route: open them directly. Recheck: webtorrent.
- **`file-calls-complete-beside-hung-dials`**: asynchronous `fs` calls queue in the shim under half the per-origin
  operation bound and socket dials under a quarter, so a program that writes at full speed or abandons many dials
  waits where Node would, and no longer meets `limit`. Apps that retried `limit` on files may drop it. Recheck: webtorrent.
- **`socket-destroy-abandons-dial`** and **`connect-signal-abandons-dial`**: `socket.destroy()` on a `net.Socket` that is
  still connecting now abandons its connection attempt at once, as in Node, and `orivon.net.connect` and `connectSecure`
  take a `signal` that does the same; the origin's in-flight slot is free at once instead of after the 30 s dial timeout.
  Apps that destroyed abandoned sockets and waited for the timeout need no change. Recheck: webtorrent.
- **`node-constants-and-exec-path`**: `require('constants')` resolves to Node's table (Linux values) and `process.execPath`
  is `''` rather than `undefined`. Apps that stubbed either for their bundle: remove the stub. Recheck: webtorrent.
- **`page-shows-own-files-by-url`**: an app that holds `fs` may point `<img>`, a CSS image, `<audio>` and `<video>` at
  `/orivon/app/<path>` (the virtual root `os.homedir()` and `app.getPath('userData')` name) and at
  `file:///orivon/app/<path>`, and the browser shows the file `orivon.fs` calls that path, which Electron allows and a web
  page did not; a path an app joined for its own page needs no change. For an app that holds `fs`, a file its own host
  serves under `/orivon/app/` is shadowed for images and media. `fetch` and `XMLHttpRequest` of the path are not served:
  use `orivon.fs`. Recheck: `webtorrent`.
- **`media-element-track-lists`**: an app's tab now gives every `<audio>` and `<video>` element the standard `audioTracks`
  and `videoTracks` lists, which Electron apps get from `enableBlinkFeatures: 'AudioVideoTracks'` in their window; an
  ordinary site's tab is unchanged. A player that guarded or polyfilled the lists: read them directly. Recheck: webtorrent.
- **`electron-clipboard-reads-the-pasted-text`**, **`electron-shell-open-external-opens-a-tab`** and
  **`window-open-external-address-asks`**: the `electron` shim's `clipboard.writeText`, `clipboard.readText` (the text of
  a paste in progress, `''` otherwise) and `shell.openExternal` now work instead of refusing, and a `window.open` of a
  `mailto:` or `magnet:` address asks the person instead of leaving a blank tab. Apps that bridged these by hand: use
  them directly. Recheck: webtorrent.
- **`page-media-from-own-listener`**: an app that holds a `tcp.listen` grant may point `<img>`, `<audio>` and `<video>`
  at `http://localhost:<port>`, `127.0.0.1` or `[::1]` when `<port>` is one its own listener holds, which Node and
  Electron allow and the page's policy refused; every other loopback port stays refused for images and media. Apps
  that run their own HTTP server for their player need no change. Recheck: `webtorrent`.
- **`url-parse-escapes-like-node`**: the legacy `url.parse` now percent-encodes a space, quotes, `<`, `>`, braces, the caret and
  the backtick after the host and turns backslashes before the query into slashes, as Node's does. Apps that escaped paths
  before `http.request` to avoid `ERR_UNESCAPED_CHARACTERS`: drop that. Recheck: webtorrent.
- **`page-sync-fs-writes-land`**: the page's `fs.mkdirSync`, `writeFileSync`, `copyFileSync`, `statSync`, `readdirSync`,
  `renameSync` and `rmSync` now work instead of throwing; `openSync` and its family still refuse on the page. Apps that
  worked around the refusal: use them directly. Recheck: webtorrent.
- **`contracts/capability-api.ts`**, **`contracts/net-options.ts`** and **`contracts/index.ts`**: `orivon.net.connect` and `orivon.net.connectSecure` take an optional `signal`
  (an `AbortSignal`); aborting it before the call settles abandons the dial and rejects with `'closed'`. Nothing changes
  for a call that passes none. Recheck: none.
- **`contracts/devices.ts`, `contracts/index.ts`, `contracts/manifest.ts`, `contracts/limits.ts`**: new capability kind `devices.hid`
  (declare `"devices": { "hid": [{ "vendorId": 11415 }] }`, at most `LIMITS.hidFilters` filters); an app then uses
  `navigator.hid`. Each device is still asked. Recheck: hardware-wallet ports (Ledger).

### Added

- **A link of a scheme an app lists opens in the app you choose**: a `magnet:` click or `window.open` asks which app should open it
  (an app that lists the scheme and holds a grant, or your system's app), "Always use the app I pick" makes it the default, and the
  app's page receives the link. Settings, under Apps, lists the default with Stop. An app can ask to be the default from a click,
  and the `electron` shim's `app.setAsDefaultProtocolClient` and `app.on('open-url')` work (ADR-0072). Links from other programs
  and `.torrent` files are not routed yet.
- **USB HID devices for apps and websites** (`devices.hid`): an app that declares the vendors it talks to uses `navigator.hid`, and the
  person approves each device, in a chooser or in a question in the tab; a website gets the chooser. Approved devices are listed in
  Settings with Forget, and "USB and HID devices" joins the site settings. WebUSB and Web Serial stay refused (ADR-0068).
- **Docs: a features list and a roadmap** replace the scope page and the build plan; the README leads with a browser built for owning and a platform for apps Chrome cannot run.

### Changed

- **Telemetry is asked in a popup after "Enter Orivon"**: the welcome screen is back to its single button, and the popup
  "Support us for free through telemetry" sits over the browser, blurred behind it, with equal "Accept" and "Deny" buttons.
- **The welcome screen's default-browser box is gone**: the default-browser question now first comes half a minute into first use, then weekly.

## [0.0.2] - 2026-10-07

Pre-release, published 2026-10-07. [Release page](https://github.com/OrivonBrowser/orivon-mvp/releases/tag/v0.0.2).

### Added

- **A new profile starts with something in it**: five bookmarks in the bar, uBlock Origin installed and pinned to the toolbar, the Extensions
  button shown, and "Orivon Featured" (Explore, The Lounge, FreeTube, ASGARDEX, Element) on the new tab in place of the Torrent and Nostr tiles. The Web3 Score
  provider is now `ipfs://attila.orivonstack.eth/score` for a profile that never chose one. Removing a bookmark or uBlock Origin is never undone.
- **Report a problem** (menu, `Alt+Shift+I`, a crashed tab's Report button, or the bar after Orivon closed unexpectedly): a form
  for a description, with the recorded crash, technical details and recent log attached and shown in full before Send; a crash dump
  only if ticked. Nothing leaves without Send. Orivon now keeps a log, crash records and local crash dumps in the profile.
- **Telemetry, chosen on the welcome and switched in Settings**: two equal buttons, neither preselected; when shared, a monthly
  count of use split into Web3, Web2.5 and Web2 time goes to `telemetry.orivonstack.com`, with public Web3 and Web2.5 sites in a
  separate unlinked report. Never in a development build or a private window; [`docs/privacy/notice.md`](docs/privacy/notice.md) says all.

### Changed

- **A run from source is a program of its own**: it keeps its data in `orivon-source` with its own lock and dock icon, beside an
  installed package now named "Orivon Browser". Its profile starts empty (`docs/development/setup.md` says how to bring data across).
- **Global Privacy Control is on by default**, and every site sees it both as `Sec-GPC: 1` and as `navigator.globalPrivacyControl`
  in pages, frames and workers of every session; turning it off makes the property `false`. A change applies at the next start.

## [0.0.1] - 2026-10-06

Pre-release, published 2026-10-06. [Release page](https://github.com/OrivonBrowser/orivon-mvp/releases/tag/v0.0.1). Everything that landed before the first pre-release.

### Changed for apps

- **`ipfs-url-opens`**: an `ipns://` key now opens the site its signed record names, as an `ipns://` DNSLink name
  already did; nothing changes for apps already published. Apps that keep grants across releases may ship under a key.
  Recheck: none.
- **`contracts/manifest.ts`**: a manifest may carry `domain`, the one ENS name or DNS host the app calls home; a
  malformed value rejects the manifest and absence is allowed. Apps published under a name set `domain` to that name,
  as a lower-case host with no scheme, port or path. Recheck: every port.
- **`contracts/manifest.ts`**: an app may now declare `media.screen` in `capabilities.media`; nothing changes for
  existing apps. See `app-screen-declared-shows-the-picker` below.
- **`app-media-declared-is-asked-once`, `app-media-undeclared-is-refused`**: `media: { camera: true, microphone: true }`
  in the manifest now works. A declared kind is asked once, in the tab's panel, at the first `getUserMedia`; an
  undeclared one is refused with no question, as before. Apps that record or call: declare it. Recheck: Element.
- **`app-screen-declared-shows-the-picker`, `app-screen-undeclared-is-refused`, `electron-desktop-capturer-serves-the-picked-source`**:
  a declared `media.screen` is asked once, then Orivon's picker opens; the `electron` shim's `desktopCapturer.getSources`
  returns the one source chosen and its `chromeMediaSource: 'desktop'` call takes it once. Apps that list every screen: use that. Recheck: Element.

### Added

- **"Orivon (source)" in the Linux dock** (`node scripts/launch-from-source.mjs install`), with New Window and New Private Window:
  a click with Orivon open reaches it at once; only a start with nothing open builds first. With it installed, a Linux
  run from source can be made the default browser from Settings.
- **Open a file from this computer**: by a typed path or `file:` address, `Ctrl+O`, a second start's command line or Open with, in a
  persistent session of its own. A file that links a manifest is asked about once per run, in a warning whose Allow needs two presses, and
  may then use `window.orivon`, its grants and data kept with its exact path (ADR-0060). The packages claim HTML, XHTML, SVG and PDF.
- **Screen sharing**: a page's `getDisplayMedia` opens Orivon's picker (a tab, a window or the entire screen, with tab
  audio), the tab and the shared tab show it, a bar offers Stop sharing, and a site can be blocked. Only the call
  Orivon's preload makes after the pick is granted, so the legacy `chromeMediaSource` capture is refused (ADR-0055).
- **A registered app's camera, microphone and screen**: `media.camera`, `media.microphone` and `media.screen` are read
  from the manifest, offered at consent, asked before first use and refused when undeclared; the `electron` shim's
  `desktopCapturer.getSources` returns the source the person picked.
  existing apps, and it is not yet granted (the implementation follows).
- **`contracts/trust.ts`, `contracts/manifest.ts`, `contracts/capability-api.ts`**: new capability kind `trust.score`
- **`contracts/trust.ts`, `contracts/manifest.ts`, `contracts/capability-api.ts`, `contracts/index.ts`**: new capability kind `trust.score`
  (declare `"trust": { "score": true }`) and `orivon.trust.websiteScore(address)`, which answers with the Web3 Score
  provider the person chose and the level it judged for that content. Apps that show a mark per site may declare it
  and must treat a `null` level, a `denied` rejection and a `limit` rejection as "use what you ship". Recheck: none; no
  port declares it yet.
- **The shell's own pages load from `orivon-shell:`, not `file:`**, and Electron's file-protocol fuse is off in a package
  and, after `npm install` or `npm run install:electron`, in a Linux checkout's binary: a `file:` page gets no more reach
  than a web page. A website cannot load, frame or navigate to a page of the shell. A copied tab, or one that becomes an
  app, no longer keeps the new-tab page behind it.
- **A `<name>.eth.limo` or `<name>.eth.link` address opens as `<name>.eth`**, checked on this computer, with its path, query and
  fragment kept; Settings > Web3 turns it off. Data a site keeps under its gateway address stays there and is not seen at
  the `.eth` name.
- **An installed app at a name moves to new content only when you accept.** Orivon notices a moved name on a visit and in
  an open tab, fetches only the new manifest, and asks "switch to the new version?" when a Web3 Score provider has judged
  it; otherwise it says why and the key icon offers Trust & Force update. The version you run keeps running meanwhile.
- **A manifest `domain` field** names the one ENS name or DNS host an app calls home. A provider's judged level shows
  only at that name; elsewhere the page shows the observed level and says why, and the install question names the home.
- **Default browser, asked properly**: Settings > Default browser, an unticked box on the welcome screen and a question
  a week after the last ask (in the default profile, "Don't ask again" from the third week). Only an installed package
  registers; a source run and an AppImage say why not. Windows and macOS packaging is written and unbuilt.
- **New Window and New Private Window** from the dock, the taskbar and the installed entry's menu, and a second start of
  a running browser with no address (or `--new-window`, `--new-private-window`) now opens a window or a private session.
- **An extension's side panel** (`chrome.sidePanel`): its page is listed in the panel's view picker, opens from its toolbar
  button, its `_execute_side_panel` key or `open()` after the person's input, and follows the tab in front.
- **Packages for Linux, Windows and macOS on every GitHub release**: a deb and an AppImage, a Windows installer and a dmg each
  for Apple silicon and Intel, each launched by CI before it is attached. Windows and macOS packages are not signed with a
  bought certificate, so the system asks once before the first run.
- **Every release is on IPFS** as one folder, `ipfs://<cid>` in its description, pinned by the Orivon node with the two
  before it; anyone can reproduce the CID and pin it.
- **A manifest `domain` field** names the one ENS name or DNS host an app calls home; the loader parses it
  (ADR-0056). Update behaviour that uses it lands with the app-update work.
- **A page can ask the Web3 Score provider the person chose** (`orivon.trust.websiteScore`, behind a declared `trust.score`
  grant): the provider's name and the level it judged for an `ipfs://` address or a `.eth` name, from caches and a verifier
  partition of the page's own, limited to 128 lookups refilling at 2 a second.
- **`test/` is ordered by area**, with a Layout table in `test/README.md`; a spec left at its top, a folder with no
  row and a dead `test/` path in any tracked file now fail CI, and a new capability kind needs a catalogue line.
- **An app-behaviour catalogue** names what a working app relies on, one row each, and each row is proven by an
  end-to-end spec whose test is titled with the row's id, so a change that breaks an app fails a test that says which.
- **`npm run perf:probe`** measures each process's CPU and memory through fixed scenes, to compare a change before and after.
- **Profiles with no Web3 Score provider saved read Orivon's own** (Settings > Web3), existing ones too: a field cleared before
  this change was never saved, so set it empty again to ask nobody. A provider a person saved keeps.
- **Web3 Score providers** (Settings > Web3): judged Levels 3 and 4, with a site's operations and connections, from any
  address Orivon opens, asked by hash bucket so a request names a group of sites, not the site. Build one with web3-score-manager.
- **Tabs can be grouped**: name and colour a group from the tab menu, collapse it to one chip, drag it, move it to its own
  window, and get it back after a restart; a link opened from a member opens inside the group.
- **Idle tabs go to sleep** (Settings > Performance): after 30 minutes by default, and sooner when the computer is low on memory, a tab frees its page and wakes
  where it was when you open it; sound, pinned, typed-in and prompt-waiting tabs stay awake, and an energy saver sleeps sooner on battery.
- **Reader view** (F9, the book button in the address bar): an article opens in its own tab with your font, size, width and
  colours, and can be read aloud with the system's voices.
- **A side panel** (Ctrl+Alt+B) beside the page, on the right or the left, resizable, lists bookmarks, history and downloads.
- **F6 steps through the address bar, toolbar, tabs, bookmarks bar, side panel and page**; the toolbar and tab strip take
  arrow keys, and every control shows a focus ring.
- **Caret browsing** (F7, Settings > Accessibility) moves a text cursor through any page, asking first by default.
- **A website asks once for the camera, microphone, location, clipboard, MIDI, idle detection, window placement and
  notifications**, in a prompt under the address bar; the answer is remembered and changes from the address bar chip,
  the site's popover or Settings > Site settings. Location is asked, but no position is ever delivered.
- **Pop-ups are blocked unless you clicked**, with a chip that lists them; JavaScript, images and sound can be switched
  off per site or for every site, and a second download a page starts on its own waits for your answer.
- **Orivon keeps your passwords** (Settings > Passwords): it offers to save after a sign-in that worked, fills the account
  you pick, makes a strong password for sign-up forms, and imports and exports CSV. It needs the system keyring.
- **Privacy settings**: block third-party cookies, send Do Not Track and Global Privacy Control, always use secure
  connections (a sheet when the upgrade fails), and secure DNS with Cloudflare or Quad9.
- **Sign-in sheets, a certificate viewer and a client-certificate chooser**: a site's HTTP sign-in asks in a sheet over
  the page, a certificate opens from site info, and a page that fails on its certificate shows why, with only Go back.
- **See and delete a site's cookies** (names, never values) from site info or Settings > Privacy, which also lists every
  site that stores data; Ctrl+Shift+Delete opens Clear browsing data, which can include site settings.
- **Orivon can be your default browser** from a packaged install (Settings > About), opens links other programs hand it
  on macOS, shares a page by link, email or QR code, creates a desktop shortcut for a site, and links to a new release.
- **Downloads have a page, a toolbar button and a bubble** (Ctrl+J): files save into the Downloads folder or the one
  you choose, or ask each time; pause, resume, cancel and retry; a ring shows progress and a new download peeks.
- **A file that runs code waits for your answer**: it sits as `Unconfirmed ... .download` until you press Keep or Discard,
  and Orivon never opens it for you.
- **Bookmarks have folders**, a bar with a menu for each and drag to reorder, a manager (Ctrl+Shift+O), an edit bubble
  on the star, Bookmark all tabs (Ctrl+Shift+D) and HTML import and export; an older flat file is carried over.
- **The address bar suggests as you type** from history, bookmarks and open tabs, finishes the text inline, searches
  after a `?` or a site keyword (`w cats`), hides `https://` and `www.`, marks insecure pages, and makes a QR code.
- **The search engine's own suggestions are available, off by default** (Settings > Search); a private window never
  asks for them.
- **History shows site icons**, groups by day or by session, sorts by recency, visits or name, selects many rows, and
  lists the recently closed tabs.
- **Import bookmarks and history from Chrome, Chromium, Edge, Brave or Firefox**, or bookmarks from an HTML file, at
  `orivon://import`; passwords are not imported.
- **About and a task manager** (`orivon://about`, `orivon://tasks`, Shift+Esc), `about:` and `chrome://` names typed in
  the bar, typed `view-source:`, and a JavaScript console shortcut (Ctrl+Shift+J).
- **`better-sqlite3` runs on the Node shim**: an adapter over `node:sqlite` with `Database`, `Statement` (`run`, `get`, `all`, `iterate`,
  `pluck`, `raw`, `expand`, `bind`, `safeIntegers`), `pragma`, `transaction` with its variants and `SqliteError`; the esbuild plugin
  points the package name at it. `function`, `aggregate`, `table`, `backup`, `serialize` and `loadExtension` refuse by name.
- **A program that starts with a burst of file calls no longer fails on the first one past the limit**: a synchronous `fs` call
  that the per-origin limiter refuses is asked again with a growing pause, and a WebAssembly program's file call is retried for
  about five seconds before it sees `EMFILE`.
- **An asynchronous file call the limiter refuses is asked again too** (`fs.promises`, `readFile`, `writeFile`), and so is `readFileSync`
  in a Worker, for about five seconds before the call fails, so an app that loads its data files beside another program doing the same does not see the limit as an error.
- **A spawned program is given the app's files under their own path as well as `/`**, so a path the app holds
  (`/orivon/app/...`) means the same file to the program.
- **A wildcard host pairs with a port in `tcp.connect` and `https.connect`**: `*:6697` and `*:6660-6699` are declarable, so an
  app that dials a server the person types reaches a reserved port by naming it. `*:*` and ranges still skip reserved ports, and
  the prompt names the ports a wildcard pattern opens and what each is for, and every named pattern the wildcard does not cover; a
  granted `*` covers public hosts only, so naming a local address under it asks again; `udp.send` keeps `*:*` only.
- **Tabs can be pinned, muted and duplicated**, and show when a page is playing sound; Close other tabs and Close tabs
  to the right keep pinned ones. A long strip scrolls and keeps the tab in front in view.
- **A closed tab or window comes back with Ctrl+Shift+T**, in its place and with its history; the main menu names what
  would return.
- **Orivon can start where it left off, or on pages you list** (Settings, On start-up); after a crash a bar offers the
  last session back. The first window opens where the last one was.
- **A Home button and a home page**, addresses on the command line opening as tabs, Keep window on top, and
  `--orivon-kiosk` for one full-screen page that can only be left by quitting.
- **Find in page** (Ctrl+F) with a live count and match case; the reload button is Stop while a page loads, and so is
  Escape.
- **Right-click menus for links, images, video, selected text, text fields and pages**, with spelling suggestions and
  Paste and Go in the address bar.
- **Print, Save as PDF, Save page as, View page source, screenshots (visible area or the whole page) and Picture in
  picture**, each reporting in a toast; a PDF opens in a tab.
- **Tab search** (Ctrl+Shift+A) lists every open tab of every window and the recently closed ones, filtered as you type.
- **A tab whose page crashed or stopped answering shows a card with Reload**, and a warning mark on the strip.
- **A forked child behaves as a Node child does**: it ends when nothing listens on its IPC channel, `setTimeout` and friends
  return Node's objects (`unref`, `refresh`), `process.versions.node` is set, a taken port is `EADDRINUSE`, a bundled
  `require('assert')` is the function, and `fs.Stats` reports the modes of an app-private store. The Lounge's server runs on it.
- **A Node web server's stack runs on the shim**: real `express` and `socket.io` on `http.createServer`, `fs.watch`, a run-time
  CommonJS `require` (also a forked child's global one), the full `fs.Stats`, `chmod`, and `tty`, `readline`, `http2`,
  `diagnostics_channel`, `async_hooks`, `perf_hooks`, `console` (with its `Console` class) and `process` modules; a fork's `console`
  is a `Console` over its `process.stdout` and `process.stderr`, and `require('process')` is the global itself.
- **An esbuild plugin for ports** (`src/shim/bundler/`): maps every Node builtin to the shim under `platform: 'node'`, fails the
  build on a builtin it lacks, serves `node:sqlite` with its browser engine, and loads from another repository.
- **`node:sqlite` in the Node shim**: `DatabaseSync` and `StatementSync` over the SQLite WebAssembly build, with a database file in
  the app's files (a rollback journal, page-level writes) in a forked child or thread of a cross-origin isolated app, and
  `:memory:` everywhere. A commit reaches the file at the end of its transaction, `synchronous=off` included. Function, aggregate,
  session, extension and backup members refuse by name.
- **The compatibility matrix covers everything a ported app can need**, in readable tables, one row per topic:
  what works, what does not, and what the app sees at the gap. Every Node builtin, `electron` export, `orivon.*`
  member, permission and protocol is also listed one by one, checked against the code, in `docs/planning/compatibility/`.
- **An app can show pages it serves itself**, each at an origin of its own, beside ordinary websites: a
  `web.embed` local pattern (`http://*.localhost:<port>`), admitted only while the app holds a listener on
  that port (ADR-0047).
- **An app hears of a shown page's new window and download** (`orivon-popup`, `orivon-download` on the
  `<webview>`); nothing opens and no file is kept. A shown page's link to another program is never offered to it.
- **A listener can be loopback only.** `orivon.net.listen` and `udpBind` honour `scope`; `'local'`, the
  default, binds `127.0.0.1`, and the shim maps a loopback host onto it (ADR-0034).
- **`http.createServer` in the Node shim**, with `Server`, `ServerResponse` and `OutgoingMessage`, over
  `orivon.net.listen`; `https.createServer` still refuses.
- **Content blockers.** MV3 blockers such as uBlock Origin Lite block ads and trackers: Orivon applies their
  `declarativeNetRequest` rules itself, with Firefox's matcher, and shows each one's per-tab count on its badge.
- **Full uBlock Origin blocks**: Orivon serves extensions' `chrome.webRequest` listeners itself, blocking ones included
  for MV2 extensions, so blockers built on it cancel, redirect and rewrite requests as in Chrome.
- **Chrome extensions.** Install from the Chrome Web Store, a `.crx`/`.zip` file or a folder, and manage them at
  `orivon://extensions`, which always says who updates each one. Content scripts, service workers, toolbar buttons,
  popups and options pages work on every website and on apps holding permissions, whose `window.orivon` refuses extension code.
- **An Extensions button lists every extension**: its badge, a pin that puts its icon on the toolbar (a new one is pinned),
  options, Manage and a two-click Remove. It shows while an extension is loaded unless Appearance says otherwise, and
  an unpinned extension runs from its row.
- **An extension asks for more access in a sheet**: nothing is granted until you press Allow, the install prompt says
  what it may later ask for, grants last across restarts, and each can be taken back from its details page.
- **Each extension has a details page** (`orivon://extensions/details`) with its source, who updates it, where it runs,
  what Orivon does not provide and the extra access you allowed.
- **Extension keyboard shortcuts work**: a command binds its suggested key when it is free, never takes one Orivon uses, and
  can be changed, cleared or moved at `orivon://extensions/shortcuts`.
- **Extensions can use bookmarks, history, top sites and search** (`chrome.bookmarks`, `history`, `topSites`, `search`);
  they cannot save a script address as a bookmark, and an app's pages never reach them.
- **An extension's DevTools panel works**: a manifest's `devtools_page` runs and `chrome.devtools.panels.create` answers.
- **Google's sign-in pages are shown a Firefox identity**, since Google rejects this browser as "not secure"; the
  request headers, `navigator.userAgent` and the missing `navigator.userAgentData` agree on `accounts.google.com`
  and `accounts.youtube.com` alone. Not yet confirmed against a real account.
- **A failed e2e spec leaves its evidence** in `qa-artifacts/latest/`: a screenshot per shown view, the console,
  page errors, failed requests, crashes and the main log. `npm run qa` adds layout-audited, baseline-compared
  shell states, a restart journey and adversarial specs; CI uploads the evidence on a red e2e job.
- **An app's child processes outlive the tab that started them** while another tab of the app is open,
  and end with its last page: they run in a hidden host of the app's own, with the app's grants
  (ADR-0046).
- **`worker_threads.Worker` runs a thread** in a Web Worker, with `parentPort`, `workerData`,
  message ports and `terminate()`, from the page or from a forked child.
- **A forked child or thread of a cross-origin isolated app can call every `fs` `*Sync` method**
  and `spawnSync`/`execSync`/`execFileSync`; the page keeps `readFileSync` and `existsSync`.
- **A CommonJS `require()` of a Node module the shim lacks a member of names the gap** when called,
  instead of `undefined is not a function`.
- **Extensions that capture a tab's audio work**, Volume Master among them: `chrome.offscreen`, `chrome.tabCapture`
  and `chrome.runtime.getContexts`. A capture needs the extension's toolbar button on that tab, and the tab is
  heard only through the extension while captured.
- **A middle click or ctrl+click opens a link in a background tab**, and a shift+click opens it in a new window,
  a private one from a private window.
- **Settings, History and Profiles update live** when a permission, a visit, cleared data or a profile changes
  anywhere, in any window or profile.
- **Tearing a tab off shows where its window will open.** A preview of the page follows the pointer; letting go
  over the page or outside every window opens the window there, in front and at once. Over another window's
  strip a line marks where the tab will land. On Linux X11 a middle click on the strip's empty end opens a tab.
- **Settings and History have a new look**, shared with Profiles and Private: Settings' sections are grouped
  in a sidebar with icons and its search; History marks each site and heads each day with a rule.
- **Chrome extensions.** Install from the Chrome Web Store, a `.crx`/`.zip` or a folder; `orivon://extensions` says who
  updates each one. Content scripts, workers, toolbar buttons, popups and options pages work on every website and on
  apps holding permissions, whose `window.orivon` refuses extension code; blocking rules come next.
- **`worker_threads` and `vm` import**: `worker_threads` answers as Node's main thread does, and
  `vm` runs code in the page's own context; starting a thread, or a context of its own, refuses
  by name.
- **A `.eth` name is shown as `ipfs://<name>`** wherever an address or origin is shown; typing or
  linking either `ipfs://<name>` or `ipns://<name>` opens the name's own, unchanged origin
  (ADR-0038).
- **A spawned program can open sockets**: `spawn` runs a WASI 0.2 component from the jco output
  shipped beside it, its files and sockets reaching `orivon.fs` and `orivon.net` under the app's
  grants (ADR-0040). A Rust program built for `wasm32-wasip2` runs, whether it blocks on `std::net`
  or runs tokio.
- **A Settings page, and the browser features a person lives in.** `orivon://settings` has a section for
  everything Orivon implements: appearance (theme, bookmarks bar, page zoom), search, tabs and windows,
  profiles, privacy and data, the apps that hold permissions, the Ethereum light client, remappable
  keyboard shortcuts, developer tools, and About. It searches, links to each section, marks what differs
  from the default and applies a change at once. The browser gained a main menu, keyboard shortcuts for
  everything it does (each can be changed, swapped, cleared or restored), zoom kept for each site, a
  history that stays on this computer (`orivon://history`, searchable, kept 90 days by default, with
  Clear browsing data), and developer tools on any page with F12, which ask once before opening on an app
  that holds permissions.
- **Tabs move, and two can share a window.** Tabs reorder by dragging or with Ctrl+Shift+PageUp and
  PageDown, go to another window or a window of their own from their menu or by being dragged out, and keep
  the page as it was. Two tabs can be shown side by side or stacked, made by dragging a tab to a page edge,
  from a tab's menu or "Open Link in Split View", with a divider that resizes and a pane that follows the
  click.
- **Profiles and private windows.** A profile is a separate browser with its own bookmarks, history,
  permissions and apps, made and managed at `orivon://profiles`; each runs as a process of its own, and a
  second start of one already open hands over to it. A private window (Ctrl+Shift+N) starts empty on a
  directory of its own, keeps no history, statistics or identity, asks for every permission again and is
  deleted when its last window closes. `ADR-0042`.
- **A native addon reaches the app's files from a forked child** of a cross-origin isolated app,
  each call blocking on the page's `orivon.fs`; that child's `fs.readFileSync` works too
  (ADR-0040).
- **A native addon loads as its WebAssembly build**: `process.dlopen` and `createRequire` take
  the `.node` path and load the build beside it through Node-API for WebAssembly; the `.node`
  machine code never runs (ADR-0040).
- **`child_process` works for ported apps**, every child in a Web Worker: `spawn`/`exec` run a
  WASI program from the app's bundle and `fork` an app module with IPC, both under the app's
  grants; a native program refuses by name (ADR-0040).
- **A WASI program runs inside an app's tab** through Node's `wasi` module, its every file call an
  `orivon.fs` call under the app's grant; native modules and child processes will come as
  WebAssembly too, never as machine code (ADR-0040).
- **An app can show a website inside its own page** (`web.embed`, ADR-0039), each shown page
  sandboxed in the app's own session; a manifest can also ask for cross-origin isolation, which
  turns on `SharedArrayBuffer` for WebAssembly threads.
- **A welcome screen on first launch**, and its picture behind the new-tab page. Nothing loads
  from the network.
- **`ipfs://` and `ipns://` addresses load, shown as themselves**, with every block checked;
  protocols register through one function in `src/protocols/` (ADR-0038).
- **`.eth` names load, with every byte checked on this machine**: a light client proves the name,
  IPFS blocks are hashed against their CID (ADR-0030, ADR-0031).
- **The identity seed survives a restart** in the OS keyring, and a granted app can encrypt its
  own secrets with `orivon.secrets`.
- **The Web3 Score shield shows the site's Website level**, coloured by level, with a Web2 /
  Web2.5 / Web3 mark; the Web3 Score page leads with the same level.
- **A site can publish its bundle hash tree (DDOC)**, and the Web3 Score page shows whether it
  matches; a local origin serving one is Level 2 in developer mode.
- **A Website Level 4 site's grants are shown without warnings** on every consent surface
  (ADR-0037), and every permission row carries an icon for what it grants.
- **A per-site permissions popover** in the address bar: one switch per capability, and the
  site's storage.
- **App tabs route `fetch()`, `XMLHttpRequest`, `EventSource` and WebSocket to granted hosts**,
  under the broker's grant and local-network checks.
- **Installed apps can compile WebAssembly and use `eval`**, and load `data:` and `blob:`
  resources.
- **Fullscreen, pointer lock and keyboard lock from a click**; Escape always gives the window
  back (ADR-0025, ADR-0026).
- **External links and site notifications ask the person first** (ADR-0027, ADR-0028).
- **`window.open()` returns a real window**; a page guarding unsaved work asks Leave or Stay;
  right-click works; tabs identify as Chrome.
- **The Node shim covers much more of Node**: more modules, one virtual root, closing `fs`
  streams, Node's error shapes, and a `Buffer` global in app tabs.
- **Ported apps reach self-signed and private-CA TLS servers**; turning verification off never
  widens what a grant reaches.
- **A manifest with unknown top-level fields installs**, with a warning; `web.context`'s
  `evaluate` takes a per-call timeout.
- **A global Orivon installs on an app's window can be replaced by the app** (ADR-0021), and
  `check:page-globals` enforces it.
- **An app tab that dies on load says so** in the shell's own output.
- **The capability broker** (build step 2): grants that survive a restart, per-origin
  enforcement, per-app `session` partitions, TCP, TLS, UDP, fs and name resolution.
- **`orivon-node-shim`** (build step 3): `net`, `dgram`, `fs`, `dns.lookup`, `http` and `https`
  in Node's shapes over the capabilities.
- **The app loader** (build step 4): a discovery hint, a hash-pinned cache, one consent dialog
  before the app's code runs, and a CSP narrowed to what was granted.
- **The browser shell** (build step 1): tabs, toolbar, address bar with DuckDuckGo search, and
  two preloads at two privilege levels.
- **`src/contracts/`**: the complete `orivon.*` interface as types, the durable asset (ADR-0002).
- **The subsystem registry, the parallel-work system and the human entry path**: README,
  ARCHITECTURE, CONTRIBUTING and a README in every directory.
- **AGPL-3.0-only licence.**
- **`npm run dev` starts on a fresh profile every launch** and deletes it at the end, so it behaves as a first run and runs
  beside an open Orivon; `npm start` keeps your real profile. `npm run dev -- --user-data-dir=<dir>` keeps one across launches.

### Changed

- **A new window opens at once**, from the New window button, `Ctrl+N` or the dock, as a torn-off tab does; a start
  of an open profile from the dock or a command line hands over in about half the time.
- **An extension added from now on is not put on the toolbar**; "Pin new extensions to the toolbar" (Settings > Apps) turns it back on.

### Fixed

- **A run from source keeps the sign-ins an installed package made**: its binary encrypts cookies as a package's does
  (`npm run install:electron`, and the source launcher on a cold start), so cookies in the profile they share are readable by both.
- **An `ipns://` key opens, in a tab and as the Web3 Score provider**: its record was asked of one gateway at a time,
  and one that hangs held the lookup past the 25 s a name may take. Sources are now raced, and a gateway that hangs
  cools down, so the default provider loads in about 5 s instead of failing.
- **A second click on the side panel's view picker closes its list**: the list lost the focus to the button, closed, and the
  click opened it again.
- **The first letter typed into the address bar is no longer lost**: the dropdown's page joins the window once loaded, and
  a window refocus no longer selects the text. A new tab starts with the keyboard in the bar; the first click selects the
  address and a first press that drags keeps its range.
- **A tab on an `ipfs://` or `.eth` page shows the page's icon on a slow connection**: the icon was fetched with a 5 s budget
  and the globe stayed for good when the gateways took longer; icons on those hosts now get 60 s.
- **Installing from the Chrome Web Store page no longer takes the browser down**: the store page keeps its own store API
  through every extension load, and a private window's store page refuses installs.
- **An extension's popup opens inside the window**, under its toolbar button or the Extensions button, at the size of its page;
  after it opens a tab it stays until the next click elsewhere, and one opened while the page behind it is still
  navigating stays through that page's commit.
- **Three ways the whole browser could quit are closed**: an app's helper page failing to load, a light-client
  checkpoint the disk refuses to keep, and a profile file holding `null`.
- **The light client switch applies at the next start, as Settings says**: switching it mid-run no longer changes the
  status line at once while `.eth` pages keep verifying, nor takes effect when the verifier next wakes.
- **Restart Orivon no longer reopens the page Orivon was started with**, and Email link says so when no mail program
  opens.
- **Looking for updates works once a day as it says**: a check made offline is tried again at the next start, the
  setting applies when switched on, and a browser left open checks again the next day.
- **A private session no longer renews the light client's checkpoint on its own**, so it reaches no Ethereum server
  unless a `.eth` name is opened; an installed `.eth` app served from its pin no longer keeps the verifier running.
- **Picture in picture finds a video inside a page's own element**, from the menu and from a right-click; a QR code
  is not offered for an address too long to carry, and a screenshot whose save dialog fails says so.
- **A closed reader view reopens on its article's page**: Reopen and a restored session bring back the page it was
  read from, not an empty reader.
- **Closing the tab in front leaves a collapsed group collapsed**: the nearest tab still shown comes to the front,
  when a tab closes or the front tab goes to sleep.
- **Closing the last tab keeps it for next time**: the session file holds that tab, not an empty window; on macOS the
  last window closed can be reopened once another window opens.
- **Sleeping tabs act like tabs**: the tab menu's Reload wakes one, Duplicate copies the pages behind it, and moving
  a group to a new window wakes only the tab put in front, the one that was in front before.
- **Dragging a tab out no longer leaves a process behind**: the floating preview's page closes with the drag, and closed
  tabs and windows are no longer kept in memory by the tab-visibility reports.
- **A second crash keeps the first one's windows**: windows still waiting to be restored stay in the session file until
  they are restored or the browser quits.
- **Two local servers keep their own tab icons**: an icon is kept under the host and its port, not the host alone.
- **Site rules and saves act on the right thing**: Save image or link as is never held as a page-started download, a
  CDN stylesheet's images follow the page's Images setting, and clearing site data also clears what sites cached.
- **Removing an extension forgets what it stored**: its `chrome.storage` and its pages' localStorage and IndexedDB are emptied, so
  installing it again, even in the same session, starts clean.
- **A permission you allow an extension with a background page applies without waiting for a restart**, and taking a permission
  back reloads the extension's open tabs instead of leaving them without its APIs.
- **An extension's right-click items show on pages**: what `chrome.contextMenus` adds (a translator, a block-element tool) is in
  the page's right-click menu, not only the toolbar icon's; Options focuses the options tab that is already open.
- **Extension popups and notifications behave with several windows and events**: a link opened from a popup, and
  `chrome.search.query`, use the popup's own window; two notifications without ids no longer replace each other.
- **A new version starts from the rulesets its manifest enables**, and an extension update keeps its install date, so a shortcut
  two extensions both suggest does not move to the other one.
- **Two windows keep their own tabs apart for extensions**: `tabs.query({ currentWindow: true })` and each toolbar icon use the
  window they belong to, a tab opened in the background does not become the active tab, a tab moved to another window keeps
  its window id and badge, a page coming back into a window is its active tab again, and a tab an extension closes is reported once.
- **Updating or reloading a disabled extension keeps it disabled**: "Update", Developer mode's "Reload" and a newer `.crx` or `.zip`
  write the new version and leave the extension switched off, as it was set.
- **Extension events can be unsubscribed**: removing a `chrome.tabs`, `windows` or `webNavigation` listener really stops it,
  repeated removals no longer silence the extension's other listeners, and `hasListener` answers instead of throwing.
- **A failed save of an update check no longer quits the browser**: a store extension's check result that cannot be written is logged.
- **A page's prompt() gets what was typed**: an `undefined` default is empty, a long answer or default comes back whole,
  and an app's child process start fails with an error instead of waiting for ever when its host is refused.
- **Popups and questions behave**: Enter right after typing in a page's prompt() answers it, F7 works again after its
  question was left in another tab, prompts follow the address bar on resize, and text boxes in popups have Cut/Copy/Paste.
- **Data the browser keeps stays kept**: the identity seed is saved on a fresh profile, clearing history clears Recently closed,
  a failed save is retried, re-importing adds no duplicate bookmarks, and an early star is not lost at start-up.
- **The browser's own pages keep up**: removing the default search engine gives the built-in default back, Clear data
  empties the site-data list, History and Import notice history turned on, and Profiles and Extensions keep the keyboard.
- **The keyboard goes to the page after Enter or Escape in the address bar**, a tab switch with the bar focused shows that
  tab's address, and "Leave" in a page's leave question runs Ctrl+Shift+R and the page menu's Back and Forward again.
- **The address bar opens what is an address and searches what is not**: `münchen.de`, `nas:5000`, `LOCALHOST:3000` and
  `[::1]:8080/api` open; `python3.12` and `3.14` are searched (no blank page, no IP address); `git ` with a space completes nothing.
- **A slow click on the downloads, tab search, extensions or address-bar chip buttons closes their popup**, as on the
  main menu, instead of closing it on the press and opening it again on release.
- **A page that fails to load says so**: a sheet over the tab names why (no such server, refused, offline, blocked),
  with the address, the error's name and Try again, instead of an empty white page.
- **A tab that keeps changing its title no longer keeps the browser busy**: the session file is written off the main thread
  and a change of titles alone at most every 30 s, history keeps five titles per page, and the tab strip redraws only what changed.
- **The Ethereum light client runs only while `.eth` is in use**: it starts when a `.eth` address is typed or opened and
  stops ten minutes after the last one; menus and panels left closed give their memory back after a minute.
- **A background tab's page is told it is hidden**, as in Chrome, so a web app that slows down out of sight now does.
- **uBlock Origin no longer grows its storage until the browser takes gigabytes of memory**: an extension's
  `chrome.storage.managed` is now an empty, read-only store, as in Chrome, instead of a second name for its local storage.
- **A page with no icon of its own shows the globe again**, as in Chrome, instead of an icon the tab or history remembered
  for its site; a remembered icon still comes back on a return after a blank or failed page.
- **A port bundled against a pnpm-installed checkout gets a working `crypto`**: the shim bundler now finds its own
  dependencies by their real paths, so The Lounge's server no longer crashes on `createHash is not a function`.
- **`npm run check:advisories` runs on Windows**: it spawns `npm audit` through the same `.cmd`-aware launcher.
- **`npm run dev -- <switch>` passes the switch to Electron**, as `npm run dev -- --password-store=basic` needs; it was dropped.
- **`npm run dev` and `npm start` start on Windows again**: Node refuses to spawn an npm `.cmd` shim without a shell, so the
  launch and build scripts exited 1 with nothing on screen; they now run the shim through cmd.exe and print a failed launch.
- **An app opened from `ipfs://` or a `.eth` name asks for its grants again over slow gateways**: its install gave up when a
  file took over 20 seconds to start arriving, so no consent prompt ever appeared. A refused install now logs its reason.
- **An app that shows pages it serves itself is granted `web.embed` again**: a local pattern (`http://*.localhost:<port>`) or an exact
  `http://` origin was read as a `host:port` pattern, which it is not, so no manifest declaring one was ever allowed to grant it. The
  subset check now compares any whole-origin pattern exactly.
- **Page zoom scales the page in every tab**: a tab's zoom now resizes what is drawn, where before only the percentage
  changed.
- **Shrinking a window with the main menu open no longer ends the browser.**
- **A tab title no longer loses the bottom row of its descenders** (g, p, y): its line box was shorter than the text.
- **A burst of short-lived sockets no longer brings the browser down.** The broker's socket streams no longer go
  through Node's `Duplex.toWeb`, whose teardown could throw where nothing could catch it.
- **A program a forked child spawns can use the app's files and network.** Every `orivon.*` call from it failed
  before, which a WASI program saw as an I/O error on its first file call.
- **A WASI program that listens on an IPv6 address no longer aborts when it reads its own address.** A
  listener reports the address it bound, and every reported address is of the socket's own family.
- **A middle, ctrl, shift or ctrl+shift click on a link no longer closes the browser.**
- **An extension's sandbox page gets no extension APIs**, as in Chrome, so untrusted code an extension runs there
  cannot act with the extension's permissions.
- **New tabs, internal pages, the window and every toolbar panel open in the theme's colour**, with no white
  flash, and the main menu opens without being rebuilt.
- **An extension's popup closes** on a click elsewhere in Orivon, a tab switch, a navigation, a window move or
  Escape, and opens in the theme's colour.
- **An extension popup's first `chrome.*` call no longer fails** with "unknown extension context", and Electron
  no longer warns that a permission Orivon serves is unknown.
- **A crash while bookmarks or a profile are being saved leaves the previous file whole.**
- **A second start with no window open shows a window only once it is drawn**, on its new-tab page
  when no address was given.
- **History search answers at once on a long history**, whether most pages match or almost none do.
- **A private window keeps the keyboard shortcuts** of the profile that opened it.
- **Settings, History, Profiles and a private window's first page load under `npm run dev`**; they were blank.
- **The main menu shows every entry with no scroll bar**, and a new split shows both panes painted at once.
- **A `.eth` or `ipfs://` site can be framed only by a page of its own origin**, so another site cannot
  lay it under its own page to steer the person's clicks; an app granted `web.embed` for it still shows it.
- **A native addon built with napi-rs loads**: its WebAssembly build gets Node-API and memory the way
  napi-rs's own loaders provide them, which a real napi-rs 3 addon needs.
- **An app that listens for TCP connections receives them**: the broker now hands each accepted
  connection's port over by transfer alone, which Electron requires.
- **The toolbar no longer creates a session partition for every website visited.**
- **An OIDC sign-in that leaves an app's tab and returns can complete.**
- **Entering fullscreen keeps the page's keyboard focus.**
- **An installed app keeps its app-tab setup after a restart.**
- **Large bundles install and stream from disk**: 512 MiB per bundle, 64 MiB per asset, Range
  requests included.
- **Real static hosts work**: lazy chunks survive an update, client routes reload, a corrupted
  cache recovers, and redirecting hosts install.
- **A declined or revoked capability is not asked for again at every launch.**
- **An unchanged app costs one conditional manifest request an hour.**
- **Chunked file I/O no longer hits the control channel's rate limit**, and a dozen socket and
  fs edge cases behave as in Node.
- **Subresources from granted hosts behave like a browser's**: queued, redirect-capped, with
  real content types.
- **A page can open and save one file through the File System Access API** (ADR-0024).
- **A routed `fetch()` to a dead host names the real failure**, and is replaceable like the
  platform's own.
- **The window appears under `npm run dev`.**
- **The chrome view and its popups expose their bridge only at their own URL**; an isolated
  context is locked before its first load, and a refused navigation is logged.
- **Favicons survive a hash change or a same-origin page**, a failed icon fetch no longer holds a
  socket, the icon cache is bounded, and an SVG entity bomb behind a quoted DOCTYPE literal is
  refused.
- **`.eth` pages keep their gateways through a lost race, a cooldown and a hostile answer**: the
  verifier host no longer crashes on a 999 status or stalls on a 101, and every run certificate
  parses.

### Security

- **Every panel, bar and sheet Orivon draws over a page shares one sandboxed bridge**, and each can reach only its own
  handler, checked by frame and exact address on every call (ADR-0048).
- **A site's permissions work only from a page that committed in that site's own session**: a page
  a link or redirect reached before its tab moved, a page an app shows or a web context is `denied`.
  A grant or revoke never strands an open page; a site's handles close when its last tab goes.
- **The file picker needs a click or key press**, names the site, opens once per site at a time, and
  refuses the browser's own data, the home folder, disk roots and system folders.
- **`orivon.net` refuses to open sockets or resolve names while a system proxy applies** (T20).
- **Consent dialogs belong to the tab that asked**: shown over its window, dropped if it left, one
  at a time per site, lists capped; `app.requestGrant` does not re-ask what the person declined.
- **An fs quota holds against sparse positional writes**, an app's files sit in their own root apart
  from its code, and a widened curve list, quota or socket count asks again.
- **The verifier caps the memory one page can hold**, dials CCIP-Read at a checked address on
  port 443, validates and caps its IPNS records, checks its host's messages, and stamps shown
  pages.
- **Packaged builds turn off RunAsNode, NODE_OPTIONS and `--inspect`**, encrypt cookies and check
  `app.asar`; the address bar hides userinfo, and a `magnet:` link must parse before it leaves.

### Resolved

- **The week-0 spike**: gates 0, 1a, 1b and 2 pass; see `docs/planning/spike-verdict.md`.
- **Handle contracts**: WHATWG streams are the durable interface (ADR-0008).

### Notable reversals

- **Protocol encryption is available**: `mse.js` ships a pure-JS RC4 fallback.
- **Transferable `ArrayBuffer`s are no rescue**: renderer to main they never arrive, and
  structured clone is fast enough.
- **The telemetry metric counts `activeSec`**, not time the app was open.
- **There is no flagship app**: build step 5 ports existing desktop apps as test cases (ADR-0001).
- **Judged Web3 Score levels are in**, each naming its provider (ADR-0006).
