# Packaging

Orivon is packaged for three systems by [`electron-builder`](https://www.electron.build) from
[`electron-builder.yml`](../../electron-builder.yml) at the repo root:

| System | Package | Signed |
|---|---|---|
| Linux (x64) | `orivon_<version>_amd64.deb` and `Orivon-<version>-x86_64.AppImage` | no (Linux packages are not) |
| Windows (x64) | `Orivon-Setup-<version>-x64.exe`, an NSIS installer | no: SmartScreen warns on first run |
| Windows (x64), Microsoft Store | `Orivon-Store-<version>-x64.appx` | no: the Store signs it after upload (section The Microsoft Store package) |
| macOS | `Orivon-<version>-arm64.dmg` (Apple silicon) and `Orivon-<version>-x64.dmg` (Intel) | yes on a release: Developer ID and notarized (ad hoc in a pull request's build and in `npm run package:mac`) |

The three systems are equal, and Linux is supported on X11 and Wayland both. Each GitHub release
builds all of them and attaches them to itself (section Releases), except the Store package, which
the workflow submits to Partner Center instead (section The Microsoft Store package). No Windows certificate is bought, so Windows does not trust the
installer out of the box (section Windows and macOS). Running from source stays supported on every system ([`setup.md`](setup.md)); its users
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
  shared `linux:` config), but nothing copies it into `~/.local/share/applications/` for you. The
  one-line installer (the Linux one-line install paragraph of section Windows and macOS) does that from outside the app, without sudo; a
  first-run "install desktop entry" flow inside the running app is not built.

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
3. When every system passes, a separate job attaches the packages to the release and writes its
   description (section Release notes). If one system fails, nothing is attached: re-run the failed
   job from the Actions tab, and the attach job follows. Re-running replaces assets of the same name.
   After it, three jobs offer the release to the places people install from: `winget` (section winget),
   `store` (section The Microsoft Store package) and `aur` (section The Arch User Repository). Each
   writes a warning and succeeds while the secret it needs is empty, so a release is never red for a
   route that is not set up yet.
4. A release build first refuses an `.eth` light-client checkpoint
   (`src/main/verifier/mainnet-checkpoint.json`) over 7 days old (`MAX_CHECKPOINT_AGE_DAYS` in the
   workflow): the app rejects one over 14, and an install of a release past that has to fetch a
   fresh one from two beacon servers, which it cannot when they are unreachable or disagree. `refresh-eth-checkpoint.yml` proposes a fresh one twice a week; merge it before
   tagging ([`release-checklist.md`](release-checklist.md)).

A pull request that changes `electron-builder.yml`, `build/`, `scripts/smoke-packaged.mjs` or the
workflow runs the same build and launch, and keeps the packages for seven days as workflow
artifacts instead of attaching them (the Store package, 30 days, in every run). Actions > Release > Run workflow does the same on demand.

The job that writes to the release only downloads the packages (the artifacts named `orivon-*`) and the description
the `notes` job made, and uploads them. The jobs that run `npm ci`, Kubo or the repository's own scripts hold a read-only
token, so no dependency's install script can alter a release.

**Offering a published release again.** Actions > Release > Run workflow takes an optional `tag`. With one, the run builds
nothing and runs only `winget`, `store` and `aur` for that already published release: the way to offer a release that was
published before a secret existed. The `store` job takes the package from the newest Release run of that tag, which
GitHub keeps for 30 days; past that the package is built again by re-running the release's run, or uploaded by hand.
Re-running only a failed job of the release's own run works too, within the same 30 days.

### Tagged packages

A release carries the plain packages only. A package tagged for an app is a copy of the release's Windows installer or
AppImage renamed for one entry of [`resources/flavours.json`](../../resources/flavours.json):
`Orivon-Setup-<version>-x64.<id>.exe` or `Orivon-<version>-x86_64.<id>.AppImage`. It is the same bytes under another name,
made outside the release workflow when one is wanted, and it is not attached to the release or added to its `ipfs.json`.
The workflow's `flavours` job fails the release if an entry's `app` is not the `domain` in `apps/<port>/orivon.json` of the
ports repository's `main`, since the allowlist ships in every package. The deb, the dmg, the Store package and winget carry
no tag.

What a tag does is in [`ADR-0093`](../decisions/ADR-0093-an-installer-file-name-or-switch-selects-an-apps-first-run-presets-from-an-allowlist.md). The Windows
installer writes the name of the file it was started from to `installer-name.txt` beside the program (`build/installer.nsh`,
removed on uninstall) and the app reads it on its first run; the AppImage's name is read from `$APPIMAGE`; the macOS script takes
the id as an argument (`curl ... | bash -s <id>`) and passes `--orivon-flavour=<id>` to the first launch it starts. Adding an app
is a line in the file, an app that opens by name from its port, and the id never reused.

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
  opens the newest release; each release's own CID stays in its description. That address opens
  the release's files, the same blocks, plus an `index.html` that starts the download of the
  package for the visitor's system (the `.exe` on Windows, the Apple silicon or Intel `.dmg` on
  macOS, the `.deb` on Linux) and lists every file; on a phone, an unknown system or without
  JavaScript it is only the list. The page asks search engines not to index it. The pinner composes that folder in the node's MFS and pins it as
  `orivon-latest-release`, so its CID differs from the release's.
