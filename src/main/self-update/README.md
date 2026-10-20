# `src/main/self-update/`: look for a signed release, ask, install

**What lives here.** Orivon's own update. It looks once a day for the newest stable release of its repository
that carries a signed file list, asks the person what to do in the window they are using, and, only when they
say so, downloads the package for this copy, checks it against the signed hash and replaces itself
([`ADR-0062`](../../../docs/decisions/ADR-0062-orivon-installs-its-own-update-only-from-a-release-an-offline-key-signed.md)).

| Piece | Files |
|---|---|
| Which release | `release-pick.ts` (drafts, nightlies, tags that are not plain versions and unsigned releases are never picked; a GitHub pre-release is, since every release here is one), `update-source.ts` (reads the list and the signed files from addresses it builds itself), `release-url.ts`, `github-release-version.ts` |
| Whether to believe it | `update-manifest.ts` (the signed list, verified with `node:crypto`), `update-signing-key.ts` (the trusted public keys) |
| When to look and ask | `update-check.ts` (the decision table), `update-checker.ts` (the daily look and the ask once per version), `update-schedule.ts` (start, hourly, on the setting), `update-ask.ts` (the two questions' words and buttons), `update-state.ts` (the state file) |
| What this copy is | `install-kind.ts` (AppImage, deb, Windows installer, macOS app, or none: a run from source), `install-plan.ts` (the steps for each, as data, and what is checked first) |
| Doing it | `update-flow.ts` (the one install that runs, its progress and failures), `download-update.ts` and `download-verify.ts` (the download, hashed as it arrives), `install-update.ts` and `install-host.ts` (the steps, performed), `restart-marker.ts` (the note that brings the windows back) |
| The page | `updates-domain.ts` (what Settings may ask), `update-answer.ts` (what it is told) |
| Wiring | `self-update.ts`, tied to Electron; `update-test-seam.ts`, test builds only |

**Tied to Electron.** `self-update.ts` only, and `update-test-seam.ts` reads a compile-time flag. Every other file
takes what it needs (`fetch`, a host, the clock) as a parameter and runs under plain vitest.

**What it depends on.** `electron` (`self-update.ts`: `net`, `app.relaunch`, `app.quit`), `node:crypto`, `node:fs`,
`node:child_process` (programs run by argument array, never a shell string),
[`../shell/question/`](../shell/question/) (the questions), [`../page-tools/toast.ts`](../page-tools/toast.ts)
(progress), [`../os/install-default-browser-ask.ts`](../os/install-default-browser-ask.ts) (`askPlace`: the window
the person is using) and [`../launch/launch-context.ts`](../launch/launch-context.ts) (the arguments a restart keeps).

**What it must never import.** [`../consent/`](../consent/) or [`../install/`](../install/): a browser update and an
app grant are different questions, asked in different dialogs, under different rules.

**Owner stream.** `shell`.

## Design notes

**Nothing installs without the signature, and the signature covers hashes.** `verifyManifest` checks the Ed25519
signature over the manifest's exact bytes before parsing it, then that its version is the tag's and every name,
hash and size has the expected shape. The package is accepted only at exactly the listed size and SHA-256
(`consumeDownload` stops reading the moment it outgrows the size), so the host that serves it is not trusted: a
redirect to GitHub's asset host is fine. A release without both signed files is not offered at all, so a release
whose packages are still being attached is not offered early; a manifest that fails verification is logged and
the release is not offered.

**The browser installs the release it found itself.** The page asks to install and names nothing: main installs
the release its own last look found, so a compromised Settings page cannot name a package or an address.

**Asked once per version, in a window the person is using.** `lastNotifiedVersion` is written only once the question
was shown. With no window in use (hidden, minimised, a welcome screen or restore bar over it) the release waits in
memory and the next hourly look asks without asking the network again, and the day's look is not recorded until
the person has been asked, so a restart looks again.

**A copy that cannot replace itself is offered the release page alone.** A run from source, a Linux copy that is
neither an AppImage nor owned by the system's package manager (a package carries no `package-type` file here,
because `publish` is `null`: ownership is asked of `dpkg-query -S`), a folder that cannot be written, a missing
`pkexec`, a macOS app running from a translocated place, and a release with no package for this system each say
so in one sentence in the question and in Settings.

**Every replacement stages first and swaps last.** The AppImage is copied beside itself and renamed over, the
macOS app is copied beside itself and swapped with the old one set aside and put back on failure, the deb is the
system's own install behind its own prompt (a refusal reads as "you did not allow it", not as a failure), and the
Windows installer takes over and starts the new copy. The macOS swap is *provisional*: no Mac has run it.

**An update restart restores the session.** Before the restart a one-shot note (`restart-marker.ts`) is written
in the profile's folder; the next start takes it, removes it, and opens the last session whatever `startup.mode`
says. The note is written when the restart is armed, not before the install, so a slow password prompt cannot age it, and a
note older than fifteen minutes belongs to an install that never finished and is ignored. If a page's unload guard cancels
the quit, the update is already on disk and the armed relaunch stays, so the next quit starts the new copy.

**The check is on by default in installed packages and never runs by itself from source.** "Check now" works from
source and offers the release page. A private session looks at nothing.

**Test builds replace the world, never an ordinary build.** `update-test-seam.ts` points the check at a local
server, trusts one more key and records what would have been installed; the names it uses are in
`scripts/check-dev-grant-absent.mjs`.
