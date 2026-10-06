# ADR-0059: Orivon's own pages load from `orivon-shell:`, and `file:` pages get no extra privileges

- **Status:** accepted
- **Date:** 2026-10-05
- **Type:** security
- **Decided by:** owner ("close it first": the file-protocol privilege gap is closed before local files
  ship); AI recommendation, accepted by default, for the scheme, the two sessions and the website gate.

## Decision

A built shell loads every one of its own renderer entries from `orivon-shell://renderer/<path inside
out/renderer>`, never from `file:`, and Electron's `grantFileProtocolExtraPrivileges` fuse is off in every
packaged build and in a Linux contributor's Electron binary.

- **One scheme, one origin.** `orivon-shell` is registered `standard` and `secure` and nothing else:
  `corsEnabled`, `bypassCSP` and `allowExtensions` stay false. The host is `renderer`, so the chrome, the
  dashboard, the welcome screen, the overlays, both popovers, the split frame and the drop catcher share the
  one origin `file://` gave them, and relative URLs resolve as they do on disk. `npm run dev` keeps loading
  from the loopback dev server; the e2e build, `npm run smoke` and a package use the scheme.
- **Two sessions serve it, with different files.** `persist:orivon-shell` serves the shell's own entries and
  every file under `assets/` of a listed type. The default session, which a website shares, serves only the
  new-tab page and the files its own build reaches in Vite's manifest (`build.manifest`). Any other path, the
  manifest included, is a 404. `src/main/pages/route.ts` still decides, by pure rules, which file a path may
  read; `shell-scheme.ts` installs the handlers in `pagesSubsystem.afterReady`, before any window, so a private
  window's process has them too. No other session has a handler.
- **A website cannot reach the default session's copy.** A tab refuses (`will-frame-navigate`,
  `will-redirect`) any navigation to the scheme from a page or a frame. A `webRequest` handler in the default
  session's owner cancels every request on the scheme except a main-frame navigation (the tab loading the
  dashboard, Back returning to it) and a request from the dashboard's own top frame. Responses carry
  `Cross-Origin-Resource-Policy: same-origin`, `nosniff` and `no-store`, and HTML adds
  `frame-ancestors 'none'; object-src 'none'; base-uri 'none'`.
- **Extensions cannot name it.** An explicit host pattern takes only `http`, `https`, `ws`, `wss`, `ftp`,
  `file` (refused where host access is decided) and `chrome-extension`; `<all_urls>` was already limited to
  the web. The extension request rules and listeners skip `orivon-shell:` as they skip `orivon:`.
- **A copy of a tab does not carry the dashboard.** `carryHistory` and `restoreHistory` drop entries on the
  scheme and restore nothing when the shown entry is one, since a copy may sit in a session with no handler; a tab woken from memory saving gets the same, its blank view having no dashboard bridge.
- **The shell session refuses `file:`.** `protocol.handle('file', ...)` on `persist:orivon-shell` answers 404.
- **The fuse is off in a package and in a Linux checkout.** `electron-builder.yml` sets `grantFileProtocolExtraPrivileges: false`.
  `scripts/install-electron.mjs` turns it off in `node_modules/electron/dist` at install on Linux, with no opt-out other
  than skipping the binary download, by writing a new file and renaming it over the binary, never writing in
  place. `src/main/local-files/file-fuse.ts` reads the running binary's fuse, memoised, so a feature that needs
  local files can ask whether it is off.

## Context

In Electron's default state a `file:` page has extra privileges (the fuse
`grantFileProtocolExtraPrivileges` names them), so any feature that opens a local page would hand that
reach to whatever the file contains. The shell's own pages were the one thing that needed `file:`, since they were loaded from disk. The
owner decided on 2026-10-05 to close the gap first. The question closed here is A392, the fuse staying on
while the shell's pages are `file:`.

## Probes

Run with the fuse off, each in a headless Electron 44 (`app.whenReady().then()`), 2026-10-06.

- **Q1: a `file:` page, fuse off.** Its module script is blocked (`Access to script ... from origin 'null'
  has been blocked by CORS policy`); a classic script and a stylesheet load. The built chrome is a module
  script, so it cannot stay on `file:` with the fuse off.
- **Q2: a page on loopback and an extension page, both in the default session, response sent with CORP
  `same-origin`.** CORP is not enforced for this scheme. From the loopback page a classic `<script>` ran, a
  stylesheet applied, an `<img>` loaded, `location=`, a 302 from the page's own server and `window.open` all
  reached the document, and an `<iframe>` requested it. A module script, `fetch` (also `no-cors`) and
  `XMLHttpRequest` failed (no `corsEnabled`). From the extension page a stylesheet, an image, a frame and a
  navigation reached it; a classic script was stopped by the extension's own CSP. So CORP and
  `frame-ancestors` are not a gate: the website gate above is.
