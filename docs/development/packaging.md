# Packaging

Orivon is packaged for three systems by [`electron-builder`](https://www.electron.build) from
[`electron-builder.yml`](../../electron-builder.yml) at the repo root:

| System | Package | Signed |
|---|---|---|
| Linux (x64) | `orivon_<version>_amd64.deb` and `Orivon-<version>-x86_64.AppImage` | no (Linux packages are not) |
| Windows (x64) | `Orivon-Setup-<version>-x64.exe`, an NSIS installer | no: SmartScreen warns on first run |
| Windows (x64), Microsoft Store | `Orivon-Store-<version>-x64.appx` | no: the Store signs it after upload (section The Microsoft Store package) |
| macOS | `Orivon-<version>-arm64.dmg` (Apple silicon) and `Orivon-<version>-x64.dmg` (Intel) | ad hoc: Gatekeeper asks once |

The three systems are equal, and Linux is supported on X11 and Wayland both. Each GitHub release
builds all of them and attaches them to itself (section Releases), except the Store package, which
the owner uploads to Partner Center. No certificate is bought, so the Windows installer and the macOS
packages are not trusted by their systems out of the box (section Windows and macOS). Running from source stays supported on every system ([`setup.md`](setup.md)); its users
and the package users count the same, and their telemetry works identically.

> **Status.** CI builds every package on its own system, installs or mounts it, and launches it
> until the shell page renders (section Releases). **Not yet checked against a real build:** the
> desktop-entry contents, the `MimeType=`/`Categories=` composition, and the `xdg-settings`
> registration flow. section Known gaps lists what is and is not confirmed.

## `deb` is the primary artefact

Not a coin flip between two equally good options. The success metric is measured in
daily-driver hours, and only an **installed package**
can put a `.desktop` file where `xdg-settings` looks for it. `xdg-settings
set default-web-browser` walks `/usr/share/applications/`, not the filesystem in general, and a
bare AppImage never places anything there on its own, and electron-builder's own docs say plainly
that since electron-builder 21, AppImages do not automatically create desktop files, associate
file types, or register with the application menu.

So:
- **`deb`** is what makes "set Orivon as your default browser" reachable at all.
- **`AppImage`** is for trying Orivon without installing anything. It still carries the same
  `.desktop` metadata internally (electron-builder generates one for every Linux target from the
  shared `linux:` config), but nothing copies it into `~/.local/share/applications/` for you. A
  first-run "install desktop entry" flow that does that from inside the running app is not built,
  and nothing in this config makes it impossible.

## How to build

`electron-builder` (`^26.15.3`) is a `devDependency` of this repository; run `npm install` and
it's there.

```bash
npm run package:linux   # on Linux
npm run package:win     # on Windows
npm run package:mac     # on macOS: both architectures
```

Each first runs `node scripts/fetch-bundled-extensions.mjs --required`, which downloads the extensions a new profile starts with
(uBlock Origin, pinned to a release and its sha256 in `resources/default-profile/bundled-extensions.json`) and fails the
package when one cannot be fetched or does not match, so a release never ships without them. `electron-builder.yml`
copies `resources/default-profile/` into the package's resources folder. Each then runs the ordinary build (`scripts/build-ordinary.mjs`: `out/main`, `out/preload`,
`out/renderer`, with the developer-only grant path stripped), then `electron-builder` for that
system with `--publish never`. `electron-builder` does not build the app itself: it packages
whatever is in `out/`. Build each system on that system: a Windows installer can be built
elsewhere only through Wine, and a dmg only on macOS. Output lands in `release/` (gitignored).

To check a package starts, launch it on a throwaway profile:

```bash
node scripts/run-headless.mjs node scripts/smoke-packaged.mjs release/linux-unpacked/orivon
```

It passes once the shell page has rendered from inside `app.asar`, and prints the app's output
when it does not.

## Releases

[`.github/workflows/release.yml`](../../.github/workflows/release.yml) builds the packages.

1. Tag the release `v<semver>` (`v0.1.0`, `v0.2.0-beta.1`) and publish it on GitHub, as a release
   or a pre-release. A saved draft builds nothing until it is published.
