# `src/main/local-files/`: where a document opened from this computer runs

**What lives here.** The session and the guard that make a document opened from this computer (a `file:`
URL) an origin of its own. `partition.ts` names the in-memory session every local file runs in.
`file-handler.ts` is the `protocol.handle('file')` handler of a session, in two kinds: the local-files
session serves any local file the way Chromium does and adds the policy of `local-file-csp.ts` to the
response; every other session serves only the shell's own built pages, and answers any other `file:` URL
with an empty sandboxed page. `install-file-guard.ts` registers them (`guardFileScheme` on a session that
is not the local one, `serveLocalFiles` on the local one, which also drops every cookie it would send or
keep), `local-files-subsystem.ts` wires that at startup, and `local-data-sweep.ts` removes the saved data of
local files at start and at quit.

**What it depends on.** `electron` (`install-file-guard.ts`, `local-files-subsystem.ts`),
[`../../broker/policy/origin.ts`](../../broker/policy/origin.ts) (`localFileKey`),
[`../../broker/grants/local-file-lifetime.ts`](../../broker/grants/local-file-lifetime.ts) (where the data
lives and how long), [`../sessions/web-request-owner.ts`](../sessions/web-request-owner.ts) (the cookie
stripping) and [`../../loader/electron/serve.ts`](../../loader/electron/serve.ts) (`liveCspHeaderFor`, the
second policy a document holding Orivon permissions gets). `file-handler.ts`, `local-file-csp.ts`,
`partition.ts` and `local-data-sweep.ts` import no Electron and are unit-tested under plain Vitest.

**What it must never import.** The tab and window code in [`../shell/`](../shell/): the shell imports
`partition.ts` to put a tab in this session, never the reverse. Nothing here may widen what a local file can
read: a new directive in `local-file-csp.ts` only ever removes a source.

**Durable or tied to Electron.** `partition.ts`, `file-handler.ts`, `local-file-csp.ts` and
`local-data-sweep.ts` are durable: they state a policy and a lifetime in plain Node. `install-file-guard.ts`
and `local-files-subsystem.ts` are tied to Electron's `Session` and `protocol` APIs.

**Owner stream.** `shell` (the local-files work).

## Design notes

**A local file is an origin of its own, keyed on its exact path.** `localFileKey` in
[`../../broker/policy/origin.ts`](../../broker/policy/origin.ts) is the `file:` URL with an empty host and no
query or fragment, at most 2,048 characters. A sibling in the same folder is another origin, and a moved or
renamed file is asked again. `originFromUrl` still answers null for `file:`, so a caller that has not been
moved to `isolationKeyFromUrl` fails closed.

**The policy removes sources and never adds one.** `LOCAL_FILE_CSP` has no `default-src`: a page keeps loading
the scripts, styles, images and fonts of its own folder, as a downloaded `.html` expects. What it takes away is
the ways a script reads a *file* as data: `connect-src` has no `file:` (so `fetch` and `XMLHttpRequest` cannot
read a sibling or `/etc/hostname`), `frame-src` and `object-src` have none, and `worker-src` allows `blob:` and
`data:` only. A document that holds Orivon permissions gets a second policy as a second header value, and the
browser enforces both, so the second can only narrow the first.

**Every other session serves no local file.** A `file:` document that commits in the default session (a
history entry, a restored tab) gets an empty page under `sandbox; default-src 'none'`. It reads and runs
nothing until the tab is moved to the local-files session by the `did-navigate` swap
([`../shell/tab-view.ts`](../shell/tab-view.ts)). The shell's own pages are `file:` URLs in a packaged build,
so the guard passes through anything under the built renderer folder.

**Attribution is by the document's own commit.**
[`../sessions/session-attribution.ts`](../sessions/session-attribution.ts) trusts a file key only if the
cross-document `did-navigate` record holds that key in the local-files session. There is no live fallback, so
a `history.pushState` onto another path (which changes the frame's URL and not its document) is denied.

**What a local file's data lasts is decided in one place.**
[`../../broker/grants/local-file-lifetime.ts`](../../broker/grants/local-file-lifetime.ts) holds the
per-run id that salts `id` and `secrets` keys, and the folder of a local file's `fs` root. The session is in
memory and `local-data-sweep.ts` removes the folder at start and at quit, so nothing a local file stores,
derives or holds is there in the next run. Keeping it for longer is a change to those two files and to the
sweep, and loses nothing; the reverse would delete data people had saved.