- **Q3: the default session's `onBeforeRequest` sees the scheme**, with `resourceType`, the webContents and
  the requesting frame (its URL and whether it is the top frame), for every request in Q2. A filter naming
  `orivon-shell://*/*` alone matches; a handler that cancels all but the dashboard's top frame stopped the
  site's script (`onerror`) and let the dashboard's own load, and a blocked request never reached the
  protocol handler.
- **Q4: P1, a `file:` page with the fuse off.** A canvas read of a sibling PNG and of a PNG in another folder
  both throw `SecurityError`; `fetch` and `XMLHttpRequest` of a sibling file fail. The spec
  `test/sites/e2e-file-protocol-fuse.test.ts` keeps this.
- **Q5: the built chrome and dashboard under `standard` + `secure`.** Module scripts, `modulepreload` links
  and stylesheets all load (10 requests for the chrome, 7 for the dashboard, none missing), the page is a
  secure context and `crypto.randomUUID` is a function. Adding `supportFetchAPI` changed nothing, so it is
  left off. No font loaded in these pages (they use none); the one `.woff2` in the build is served by the
  shell session's `assets/` rule.
- **Q6: `protocol.handle('file', ...)` on a partition.** It answers that partition's main-frame `file:`
  loads (the handler saw `file:///etc/hostname` and the page showed its answer); a partition without it read
  the file from disk. From a page on the scheme, `fetch` of a `file:` URL is rejected, `XMLHttpRequest` ends
  at status 0 and an `<img>` is empty, without the handler being asked.

## Alternatives considered

- **Join `orivon:`.** Rejected: ADR-0041 holds because no website session handles `orivon:`, and the dashboard
  runs in the default session, so it needs a scheme that session handles.
- **Loopback HTTP for the shell's pages.** Rejected: it is a local network server another process could
  reach (T12), and a port to find.
- **Keep the fuse on.** Rejected: that is the privilege gap (P1).
- **The dashboard in its own session.** Rejected: a typed address from the dashboard would become a session
  swap, replacing the view on every first navigation.
- **Flip the fuse in place.** Rejected: a worktree's `node_modules` is a hard-linked copy of another
  checkout's, so an in-place write changes that checkout's binary, and it fails with `ETXTBSY` while the
  binary runs.
- **Rely on CORP and `frame-ancestors` alone.** Rejected by Q2.

## Consequences

- A website learns nothing from the scheme: every request it makes on it is cancelled the same way, whether
  the path exists or not. The residual is that the default session holds a handler for the scheme, and
  `will-frame-navigate`, `will-redirect` and the `webRequest` handler are all that stand between a site and
  the dashboard's page and files. A window a page opens is adopted as a tab with no `sanitizeDirectUrl` pass,
  so its `will-frame-navigate` and `will-redirect` (wired when the tab is made) are what refuse it the
  scheme; the spec opens a window with pop-ups allowed and checks that none lands on the dashboard. The
  `webRequest` handler lets a main-frame request through whichever web contents makes it, so an extension's
  popup or background page, which is no tab, can show the dashboard, without its bridge. A gap in the tab
  guards would show as such a request, and the only files it could read are the dashboard's own.
- Another checkout, and a worktree made by `cp -al`, keeps the fuse on until `npm run install:electron` runs
  there. A symlinked `node_modules` is refused (the flip would rewrite the target's binary), and the script
  warns, exits 0 and leaves the fuse on. A feature that needs it off treats `'unknown'` and `'on'` alike.
- Every overlay and popover now reads its page through the main process instead of Chromium's file loader;
  custom-scheme responses skip the HTTP cache. If `window/e2e-menu-warm` or `perf:probe` regress, built
  files are cached in memory.
- The flip runs on Linux only (*provisional*, A394): on macOS the binary sits in a signed framework that
  would need an ad hoc re-sign, and Windows refuses a rename over a running `.exe`. Until each is measured
  the script refuses there, warns, and leaves the binary as it is, so local files stay closed on those systems
  in a checkout. A package sets the fuse through electron-builder on every platform.
- The packaged Linux build (`electron-builder --linux dir`, 2026-10-06) was launched once under a headless
  display with a debugging port: its two pages were `orivon-shell://renderer/newtab/index.html` and
  `orivon-shell://renderer/index.html`, read from the asar, and `@electron/fuses read` showed
  `GrantFileProtocolExtraPrivileges is Disabled`. CI never packages, so a regression in the packaged path
  appears only on a person's package run.

## Reversibility

- **Cost to reverse:** moderate. The scheme is internal and its addresses are not stored; going back to
  `file:` means flipping the fuse on again, which every Linux checkout then does by script.
- **What would make us revisit:** a macOS or Windows measurement that the flip cannot be done safely
  (A394), or a need for the shell's pages to load where the scheme has no handler.