2. The workflow sets each package's version from the tag (`package.json` stays `0.0.0` in git),
   builds on `ubuntu-latest`, `windows-latest` and `macos-latest`, then installs the deb and runs
   the AppImage, installs the Windows installer silently, and mounts each dmg, checking its
   signature, and launches each one with `scripts/smoke-packaged.mjs`. The Windows leg also installs
   the Store package and launches it (section The Microsoft Store package).
3. When every system passes, a separate job attaches the packages to the release. If one system
   fails, nothing is attached: re-run the failed job from the Actions tab, and the attach job
   follows. Re-running replaces assets of the same name.
4. A release build first refuses an `.eth` light-client checkpoint
   (`src/main/verifier/mainnet-checkpoint.json`) over 14 days old: the app rejects one that old,
   and a fresh install of that release would verify no `.eth` name. Refresh it before tagging
   ([`release-checklist.md`](release-checklist.md)).

A pull request that changes `electron-builder.yml`, `build/`, `scripts/smoke-packaged.mjs` or the
workflow runs the same build and launch, and keeps the packages for seven days as workflow
artifacts instead of attaching them (the Store package, 30 days, in every run). Actions > Release > Run workflow does the same on demand.

The job that writes to the release only downloads the packages (the artifacts named `orivon-*`) and uploads them. The jobs that
run `npm ci` or Kubo hold a read-only token, so no dependency's install script can alter a release.

### On IPFS

Every release is also one folder on IPFS. Its `ipfs://<cid>` is in the release's description,
under "On IPFS", which the workflow writes, and in the `ipfs.json` attached to it:

```json
{ "cid": "bafy...", "add": "ipfs add -r --cid-version=1 ...", "files": [{ "name": "orivon_0.1.0_amd64.deb", "sha256": "..." }] }
```

- **The workflow** computes the CID with [`scripts/pin-releases.sh`](../../scripts/pin-releases.sh)
  `manifest`, using Kubo at a pinned version and checksum, in a job with a read-only token. It
  only hashes: nothing is uploaded to IPFS from CI.
- **A pinning node** runs `pin-releases.sh sync` on a timer. It reads the public releases list,
  downloads the files of the newest three releases, checks each against its SHA-256, adds them
  with the same flags, and refuses a release whose files add up to any other CID. It pins what
  it keeps as `orivon-release-<tag>` and unpins the older releases it pinned; a pin without that
  name is never touched. With `LATEST_KEY` set it also points that IPNS key at the newest release
  it keeps, so one `ipns://` address, and a `.eth` name whose contenthash is that address, always
  opens the newest release; each release's own CID stays in its description.
- **Anyone can pin a release too.** The CID depends only on the files and the flags in
  `pin-releases.sh`, so `pin-releases.sh sync` (or `ipfs add` with those flags) on any Kubo node
  reproduces it. Changing the flags changes every CID from the next release on.

The Orivon node runs it from a systemd timer every 15 minutes:

```ini
# orivon-release-pinner.service
[Service]
Type=oneshot
User=<a user that can reach the Kubo API>
Environment=IPFS_API=/ip4/127.0.0.1/tcp/5001 KEEP=3 LATEST_KEY=latest-release
ExecStart=/path/to/pin-releases.sh sync

# orivon-release-pinner.timer
[Timer]
OnBootSec=5min
OnUnitActiveSec=15min

[Install]
WantedBy=timers.target
```

`journalctl -u orivon-release-pinner` shows each run: a line per release pinned, refused or
unpinned, and each move of the latest key. `ipfs key gen --type=ed25519 latest-release` creates the key
once. A refused release is not downloaded again until its `ipfs.json` names another CID.

#### Keeping the node reachable

