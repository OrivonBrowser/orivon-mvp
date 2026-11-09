# ADR-0108: A session's folder name keeps 32 digits of the origin's hash, and the folders of the old names are renamed at launch

- **Status:** accepted
- **Date:** 2026-11-09
- **Type:** architecture
- **Decided by:** owner (shorten the names, and move every existing folder once at launch so nobody loses an app's data); AI for the rest

## Decision

Every persistent session Orivon names from an origin's hash keeps the first 32 hex digits of `originHash`
(`sha256_hex(utf8(origin))`) in its name instead of all 64: an installed app's `persist:app-`, the session a page an app
shows runs in (`persist:embed-`), and a recorded local file's (`persist:local-`). The folder on disk is
`<userData>/Partitions/<kind>-<32 hex>`. One function (`hashedPartitionName`, `src/broker/grants/origin-hash.ts`) builds
all three, and the list of kinds in that file is what the move reads.

At every start, before any session is made, Orivon renames each `Partitions/<kind>-<64 hex>` to `<kind>-<first 32 hex>`
(`src/main/launch/partition-folders.ts`). It only renames: a folder is never copied, merged, overwritten or deleted.

- A short name that does not exist: the rename.
- A short name that is an empty folder: that folder is removed (it holds no data) and the rename follows.
- A short name that holds anything: nothing moves, both folders stay, and the log says so. This repeats at every start for as long as it lasts.
- A rename the system refuses because a process holds the folder (`EBUSY`, `EPERM`, `EACCES`, which Windows answers while another process has a file in it): all such folders are tried again after pauses of 100, 250, 650, 1000 and 2000 ms (about four seconds in all, spent only when a folder is refused), and a folder still refused stays under its long name until the next start. Any other refusal waits for the next start without a pause.
- Every outcome is a `[partitions]` line in the log, so `orivon://report` shows it. A start with nothing to move logs nothing.

What is keyed by the whole hash and is not a session folder stays as it is: `grants/<hash>`, `apps/<hash>`,
`app-data/<hash>`. So do the in-memory sessions (no folder) and the legacy `site-<64 hex>` sessions, which are only ever
cleared.

## Context

Windows refuses a path over 259 characters, and Electron's binary declares no support for longer ones, so nothing Orivon
sets changes it. An installed app's session folder was `Partitions\app-<64 hex>`. Chromium's deepest Cache Storage file,
`Service Worker\CacheStorage\<40 hex>\<uuid>\index-dir\the-real-index`, is about 130 characters below it, 211 below the
profile folder. A profile folder over 48 characters (a user name over about 16 under `AppData\Roaming\Orivon`) leaves a
service worker's cache without a place for its index: Chromium logs `simple_index_file.cc ... Could not create a directory to
hold the index file`, the worker's install fails, and the page sees nothing, so an app with an offline copy loses it. A
test profile in the Windows runner's default temporary folder (55 characters) fails the same way, and
`test/app-loading/e2e-app-service-worker-cache.test.ts` is that case.

Releases already ran with the 64-digit names, so real profiles hold these folders, and the owner's decision was that
nobody loses an app's data to a rename of folders.

## Alternatives considered

- **Keep 64 digits and rely on Windows' long-path setting.** Rejected: that per-computer setting helps a program whose
  manifest declares support, Electron's declares none, and a run from source uses Electron's own binary.
- **Fewer digits, 16.** Rejected: it saves 16 more characters nobody is short of, and 64 bits is within reach of a
  determined search for another origin with a given name.
- **A short counter for each origin, kept in a table.** Rejected: the table would be state every app's data hangs from, and
  a lost or damaged one would orphan every session; the hash needs no table.
- **Leave the old folders and start the new names empty.** Rejected: every installed app, embed and local file loses its
  storage, which is the outcome the owner ruled out.
- **Copy the data, then delete the old folder.** Rejected: hundreds of megabytes at a start, a crash halfway leaves two partial
  folders, and it deletes. A rename on one volume moves nothing.
- **Merge into a short name that already holds data.** Rejected: the folders hold LevelDB and SQLite databases that nothing merges safely.

## Reasoning

32 digits are 128 bits. Among a million origins on one computer the chance that two share a name is about 10^-27. To run
in an installed app's session, another origin would need the same 32 digits as that app's: a second origin for a given
hash, about 2^128 work, beyond any attacker. A pair of colliding origins costs about 2^64 work and shares a session
between two origins that one attacker owns, which gains nothing. The sessions hold web storage only: grants, app files and the
`orivon.fs` root stay on the whole hash.

32 digits put the deepest Chromium file about 179 characters below the profile folder for an app's session (181 for
the other kinds, whose names are two characters longer), so one of up to 80 characters works (78 for those), a Windows
user name up to about 48, where 64 digits allowed 48.

Electron opens the session `persist:<name>` in `<userData>/Partitions/<name>`. The names here are a kind, a hyphen and
lowercase hex, which a folder name needs no escaping or case folding for, and `e2e-app-partition-move.test.ts` reads the
folder under the short name from a real launch and shows an app finding its data in it, on every system the cross-OS run covers.

## Consequences

- A folder whose rename is refused at a start stays under its long name, and its app runs that start with an empty session
  under the short name. The next start then finds the short name holding data and leaves both folders (the third bullet
  above): the older data is on disk, untouched, and not the one the app reads. The retries make this rare; it is
  logged every time it happens, and it can only be settled by a person with the folders in hand. Every way Orivon
  deletes a site's or an app's data (clearing it, removing a recorded local file, the cleanup of orphaned app sessions)
  acts through the session's name, so none of them reaches a folder left under the long name.
- Going back to an earlier build makes that build open `app-<64 hex>` again, empty, while the data is under the short
  names; and what that build then writes meets the third bullet at the next start of this one.
- The cleanup of orphaned app sessions (`src/main/pages/orphaned-app-partitions.ts`) asks for a session by an origin's
  name and never reads the folder, so it names the short name and cannot reach a folder still waiting under the long one.
- The move costs one directory listing at every start.
- `PARTITION_HASH_LENGTH` and the list of kinds are a one-way door: a different length is another move like this one.

## Reversibility

- **Cost to reverse:** one-way door once a profile has been moved: reversing it is the same move the other way, for every
  profile, and a build that has not heard of it finds empty sessions.
- **What would make us revisit:** a Windows path limit that Electron's binary lifts (long paths declared in its manifest)
  would remove the reason for the length, not the need to keep names stable; a use of the session name where 128 bits are
  not enough.
