# Features

What Orivon does today, one line each. [`roadmap.md`](roadmap.md) says what is expected next and
what is later; [`known-limitations.md`](known-limitations.md) says what each feature does not do;
[`planning/compatibility-matrix.md`](planning/compatibility-matrix.md) says what a ported app can
rely on, row by row. A new feature adds its line here when it lands.

## Apps and the platform

- **Capability broker**: an app's manifest, the person's grants, and per-origin enforcement on every call.
- **`orivon.*` capability API**: the interface apps are written against, as types in `src/contracts/`.
- **App loader**: fetch a manifest from a URL, cache the bundle hash-pinned, check its integrity, and ask once in plain words before the app runs.
- **`orivon-node-shim`**: Node's `net`, `tls`, `dgram`, `fs`, `http`, `child_process`, `worker_threads` and `node:sqlite` mapped onto the same capabilities, enough to run a Node web server (Express, Socket.IO) in a tab. An app's `process` and `os` present as Node on Linux (a Node version, no `browser` flag, `linux`, `x64`), so a library takes the path it takes under Node.
- **UDP sockets** (`net.udpBind`) for peer-to-peer protocols a web page cannot open.
- **Ported desktop apps**: FreeTube, Element, The Lounge, AirGap Vault and ASGARDEX run from a name, unmodified, with a bridge file kept in `orivon-ports`.
- **WASI and native modules as WebAssembly**: a WASI host over `orivon.fs`, native addons loaded as their WebAssembly build, and `spawn` and `fork` as WebAssembly programs and workers.
- **USB HID devices** (`devices.hid`): an app uses `navigator.hid` for the vendors its manifest names, and the person approves each device; a website picks one in a chooser under Site settings.
- **Embedded sites** (`web.embed`): an app shows another site inside its own page, in an isolated view.
- **Cross-origin isolation on request** (`crossOriginIsolated` in the manifest) for WebAssembly built with threads.
- **Per-app storage isolation** with a disk-usage view.
- **Identity seed and `orivon.secrets`**: a seed kept in the OS keyring and an app's own origin-bound encrypted secret.
- **Links to an app**: a link of a scheme an app lists in its manifest (`magnet:`) opens in the app the person chooses, with the choice remembered per scheme and listed in Settings, and the app's page receives the link.
- **Developer mode**: load an unpacked app from a folder.
- **A published app loads at once, asks beside it, and is checked as it runs**: an `ipfs://`, `ipns://`, `.eth` or https app shows its page straight away as an ordinary website, with no permissions, while it asks what it may do and caches its files beside the question. Allow reloads the tab as the app; Deny leaves the website as it is. Each file the app loads is checked against the hash tree its site declares before the page receives it; one that differs is never delivered, every permission is removed and a security warning is shown. The rest of the app is pinned once allowed.
- **A tunnel for an installed app**: under Privacy and data the tunnel is Nym, built into Orivon, or your own SOCKS5 address (Tor on `127.0.0.1:9050`, say); turn it on for an app on its card in Apps. Everything the app causes to leave this computer goes through it, a name unresolved; on Nym each app has a mixnet tunnel of its own, which starts when the app first connects and stops some minutes after the last one, and Settings and the app's site-info popover say whether it is connecting, ready or not answering (a Test brings Nym up and says how long it took); what the tunnel cannot carry is refused, and the app stops when the tunnel does. Its updates are not checked and WebRTC is off while the route is on. When the app's page opens a website, or navigates its tab to one, you are asked each time whether the page goes through your tunnel (a temporary tab that keeps nothing once closed) or directly; another installed app whose route is off is offered the tunnel too. A website you open is routed only when you turn the tunnel on for it, or for the whole browser.
- **The tunnel for a website**: with a tunnel set, the key in the address bar offers "Use the tunnel for this site" for any website. The first time, you are told that the site moves to your tunnel profile, that you sign in to it again once, and that what it stores stays apart from your normal browsing, and you confirm. The site then loads, with everything it asks of other hosts, through your tunnel in the tunnel profile, one session kept across restarts and shared by every site you turned the tunnel on for, with one copy of each of your extensions (toolbar button, popup and blockers like uBlock Origin work there, with settings of their own in that profile); the key shows the tab is on the tunnel. Turning it off returns the tab to your normal browsing and keeps the site's data in the profile; Settings lists every site and app with a tunnel setting of its own under the profile it lives in, and "Remove its separate storage" clears that site's data. A `.eth`, `ipfs://` or `ipns://` site is read through the tunnel too: its gateway blocks, its DNSLink lookup, its name's proofs and its CCIP-Read answers, so the key and the popover show it as fully tunnelled and it does not load when the tunnel is down; a `bzz://` address does not open with the tunnel on for it, because the Swarm node cannot send one site's traffic through a tunnel.
- **The tunnel for the whole browser**: "Send all of Orivon's traffic through the tunnel" under Privacy and data sends every website and app with no setting of its own through the tunnel, and what Orivon sends for itself too (update checks, usage statistics, search suggestions, the Web3 names it reads): through the tunnel or not at all. This computer, the connection to the tunnel and the sites and apps you turn off stay direct; a site you turn off from its popover lives in your direct profile. The IPFS and Swarm nodes Orivon can run are off meanwhile, and IPFS is read through gateways. Turning the setting over moves no site and signs you out of none.
- **App updates at a name**: an installed app keeps its version until the person accepts a newer one.
- **Files as apps**: a local HTML, SVG or PDF file opens in a tab, and a file that links a manifest asks once per run.

