# ADR-0062: Orivon installs its own update only from a release an offline key signed

- **Status:** accepted
- **Date:** 2026-10-06
- **Type:** security
- **Decided by:** owner (the request to alert on a new stable release and let the person install it or open GitHub; the offline key and the default of the check, 2026-10-06)

## Decision

An installed Orivon looks once a day for the newest stable release of its own repository that carries a signed
file list, and asks the person, in the window they are using, whether to install it, open its page, or do
nothing. It installs only after the person says so. What it installs is a package of that release whose SHA-256
and size appear in `orivon-update.json`, a list that an Ed25519 key held offline by the maintainer signed
(`orivon-update.json.sig`, over the exact bytes of the list). The public half is in
`src/main/self-update/update-signing-key.ts`, as a list so a key can be rotated in before the old one is
retired. Nothing is installed from a release without both files, with a signature that no trusted key makes, or
whose version is not its tag's.

- **Release choice.** Drafts, prereleases, any tag or name containing "nightly", tags that are not a plain
  `MAJOR.MINOR.PATCH` and releases without both signed files are never offered. A release counts as ready only
  once it is signed, so a release whose packages are still being attached is not offered early.
- **What is fetched.** Every address is built from the repository constants and a tag that is only a version;
  nothing in an answer is fetched or opened. The package may redirect to GitHub's asset host: what is trusted is
  the signed hash, not the host.
- **How a copy replaces itself.** An AppImage is replaced in its own folder by a staged copy renamed over it; a
  `.deb` is installed through `pkexec dpkg -i` with the system's own prompt; the Windows installer is run with
  its update flags; a macOS app is swapped from the mounted disk image with the old app put back on failure.
  A copy run from source, or installed in a way none of these replaces, is offered the release page alone.
  The macOS swap is *provisional*: no Mac has run it. Measuring it on one settles it.
- **The restart.** The browser quits through the ordinary quit, so the session is written, and the next start
  restores the windows and tabs whatever the start-up setting says.
- **The check is on by default** in installed packages (`updates.check`), and never runs by itself from source.

## Context

The earlier decision was that Orivon checks and notifies and never installs, because unsigned `electron-updater`
verifies a hash fetched from the same host as the binary, so a stolen GitHub token would be a remote-code-execution
channel into every browser. That decision named its own way out: sign the update list with an offline key.
This decision is that way out. The owner asked for the person to be able to install a new stable release from
the browser, or to open it on GitHub.

## Alternatives considered

- **`electron-updater`.** Its trust is the hash in a manifest on the same host as the binary, the property that
  made installing unacceptable. It also needs a Developer ID signature to update on macOS (Squirrel.Mac),
  which the project does not buy, and it would be a second release source beside the check that already exists.
- **A signing key held as a GitHub Actions secret.** The token that can publish a release could then also sign:
  the compromise this exists to remove.
- **Unsigned install from the release.** Same host, same trust: rejected for the reason above.
- **Notify and link only.** The earlier behaviour; the owner asked for more.

## Reasoning

A person who installs Orivon has already trusted the maintainer's key once, by installing a build that carries
it. Verifying updates against that key adds no new party. The signature covers hashes, so the transport does not
matter and a mirror or an IPFS copy of a package verifies the same way.

## Consequences

- **Key custody.** The private key lives on the maintainer's own machine, offline, and signs after each release
  job finishes with `scripts/release/sign-update.mjs`. One person holds it; losing it ends updates from the
  browser until people install a build carrying a new key by hand. There is no revocation list in this build
  (*provisional*): a leaked key is rotated by signing a release that carries the new key, which an attacker who holds
  the old key can sign too, so a leak is answered by a manual reinstall notice, not by the browser.
- **What an attacker with a GitHub token can do.** Publish, delete or alter releases and assets. They cannot make a
  browser install a package of their own: a changed package fails its signed hash, a changed list fails the
  signature, an old signed list under a new tag fails the version check, and an old release is never newer.
  They can withhold updates, or make the install fail with a refusal the person sees.
- **What signing does not cover.** The maintainer signs the packages the release holds when the script runs. An
  attacker who replaces a package before then, or changes the workflow that builds it, has their package signed too.
  Signing soon after the release job finishes keeps that window short; closing it needs builds anyone can
  reproduce, which this build does not have.
- **What they cannot be stopped from.** A person who opens "Download from GitHub" and installs by hand gets
  what GitHub serves, as before. Packages carry no vendor code-signing certificate on Windows or macOS.
- **A release re-run changes the packages.** The signature then no longer matches: the maintainer signs again
  after the last re-run.
- **A deb install runs the package's maintainer scripts as root,** after the person confirms in the system prompt;
  the package is the signed one.
- **The downloaded package can be replaced between the hash check and the root install.** A process running as the
  same user can swap the file in that gap. Such a process can already ask pkexec for itself, so this build accepts it.
  Closing the gap would mean the password prompt names a shell rather than dpkg.

## Reversibility

- **Cost to reverse:** moderate. Removing the install leaves the check and its prompt; the key list and the list
  format are read by every installed browser, so changing the format means supporting the old one for a while.
- **What would make us revisit:** a second person holding a key, which wants a threshold or a revocation list; a
  measurement of the macOS swap on a Mac that fails.
