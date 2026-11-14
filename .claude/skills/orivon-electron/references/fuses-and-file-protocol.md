# Fuses, the `file:` protocol and secure contexts

## The file-protocol fuse is off, and cookie encryption on, in this repository's binaries

On Linux, `npm install` (the `postinstall` hook) and `npm run install:electron` turn `grantFileProtocolExtraPrivileges`
off and `enableCookieEncryption` on in `node_modules/electron/dist/electron`, as `electron-builder.yml` sets them for a
package (`CHECKOUT_FUSES` in `scripts/install-electron.mjs`; a unit test fails when the two disagree). Cookie encryption
is one-way per profile: a binary without the fuse reads none of the cookies an encrypting binary wrote and deletes them,
signing the person out of every site. A run from source has a profile of its own (`<appData>/orivon-source`, ADR-0057),
which the fuse keeps readable when it moves between a checkout and a package.
Every test launch passes `--password-store=basic`, so the cookie key never comes from the desktop's keyring.
With the file-protocol fuse off, a `file:` page's module scripts are blocked (a null origin), a canvas read of a sibling
image throws `SecurityError` and `fetch` of a sibling file rejects, so the shell's own pages load from
`orivon-shell://renderer/...` instead (`src/main/pages/shell-scheme.ts`, ADR-0059). After syncing `main`, run
`npm run install:electron` in each checkout: it writes a new file and renames it over its own path, because a
`cp -al` worktree shares the binary's inode with the checkout it came from and an in-place write would flip
that one too (and fail with `ETXTBSY` while it runs). Never `flipFuses` a binary in `node_modules` directly.

## `file://` is a secure context only while the file-protocol fuse is on

Service workers are ordinarily gated to secure contexts (`https:` or `localhost`). **Electron treats a `file://` origin
loaded via `loadFile()` as a secure context** while `grantFileProtocolExtraPrivileges` is on, and
`navigator.serviceWorker.register()` then succeeds with no flag and no workaround (spike gate 3,
`docs/planning/spike-verdict.md`, run with the fuse on). A package and a Linux checkout's binary have it off (the
section above), so nothing here loads its pages from `file:` and the result does not carry over: a page that needs a
service worker is served from a scheme or an origin that is a secure context by itself.

**What this does not prove:** gate 3 itself is **BLOCKED**, not passed. `register()` succeeding is confirmed, but the
end-to-end media path through the `<video>` element is still unproven, because Playwright could not attach to that
gate's window (`playwright-electron.md`) and the element itself is explicitly "not yet tested" in `spike-verdict.md`.