- **Anyone can pin a release too.** The CID depends only on the files and the flags in
  `pin-releases.sh`, so `pin-releases.sh sync` (or `ipfs add` with those flags) on any Kubo node
  reproduces it. Changing the flags changes every CID from the next release on.
- **An additional pinning service** can hold the same releases: `scripts/pin-extra.mjs` pins the CIDs
  of the newest releases, and any `name=cid` lines in a file passed with `--extra`, on a service that
  speaks the IPFS Pinning Service API. It reads `PINNING_ENDPOINT` and `PINNING_TOKEN` from the
  environment and only adds what is missing; `--prune` also removes pins under the `orivon-` prefix
  that are no longer listed.

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

**Filebase holds the live versions only.** `scripts/filebase-sync.mjs`, run from a timer on the pinning
node, pins on Filebase the version each IPNS key of the node's Kubo points at (the newest release is
among them, through the `latest-release` key's start page), the CIDs in a keep file, and the live pins
of the DecentraWiki relay, and unpins everything else once it is two hours old: the version a key
moved past, the per-file pins a folder upload leaves behind, the releases that are no longer the newest.
Removal stops for a run when a key cannot be read or most of the keys seen last time are gone, and a
version that fails to add is tried again after an hour, then two, up to a day. Filebase refuses a file
or a block holding phrases a phishing page uses ("Authentication is required", "password to continue",
and others it does not list) with an empty 403 on an upload, and never finishes pinning such a block by CID, so the
script imports a CAR, which it does not filter; only a version over 300 MB goes by CID. Do not run
`pin-extra.mjs` against the account this script prunes: it would pin the older releases again. The
settings are in the script's header and the unit is:

```ini
# orivon-filebase-sync.service
[Service]
Type=oneshot
EnvironmentFile=/etc/orivon-filebase-sync/secrets.env   # FILEBASE_KEY=<IPFS RPC key>, root 0600
Environment=KEEP_FILE=/etc/orivon-filebase-sync/keep.txt PROTECT_FILE=/var/lib/decentrawiki-relay/pins.jsonl
Environment=STATE_FILE=/var/lib/orivon-filebase-sync/state.json SUMMARY_LOG=<the node's summary file>
StateDirectory=orivon-filebase-sync
ExecStart=/usr/local/bin/node /path/to/filebase-sync.mjs

# orivon-filebase-sync.timer: OnBootSec=10min, OnUnitActiveSec=30min
```

It runs as root because the relay's state directory is private to the relay's user.

#### Orivon's sites on Swarm

