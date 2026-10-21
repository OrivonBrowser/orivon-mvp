#!/usr/bin/env bash
# Installs or updates Orivon on a Mac with one command, and opens it without a Gatekeeper warning
# (docs/development/packaging.md section Windows and macOS):
#
#   curl -fsSL https://raw.githubusercontent.com/OrivonBrowser/orivon-mvp/main/scripts/install-macos.sh | bash
#
# An optional argument names an app for Orivon to open the first time it runs on this Mac, passed on only when Orivon is
# opened by this script (one of the ids in resources/flavours.json; anything that is not 2 to 24 lowercase letters or
# digits stops the script before it downloads anything):
#
#   curl -fsSL https://raw.githubusercontent.com/OrivonBrowser/orivon-mvp/main/scripts/install-macos.sh | bash -s freetube
#
# Finds the newest release with a package for this Mac, downloads it with curl, checks its SHA-256
# against the digest GitHub reports for the file, copies Orivon.app into Applications and opens it.
# curl sets no quarantine attribute, so Gatekeeper never inspects the app. Runs on macOS's own bash 3.2
# and tools only. Settings come from the environment:
#
#   ORIVON_REPO         the GitHub repository to read releases from (default OrivonBrowser/orivon-mvp)
#   ORIVON_DMG          a local .dmg to install instead: skips the release lookup, the download and the
#                       digest check, since the caller vouches for the file
#   ORIVON_INSTALL_DIR  where Orivon.app goes (default /Applications if you can write there, else
#                       ~/Applications); never uses sudo
#   ORIVON_NO_OPEN=1    do not open Orivon at the end
#   ORIVON_GITHUB_TOKEN a GitHub token for the release lookup, which lifts the per-address rate limit an
#                       unauthenticated lookup shares (a CI runner's address is shared by many jobs)
set -euo pipefail

REPO=${ORIVON_REPO:-OrivonBrowser/orivon-mvp}

TMP_DIR=""
MOUNT_DIR=""

say () { echo "[orivon] $*"; }
fail () { echo "[orivon] $*" >&2; exit 1; }

cleanup () {
  if [ -n "$MOUNT_DIR" ] && [ -d "$MOUNT_DIR" ]; then
    hdiutil detach -quiet "$MOUNT_DIR" >/dev/null 2>&1 || hdiutil detach -quiet -force "$MOUNT_DIR" >/dev/null 2>&1 || true
  fi
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then rm -rf "$TMP_DIR"; fi
}

# Prints the tag, the download URL and the SHA-256 (hex) of the release to install, one per line: the
# first release that is not a pre-release and has a package for this architecture with a digest, else
# the first such release of any kind. A release published but not yet carrying its packages is skipped.
pick_release () {
  local arch=$1 json=$2
  osascript -l JavaScript -e '
    function run(argv) {
      var arch = argv[0];
      var releases = JSON.parse(argv[1]);
      var name = new RegExp("^Orivon-.*-" + arch + "\\.dmg$");
      var found = [];
      releases.forEach(function (r) {
        if (r.draft) return;
        (r.assets || []).forEach(function (a) {
          if (found.length && found[found.length - 1].tag === r.tag_name) return;
          if (!name.test(a.name) || !a.digest) return;
          found.push({ tag: r.tag_name, pre: !!r.prerelease, url: a.browser_download_url, digest: String(a.digest) });
        });
      });
      var pick = found.filter(function (f) { return !f.pre; })[0] || found[0];
      if (!pick) return "";
      return [pick.tag, pick.url, pick.digest.replace(/^sha256:/, "")].join("\n");
    }' "$arch" "$json" </dev/null
}

