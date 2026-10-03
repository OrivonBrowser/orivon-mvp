# Changelog

All notable changes to this project are recorded here, at most three lines each; the full
account of a change is in its pull request.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning will follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) once there is something to version.

> **Nothing has been released.** There is no version, no tag, no packaged build. The list below
> is what has landed on `main` during development.

## [Unreleased]

### Added

- **`npm run perf:probe`** measures each process's CPU and memory through fixed scenes, to compare a change before and after.
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

### Fixed

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