Kubo's resource manager keeps counting some inbound connections after they close (on Kubo 0.43.1, about
one a minute, while the swarm's own opened and closed totals stay level), so its count climbs until it
reaches the system limit. From then on every new dial is refused, and content only this node holds (a new release) cannot be fetched
although it is pinned. A restart resets the count. [`scripts/ipfs-node-watchdog.sh`](../../scripts/ipfs-node-watchdog.sh)
`check` restarts Kubo when the count is at least `LEAK_PCT` percent of the limit and exceeds the real
connections by `GAP_PCT` percent of it, or when the API has not answered `API_FAILS` runs in a row. It
waits while the release pinner is running and keeps `MIN_INTERVAL` seconds between restarts. A crash
is left to systemd. `status` prints the numbers and never acts; `DRY_RUN=1` says what `check` would do.

```ini
# orivon-ipfs-watchdog.service
[Service]
Type=oneshot
User=root
Environment=IPFS_API=/ip4/127.0.0.1/tcp/5001 STATE_FILE=/var/lib/orivon-ipfs-watchdog/watchdog.json
# SUMMARY_LOG=/path/to/summary.md also gets a line for each restart
ExecStart=/path/to/ipfs-node-watchdog.sh check

# orivon-ipfs-watchdog.timer
[Timer]
OnBootSec=5min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
```

It runs as root because it restarts the Kubo service. The state file records each check and the last
ten restarts.

#### The status page

[`scripts/ipfs-status.sh`](../../scripts/ipfs-status.sh) answers "is everything served?" on one page. It
lists every IPNS key of the node with its `ipns://` address, the build it points at, whether that build
is pinned, whether the IPNS record and the node as a provider are on the network, and whether public
gateways hand back what the node holds, byte for byte: a site's whole `index.html` and 1 KiB at a random
offset of its largest other file, or 1 KiB of every file of a folder with no page (a release). A random
offset deep in a large file is rarely in a gateway's cache, so the gateway has to fetch it from the network;
every sample is a range request, because a gateway behind a CDN can rewrite a whole HTML answer. It lists
the newest releases with their `ipfs://` CID, which are kept and pinned here, and the same samples. It runs
on the pinning node, so it cannot say whether a page opens in a person's own browser. For each IPNS key it reads the `.eth` names that should point at it from
`NAMES_FILE` and checks their contenthash on Ethereum (and, unless `ETH_LIMO=0`, that `<name>.limo`
loads). Below them it shows the node's version, uptime, inbound connection budget, storage and the last
runs of the pinner and the watchdog. A banner at the top is green when nothing is wrong and otherwise
lists each problem in plain words; one gateway failing while another serves shows in the table but is not
a problem. With `LATEST_KEY` set it also says which release that key opens. `status.json` holds the same
data for agents; `STATUS.md` is the page as Markdown.

`NAMES_FILE` has one line per IPNS key, the key name first and then the names, with `#` starting a comment:

```
# IPNS key   .eth names whose contenthash should be ipns://<that key>
website      example.eth www.example.eth
docs         docs.example.eth
```

A key without a line is shown as "none expected"; a line whose key is not in the node's keystore is an error.
The page names every key and the node's health, so it is served privately: the Orivon node's web server
serves `OUT_DIR` over HTTPS behind a password. The script itself publishes nothing.

```ini
# orivon-ipfs-status.service
[Service]
Type=oneshot
User=<the user that runs the release pinner>
Environment=IPFS_API=/ip4/127.0.0.1/tcp/5001 OUT_DIR=/path/to/status NAMES_FILE=/path/to/names.conf
Environment=WATCHDOG_STATE=/var/lib/orivon-ipfs-watchdog/watchdog.json LATEST_KEY=latest-release
ExecStart=/path/to/ipfs-status.sh run

# orivon-ipfs-status.timer
[Timer]
OnBootSec=5min
OnUnitActiveSec=15min

[Install]
WantedBy=timers.target
```

A run takes one to three minutes, most of it waiting on gateways; `TIMEOUT` caps each network check.
The page reloads itself every five minutes; if the job stops, it shows "This page is stale" once it is
three intervals old.

## winget

