# ADR-0091: A dialog hands an app a stand-in path that `fs` reads and writes directly

- **Status:** accepted. *Provisional* on the picked file's name (below), which waits on a contract field.
- **Date:** 2026-10-19
- **Type:** architecture
- **Decided by:** owner for the stand-in path; AI recommendation accepted by default for the details below

## Decision

**`dialog.showOpenDialog` and `dialog.showSaveDialog` answer a made-up path, and the Node `fs` shim reads and writes the
pick through it.** No copy is made and no host path reaches the page. The seam is two small pieces, both tied to the
shim and neither to the contracts:

- **The table of picks** is [`src/shim-electron/picked-paths.ts`](../../src/shim-electron/picked-paths.ts) (durable). A pick is
  registered under a random 24-hex id: a picked file is `/orivon/picked/<id>/<name>`, a picked folder is
  `/orivon/picked/<id>`, and paths beneath the folder are relative to it. The namespace sits beside the app's own root
  (`/orivon/app`, `virtual-root.ts`) and never inside it. A path is normalised before it is matched, so a `..` can leave a
  pick for the app's root or the list of picks and can never stay inside one pick while reaching past its root, nor
  be handed to a handle as a relative path that climbs.
- **The routing** is [`src/shim/fs/picked.ts`](../../src/shim/fs/picked.ts) (durable). Every asynchronous `fs` call asks the table
  first: a path outside the namespace takes the app-root route unchanged. `readFile`, `writeFile`, `appendFile`, `stat`,
  `lstat`, `access`, `realpath`, `open` (and so `FileHandle` reads, writes, `truncate`, `sync`, the callback `read`/`write`
  family), `createReadStream`, `createWriteStream`, and, for a folder, `readdir`, `mkdir`, `rm`, `rmdir`, `unlink` and
  `rename` are answered by the pick's `FileHandle` or `DirectoryHandle`. The synchronous family fails
  `ENOSYS`, saying a pick has no synchronous wire; `existsSync` answers `false`, as Node's never throws; `fs.watch` is
  refused the same way and a write to a pick announces nothing.

**The open dialog is Orivon's own picker** (`orivon.fs.userSelected`): `openFile`, `openDirectory` and `multiSelections`
choose its shape; `filters`, `defaultPath`, `title`, `buttonLabel` and `message` are not applied, because the picker is worded to name
the app that asks and the choice is not filtered; each says so once in the console. **The save dialog is the web's
`showSaveFilePicker`**, which the permission gate already allows for one file ([ADR-0024](ADR-0024-the-permission-gate-allows-one-chosen-file.md)):
`defaultPath`'s last segment becomes `suggestedName` and `filters` become `types`. The returned handle is adapted to a
`FileHandle` and registered, and its writer commits when a call that wrote closes it. `showOpenDialogSync` and `showSaveDialogSync`
refuse by name. A call with no click or key press a moment before rejects naming the click; a dismissed save dialog
answers `canceled: true, filePath: ''`.

**A stand-in lives as long as the page.** The table is in the page's memory, so after a reload an old path matches no pick and every call on it
fails `ENOENT` with a message saying the pick did not survive and must be made again. The id is random for that reason: a counter
would let a path from before a reload name a different pick afterwards.

**Every picked file is called `picked-file`.** The handle `userSelected` returns carries no name and the stand-in must not reveal the
host path, so the picked file's basename and extension are not the real ones. A saved-to file keeps the name the
browser's picker reports.

## Context

Ported Electron apps call `dialog.showOpenDialog` and `showSaveDialog` and hand the returned host paths to `fs`. A page never gets a host
path, so every `dialog` method refused. Three ports each wrote a picker of their own (about 300 lines between them), and
WebTorrent copied each picked file into the app's storage, which doubles the disk use and is slow for a video. The compatibility
matrix called the shape an open question: a path-string idiom over an opaque handle.

## Alternatives considered

**Copy the pick into the app's files and return that path.** What WebTorrent does. It doubles the disk use, is slow for large files,
leaves the person's edits in a copy and not the file they chose, and a save target would need a copy back.

**Return the host path.** The broker's confinement exists so that no path is ever the page's to name (T1); a real path in the page is
a path an app can log, send or display, and a contracts change besides.

**A shim-only API that returns handles instead of paths.** It is Orivon-shaped, not Electron-shaped: every ported app would change its
call sites, which is the cost the porting rule exists to avoid.

**The table on `globalThis`.** Both packages are bundled into one app bundle, where a module is one instance, so a module-level table
is shared without a global. A global is how a second bundle in the page could read picks it was not handed. Its price is that a
Worker or a forked child, which loads its own shim, has an empty table and meets the stale-path error.

**`src/shim/` owning the table.** `src/shim-electron/` must never import `src/shim/` and the dialog registers the picks, so the table
lives in `shim-electron` and `src/shim/` reads it, the same direction as its existing import of `unimplemented.ts`.

**A new broker method for a save picker.** `src/contracts/` is the product surface and a save mode there is a larger decision than the
need. The web's own picker already reaches the same file with the same consent.

## Reasoning

The page already holds the handle; what an Electron app lacks is a string to put in `fs.readFile`. A stand-in path gives it one, and
routing it to the handle keeps every guarantee the handle has: the broker confines a folder's paths, quota is charged, and revoking
the pick ends the access. Nothing is copied, and the person's file is the file the app edits.

## Consequences

- The picked file's real name and extension are not available to the app. Where it matters (a torrent's name, a media player's guess from
  the extension) the app sees `picked-file`. A real name needs a field on the contract's `FileHandle` (A414).
- Nothing synchronous reaches a pick. An app that calls `statSync` or `readFileSync` on a pick fails at that line.
- A pick does not survive a reload or a restart; the app asks again, and the person sees the picker again.
- A page's handle has no `closed` yet (A184), so a revoked pick is not noticed ahead of time: its calls fail with the broker's `revoked`.
- A picked file's folder holds only that file: it can be stat-ed, listed and `mkdir -p`-ed, and nothing else can be created, removed or renamed
  there, so a save that writes a temporary file and renames it over the target fails with `EACCES` or `EXDEV`.
- A write to a save target is committed when the call that wrote it closes the file, so a program that holds a file open and never closes it
  leaves nothing on disk.

## Reversibility

- **Cost to reverse:** cheap. The table, the routing and the dialog are in the shims; the contracts and the broker are unchanged, and no
  state is stored.
- **What would make us revisit:** a `name` on the contract's `FileHandle` (the picked file then keeps its real name), a stream form of a page
  handle (A184, the chunked reads then become one stream), or a port that needs a pick to outlive a reload.