`scripts/swarm-feeds.mjs` publishes each of Orivon's own sites to a Swarm sequence feed and keeps the feed
current. It runs on a machine that runs a [Bee](https://docs.ethswarm.org) node and can reach the pinning
node's Kubo RPC, directly or over ssh. The pinning node keeps the IPNS keys, stays the trigger (a key that
moves to a new CID is a new version) and keeps its own copy of every site. A run reads the names file (one
line per site: the IPNS key's name, then the ENS names it serves), and for each site that moved uploads the
version to Bee and appends an update to the site's feed. The feed's owner is one secp256k1 key that never
holds funds; Bee's wallet pays. `swarm-feeds.mjs list` prints each site's `bzz://` feed manifest, the address an
ENS name's contenthash points at, and it does not change when a version does. It prints each site's **Score id**
too: the Web3 Score identifier of the version in the Swarm reference column, `cid:` and the CIDv1 of that reference
(codec swarm-manifest, keccak-256 multihash), so it always starts `cid:bah5acgza`. It is the id to add to the site's
Web3 Score evaluation, and it changes with each version, as the reference does; a site with no version uploaded yet
shows `-`.

Postage is two **immutable** batches, because an immutable batch refuses a chunk it has no room for instead of
overwriting an older one, so what was published stays readable until the batch expires:

| Batch | Holds | Policy |
|---|---|---|
| Pointers (`POINTER_DEPTH` 18) | One small update per version, and the feed manifests | Never replaced: it is bought for `POINTER_TTL_TARGET_DAYS` (240) and topped up when under `POINTER_TTL_MIN_DAYS` (120). At `POINTER_DILUTE_AT` (0.75) fill its depth grows by one, then it is topped up again, since dilution halves the time left. Fill is the fullest bucket's share of its slots, only 4 at depth 18, so a lower threshold dilutes after a few hundred chunks; a bucket that does fill only refuses an upload, which dilutes the batch and retries |
| Content (`CONTENT_DEPTH` 22) | The site versions | Bought for `CONTENT_TTL_TARGET_DAYS` (35), topped up under `CONTENT_TTL_MIN_DAYS` (21), and replaced at `ROTATE_AT` (0.75) fill or when Bee answers 402 to an upload: every site's current version is uploaded again into the new batch, and the old batch is never topped up, so old versions leave the network when it expires |

A role with no batch in the state, or whose batch Bee no longer knows (expired), first takes up a batch the node
already holds under the role's label (`orivon-pointers`, `orivon-content`; the job buys under the same labels) that is
immutable, usable and not expired, and for content not at the rotation fill, the longest-lived if there are several;
it buys only when there is none. A batch bought by hand under the label is used as it is, and a lost `state.json`
buys nothing twice. A pointer batch that is new to the state is filled again from `socs.jsonl`, the journal of every
signed update, so the feeds read as before. Sites are
handled one at a time: the version is streamed from Kubo through `tar` into a folder in `WORK_DIR`, packed
into one tar, the folder removed, and the tar streamed to Bee, so the disk holds one site (twice, for a moment)
and memory holds none. Keep `WORK_DIR` on a disk with room for twice the largest site. A site whose upload has
not finished syncing within `SYNC_TIMEOUT_MIN` gets no feed update that run, and the next run takes up the same
upload. A run after days off finds the same state and carries on; one that starts while Bee is still starting or
has no peers exits 1 and spends nothing.

`MAX_SPEND_BZZ` (100) limits what one run may pay for purchases, top-ups and dilutions together: a step over it
is refused and logged, and the run exits 1. When the wallet is short the run says which address to fund and
buys nothing, never half of a purchase. At 196,236 PLUR per chunk and block, the first run costs about 50 xBZZ
for the content batch and about 21 xBZZ for the pointer batch. `sync --dry-run` reads Bee and Kubo and
prints what it would buy and upload; it spends and writes nothing.

Build the one-file bundle (it carries `viem` and `multiformats`) and copy it to the machine that runs Bee; the script needs
Node and GNU `tar` there:

```sh
npx esbuild scripts/swarm-feeds.mjs --bundle --platform=node --format=esm --outfile=swarm-feeds.mjs
```

Create the feed's key once, then read the two addresses to fund and to publish from:

```sh
mkdir -p ~/.config/orivon-swarm-feeds && (umask 077 && openssl rand -hex 32 > ~/.config/orivon-swarm-feeds/feed-signer.key)
node swarm-feeds.mjs address     # the feed owner, and Bee's wallet (xBZZ and a little xDAI go there)
```

The job refuses a key file that group or others can read. Losing the key loses the right to update the feeds:
an ENS name would then have to point at a new manifest. `STATE_DIR` (`$XDG_STATE_HOME/orivon-swarm-feeds`) holds
`state.json` (batch ids, per-site progress), `socs.jsonl` (the journal, appended before each upload) and
`status.json`; back up the first two. Without `state.json` the job finds its batches again by label, and
without `socs.jsonl` it cannot put the updates back onto a pointer batch it has to replace.

Where the machine reaches Kubo over ssh, `IPFS_API=ssh://<user>@<host>[:<port>]` runs each RPC call as
`ssh -o BatchMode=yes <user>@<host> curl -sS --fail -X POST '<IPFS_SSH_RPC>/api/v0/<path>'`
(`IPFS_SSH_RPC` is the RPC address as the node sees it, `http://127.0.0.1:5001` by default), and
`NAMES_FILE=ssh://<user>@<host>/<absolute path>` reads the names file there with `cat`. ssh never asks a
question, so the machine needs a key the node accepts without a passphrase prompt (an `IdentityFile` in
`~/.ssh/config` for that host). Both settings also take a plain path or an http(s) URL. The unit and timer, as
user units on the machine that runs Bee:

```ini
# ~/.config/systemd/user/orivon-swarm-feeds.service
[Service]
Type=oneshot
EnvironmentFile=%h/.config/orivon-swarm-feeds/settings.env
# settings.env: BEE_API=http://127.0.0.1:1733  IPFS_API=ssh://<user>@<host>  NAMES_FILE=ssh://<user>@<host>/<path>
#               WORK_DIR=<a disk folder>  SUMMARY_LOG=<optional>  FEEDS_FILE=ssh://<user>@<host>/<path>
ExecStart=/usr/bin/flock -n %t/orivon-swarm-feeds.lock /usr/bin/node %h/.local/lib/orivon-swarm-feeds/swarm-feeds.mjs

# ~/.config/systemd/user/orivon-swarm-feeds.timer: OnBootSec=10min, OnUnitActiveSec=10min
```

Two runs at once would both write `state.json`. systemd never starts a unit that is still running, and the
`flock` covers a run started by hand: start one the same way, with the same lock file.

`FEEDS_FILE` (optional; a path or `ssh://<user>@<host>/<absolute path>`, the forms `NAMES_FILE` takes, and never the
names file itself) is where a sync leaves the feed manifests for the tools that check an ENS name against its site:
a comment line, then one line per site that has a manifest, in names-file order.

```
# <ipns-key> bzz://<feed manifest>, one line per site. Written by swarm-feeds.mjs: do not edit.
explore bzz://<64 hex>
web3score bzz://<64 hex>
```

It is written after a sync that is not a dry run and replaced all at once (over ssh as `cat > <path>.tmp && mv
<path>.tmp <path>`, every value single-quoted, the text on stdin). It is written only when its text differs from what the
job wrote last to that place (`state.json` keeps the SHA-256), so a timer that finds nothing new never reaches the
host: the job does not notice a file removed or edited on the host, and a `feedsFile` entry deleted from `state.json`
makes the next run write it again. It is also written when `FEEDS_FILE` names another place, and, with no site holding a
manifest yet, as the comment line alone. A file the job cannot write is an error of the run (exit 1, in `status.json`'s
`errors`) and the sites are still published; the next run writes it. The status page reads it (section The status
page).

`NAMES_FILE` and `FEEDS_FILE` may not name the same file (the check normalises the path and spells out ssh's default
port): the job would overwrite the list of names.

`status.json` is what each run leaves: `ok`, the wallet, each batch (`ttlDays`, `fill`, `usable`), and per site
the feed manifest, the newest index, the IPFS CID and Swarm reference it carries, and `uploadPending`; its
`errors` hold the reasons of a failed run. `journalctl --user -u orivon-swarm-feeds` shows the run's log lines.
`SKIP_KEYS` leaves keys out of a run. The settings are listed in the script's header.

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
a problem. With `LATEST_KEY` set it also says which release that key opens: the one whose files it holds, the start page aside. `status.json` holds the same
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

A site that is also on Swarm (section Orivon's sites on Swarm) may have its names point at its feed
instead. `FEEDS_FILE` (optional, a local path on the pinning node) is the file the Swarm job writes, `<ipns-key>
bzz://<64 hex>` per line, `#` starting a comment; the job's own `FEEDS_FILE=ssh://<user>@<node>/<that path>` puts it
there. A name is then right when its contenthash is its key's `ipns://` address or its key's feed: the page shows the
feed beside the key's address and says "points at its Swarm feed" under a name that points at it, and a name that is
wrong or empty is told to point at the feed, or at the `ipns://` address for a key with no feed. A `FEEDS_FILE` that
cannot be read is a warning, and every name is then judged against the `ipns://` address alone, except that a name
pointing at a Swarm address is a warning rather than an error, since the feed it should match is unknown.

```ini
# orivon-ipfs-status.service
[Service]
Type=oneshot
User=<the user that runs the release pinner>
Environment=IPFS_API=/ip4/127.0.0.1/tcp/5001 OUT_DIR=/path/to/status NAMES_FILE=/path/to/names.conf
Environment=WATCHDOG_STATE=/var/lib/orivon-ipfs-watchdog/watchdog.json LATEST_KEY=latest-release
# Optional, for a site that is also on Swarm: Environment=FEEDS_FILE=/path/to/feeds.txt
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

**What the owner does once.**

1. Create a classic personal access token with the `public_repo` scope, in the account the pull requests should come from
   (GitHub > Settings > Developer settings > Personal access tokens > Tokens (classic)). Komac documents this scope; a
   fine-grained token can write the manifests but cannot open the pull request.
2. Add it as the repository secret `WINGET_TOKEN` (Settings > Secrets and variables > Actions).
3. Have the first version of each identifier accepted by hand (`Orivon.Browser.Preview`, and `Orivon.Browser` with the first
   full release): the job only adds versions to a package winget-pkgs already holds
   ([`release-checklist.md`](release-checklist.md) item The winget package says how).

From then on every release is submitted by the job. A release published before the secret existed is submitted by running
the workflow with its tag (section Releases). Once winget-pkgs has accepted a version, set `winget` to `true` in
[`packaging/release-routes.json`](../../packaging/release-routes.json), so the release notes list the command (section
Release notes).

## The Microsoft Store package

The Windows build also writes `Orivon-Store-<version>-x64.appx` (the `appx` target and block of
[`electron-builder.yml`](../../electron-builder.yml)), the same app as the installer wrapped in a package the Microsoft
Store accepts, which signs it itself: nothing signs it here, and a Store install is never met with SmartScreen
([`ADR-0081`](../decisions/ADR-0081-windows-builds-also-ship-to-the-microsoft-store.md)). The installer stays the
only Windows file attached to a release. The package is the workflow artifact `store-msix`, which the
`manifest` and `publish` jobs do not take, so it reaches neither the release nor its IPFS folder. The `store` job submits
it to Partner Center (section Submitting it to Partner Center), and the artifact, kept 30 days, is what the owner uploads
by hand when that job cannot.

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

### Submitting it to Partner Center

The `store` job of [`release.yml`](../../.github/workflows/release.yml) runs on a published release, after `publish`, on a
Windows runner. It takes the run's `store-msix` artifact, checks that the package's manifest carries the release's
version, installs the Microsoft Store Developer CLI ([`msstore`](https://github.com/microsoft/msstore-cli), at the version
pinned in the step, through Microsoft's `microsoft-store-apppublisher` action, pinned by commit) and runs
`msstore publish <package> -id 9MXV3FNMFBP4`. That uploads the package to a new submission of the existing product, started
from the last published one, so the listing text, images and pricing are not touched, and commits it for certification.
The job logs the submission's status and writes it to the run's summary. Certification by Microsoft follows and takes
from hours to days; the job does not wait for it.

- **The version.** electron-builder writes the tag's three numbers and a fourth that is always `0`
  (`getVersionInWeirdWindowsForm` in `app-builder-lib`; `v0.0.9` is `0.0.9.0`), which is the form the Store requires. A
  tag with a pre-release suffix (`v0.2.0-beta.1`) would carry the version of the release after it, which the Store takes
  only once and only in increasing order, so the job does not submit it.
- **The identity** (name `OrivonBrowser.OrivonBrowser`, publisher and display name) is in the `appx` block of
  `electron-builder.yml`, copied from the product's Product identity page in Partner Center; the Store refuses a package
  whose identity differs.
- **Nothing happens without the four secrets** `MS_STORE_TENANT_ID`, `MS_STORE_SELLER_ID`, `MS_STORE_CLIENT_ID` and
  `MS_STORE_CLIENT_SECRET`: the job writes a warning naming them and succeeds. They are read in two places only, the
  step that checks they exist and the step that runs `msstore reconfigure`.
- **One submission at a time.** Partner Center allows one submission of a product in review. `msstore publish` replaces
  a draft but not a submission in review, so when it fails with that, the job says so in a warning, naming the tag to run
  again once the first one is published, and succeeds. Any other failure fails the job, and only that job.
- **After the submission.** Microsoft documents that a submission created through the API is changed only through the API:
  one edited in Partner Center can no longer be committed through it. A change to the listing text goes into a new draft
  in Partner Center once the submitted release is published; the next release's `msstore publish` then starts from the
  published one.
- **Not verified here.** The job has not run against Partner Center, which needs the secrets. What was checked is its
  shell logic against a stand-in `msstore`, the version rule in electron-builder's source, and the commands and flags
  against Microsoft's documentation. The `.msix` copy the job makes of the `.appx` (the CLI names `.msix` and
  `.msixupload`; the container is the same) and the wording of the in-review failure that the job matches are the two
  points the first real run settles.

**What the owner does once.**

1. Publish the first version of the product by hand in Partner Center, with its age-rating questionnaire and the steps of
   [`release-checklist.md`](release-checklist.md) item The Microsoft Store package, and wait until it is live. Microsoft:
   `msstore` can only publish updates of a product that has been published once. It supports free products.
2. Have a Microsoft Entra ID tenant associated with the Partner Center account (Microsoft's guide: "Associate an existing
   Microsoft Entra ID with your Partner Center account", or "Create a new Microsoft Entra ID"). The next step needs a
   Partner Center sign-in that has the Manager role and is a global administrator of that tenant.
3. In Partner Center, Account settings > User management > the **Microsoft Entra applications** tab > **Add Microsoft
   Entra application**: **Create Microsoft Entra application** (a name and a reply URL, which can be any address you own)
   or **Add Microsoft Entra application** to take one the tenant already has. In **Roles applicable to developer
   programs** give it **Manager**. Open the application from that list and note its **Tenant ID** and **Client ID**, then
   **Add new key** and note the **Key** at once: it is shown once, and the list shows when each key expires. Note the
   account's **Seller ID**, which Microsoft's guide places under Account settings.
4. Add the four repository secrets: `MS_STORE_TENANT_ID`, `MS_STORE_SELLER_ID`, `MS_STORE_CLIENT_ID` and
   `MS_STORE_CLIENT_SECRET` (Settings > Secrets and variables > Actions). A failing
   `reconfigure` in the job is most likely an expired key: add a new one and replace the secret.
5. Once the Store lists Orivon, set `store` to `true` in
   [`packaging/release-routes.json`](../../packaging/release-routes.json), so the release notes point to it.

## The Arch User Repository

`orivon-bin` on the [AUR](https://aur.archlinux.org) installs the release's `.deb` on Arch Linux and its relatives. The
`.deb` is the source, not the AppImage: it is the package CI installs and launches, it carries the desktop entry with its
two launcher actions and the icon, and it puts `chrome-sandbox` on a filesystem where the SUID bit can be set. The
template is [`packaging/aur/PKGBUILD`](../../packaging/aur/PKGBUILD): it unpacks the `.deb` into `/opt/Orivon`, links
`/usr/bin/orivon`, sets `chrome-sandbox` to `4755`, drops Debian's AppArmor profile, moves the AppStream file to
`/usr/share/metainfo`, and declares `provides=('orivon')`, `conflicts=('orivon')` and the license `AGPL-3.0-only`, the
license `package.json` and the README state.

The `aur` job of `release.yml` runs after `publish`. It takes the `.deb`'s sha256 from the release's `ipfs.json`, reads what
the AUR holds now over https, and runs [`packaging/aur/prepare.sh`](../../packaging/aur/prepare.sh) in an Arch container
(`archlinux:base-devel`, pinned by digest). That script fills `_upstream`, `pkgrel` and `sha256sums`, builds the package once
with `makepkg` (which downloads the `.deb` and checks the sha256, so a broken PKGBUILD is found before anything is pushed)
and writes `.SRCINFO` with `makepkg --printsrcinfo`. The last step, the only one that holds the key, pushes `PKGBUILD` and
`.SRCINFO` to `ssh://aur@aur.archlinux.org/orivon-bin.git`, against the AUR's ed25519 host key, pinned in the step.

- **Versions.** `pkgver` may not contain a hyphen. `0.0.9` is `0.0.9`; a pre-release tag drops the hyphen, so
  `v0.2.0-beta.1` is `0.2.0beta.1`, which `vercmp` sorts after `0.2.0alpha.3` and before `0.2.0`, and `beta.10` after
  `beta.9`. A suffix other than a word and an optional `.n` has no such mapping and is not offered. `pkgrel` is 1 for
  a new version, and one more than the AUR's when the same version is pushed with another `.deb`. A version older than the
  AUR's, or the same package again, pushes nothing.
- **Nothing happens without the secret** `AUR_SSH_PRIVATE_KEY`: the job writes a warning and succeeds.
- **Not verified here.** The PKGBUILD and `prepare.sh` were run in the pinned Arch container against a released `.deb`
  (the package builds, `.SRCINFO` is written, the version cases above give the results above). The push has not run,
  which needs the key and an AUR account.

**What the owner does once.**

1. Create an AUR account, and an SSH key pair for it (`ssh-keygen -t ed25519 -f aur-orivon`). Add the public key to the
   account (AUR > My Account > SSH Public Key).
2. Add the private key as the repository secret `AUR_SSH_PRIVATE_KEY`. The first push to `orivon-bin` creates the package.
3. Set `aur` to `true` in [`packaging/release-routes.json`](../../packaging/release-routes.json) once the package is
   listed, so the release notes list it.

## AppImageHub

[AppImageHub](https://appimage.github.io) lists AppImages found on GitHub releases. A listing is one pull request to
[`AppImage/appimage.github.io`](https://github.com/AppImage/appimage.github.io), opened once by the owner; the Hub then
reads the newest release itself. Its rules, as that repository states them: a type 2 AppImage that runs on the oldest
supported Ubuntu LTS and shows a window within 30 seconds without network access, an English interface, a desktop file that
passes `desktop-file-validate`, an AppStream file that passes `appstreamcli`, `appdir-lint.sh`, and X11 (it does not test
Wayland).

- **The AppStream file** is [`build/linux/com.orivonstack.orivon.metainfo.xml`](../../build/linux/com.orivonstack.orivon.metainfo.xml),
  put into the AppImage at `usr/share/metainfo/` by `linux.extraFiles` in `electron-builder.yml`. A built AppImage was
  extracted and both files checked: the desktop file passes `desktop-file-validate`, and `appstreamcli validate --pedantic`
  passes with one pedantic note, that the file lists no `<releases>`. The `.deb` carries the same file under
  `/opt/Orivon/usr/share/metainfo`, where nothing reads it; the Arch package moves it.
- **The data file** is [`packaging/appimagehub/Orivon_Browser`](../../packaging/appimagehub/Orivon_Browser): named after the
  desktop file's `Name` with the space an underscore, and holding one line, the repository's address.
- **Not checked here.** `appdir-lint.sh` and the Hub's own screenshot and offline runs; the Hub's pull request shows them.
  An AppImage built with this electron-builder starts with `--no-sandbox` (its desktop entry says so), and on Ubuntu 22.04
  and later needs `libfuse2` (section Caveats); the Hub's test machine settles whether either stops the listing.

**What the owner does once.** Open a pull request to `AppImage/appimage.github.io` that adds only the file
`data/Orivon_Browser`, with the content of `packaging/appimagehub/Orivon_Browser`. One file per pull request: the Hub's
checks fail on any other change. Answer its test comment, and comment `/retest` after a fix is released.

## Release notes

The description of a GitHub release is written by the `notes` job (and attached by `publish`) with
[`scripts/release-notes.mjs`](../../scripts/release-notes.mjs), which uses Node's built-ins only and is tested in
[`scripts/tests/release-notes.test.ts`](../../scripts/tests/release-notes.test.ts). It writes, below a hidden marker line:

1. **What changed**: the `Added`, `Changed`, `Fixed`, `Security`, `Removed` and `Deprecated` entries of the tag's section
   in [`CHANGELOG.md`](../../CHANGELOG.md), verbatim, and a link to the file at the tag. `Changed for apps` is left to the
   changelog, and `[Unreleased]` is never used: the section must be renamed to the version before tagging. With no such
   section the description has none and the job shows a warning.
2. **Which file is mine?**: a table with one row for each package the release carries (Windows installer, both macOS
   disk images and the Terminal install, the `.deb`, the AppImage), then a row for the Store, winget and the AUR when the
   route is open in [`packaging/release-routes.json`](../../packaging/release-routes.json), which holds a `true` or `false`
   for each.
3. **On IPFS**: the release's CID, as before.

Whatever a person wrote above the marker stays, and a re-run replaces everything from the marker on. A description written
before the marker existed is converted at its `### On IPFS` heading. The changelog's entries are published as written, so
they follow the same rules as any release text: shipped items only.

## Windows and macOS

**Windows.** The installer is unsigned. On first run SmartScreen shows "Windows protected your
PC": **More info**, then **Run anyway**. It installs for the current user into
`%LOCALAPPDATA%\Programs\Orivon`, needs no administrator, and lets the person choose another
folder. Silent install: `Orivon-Setup-<version>-x64.exe /S`. A person who would rather not see the warning installs
from the Microsoft Store instead (section The Microsoft Store package).

**macOS.** A release's apps are signed with a Developer ID Application certificate, run with the
hardened runtime, and notarized by Apple with the ticket stapled to each app, so a Mac opens Orivon
after a download without refusing it (section Signing). [`build/entitlements.mac.plist`](../../build/entitlements.mac.plist)
gives the app and its helpers what the hardened runtime otherwise refuses: executable memory for V8 and
WebAssembly, and the camera and microphone (`extendInfo` carries the reasons macOS shows when a page
first asks). `npm run package:mac:signed` builds that. `npm run package:mac`, and the pull-request
build, sign ad hoc instead (`identity: "-"`, hardened runtime off, no notarization), because
Apple silicon refuses a binary with no signature at all, and packaging rewrites the Electron binary
(its fuses, name and `Info.plist`), so the signature Electron shipped with no longer holds. An ad-hoc
app is refused on its first open: open **System Settings > Privacy & Security** and choose
**Open Anyway**, or run `xattr -dr com.apple.quarantine /Applications/Orivon.app`. The Intel dmg
is built on an Apple silicon runner and launched there under Rosetta.

**macOS one-line install.** `scripts/install-macos.sh`, run as
`curl -fsSL https://raw.githubusercontent.com/OrivonBrowser/orivon-mvp/main/scripts/install-macos.sh | bash`,
installs or updates Orivon with no Gatekeeper prompt. Gatekeeper only checks files that carry the
`com.apple.quarantine` attribute, which a browser adds to a download and `curl` does not; Apple
silicon still wants a signature, and the build's is enough. The script reads the
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

**Windows one-line install.** `scripts/install-windows.ps1`, run in PowerShell as
`irm https://raw.githubusercontent.com/OrivonBrowser/orivon-mvp/main/scripts/install-windows.ps1 | iex`,
installs or updates Orivon with no SmartScreen warning. SmartScreen only inspects files that carry the Mark of the
Web (a `Zone.Identifier` stream), which a browser adds to a download and `Invoke-WebRequest` does not. It picks the
release and checks the download exactly as the macOS script does (the newest non-pre-release with an x64 installer
and a digest, else the newest pre-release), runs the installer with `/S`, and starts Orivon unless the installer
already did. It refuses to run while Orivon is running. The digest check guards against a broken or swapped
download in transit, not against someone who controls the GitHub repository. Antivirus software judges the file on
its own and can still flag an unsigned installer. Settings are environment variables: `ORIVON_REPO`,
`ORIVON_INSTALLER` (a local installer, which skips the lookup, download and digest check), `ORIVON_INSTALL_DIR`,
`ORIVON_NO_OPEN=1` and `ORIVON_GITHUB_TOKEN`. The release workflow's Windows leg installs the package it just built
through the script and launches the result with the packaged smoke check; on pull requests and manual runs it also
installs the newest published release through it.

**Linux one-line install.** `scripts/install-linux.sh`, run as
`curl -fsSL https://raw.githubusercontent.com/OrivonBrowser/orivon-mvp/main/scripts/install-linux.sh | bash`
(or `bash -s <id>` with an app id), installs or updates the AppImage for the person alone, with no sudo, on
x86_64. It reads the newest releases from GitHub's API the way the update check does: the highest version, pre-releases
counted, drafts and tags that are not versions (`pre-releases`) skipped, and a release whose AppImage is not
attached yet passed over. It downloads that `Orivon-<version>-x86_64.AppImage`, compares its SHA-256 with the digest
GitHub reports for the asset, and refuses a mismatch or a missing digest before it installs anything. Then it
writes, under the home folder only: the AppImage as `~/.local/lib/orivon/Orivon.AppImage`; a launcher beside it,
`orivon`; `~/.local/share/applications/orivon.desktop` (the packaged entry's name, categories and the
`x-scheme-handler/http` and `https` types, plus New Window and New Private Window, its `Exec` the launcher, so
a desktop's default-browser choice lists Orivon and the entry works wherever the folder is); the icon in
`~/.local/share/icons/hicolor/512x512/apps/`, unpacked from the AppImage (the repository's copy at the release's
tag when that fails); and `~/.local/bin/orivon`, a link to the launcher, only when that folder is already on
`PATH` and holds no other file of that name. The file is renamed into place, so a running Orivon keeps working
and the next start is the new version; running the command again is the update.

The launcher decides at every start whether the AppImage can mount itself: `/dev/fuse` readable and writable,
`fusermount`, and `libfuse.so.2` from `ldconfig -p` or the usual library folders must all be there. When one is
missing (Ubuntu 22.10 and later without `libfuse2`, a container) it starts the AppImage with
`--appimage-extract-and-run`, which unpacks it to a temporary folder first (slower to start, nothing to
install); installing `libfuse2` later needs no new install. The launcher is not the registration of Orivon as the
default browser that a package makes at a person's click (the runtime half in section Making "set as default browser" possible): the desktop entry only lets a desktop list it.

An app id (2 to 24 lower-case letters and digits, refused otherwise) is passed to the launch the installer makes
as `--orivon-flavour=<id>`; `--no-launch` (or `ORIVON_NO_OPEN=1`) installs without starting Orivon, which is what
a test uses, and then the id is not used. The environment variables are `ORIVON_REPO` (the repository to read
releases from), `ORIVON_APPIMAGE` (a local AppImage, which skips the lookup, download and digest check) and
`ORIVON_GITHUB_TOKEN` (lifts the unauthenticated rate limit). Reading GitHub's answer needs `python3` or `jq`;
the script reads either and refuses to guess without one. The digest check guards against a broken or swapped
download in transit, not against someone who controls the GitHub repository. The unit tests
(`scripts/tests/install-linux.test.ts`) run it in a scratch home against a stand-in `curl`; the release workflow
installs the AppImage it just built through it and starts the launcher with the packaged smoke check, and on pull
requests and manual runs also installs the newest published release.

**Signing.** The release workflow's step "Package, sign and notarize" signs and notarizes the macOS
apps from five repository secrets: `CSC_LINK` (the Developer ID Application certificate with its private
key, as a base64 `.p12`), `CSC_KEY_PASSWORD` (the `.p12`'s password), `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD` (made for this use at account.apple.com, under Sign-In and Security) and
`APPLE_TEAM_ID`. Only a release and a manual run read them, no other platform's step does (`CSC_LINK`
would make electron-builder sign the Windows installer with it), and a pull request builds ad hoc. An
empty secret stops the macOS job before it builds. The step "Check the signature, mount each dmg and
launch it" mounts each dmg and requires the Developer ID signature, the hardened runtime, a stapled
ticket and Gatekeeper's verdict `Notarized Developer ID`. `gh workflow run release.yml --ref <branch>`
signs and notarizes a branch's build without publishing anything, which is how a change to this is
tried; it runs the branch's own build scripts with the secrets, so anyone who can push a branch to the
repository can read them, and an environment limited to `main` and release tags would narrow that.

The certificate lasts five years from its issue. Before it ends, make a new signing request, issue a new
Developer ID Application certificate, and replace `CSC_LINK` and `CSC_KEY_PASSWORD`; releases already
notarized keep opening. The app-specific password stops working when the Apple ID's password changes:
make a new one and replace `APPLE_APP_SPECIFIC_PASSWORD`. A Windows code-signing certificate would remove
the SmartScreen warning; none is bought (the Store package has no warning to remove).

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
#   MimeType=text/html;application/xhtml+xml;image/svg+xml;application/pdf;x-scheme-handler/http;x-scheme-handler/https;x-scheme-handler/orivon;
# and:
#   Categories=Network;WebBrowser;
#   Actions=new-window;new-private-window;
# followed by a [Desktop Action new-window] and a [Desktop Action new-private-window] section whose Exec
# lines run /opt/Orivon/orivon with --new-window and --new-private-window. The AppImage's own entry
# (Exec=AppRun) carries no actions: they sit under `deb:` in electron-builder.yml, and `appImage:` has an entry of its own.
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
(`schemes: [http, https, orivon]`) is what electron-builder documents as producing the `.desktop` file's
`MimeType=` line (`x-scheme-handler/http;x-scheme-handler/https;x-scheme-handler/orivon;`), and `linux.category` supplies
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
`--new-private-window`); they sit under `deb:` and not `linux:`, and the entry's common keys are written under `deb:` and
`appImage:` each, because a `linux.desktop` would reach the AppImage's entry too, where `Exec` is `AppRun` and `/opt/Orivon`
does not exist. A built AppImage's entry has no `Actions` line. On Windows the same two
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
- **`orivon:` links.** The Windows installer also writes the class `Software\Classes\orivon` (`URL Protocol`, the same
  `-- "%1"` command), which is not a default-app choice and is removed on uninstall. On macOS and in the Store manifest
  the `protocols` entry carries it (`CFBundleURLTypes`; a `windows.protocol` extension), and on Linux the .deb's desktop
  entry lists `x-scheme-handler/orivon`. A run from source registers none of them, and the Linux "Orivon (source)"
  entry does not list the scheme, so a checkout never takes the links from an installed Orivon; the AppImage does
  not integrate with the desktop and takes none either. What an `orivon:` link may name is in
  [ADR-0094](../decisions/ADR-0094-an-orivon-link-from-another-program-opens-a-eth-name-or-an-ipfs-address.md).
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
