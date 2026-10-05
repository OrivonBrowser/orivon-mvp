# ADR-0057: Orivon's identity to the operating system is fixed names, registered only by an installed package

- **Status:** proposed
- **Date:** 2026-10-05
- **Type:** architecture
- **Decided by:** AI recommendation accepted by default

## Decision

What the operating system holds about Orivon is keyed on names that never change, and only an installed
package writes them. The names are `orivon.desktop` (the Linux entry), `com.orivonstack.orivon` (the app
user model id of an installed Windows program; a run from source uses `com.orivonstack.orivon.source`),
`OrivonURL` (the Windows URL class) and `StartMenuInternet\Orivon` (the Windows client key and the name
`RegisteredApplications` lists). An installed package (a .deb, an NSIS installer, a macOS app) registers them
at install time. The browser itself registers nothing at start-up: from an installed package it asks, and only
a person's click (Settings, the welcome screen's box or the weekly question) makes the call. A run from source,
an AppImage and a private session never register, and say why.

## Context

A pinned taskbar button, a default-app choice and a desktop environment's browser list are all keyed on these
names. `docs/open-questions.md` A326 asked whether the browser should offer to become the default, and A375
found the package claiming a type it could not open. The earlier rule (`d-0320`) allowed a registration only
from a packaged build on a press of the button, which left Windows and macOS with no path and nothing offering.

## Alternatives considered

- **Register at start-up from any run.** Rejected: a run from source would register the Electron binary, an
  AppImage moves and leaves a stale registration, and a test run would change the machine's default browser.
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
migration. The Windows and macOS paths are written from the builders' documentation and are *provisional* until
a package is built on those systems (A328).

## Reversibility

- **Cost to reverse:** expensive once packages ship: a person's choices are keyed on the names.
- **What would make us revisit:** a platform that lets a program set the default itself, or a second program
  identity (a separate private-window program) that needs a name of its own.
