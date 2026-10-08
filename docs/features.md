# Features

What Orivon does today, one line each. [`roadmap.md`](roadmap.md) says what is expected next and
what is later; [`known-limitations.md`](known-limitations.md) says what each feature does not do;
[`planning/compatibility-matrix.md`](planning/compatibility-matrix.md) says what a ported app can
rely on, row by row. A new feature adds its line here when it lands.

## Apps and the platform

- **Capability broker**: an app's manifest, the person's grants, and per-origin enforcement on every call.
- **`orivon.*` capability API**: the interface apps are written against, as types in `src/contracts/`.
- **App loader**: fetch a manifest from a URL, cache the bundle hash-pinned, check its integrity, and ask once in plain words before the app runs.
- **`orivon-node-shim`**: Node's `net`, `tls`, `dgram`, `fs`, `http`, `child_process`, `worker_threads` and `node:sqlite` mapped onto the same capabilities, enough to run a Node web server (Express, Socket.IO) in a tab.
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
- **App updates at a name**: an installed app keeps its version until the person accepts a newer one.
- **Files as apps**: a local HTML, SVG or PDF file opens in a tab, and a file that links a manifest asks once per run.

## Names, content and trust

- **`.eth` names**: resolved by a light client that proves the name's record on this machine; `.eth.limo` and `.eth.link` addresses open as the `.eth` name.
- **`ipfs://` and `ipns://` addresses**: every block checked against its CID; a protocol registry makes the next protocol an isolated piece of work.
- **DDOC**: a site publishes its bundle hash tree, anchored in its ENS record, and the Web3 Score page shows whether the pinned bundle matches.
- **Web3 Score**: a shield in the address bar for the delivery and connection levels, observed by the machine or judged by a provider the person chooses.
- **Web3 Score providers**: static sites built with web3-score-manager, asked by hash bucket so a provider never learns the site.

## The browser

- **Shell**: tabs, address bar, back and forward, and a main menu.
- **Settings** at `orivon://settings`: every feature's controls in one place, with search.
- **Keyboard**: remappable shortcuts, F6 focus cycling, a focus ring on every control, and caret browsing.
- **Tabs**: reorder, move between windows and tear off; pinned, muted and audible tabs; duplicate; reopen closed tabs and windows; tab search; split view.
- **Tab groups and sleeping tabs**: named, coloured groups that survive a restart, and idle tabs that sleep.
- **Profiles and private windows**: a profile is a separate browser; a private window starts empty and is deleted when closed.
- **Start-up and windows**: the new-tab page, the last session or chosen pages, crash restore, a Home button, window placement and `--orivon-kiosk`.
- **New-tab dashboard**: a search box, Orivon Featured apps and every bookmark as a tile.
- **Welcome screen**: shown once per profile before the dashboard.
- **Address bar**: DuckDuckGo by default or another engine, keywords, suggestions from history, bookmarks and open tabs, a "Not secure" mark for plain http, and a QR code for the page.
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
- **Orivon and the operating system**: default browser registration, links from other programs, dock and taskbar entries, Share, and Create shortcut.
- **About and a task manager**: `orivon://about` and `orivon://tasks`, with a way to end a tab that hangs.
- **Real tab icons**, fetched by the main process and handed to the interface as data.

## Reporting and distribution

- **Bug reports**: a form that shows the report in full before Send, an opt-in crash dump, deletion from the server, and a local log.
- **Telemetry**: opt-in, with a first-run choice, a Settings switch, a privacy notice and erasure.
- **Packages for Linux, Windows and macOS** on every GitHub release (deb, AppImage, NSIS installer, dmg for Apple silicon and Intel), also published on IPFS.
- **Update check**: a check for a new release that links to its page.
- **Run from source** on Linux, Windows and macOS with `npm install && npm start`.
