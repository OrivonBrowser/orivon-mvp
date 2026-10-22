# ADR-0093: A package's tag selects an app's first-run presets from an allowlist

- **Status:** accepted, provisional until the Windows installer's file name has been read on a real install; **amended 2026-10-22 (`d-0722`)**: a release carries the plain packages only, and tagged copies are made apart from it (see Amendment)
- **Date:** 2026-10-20
- **Type:** product
- **Decided by:** owner

## Decision

A release package can be tagged for one app. The tag is a lowercase id (`freetube`) that names an
entry of `resources/flavours.json`, the allowlist; it reaches the browser as the file name of the
Windows installer (`Orivon-Setup-<version>-x64.<id>.exe`, written verbatim by the installer to
`installer-name.txt` beside the program), as the file name of the AppImage
(`Orivon-<version>-x86_64.<id>.AppImage`), or as the switch `--orivon-flavour=<id>` (which the macOS
install script passes on the first launch it starts). On the first run of a new default profile, and
only then, the browser opens that app in a tab as the address bar would after the welcome screen
closes, so the app's own question about what it may do is asked as for any visit, and pins it first
in the new tab's Featured row. It stores the id once, in `flavour.json` of the profile.

A tagged package is the same bytes as the plain one under another name: the release workflow copies
the built installer and AppImage once per allowlisted id, fails the release if a copy's SHA-256
differs, and fails it if an entry's app is not the `domain` its port declares on `main`. Nothing is
rebuilt per app. The `.deb`, the dmg and the Store package carry no tag.

## Context

A person who comes for one app should land on it. The installer is the one place they chose an app
before the browser ever ran. A build per app would multiply every release, its signing and its
checks by the number of apps; a tag in the file name costs one copy.

## Alternatives considered

- **A separate build per app.** Rejected: one compiled package per system per release is what the
  smoke, signing and IPFS pin work on, and a build that differs from the plain one is a build nobody
  has run.
- **An address or free text in the tag.** Rejected: a file name is chosen by whoever hands the file
  over, so a tag that could carry an address would let a link in a file name open any page on the
  first run. The tag only selects.
- **A setting the person picks in the welcome screen.** Not rejected: it answers a different
  question (a person with the plain package). This decision is about a package that already says.
- **Reading the tag on every start.** Rejected: a tag that outlives the first run would change a
  profile the person has used, and the update path would then depend on a file name.

## Reasoning

The allowlist makes the worst a hostile name can do equal to the best a plain first run can: nothing
for an id that is unknown or malformed, silently. Applying only to a new default profile, once, keeps
a copied installer from changing a profile that has history. Opening the app through the ordinary
navigation path keeps the consent prompt, because the presets must never decide what an app may do.

## Consequences

- The release carries twelve more files (six apps, two systems) the size of the originals, and the
  IPFS folder grows with them; the workflow's two checks are the price of trusting a copy.
- An id is lowercase letters and digits, 2 to 24, because it must survive a file name, a command line
  and a browser's `(1)` suffix on a second download; ids are never reused for another app.
- An app is on the allowlist only when its checks run on a real stack: an app whose tests use an
  emulator or a mock is not.
- A later link into the browser may name an id too; it goes through the same function
  (`applyFirstRunFlavour`), so the allowlist, the new-profile rule and the once-only rule hold there.
- The presets are: the app tab, its Featured pin and the stored id. They never grant, consent,
  answer the telemetry question, set the default browser, change a search engine, a score provider,
  a tunnel or any setting. Nothing in the update path reads a tag.

## Amendment recorded 2026-10-22

The release workflow no longer makes the tagged copies, and a release and its IPFS folder carry the plain packages
only (`d-0722`). A tagged package is still a copy of the plain installer or AppImage under the tagged name, the same
bytes, made apart from the release when one is wanted; nothing about how the browser reads a tag changes. The
workflow keeps one of its two checks: it fails the release if an entry's app is not the `domain` its port declares
on `main`, since the allowlist ships in every package. The first Consequences line, twelve more files in each
release and its IPFS folder, no longer holds.

## Reversibility

- **Cost to reverse:** cheap. Dropping the tagged copies and the module leaves the plain packages
  as they are; a `flavour.json` in a profile is ignored.
- **What would make us revisit:** a tag read from a name that a download manager rewrites, seen on a
  real Windows install; or an app on the allowlist that cannot run first-time without a setting.