## Names, content and trust

- **`.eth` names**: resolved by a light client that proves the name's record on this machine; `.eth.limo` and `.eth.link` addresses open as the `.eth` name. The address bar shows `bzz://<name>` when the name's content was found on Swarm and `ipfs://<name>` when it was found on IPFS (`ipfs://` until the name has loaded once on this install).
- **`ipfs://` and `ipns://` addresses**: every block checked against its CID; a protocol registry makes the next protocol an isolated piece of work. IPFS loads from Orivon's own node by default: an IPFS node that Orivon runs on this computer (WebAssembly, in a process of its own, reading only), started when an IPFS address is opened and stopped after ten minutes without use, so no public gateway learns which sites you open. Settings > Web3 chooses between that node and public gateways, and whether the node may ask two lookup services (delegated-ipfs.dev and cid.contact), as well as the IPFS network, who holds a site; both apply at once. The node resolves host names over DNS-over-HTTPS first, so a network that hijacks DNS does not break its lookups. When the node cannot run (a build made without it, a system proxy, a failed start) IPFS loads from the public gateways, and Settings and the site-info popover say why and where the content came from.
- **`bzz://` addresses and `.eth` names on Swarm**: every chunk checked against its address, feeds followed to their newest signed update. Swarm loads from Orivon's own node, never from a public gateway: a Swarm light node that Orivon runs on this computer (WebAssembly, in a process of its own), started when a Swarm address is opened and stopped after ten minutes without use. Swarm is off in a build made without the node, and behind a system proxy; the page then says why. Settings shows the node's state.
- **Try again on a page that could not check a site**: the "Cannot check this site right now" and "Cannot verify this name yet" pages carry a Try again button; it asks again at once, though the failed attempt was remembered for a few seconds. Local nodes that cannot start name their reason on the page instead of timing out.
- **DDOC**: a site publishes its bundle hash tree, anchored in its ENS record, and the Web3 Score page shows whether the pinned bundle matches.
- **Web3 Score**: a shield in the address bar for the delivery and connection levels, observed by the machine or judged by a provider the person chooses. On a new tab it opens a card that explains the four levels.
- **Web3 Score providers**: static sites built with web3-score-manager, asked by hash bucket so a provider never learns the site.

## The browser