Every GitHub release also offers its Windows installer to [winget-pkgs](https://github.com/microsoft/winget-pkgs), the
repository behind `winget install`. winget's default source is trusted, and winget marks an installer it downloads from it
as coming from a trusted zone, so a winget install is not met with SmartScreen. That comes from reading winget's source,
not from a run of Orivon's own installer (*provisional*: the first install of a merged Orivon package settles it).

| Release | Package identifier |
|---|---|
| marked pre-release on GitHub | `Orivon.Browser.Preview` |
| a full release | `Orivon.Browser` |

The `winget` job of `release.yml` runs on a published release, after `publish` has attached the installer. It never
checks out the repository or runs npm; the one program it downloads is [Komac](https://github.com/russellbanks/Komac),
at the version and sha256 pinned in the workflow's `env`, and only its last step holds the token. It takes the version from
the tag without its `v`, looks the installer up among the release's assets (`Orivon-Setup-<version>-x64.exe`) and runs
`komac update`, which downloads the installer, reads its product code and uninstall entry, copies the previous version's
descriptive fields and opens a pull request to `microsoft/winget-pkgs` from the fork it creates in the token's account.

It succeeds with a warning, or a notice, and submits nothing, when:

- the repository secret `WINGET_TOKEN` is empty;
- winget-pkgs holds no version of the identifier yet, because Komac only adds a version to a package that exists (the
  first version of each identifier is submitted by hand, [`release-checklist.md`](release-checklist.md) item The winget package);
- winget-pkgs already holds that version, or has an open pull request for it;
- the release has no such installer asset.

Any other failure (Komac itself, the network) fails the job and only that job: the release and its packages are already
published. Komac's own check for an open pull request is a prompt that ends a run with `CI=true` without submitting, so the
job passes `--skip-pr-check` and does the check itself.

## The Microsoft Store package

The Windows build also writes `Orivon-Store-<version>-x64.appx` (the `appx` target and block of
[`electron-builder.yml`](../../electron-builder.yml)), the same app as the installer wrapped in a package the Microsoft
Store accepts, which signs it itself: nothing signs it here, and a Store install is never met with SmartScreen
([`ADR-0081`](../decisions/ADR-0081-windows-builds-also-ship-to-the-microsoft-store.md)). The installer stays the
only Windows file attached to a release. The package is the workflow artifact `store-msix`, which the
`manifest` and `publish` jobs do not take, so it reaches neither the release nor its IPFS folder; the owner downloads
it from the run page and uploads it in Partner Center ([`release-checklist.md`](release-checklist.md)).

- **Identity comes from Partner Center.** `appx.identityName`, `appx.publisher` and `appx.publisherDisplayName` are
  the three values of the "Orivon Browser" product's Product identity page (Package/Name, Package/Publisher,
  Package/PublisherDisplayName), copied verbatim into `electron-builder.yml`. The Store refuses a package with any
  other identity. `applicationId` (`Orivon`) and `displayName` are Orivon's own.
- **The tiles are Orivon's.** `build/appx/` holds the four logos the manifest names and two more tile sizes, cut from
  `build/icon.png` with ImageMagick (`convert build/icon.png -resize 150x150 Square150x150Logo.png`, and likewise for
  the others); without them electron-builder fills the package with its own stock logo.
- **Protocols and file types.** `protocols` becomes `windows.protocol` entries for http and https. The five document
  types the installer registers under Open with (`.html`, `.htm`, `.xhtml`, `.svg`, `.pdf`) are in
  `build/appx-extensions.xml`, read through `appx.customExtensionsPath`, so the installer is unaffected. The
  manifest's other facts: Windows 10 1809 as the minimum, `en-US` as the language, the `runFullTrust` capability
  (electron-builder adds it; a Win32 app needs it), no auto-launch extension.
- **What CI proves.** The Windows job prints the package's `AppxManifest.xml`, signs a copy with a throwaway
  certificate whose subject is the manifest's publisher, trusts it for the run, installs it (`Add-AppxPackage`),
  launches it through its AUMID (`shell:AppsFolder\<PackageFamilyName>!Orivon`, the only way an app gets its package
  identity), asserts an `Orivon.exe` from the package's own folder keeps running for 20 seconds, then starts the
  app inside the package with `Invoke-CommandInDesktopPackage` and a DevTools port and runs
  `scripts/smoke-packaged.mjs --attach <port>` against it, and removes the package. No secret is involved.
- **What differs inside the package.** `process.windowsStore` is true. No update check runs and Settings says the
  Store delivers updates. The default-browser read compares the person's handler's `AppUserModelID` with the
  package's own, since a packaged handler has no path (`src/main/os/windows-store.ts`, `default-browser-runner.ts`);
  Make default opens the default-apps page without selecting an entry. The taskbar menu, the process's app user
  model id and a second Orivon started by the first are written for the installer and unchecked inside the package
  (`docs/open-questions.md` A410).

## Windows and macOS

**Windows.** The installer is unsigned. On first run SmartScreen shows "Windows protected your
PC": **More info**, then **Run anyway**. It installs for the current user into
`%LOCALAPPDATA%\Programs\Orivon`, needs no administrator, and lets the person choose another
folder. Silent install: `Orivon-Setup-<version>-x64.exe /S`. A person who would rather not see the warning installs
from the Microsoft Store instead (section The Microsoft Store package).

**macOS.** The app is signed ad hoc, not with a Developer ID, and not notarized. Apple silicon
refuses a binary with no signature at all, and packaging rewrites the Electron binary (its fuses,
name and `Info.plist`), so the signature Electron shipped with no longer holds: electron-builder
signs it again with `identity: "-"`. Hardened runtime is off, since it rejects an ad-hoc app
loading the Electron framework, and it only matters for notarization. After dragging Orivon to
Applications, the first open is refused: open **System Settings > Privacy & Security** and choose
**Open Anyway**, or run `xattr -dr com.apple.quarantine /Applications/Orivon.app`. The Intel dmg
is built on an Apple silicon runner and launched there under Rosetta.

**macOS one-line install.** `scripts/install-macos.sh`, run as
`curl -fsSL https://raw.githubusercontent.com/OrivonBrowser/orivon-mvp/main/scripts/install-macos.sh | bash`,
installs or updates Orivon with no Gatekeeper prompt. Gatekeeper only checks files that carry the
`com.apple.quarantine` attribute, which a browser adds to a download and `curl` does not; Apple
silicon still wants a signature, and the ad-hoc one the build has is enough. The script reads the
newest releases from GitHub's API and takes the newest non-pre-release that has a dmg for the Mac's
architecture with a digest, else the newest pre-release that has one (a release whose packages are not
attached yet is skipped). It downloads that dmg, compares its SHA-256 with the digest GitHub reports
for the asset, copies `Orivon.app` into `/Applications` (or `~/Applications` when the first is not
writable; never sudo), checks `codesign --verify`, and opens it. It refuses to run while Orivon is
running. The digest check guards against a broken or swapped download in transit, not against
someone who controls the GitHub repository. It runs on macOS's own bash and tools. Four environment
variables: `ORIVON_REPO` (the repository to read releases from), `ORIVON_DMG` (a local dmg, which
skips the lookup, download and digest check), `ORIVON_INSTALL_DIR` (where `Orivon.app` goes) and
`ORIVON_NO_OPEN=1` (do not open it). The release workflow installs the package it just built through
the script and launches the result with the packaged smoke check; on pull requests and manual runs
it also installs the newest published release through it, which exercises the lookup, download and
digest check.

**Signing later.** A Developer ID certificate (with notarization) and a Windows code-signing
certificate would remove both warnings (the Store package has none to remove). electron-builder reads them from the environment
(`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`), so
adding them is repository secrets, the matching `env:` lines in the workflow, and removing
`identity: "-"` and `hardenedRuntime: false` from `mac:`.

### Verifying the desktop entry

The commands below, inspecting the `.desktop` entry's contents and registering as the default
browser, have **not** been run against a built package. Treat this section as a checklist still
to complete, not a report of those results.

```bash
# Confirm the desktop entry actually says what "Making 'set as default browser'
# possible" below claims it says -- don't assume the protocols composition in
# electron-builder.yml renders the way its comments predict.
dpkg -e release/*.deb /tmp/orivon-deb-control   # control files only, no install needed
dpkg -x release/*.deb /tmp/orivon-deb-inspect   # full contents
cat /tmp/orivon-deb-inspect/usr/share/applications/*.desktop

# Expect a line equivalent to:
#   MimeType=text/html;application/xhtml+xml;image/svg+xml;application/pdf;x-scheme-handler/http;x-scheme-handler/https;
# and:
#   Categories=Network;WebBrowser;
#   Actions=new-window;new-private-window;
# followed by a [Desktop Action new-window] and a [Desktop Action new-private-window] section whose Exec
# lines run /opt/Orivon/orivon with --new-window and --new-private-window. The AppImage's own entry
# (Exec=AppRun) carries no actions: they sit under `deb:` in electron-builder.yml, not `linux:`.
```

```bash
# Try the actual default-browser registration once installed
sudo dpkg -i release/*.deb
xdg-mime default orivon.desktop x-scheme-handler/http x-scheme-handler/https
gio mime x-scheme-handler/https   # the registered handler, and the applications the system lists
xdg-settings check default-url-scheme-handler https orivon.desktop
```

The file name is `orivon.desktop`, from `linux.executableName` and `desktopName` in `package.json`; confirm it
with `ls /usr/share/applications | grep -i orivon`. A file of that name in `~/.local/share/applications` wins
over it: the dock then starts whatever that file names, and a default-browser choice opens links with it. The entry is named "Orivon Browser", as
the window's title is. A run from source has its own entry, `orivon-source.desktop` (`scripts/launch-from-source.mjs`),
and names its windows `orivon-source`, so the dock never shows it under the package's icon (ADR-0057). Whether a desktop lists Orivon in its browser list with
only the two scheme handlers is unmeasured (`docs/open-questions.md` A387).

## Making "set as default browser" possible: what's config and what isn't

`electron-builder.yml` handles the packaging half: the top-level `protocols` key
(`schemes: [http, https]`) is what electron-builder documents as producing the `.desktop` file's
`MimeType=` line (`x-scheme-handler/http;x-scheme-handler/https;`), and `linux.category` supplies
`Categories=Network;WebBrowser;`. `linux.mimeTypes` lists `text/html`, `application/xhtml+xml`, `image/svg+xml`
and `application/pdf`, which puts Orivon under Open with for those files and opens them as local files; only
as the default browser does it also take `text/html`, `application/xhtml+xml` and `application/pdf` (the
runtime half below), and SVG stays under Open with. Both are freedesktop.org conventions `xdg-settings` and
desktop menus rely on. macOS lists the same types as `mac.fileAssociations` at rank Alternate, and the
installer script lists them under `Capabilities\FileAssociations` and each extension's `OpenWithProgids`,
never taking an extension over; neither is read back on a system yet (A397).

The runtime half is application code in `src/main/os/`: an installed package registers, and only when a person
clicks (Settings > Default browser, or the question the default profile asks). An AppImage never registers,
because a registration naming it would point at a file that moves, and neither does a run from source on Windows or
macOS, which would register the Electron binary. A Linux run from source registers its own entry,
`orivon-source.desktop`, once `scripts/launch-from-source.mjs install` has written it. On Linux the same click also
runs `xdg-mime default` with that entry for `text/html`, `application/xhtml+xml` and `application/pdf`
(`LINUX_DOCUMENT_TYPES` in `default-browser.ts`).

## Launcher actions

A right-click on Orivon's icon offers New Window and New Private Window. On Linux they are the `.deb`'s desktop
actions (`deb.desktop.desktopActions` in `electron-builder.yml`, which run `/opt/Orivon/orivon --new-window` and
`--new-private-window`); they sit under `deb:` and not `linux:` because electron-builder merges `linux.desktop`
into the AppImage's entry too, where `Exec` is `AppRun` and `/opt/Orivon` does not exist. On Windows the same two
are jump-list tasks and on macOS dock-menu items, set by the running program (`src/main/os/install-launcher-menu.ts`).
A run from source on Linux gets both from `scripts/launch-from-source.mjs install` (`docs/development/setup.md`).

## Windows and macOS: registering as a browser

The release workflow builds and launches the NSIS installer and the dmgs (above). Their registration as a browser,
below, is written from the platforms' documentation and is *provisional* until a built package is seen in Windows'
and macOS' default-app lists (`docs/open-questions.md` A328).

- **Windows.** `build/installer.nsh` writes, under `SHCTX`, the client key `Software\Clients\StartMenuInternet\Orivon`
  with its `Capabilities` (`http` and `https` pointing at `OrivonURL`), a `RegisteredApplications` entry, and the URL
  class `Software\Classes\OrivonURL`, whose command is `"<install>\Orivon.exe" -- "%1"` (the `--` stops a link being
  read as a switch). Uninstalling removes all three. Windows does not let a program set the default browser, so
  Make default opens `ms-settings:defaultapps?registeredAppUser=Orivon` and the person chooses. The installer's
  shortcuts carry the app user model id `com.orivonstack.orivon`, the one `src/main/os/launcher-tasks.ts` sets on
  the process.
- **macOS.** `protocols` becomes `CFBundleURLTypes`. No HTML document types are declared, so a file dropped on the
  dock icon is refused and logged. Make default calls `setAsDefaultProtocolClient`, which the system confirms.

## Caveats

**AppImage needs `libfuse2` on Ubuntu 22.10+.** Ubuntu dropped `libfuse2` from the default
install starting around 22.04/22.10, and classic (type 2) AppImages need it to mount themselves
at launch, and without it the AppImage fails to start, often with a terse `dlopen(): error
loading libfuse.so.2` rather than an obviously-actionable message. Fix on the user's end:
`sudo apt install libfuse2` (or `libfuse2t64` on very recent Debian/Ubuntu, which renamed the
package during the 64-bit time_t transition).
> **This may not apply to every version.** electron-builder's own AppImage docs state that from
> electron-builder 27 the default AppImage runtime is a static, FUSE3-compatible build that does
> not require host-level FUSE at all, specifically for distros like Ubuntu 24.04+ that this exact
> problem affects. This project pins `^26.15.3`, not v27, and whether 26.15.3's AppImage runtime
> already carries the static FUSE3 build has not been checked. **Don't delete
> this caveat on the assumption it's obsolete; confirm against the installed version and test on
> a `libfuse2`-less system before deciding it doesn't apply.**

**The `chrome-sandbox` SUID error.** Chromium's sandbox needs a small helper binary,
`chrome-sandbox`, owned by `root` with the SUID bit set (`4755`), so it can set up an
unprivileged renderer's namespaces before dropping root. AppImages mount as a **read-only**
FUSE filesystem at run time; there is no install step that could `chown root` and set a SUID
bit on a file inside it, so the sandbox helper inside an AppImage cannot be SUID-root the way a
normally-installed binary can. Electron notices and refuses to start rather than silently
running unsandboxed. The common workaround is launching with `--no-sandbox`, which is a real
reduction in the process-isolation guarantee, not a cosmetic flag, and worth surfacing to a user
who hits it rather than quietly baking it into a launcher script. **This is a second, concrete
reason `deb` is the artefact that should carry any daily-driver usage**: an installed `.deb`
places `chrome-sandbox` on a normal read-write filesystem where `dpkg` can and does set its
permissions correctly at install time, so the sandbox works as intended without extra flags.

**The oldest Linux it runs on is Electron's, not the build machine's.** A binary compiled
against a newer glibc fails to launch on an older system (`version 'GLIBC_2.xx' not found`).
Packaging compiles nothing here (`npmRebuild: false`, and Rule 8 keeps native modules out), so
the only binaries in the package are Electron's own, built against an old baseline, and building
on `ubuntu-latest` does not raise the floor. A native module added to the shell's dependencies
would change that, and would have to be built on the oldest LTS Orivon supports.

**Of the Linux artefacts only `deb` can register as the default browser.** Covered above at length; restated here
because it is the caveat that most directly shapes the "primary vs. trial artefact" framing at
the top of this document, and it's easy to read past once and forget while skimming for build
commands.

## Files shipped, and why the list is short

`electron-builder.yml`'s `files:` key is an **allowlist** of the app's own sources: `out/**/*`
and `package.json`. An allowlist cannot pick up `spike/`, `test/`, `scripts/`, `devlog/`,
`.claude/`, `docs/` or root-level markdown the way a blocklist subtracted from `**/*` would have
to remember to keep excluding. The production tree of `package.json`'s `dependencies` (the ENS
resolver's, the IPFS/IPNS reader's and the renderer shims' packages) is still copied into
`app.asar`'s own `node_modules/`, since electron-vite leaves some of them to be required at run
time. webtorrent and every app-side library are not shell dependencies: they are app assets
fetched into `userData` (`ADR-0005`). `build/icon.png` is copied beside `app.asar` as
`resources/icon.png`, for the window icon.

## Known gaps

What a real build leaves open. None of them blocks a build.

- **The `MimeType=` and `Actions=` composition (`protocols.schemes` -> `MimeType=`, `deb.desktop` ->
  `Actions=` and the two action sections) is documented behaviour, not observed.** Verify it against
  `release/*.deb` with the `dpkg -e`/`-x` commands above.
- **`StartupWMClass`/`executableName` (`orivon`) is a reasonable guess, not a confirmed match.**
  Nothing in `src/main/*.ts` currently calls `app.setName()` or sets an explicit window/app
  identifier, so Electron's runtime default may not agree with the
  string baked into the `.desktop` file until someone sets one explicitly. A mismatch here means
  taskbar/window-manager icon grouping can misbehave even though the app itself runs fine, so it is
  worth checking against the built `.deb`, not a launch blocker.
- **`linux.maintainer` reuses the fallback contact address already public in
  [`SECURITY.md`](../../SECURITY.md)**, because `package.json` has no `author` field and a
  `.deb` control file requires *some* `Maintainer:` entry. Revisit if the project ever wants a
  dedicated packaging/releases address instead.
- **`electron-builder` is pinned at `^26.15.3`** in `package.json`, npm's actual `latest` tag.
  v27 exists only as alpha prereleases and some of its documented behaviour does not hold for
  26.x; see section Version notes below.

## What this document does not cover

**Auto-update.** Unsigned
`electron-updater` on Linux verifies only a SHA-512 fetched from the same host that serves the
binary, which is a standing remote-code-execution channel keyed to a GitHub token, so it is not
used. Today Orivon checks for a new version and notifies; installing one is not built, and the
person downloads the package from the release page. A signed self-update is expected next
([`roadmap.md`](../roadmap.md)): it checks by default, installs only after the person answers
"Yes, install", and always offers the manual download. It is a separate piece of work, not
part of this config. `electron-builder.yml` sets `publish: null` explicitly (not just omitted)
specifically so that a stray `latest-linux.yml`/`app-update.yml` never ships implying an update
channel that doesn't exist, since electron-builder would otherwise auto-detect a GitHub publish
target from `package.json`'s `repository` field.

**Code signing with a bought certificate.** Not configured; section Windows and macOS says what a
person sees without it, and what adding it takes.

## Version notes: 26.x, not v27

Current electron-builder documentation describes **v27**, which exists only as alpha
prereleases; `npm install --save-dev electron-builder` installs **26.15.3**. The two generations
differ in ways that matter for this exact config, so write it from neither the v27 docs nor
memory ([`CLAUDE.md`](../../CLAUDE.md)'s tooling table: training data is stale here):

- **`asar` and native-module options are flat, top-level keys in 26.x**, not nested under a
  `nativeModules:` object as in v27. The 26.x schema rejects the nested form outright (see the
  `npmRebuild` key's comment in `electron-builder.yml`).
- **Three v27 behaviours are unverified against 26.15.3:** a generated Linux launcher script that
  any custom `.desktop`/AppArmor/MIME override must reference instead of the raw binary,
  `productName`/`executableName` being hard-validated rather than silently sanitized, and
  publishing requiring an explicit `--publish` flag. Re-check each live before relying on it.
