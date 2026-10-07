# ADR-0057: Orivon's identity to the operating system is fixed names, registered only by an installed package

- **Status:** proposed
- **Date:** 2026-10-05
- **Type:** architecture
- **Decided by:** AI recommendation accepted by default; the owner chose the Linux run-from-source exception, and
  that a run from source is a program of its own (`d-0554`)

## Decision

What the operating system holds about Orivon is keyed on names that never change, and only an installed
package writes them. The names are `orivon.desktop` (the Linux entry), `com.orivonstack.orivon` (the app
user model id of an installed Windows program; a run from source uses `com.orivonstack.orivon.source`),
`OrivonURL` (the Windows URL class) and `StartMenuInternet\Orivon` (the Windows client key and the name
`RegisteredApplications` lists). An installed package (a .deb, an NSIS installer, a macOS app) registers them
at install time. The browser itself registers nothing at start-up: from an installed package it asks, and only
a person's click (Settings, the welcome screen's box or the weekly question) makes the call. An AppImage and a
private session never register, and say why. A run from source registers only on Linux, and only its own entry,
`orivon-source.desktop` ("Orivon (source)"), which `scripts/launch-from-source.mjs install` writes for one checkout;
elsewhere, or with no entry, it says why. A run from source never writes or names `orivon.desktop`.

A run from source is a program of its own beside an installed package. Before it reads any data it names itself
`orivon-source` (`takeSourceIdentity` in `src/main/launch/start-launch.ts`), so its data directory
(`<appData>/orivon-source`), its single-instance lock, its window class and its Wayland app id are never the
package's, and a dock files its windows under `orivon-source.desktop` and `build/icon-source.png`. A launch that names
its directory with `--user-data-dir` keeps it. Neither takes the other's starts or links.

## Context

A pinned taskbar button, a default-app choice and a desktop environment's browser list are all keyed on these
names. A326 asked whether the browser should offer to become the default, and A375 found the package claiming
a type it could not open (both now in `resolved-questions.md`). The earlier rule (`d-0320`) allowed a registration only
from a packaged build on a press of the button, which left Windows and macOS with no path and nothing offering.

## Alternatives considered

- **Register at start-up from any run.** Rejected: a run from source would register the Electron binary, an
  AppImage moves and leaves a stale registration, and a test run would change the machine's default browser.
- **Never register from source.** Rejected for Linux: there a choice names a desktop entry, not a binary, and a
  developer who browses with a run from source has no other way to receive links. A test build never names the
  entry, so a test run still cannot change the default.
- **Let a run from source share the installed package's profile and lock.** Rejected: the two then file their
  windows under one dock icon, whichever starts first receives the other's starts, and any fuse that differs between
  the two binaries rewrites the other's data (a binary without cookie encryption deletes every cookie the package
  encrypted). A developer runs them as two programs, one of them the release as a person gets it.
- **Let each profile or each run mint its own identity.** Rejected: a profile is a data directory, not an
  application, and a name that varies per run cannot be pinned.
- **Register on Windows from the program (`setAsDefaultProtocolClient`).** Rejected: Windows ignores it for
  `http` and `https`; the person alone chooses, in Windows Settings, so the browser opens that page.

## Reasoning

The registry, the desktop entry and the taskbar are written by the thing that installs the program and removed by
the thing that removes it, so a name outlives no install. Keeping the names fixed means an update, a reinstall or a
move of the program keeps the person's choices.

## Consequences

Renaming any of the names costs every person their pinned button and default-app choice, so a rename needs a
migration; the name a person reads (the Linux entry's "Orivon Browser", the window's title) is not one of them. A run
from source still stores its profile as a package does: an Electron fuse that changes what lands in the profile is set
in both, by `electron-builder.yml` for a package and by `scripts/install-electron.mjs` for a checkout's binary, so a
profile moved from one to the other reads back. Cookie encryption is one: a binary without it reads none of the
cookies an encrypting binary wrote and deletes them, which signs the person out of every site. An entry
`launch-from-source.mjs install` wrote is rewritten by `npm start` and by the launcher when the checkout moves on, so
it keeps claiming the windows that checkout makes. The Windows and macOS paths are written from the builders'
documentation and are *provisional* until a package is built on those systems (A328).

## Reversibility

- **Cost to reverse:** expensive once packages ship: a person's choices are keyed on the names.
- **What would make us revisit:** a platform that lets a program set the default itself, or a second program
  identity (a separate private-window program) that needs a name of its own.
