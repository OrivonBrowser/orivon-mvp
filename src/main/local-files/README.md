# `src/main/local-files/`: where a document opened from this computer runs

**What lives here.** A file opened from this computer is an origin of its exact path
([`ADR-0060`](../../../docs/decisions/ADR-0060-a-file-opened-from-this-computer-is-an-origin-of-its-exact-path.md)),
and this directory is the session side of that.

- `file-fuse.ts`: does the running Electron binary leave a `file:` page the extra privileges Electron grants
  by default (`grantFileProtocolExtraPrivileges`, the fuse)? `fileProtocolFuse()` reads the fuse wire once,
  streaming the binary in 1 MiB chunks, and answers `'off'`, `'on'` or `'unknown'`; anything but `'off'` is
  treated as on. `knownFileProtocolFuse()` is the answer once read, for a caller that cannot wait.
- `partition.ts`: `localPartitionFor(url)`, the one function that says which session a local file belongs in:
  `persist:orivon-local-files` until the file is recorded, `persist:local-<hash of its key>` after.
- `local-file-apps.ts`: the record, `<userData>/local-file-apps.json`, of the files a person let use Orivon
  permissions (one key each, capped, a corrupt file reads as empty), and the installed record the shell asks.
- `file-handler.ts`: the `protocol.handle('file')` handler of a local session.
- `local-file-fence.ts`: the `webRequest` rule that cancels a `file:` document load that belongs to another
  local session. `local-partition.ts` makes a session local (handler and fence, once); `refuse-file-scheme.ts`
  answers `file:` with a 404 on every other session; `local-files-subsystem.ts` wires them to Electron.

Tied to Electron (`ARCHITECTURE.md`'s `src/main/` row): sessions, `protocol.handle` and a byte inside the binary.

**What it depends on.** `electron`, `../../broker/policy/origin.ts` and `grants/origin-hash.ts` (the key and its
hash), `../../loader/electron/serve.ts` (`liveCspHeaderFor`), `../sessions/web-request-owner.ts`, Node's `fs`.

**What it must never import.** Anything under `../shell/`: the tab code asks this directory which session a
file belongs in, never the reverse.

**Owner stream.** `sites`.

## Design notes

**The fuse is off in a packaged build and in a contributor's binary.** `electron-builder.yml` turns it
off for a package; `scripts/install-electron.mjs` turns it off in `node_modules/electron/dist` on Linux once the
binary is present (writing a new file and renaming it over the old, since a worktree's `node_modules`
shares its binary's inode with other checkouts). Both are why a page the shell loads never needs
`file:` (`../pages/shell-scheme.ts`). A feature that opens a local file asks `fileProtocolFuse()` first and
opens only on `'off'`: a checkout whose binary was not flipped (a copy made before the flip, an install that
skipped it, a macOS or Windows checkout, where the script refuses) reports `'on'` and opens no local file,
and the handler itself serves nothing then. The subsystem reads the fuse before any window opens, so
`TabOpener.openLocalFile` can ask `knownFileProtocolFuse()` without waiting.

**With the fuse off no channel reads another file, so the handler adds no policy of its own.** Measured on
Electron 44: `fetch`, XHR, module and JSON imports, frames, objects, workers, stylesheet rules and
`pushState` to another path all fail, an image taints a canvas, and XSLT `document()` of a sibling is empty.
What the handler does add is `X-Content-Type-Options: nosniff`, because a text file included as a `<script>`
is otherwise parsed as JavaScript and leaks its first unknown word through the error it raises. The cost is
that a file with no recognisable type does not run as a script. A base `Content-Security-Policy` would only
break pages: `file:///dir/` is not a valid source, so no directive can name "this folder".

**Web storage is shared by every `file:` document in a session, so sessions are what separate files.**
IndexedDB, Cache Storage, OPFS and `BroadcastChannel` are one store for the whole session (measured), and
`localStorage` throws (A396). A file the person has let use Orivon permissions is recorded and gets a
session of its own; every other file shares one. The record picks the session and is never a grant:
grants come only from a manifest read at the document (A137), and nothing is registered with the broker at
start. Recording moves the file to its own session and leaves its earlier storage behind (A398).

**One function names a file's session, and the fence enforces it.** `localPartitionFor` is used by the tab
(`../shell/tab-partition.ts`), by the fence and by attribution (`../sessions/session-attribution.ts`), so
they cannot disagree. A `file:` main-frame, frame or `<object>` load that belongs to another local session
is cancelled (a handler cannot tell a document from a subresource, but `webRequest` can). A cancelled main
frame fails with -20 and `../shell/pre-partition.ts` moves the tab; a 404 from a session that is not local
moves it through `did-navigate`. Scripts, styles and images are not fenced: they are not readable as data.

**A session is made local when a view is built for it.** Electron creates a session on first use and
gives it the 404 for `file:` (`refuse-file-scheme.ts`, from `session-created`); `makeTabView` asks
`ensureLocalSession` first, which takes that handler off and installs the real one, once per session.

**The record is read once, at start.** `LocalFileApps` reads synchronously and writes atomically on every
change; a write that fails changes nothing in memory.