main () {
  local flavour=${1:-}
  case "$flavour" in
    "") ;;
    *[!a-z0-9]*) fail "The app to open first must be 2 to 24 lowercase letters and digits, such as freetube." ;;
    *) [ ${#flavour} -ge 2 ] && [ ${#flavour} -le 24 ] || fail "The app to open first must be 2 to 24 lowercase letters and digits, such as freetube." ;;
  esac
  [ "$(uname -s)" = "Darwin" ] || fail "This installer is for macOS. Download Orivon for your system from https://github.com/$REPO/releases"

  # hw.optional.arm64 is 1 on Apple silicon even when Terminal runs under Rosetta, where uname -m says x86_64.
  local arch=x64
  if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = "1" ]; then arch=arm64; fi

  local dest=${ORIVON_INSTALL_DIR:-}
  if [ -z "$dest" ]; then
    if [ -w /Applications ]; then dest=/Applications; else dest=$HOME/Applications; fi
  fi
  mkdir -p "$dest" || fail "Cannot create $dest."
  [ -w "$dest" ] || fail "Cannot write to $dest. Set ORIVON_INSTALL_DIR to a folder you own."

  TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/orivon-install.XXXXXX")
  trap cleanup EXIT

  local dmg tag
  if [ -n "${ORIVON_DMG:-}" ]; then
    [ -f "$ORIVON_DMG" ] || fail "ORIVON_DMG is not a file: $ORIVON_DMG"
    dmg=$ORIVON_DMG
    tag="local package"
  else
    say "Looking for the newest Orivon for $arch ..."
    local json picked url digest
    json=$(curl -fsSL ${ORIVON_GITHUB_TOKEN:+-H "Authorization: Bearer $ORIVON_GITHUB_TOKEN"} "https://api.github.com/repos/$REPO/releases?per_page=20") \
      || fail "Could not read the releases of $REPO from GitHub (offline, or its rate limit is reached). Try again later."
    picked=$(pick_release "$arch" "$json") || fail "Could not read the release list."
    tag=$(printf '%s\n' "$picked" | sed -n 1p)
    url=$(printf '%s\n' "$picked" | sed -n 2p)
    digest=$(printf '%s\n' "$picked" | sed -n 3p)
    [ -n "$tag" ] && [ -n "$url" ] || fail "No release of $REPO has an Orivon package for $arch yet."
    case "$digest" in
      *[!0-9a-f]*|"") fail "GitHub reports no SHA-256 for the $tag package." ;;
    esac
    [ ${#digest} -eq 64 ] || fail "GitHub reports no SHA-256 for the $tag package."

    say "Downloading Orivon $tag ($arch) ..."
    dmg=$TMP_DIR/Orivon.dmg
    curl -fL --progress-bar -o "$dmg" "$url" || fail "The download failed."
    local actual
    actual=$(shasum -a 256 "$dmg" | cut -d ' ' -f 1)
    if [ "$actual" != "$digest" ]; then
      rm -f "$dmg"
      fail "The download does not match the SHA-256 GitHub reports for it. Nothing was installed."
    fi
    say "Checked the SHA-256."
  fi

  if pgrep -xq Orivon; then
    fail "Orivon is running. Quit it (so no work is lost) and run this command again."
  fi

  MOUNT_DIR=$TMP_DIR/mnt
  mkdir -p "$MOUNT_DIR"
  hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$MOUNT_DIR" "$dmg" </dev/null >/dev/null \
    || fail "Could not open the package."
  [ -d "$MOUNT_DIR/Orivon.app" ] || fail "The package has no Orivon.app."

  say "Installing into $dest ..."
  rm -rf "$dest/Orivon.app.new"
  ditto "$MOUNT_DIR/Orivon.app" "$dest/Orivon.app.new" || { rm -rf "$dest/Orivon.app.new"; fail "Copying Orivon failed."; }
  rm -rf "$dest/Orivon.app"
  mv "$dest/Orivon.app.new" "$dest/Orivon.app"
  hdiutil detach -quiet "$MOUNT_DIR" >/dev/null 2>&1 || true
  MOUNT_DIR=""

  codesign --verify --deep --strict "$dest/Orivon.app" || fail "The installed Orivon.app fails its signature check."

  say "Installed Orivon ($tag) at $dest/Orivon.app"
  say "Run this command again at any time to update Orivon."
  if [ "${ORIVON_NO_OPEN:-}" != "1" ]; then
    # --args reaches the app only when this opens it, which is a first launch: Orivon is not running here (checked above).
    if [ -n "$flavour" ]; then open "$dest/Orivon.app" --args "--orivon-flavour=$flavour"; else open "$dest/Orivon.app"; fi
  fi
}

main "$@"
