# ADR-0042: Each profile and each private session is a process of its own

- **Status:** accepted
- **Date:** 2026-09-28
- **Type:** architecture
- **Decided by:** owner, for profiles and private sessions being separate processes and for private
  sessions keeping `orivon.*`; AI recommendation, accepted by the owner, for the directory layout,
  what a private session starts with and how it is deleted.

## Decision

A browser process is exactly one of: **the default profile**, **another profile**, or **a private
session**, for its whole life.

- **The default profile is the directory the app already uses.** Nothing moves and nothing is migrated.
  Other profiles are directories inside it, `profiles/<id>/`, each with a `profile.json` (name, colour,
  created). The list of profiles is the directories that hold one, so no file is shared between two
  running browsers. An id is twelve random hexadecimal characters, and one that does not have that
  shape is refused before any path is built from it.
- **A profile is opened by starting a peer process** with `--orivon-profile=<id>`, which points its
  data directory there before anything reads a byte. Electron's single-instance lock is per data
  directory, so starting a profile that is already open only asks the running one to show itself and to
  open any web address it was given. A profile that is running writes a marker with its process id, and a
  profile that is running is never deleted. Deleting one renames its directory first, so a browser
  started for it in the meantime finds nothing rather than half a directory.
- **A private session is a peer process on a fresh directory** in the system temp directory (mode
  0700), made by the browser that opens it and holding a copy of that profile's `settings.json` and of the
  light client's verified checkpoint, which is public. It never receives history, bookmarks, grants,
  installed apps, identity, zoom levels or site data. `orivon.*` works in it, consent is asked again (its
  ledger starts empty), and two things differ from a profile, both true to the contract: its identity seed
  lives in memory only, so `orivon.secrets.available()` is false and `orivon.id` is a new identity every
  session; and it keeps no history, sends no usage statistics and shows no welcome screen. It ends with
  its last window on every platform.
- **Its directory is deleted after the process has exited**, by the browser that opened it, and otherwise
  by the sweep every other browser runs shortly after it starts: directories owned by this user, not
  links, whose marker names a process that is gone, or with no marker and older than ten minutes.
  Deletion is never claimed to happen inside the dying process, because Chromium writes after quit and
  Windows will not delete an open file. A directory named on a command line is refused unless it was made
  this way, because it is deleted at the end.
- **A peer is passed only** the data directory and sandbox switches of the launch that started it. A
  debugger's port would collide with the first process's own.

## Context

One process holds one broker, one grant ledger, one verifier, one telemetry runner and one identity seed,
and every store hangs off one data directory. Two profiles in one process would share all of it unless the
broker were rebuilt to hold several sets, which is the security-critical part of the browser.

## Alternatives considered

- **Several profiles or private sessions inside one process.** Fifteen places where the broker, the
  loader, the app registries and the per-app storage assume one of each were found. It reworks the
  transport that decides what an app may do, and a mistake leaks one profile's grants or data into
  another's, silently. Rejected as the wrong place to spend care.
- **Private sessions as a partition only.** The web session would be isolated, but grants, an app's
  confined files, its pinned code and the identity seed live outside any partition, so they would outlive
  the window.
- **A shared list of profiles in one file.** Two running browsers writing it would race, and a damaged
  file would hide every profile. A directory per profile has neither problem.

## Reasoning

A directory and a process are the boundary the operating system already enforces, so "nothing of this
profile is visible to that one" needs no check to remember. The costs are known and accepted: about
150-300 MB and one to two seconds per profile or private session, and one light client each.

## Consequences

- A second launch of the same profile no longer opens a second browser. A development run and an installed
  one that share a data directory now hand over to each other (`open-questions.md`).
- Windows opened from inside a private session (a new window, a tab moved out) belong to that session;
  "New private window" always starts a new one. A tab cannot be moved between profiles or into a private
  session, by construction, and the tab menu does not offer it.
- Telemetry's install id is per data directory, so a second profile counts as a second install
  (`open-questions.md`).
- A private session still shows a person's network address to sites, keeps downloaded files, and does not
  hide who they sign in as: the Private page says so.
