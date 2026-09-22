# Packaging

Linux only: `deb` and `AppImage`, built by [`electron-builder`](https://www.electron.build)
from [`electron-builder.yml`](../../electron-builder.yml) at the repo root. Windows and macOS
are not packaged at all: they ship run-from-source, deliberately, to avoid buying
certificates ([`docs/planning/build-plan.md`](../planning/build-plan.md) "Platform policy";
[`docs/development/setup.md`](setup.md)).

> **Status: builds, and only partly verified against the build's output.** The build produces
> real `deb`/`AppImage` artefacts in `release/`, and the app window launches and renders the
> real shell from the built AppImage. **Not yet checked against a real build:** the desktop-entry
> contents, the `MimeType=`/`Categories=` composition, and the `xdg-settings` registration flow.
> §Known gaps below lists what is and is not confirmed; treat any other claim here as "designed
> to, per current docs" rather than "observed."

## `deb` is the primary artefact

Not a coin flip between two equally good options. The project's success metric is measured in
daily-driver hours ([`docs/mvp-scope.md`](../mvp-scope.md)), and only an **installed package**
can put a `.desktop` file where `xdg-settings` looks for it. `xdg-settings
set default-web-browser` walks `/usr/share/applications/`, not the filesystem in general, and a
bare AppImage never places anything there on its own, and electron-builder's own docs say plainly
that since electron-builder 21, AppImages do not automatically create desktop files, associate
file types, or register with the application menu.

So:
- **`deb`** is what makes "set Orivon as your default browser" reachable at all.
- **`AppImage`** is for trying Orivon without installing anything, and for the audience of the
  launch clip. It still carries the same `.desktop` metadata internally (electron-builder
  generates one for every Linux target from the shared `linux:` config), but nothing copies it
  into `~/.local/share/applications/` for you. A first-run "install desktop entry" flow that
  does that from inside the running app is planned (`build-plan.md` "Packaging"), and nothing in
  this config makes it impossible.

## How to build

`electron-builder` (`^26.15.3`) is a `devDependency` of this repository; run `npm install` and
it's there.

```bash
npm run package:linux
```

`"package:linux": "electron-vite build && electron-builder --linux"` in `package.json` runs the
same two steps a manual build would: `electron-vite build` first (`out/main`, `out/preload`,
`out/renderer`), then `electron-builder --linux`. `electron-builder` does not invoke the app
build itself: it packages whatever is already on disk, so skipping the first step packages a
stale (or missing) `out/`. `electron-builder.yml` is picked up automatically; it's the tool's
default config filename, so no `--config` flag is needed.

Output lands in `release/` (already gitignored).

### Verifying what actually got built

The build itself has now been run once (2026-09-03) and produced real `release/*.deb` and
`release/*.AppImage` files; the app window was confirmed launching and rendering the real shell
from the AppImage. The specific commands below, inspecting the `.desktop` entry's contents and
registering as the default browser, have **not** been run against that build. Treat this
section as a checklist still to complete, not a report of those results.

```bash
# Confirm the desktop entry actually says what "Making 'set as default browser'
# possible" below claims it says -- don't assume the protocols/mimeTypes composition in
# electron-builder.yml renders the way its comments predict.
dpkg -e release/*.deb /tmp/orivon-deb-control   # control files only, no install needed
dpkg -x release/*.deb /tmp/orivon-deb-inspect   # full contents
cat /tmp/orivon-deb-inspect/usr/share/applications/*.desktop

# Expect a line equivalent to:
#   MimeType=x-scheme-handler/http;x-scheme-handler/https;text/html;
# and:
#   Categories=Network;WebBrowser;
```

```bash
# Try the actual default-browser registration once installed
sudo dpkg -i release/*.deb
xdg-settings set default-web-browser orivon.desktop   # filename derived from
                                                        # linux.executableName below --
                                                        # confirm the real name first with
                                                        # `ls /usr/share/applications | grep -i orivon`
xdg-settings check default-web-browser orivon.desktop
```

## Making "set as default browser" possible: what's config and what isn't

`electron-builder.yml` handles the packaging half: the top-level `protocols` key
(`schemes: [http, https]`) and `linux.mimeTypes: [text/html]` are what electron-builder
documents as producing the `.desktop` file's `MimeType=` line, and `linux.category` supplies
`Categories=Network;WebBrowser;`. Both are freedesktop.org conventions `xdg-settings` and
desktop menus rely on.

That is necessary but not sufficient. **The app itself still has to call
`app.setAsDefaultProtocolClient()` at runtime** (and generally offer a "make me default" UI
action): that's application code belonging in `src/main`, not packaging config, and it is out
of scope for this file. Until it exists, a user can still run `xdg-settings set
default-web-browser` by hand against the installed `.desktop` file; the in-app convenience
action is separate follow-up work.

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

**Build on the oldest LTS you intend to support.** glibc's symbol versioning is backward
compatible, not forward compatible: a binary built (or linked, or whose shared-library version
floor is computed) on a newer glibc can reference symbol versions (`memcpy@GLIBC_2.14`,
`pthread_create@GLIBC_2.34`, and so on) that don't exist on an older system, and fails at
*launch* on that older system with an opaque `version 'GLIBC_2.xx' not found`, not at package
build time. The reverse direction is fine: a binary built against an old glibc baseline runs
unmodified on every newer one. Practically: build (and smoke-test) the `.deb` on the oldest
Ubuntu/Debian LTS this project intends to support, not on whatever happens to be on the
developer's own machine, or the packaged binary can silently stop working for exactly the users
least likely to know how to work around it.

**Only `deb` can register as the default browser.** Covered above at length; restated here
because it is the caveat that most directly shapes the "primary vs. trial artefact" framing at
the top of this document, and it's easy to read past once and forget while skimming for build
commands.

## Files shipped, and why the list is short

`electron-builder.yml`'s `files:` key is an **allowlist**: `out/**/*` and `package.json`,
nothing else, not even `node_modules/`. See the comments in that file for the full reasoning;
short version: `package.json` declares zero runtime `dependencies` (webtorrent and every
app-side library are pre-built app assets fetched into `userData` at runtime, never a shell
dependency, per `build-plan.md` "Platform policy" #1 and `ADR-0005`), so there is nothing under
`node_modules/` the packaged app needs, and an allowlist can't accidentally pick up `spike/`,
`test/`, `scripts/`, `devlog/`, `.claude/`, `docs/`, or root-level markdown the way a
blocklist subtracted from `**/*` would have to remember to keep excluding.

## Known gaps

What a real build leaves open. None of them blocks a build.

- **No app icon exists in this repository.** `electron-builder.yml` does not set `linux.icon`
  or `directories.buildResources`, so it relies on the documented default: a `build/icon.png`
  (or `.svg`, 1024x1024 recommended) that does not currently exist. Electron-builder does not
  hard-fail without one (it falls back to the stock Electron icon) but shipping the browser
  with the generic Electron logo is a real, visible gap, not a neutral default. Someone needs to
  design one, or accept the placeholder knowingly.
- **The `MimeType=` composition (`protocols.schemes` + `linux.mimeTypes` -> one merged line) is
  documented behaviour, not observed.** Verify it against `release/*.deb` with the
  `dpkg -e`/`-x` commands above.
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
  26.x; see §Version notes below.

## What this document does not cover

**Auto-update.** Cut (`build-plan.md`): unsigned
`electron-updater` on Linux verifies only a SHA-512 fetched from the same host that serves the
binary, which is a standing remote-code-execution channel keyed to a GitHub token. v0 checks
for a new version and notifies instead, which is a separate, already-scoped piece of work, not
part of this config. `electron-builder.yml` sets `publish: null` explicitly (not just omitted)
specifically so that a stray `latest-linux.yml`/`app-update.yml` never ships implying an update
channel that doesn't exist, since electron-builder would otherwise auto-detect a GitHub publish
target from `package.json`'s `repository` field.

**Code signing.** Not configured because it doesn't need to be: Linux `deb`/`AppImage` targets
aren't signed by electron-builder in the way Windows/macOS builds are, and this file doesn't
configure Windows or macOS targets at all (see the top of `electron-builder.yml`).

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