- **Shell**: tabs, address bar, back and forward, and a main menu.
- **Settings** at `orivon://settings`: every feature's controls in one place, with search.
- **Keyboard**: remappable shortcuts, F6 focus cycling, a focus ring on every control, and caret browsing.
- **Tabs**: reorder, move between windows and tear off; pinned, muted and audible tabs; duplicate; reopen closed tabs and windows; tab search; split view.
- **Tab groups and sleeping tabs**: named, coloured groups that survive a restart, and idle tabs that sleep.
- **Profiles and private windows**: a profile is a separate browser; a private window starts empty and is deleted when closed.
- **Start-up and windows**: the new-tab page, the last session or chosen pages, crash restore, a Home button, window placement, `--orivon-kiosk`, and on macOS the window buttons kept in the tab strip in full screen.
- **New-tab dashboard**: a search box, Orivon Featured apps and every bookmark as a tile.
- **Welcome screen**: shown once per profile before the dashboard.
- **Address bar**: a Web3 / Web2 switch for what you type (Web3, searched with Explore, by default; Web2, DuckDuckGo or another engine), keywords, suggestions from history, bookmarks and open tabs, a "Not secure" mark for plain http, and a QR code for the page.
- **Page tools**: find in page, print and Save as PDF, Save page as, View page source, screenshots, Picture in picture, and right-click menus with spelling.
- **Reader view and a side panel**: an article in its own tab, read aloud; a panel for bookmarks, history and downloads.
- **Bookmarks**: a bar, folders, a manager at `orivon://bookmarks`, and HTML import and export.
- **History**: by day or by session, searchable, with many-at-once delete and recently closed tabs.
- **Downloads**: a list, pause, resume and retry, and a hold on files that run code.
- **Import** of bookmarks and history from Chrome, Chromium, Edge, Brave and Firefox.
- **Passwords**: a local store encrypted by the system keyring, with save, fill, a generator and CSV import and export.
- **Privacy controls**: third-party cookie blocking, Do Not Track, Global Privacy Control, HTTPS-only, secure DNS, a certificate viewer and Clear browsing data.
- **Per-site permissions**: prompts for camera, microphone, location, clipboard and more; a popover, a Settings page, a pop-up blocker, and per-site JavaScript, images, sound and downloads.
- **Screen sharing**: a picker for a tab, a window or the screen, with a bar to stop.
- **Chrome extensions**, MV3 and MV2, from the Chrome Web Store, a `.crx` or `.zip`, or a folder; full uBlock Origin works.
- **Extension controls**: a toolbar menu with pinning, side panels, access sheets and command keys.
- **Extensions in the tunnel and direct profiles**: your extensions run for websites you set to on or to off as they do for the rest, one copy of each per profile and not one per site; the toolbar follows the tab in front. Each profile's copies run only while a site of it is open, so an idle profile costs no memory, and with the whole browser on the tunnel no extension makes a direct request while no excluded site is open. Each profile keeps its own extension settings; side panels and command keys stay with your normal browsing.
- **Orivon and the operating system**: default browser registration, links from other programs, dock and taskbar entries, Share, and Create shortcut.
- **About and a task manager**: `orivon://about` and `orivon://tasks`, with a way to end a tab that hangs.
- **Real tab icons**, fetched by the main process and handed to the interface as data.

## Reporting and distribution

- **Bug reports**: a form that shows the report in full before Send, an opt-in crash dump, deletion from the server, and a local log.
- **Telemetry**: opt-in, with a first-run choice, a Settings switch, a privacy notice and erasure.
- **Packages for Linux, Windows and macOS** on every GitHub release (deb, AppImage, NSIS installer, dmg for Apple silicon and Intel), also published on IPFS. On macOS a one-line Terminal command installs or updates Orivon with no Gatekeeper warning.
- **A Microsoft Store package** built with every Windows build and kept for upload to Partner Center (not on the release); a Store install is updated by the Store and looks for no update itself.
- **winget**: every release's Windows installer is offered to winget-pkgs by the release workflow (`Orivon.Browser`, and `Orivon.Browser.Preview` for a pre-release), once the owner has stored the token and submitted the first version of each.
- **Update check**: a check for a new release that links to its page.
- **Run from source** on Linux, Windows and macOS with `npm install && npm start`.
