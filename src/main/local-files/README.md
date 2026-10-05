# `src/main/local-files/`: what this build's binary lets a `file:` page do

**What lives here.** `file-fuse.ts` answers one question about the running Electron binary: does it
leave a `file:` page the extra privileges Electron grants by default (`grantFileProtocolExtraPrivileges`,
the fuse)? `fileProtocolFuse()` reads the fuse wire once, streaming the binary in 1 MiB chunks
instead of loading its 200 MB, and answers `'off'`, `'on'` or `'unknown'`. Anything but `'off'` is
treated as on.

Tied to Electron (`ARCHITECTURE.md`'s `src/main/` row): the answer is a byte inside the binary.

**What it depends on.** Node's `fs/promises` and `path`; nothing of Orivon's.

**What it must never import.** Anything that needs the fuse to be off to work: the check says what
the binary does, and the feature that depends on it asks here.

**Owner stream.** `sites`.

## Design notes

**The fuse is off in a packaged build and in a contributor's binary.** `electron-builder.yml` turns it
off for a package; `scripts/install-electron.mjs` turns it off in `node_modules/electron/dist` once the
binary is present (writing a new file and renaming it over the old, since a worktree's `node_modules`
shares its binary's inode with other checkouts). Both are why a page the shell loads never needs
`file:` (`../pages/shell-scheme.ts`), and why a local file is opened only when this check says `'off'`:
a checkout whose binary was not flipped (a copy made before the flip, an install that skipped it)
reports `'on'` and opens no local file until `npm run install:electron` runs there.

**The sentinel is searched in chunks, and every one must agree.** The wire follows a 32-byte
sentinel, so a chunk boundary can split it: the tail of each chunk is searched again with the next. A
universal macOS build has two sentinels; `'off'` needs all of them off. A wire of another version, one
too short to hold this fuse, or a removed fuse (byte 114) is `'unknown'`.

**The constants repeat `@electron/fuses`'s.** The main process cannot import a development
dependency, so the sentinel and the fuse's index and state bytes are copied here, and
`tests/file-fuse.test.ts` fails when they stop equalling the library's.
