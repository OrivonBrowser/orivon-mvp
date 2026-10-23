#!/usr/bin/env bash
# Installs or updates Orivon on Linux (x86_64) with one command, no sudo (docs/development/packaging.md
# section Linux one-line install):
#
#   curl -fsSL https://raw.githubusercontent.com/OrivonBrowser/orivon-mvp/main/scripts/install-linux.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/OrivonBrowser/orivon-mvp/main/scripts/install-linux.sh | bash -s <id>
#
# Finds the newest release with an x86_64 AppImage (the highest version, pre-releases included, drafts and
# tags that are not versions skipped, as the update check reads them), downloads it with curl, checks its
# SHA-256 against the digest GitHub reports for the file, and puts it in ~/.local/lib/orivon/. A launcher,
# a desktop entry that lists Orivon as a browser (http and https) and its icon go in your home folder, so it
# shows in the application menu and in the default-browser choice of your desktop. Run it again to update.
#
# Options: an app id (2 to 24 lower-case letters and digits) is handed to the first launch as
# --orivon-flavour=<id>; --no-launch installs without starting Orivon. Settings come from the environment:
#
#   ORIVON_REPO         the GitHub repository to read releases from (default OrivonBrowser/orivon-mvp)
#   ORIVON_APPIMAGE     a local AppImage to install instead: skips the release lookup, the download and the
#                       digest check, since the caller vouches for the file
#   ORIVON_NO_OPEN=1    the same as --no-launch
#   ORIVON_GITHUB_TOKEN a GitHub token for the release lookup, which lifts the per-address rate limit an
#                       unauthenticated lookup shares (a CI runner's address is shared by many jobs)
#
# Needs bash, curl, and python3 or jq to read GitHub's answer.
set -euo pipefail

REPO=${ORIVON_REPO:-OrivonBrowser/orivon-mvp}

TMP_DIR=""

say () { echo "[orivon] $*"; }
fail () { echo "[orivon] $*" >&2; exit 1; }

cleanup () {
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then rm -rf "$TMP_DIR"; fi
}

usage () {
  cat <<'EOF'
Usage: install-linux.sh [--no-launch] [app-id]

Installs or updates Orivon for your user (no sudo): the newest release's x86_64 AppImage, a launcher, a
desktop entry and an icon. An app id is passed to the first launch as --orivon-flavour=<id>.
EOF
}

# Prints the tag, the download URL and the digest ("sha256:<hex>") of the release to install, one per line:
# the release with the highest version that is not a draft and has an x86_64 AppImage. A release published but
# not yet carrying its packages is skipped; one whose AppImage has no digest is picked and refused later.
pick_with_python () {
  python3 - "$1" <<'PYTHON'
import json, re, sys

releases = json.loads(sys.argv[1])
version = re.compile(r"^[vV]?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$")
asset_name = re.compile(r"^Orivon-.*-x86_64\.AppImage$")
best = None
for release in releases if isinstance(releases, list) else []:
    if not isinstance(release, dict) or release.get("draft"):
        continue
    match = version.match(str(release.get("tag_name", "")))
    if not match:
        continue
    asset = next((a for a in release.get("assets") or [] if isinstance(a, dict) and asset_name.match(str(a.get("name", "")))), None)
    if asset is None:
        continue
    pre = match.group(4)
    # A release ranks above its own pre-releases; numbers rank below words inside a pre-release.
    ids = [] if pre is None else [(0, int(i), "") if i.isdigit() else (1, 0, i) for i in pre.split(".")]
    key = (int(match.group(1)), int(match.group(2)), int(match.group(3)), 1 if pre is None else 0, ids)
    if best is None or key > best[0]:
        best = (key, release["tag_name"], asset.get("browser_download_url", ""), str(asset.get("digest") or ""))
if best:
    print("\n".join(best[1:]))
PYTHON
}

pick_with_jq () {
  printf '%s' "$1" | jq -r '
    [ .[]?
      | select(.draft != true)
      | . as $r
      | ($r.tag_name // "" | sub("^[vV]"; "") | sub("\\+.*$"; "")
         | capture("^(?<m>0|[1-9][0-9]*)\\.(?<n>0|[1-9][0-9]*)\\.(?<p>0|[1-9][0-9]*)(-(?<pre>[0-9A-Za-z.-]+))?$")?) as $v
      | select($v != null)
      | ($r.assets // [] | map(select(.name | test("^Orivon-.*-x86_64\\.AppImage$"))) | first) as $a
      | select($a != null)
      | { tag: $r.tag_name, url: $a.browser_download_url, digest: ($a.digest // ""),
          key: [ ($v.m | tonumber), ($v.n | tonumber), ($v.p | tonumber),
                 (if $v.pre == null then 1 else 0 end),
                 (($v.pre // "") | if . == "" then [] else split(".") | map(if test("^[0-9]+$") then [0, tonumber] else [1, .] end) end) ] } ]
    | sort_by(.key) | last // empty | [.tag, .url, .digest] | .[]'
}

pick_release () {
  if command -v python3 >/dev/null 2>&1; then pick_with_python "$1"
  elif command -v jq >/dev/null 2>&1; then pick_with_jq "$1"
  else return 1
  fi
}

sha256_of () {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d ' ' -f 1
  else openssl dgst -sha256 "$1" | sed 's/^.*= //'
  fi
}

# The launcher the desktop entry and ~/.local/bin/orivon run. It decides at every start whether the AppImage
# can mount itself (FUSE 2: the device, fusermount and libfuse.so.2 must all be there), so installing libfuse2
# later needs no new install; without it the AppImage unpacks itself to a temporary folder and runs from there.
write_launcher () {
  cat >"$1" <<'LAUNCHER'
#!/bin/sh
# Starts Orivon from the AppImage beside this file (written by scripts/install-linux.sh).
here=$(dirname "$(readlink -f "$0")")
app=$here/Orivon.AppImage
# ORIVON_FUSE_DEVICE names another device file than /dev/fuse, which is how a test makes the AppImage unable to mount.
fuse_device=${ORIVON_FUSE_DEVICE:-/dev/fuse}

fuse2_library () {
  if command -v ldconfig >/dev/null 2>&1 || [ -x /sbin/ldconfig ] || [ -x /usr/sbin/ldconfig ]; then
    { ldconfig -p || /sbin/ldconfig -p || /usr/sbin/ldconfig -p; } 2>/dev/null | grep -q 'libfuse\.so\.2' && return 0
  fi
  for lib in /usr/lib /usr/lib64 /lib /lib64 /usr/lib/*-linux-gnu /lib/*-linux-gnu /usr/lib/*/lib; do
    for file in "$lib"/libfuse.so.2*; do
      [ -e "$file" ] && return 0
    done
  done
  return 1
}

can_mount () {
  [ -r "$fuse_device" ] && [ -w "$fuse_device" ] || return 1
  command -v fusermount >/dev/null 2>&1 || [ -x /usr/bin/fusermount ] || [ -x /bin/fusermount ] || return 1
  fuse2_library
}

if can_mount; then exec "$app" "$@"; fi
exec "$app" --appimage-extract-and-run "$@"
LAUNCHER
  chmod 755 "$1"
}

# A path that goes into the desktop entry's Exec line is quoted there; these characters would need escapes
# this installer does not write.
plain_path () {
  case "$1" in
    *[\"\\\`\$%]*|*"
"*) return 1 ;;
  esac
}

write_desktop_entry () {
  local file=$1 exec_path=$2
  cat >"$file" <<EOF
[Desktop Entry]
Name=Orivon Browser
GenericName=Web Browser
Comment=A browser that runs applications Chrome cannot
Exec="$exec_path" %U
Terminal=false
Type=Application
Icon=orivon
StartupWMClass=orivon
Categories=Network;WebBrowser;
MimeType=text/html;application/xhtml+xml;image/svg+xml;application/pdf;x-scheme-handler/http;x-scheme-handler/https;
Actions=new-window;new-private-window;

[Desktop Action new-window]
Name=New Window
Exec="$exec_path" --new-window

[Desktop Action new-private-window]
Name=New Private Window
Exec="$exec_path" --new-private-window
EOF
}

# Puts the icon in the user's icon theme. The AppImage's own copy first (unpacking a few files needs no FUSE);
# the repository's copy at the release's tag when that fails and the release is known. Never fatal.
install_icon () {
  local appimage=$1 tag=$2 icon_dir=$3 found="" work
  work=$TMP_DIR/icon
  mkdir -p "$work" "$icon_dir"
  if ( cd "$work" && "$appimage" --appimage-extract 'usr/share/icons/hicolor/*/apps/*.png' >/dev/null 2>&1 ); then
    found=$(find "$work/squashfs-root/usr/share/icons/hicolor" -name '*.png' 2>/dev/null | sort | tail -n 1)
  fi
  if [ -z "$found" ] && [ -n "$tag" ]; then
    if curl -fsSL -o "$work/icon.png" "https://raw.githubusercontent.com/$REPO/$tag/build/icon.png" 2>/dev/null; then found=$work/icon.png; fi
  fi
  if [ -z "$found" ]; then
    say "Could not get the icon; the menu entry will show a generic one."
    return 0
  fi
  cp "$found" "$icon_dir/orivon.png"
}

main () {
  local no_launch=0 app_id="" arg
  [ "${ORIVON_NO_OPEN:-}" = "1" ] && no_launch=1
  for arg in "$@"; do
    case "$arg" in
      --no-launch) no_launch=1 ;;
      -h|--help) usage; exit 0 ;;
      -*) usage >&2; fail "Unknown option: $arg" ;;
      *)
        [ -z "$app_id" ] || fail "Give at most one app id."
        printf '%s' "$arg" | grep -Eq '^[a-z0-9]{2,24}$' || fail "The app id must be 2 to 24 lower-case letters and digits."
        app_id=$arg
        ;;
    esac
  done

  [ "$(uname -s)" = "Linux" ] || fail "This installer is for Linux. Download Orivon for your system from https://github.com/$REPO/releases"
  [ "$(uname -m)" = "x86_64" ] || fail "Orivon's AppImage is built for x86_64 only; this computer is $(uname -m). Packages: https://github.com/$REPO/releases"
  [ -n "${HOME:-}" ] && [ -d "$HOME" ] && [ -w "$HOME" ] || fail "HOME is not a folder you can write to."

  local lib_dir=$HOME/.local/lib/orivon
  local apps_dir=$HOME/.local/share/applications
  local icon_dir=$HOME/.local/share/icons/hicolor/512x512/apps
  local bin_dir=$HOME/.local/bin
  plain_path "$lib_dir" || fail "$lib_dir has a character a desktop entry cannot hold here; set HOME to a plainer path."

  TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/orivon-install.XXXXXX")
  trap cleanup EXIT
  mkdir -p "$lib_dir" "$apps_dir" || fail "Cannot create folders under $HOME/.local."

  local package tag
  if [ -n "${ORIVON_APPIMAGE:-}" ]; then
    [ -f "$ORIVON_APPIMAGE" ] || fail "ORIVON_APPIMAGE is not a file: $ORIVON_APPIMAGE"
    package=$ORIVON_APPIMAGE
    tag=""
  else
    command -v curl >/dev/null 2>&1 || fail "curl is needed."
    say "Looking for the newest Orivon ..."
    local json picked url digest tries=0
    # GitHub now and then answers the release list with an empty array: asked again twice before it counts.
    while :; do
      json=$(curl -fsSL ${ORIVON_GITHUB_TOKEN:+-H "Authorization: Bearer $ORIVON_GITHUB_TOKEN"} "https://api.github.com/repos/$REPO/releases?per_page=30") \
        || fail "Could not read the releases of $REPO from GitHub (offline, or its rate limit is reached). Try again later."
      tries=$((tries + 1))
      if ! [[ $json =~ ^[[:space:]]*\[[[:space:]]*\][[:space:]]*$ ]] || [ "$tries" -ge 3 ]; then break; fi
      sleep 1
    done
    picked=$(pick_release "$json") || fail "Reading the release list needs python3 or jq; install one and run this again."
    tag=$(printf '%s\n' "$picked" | sed -n 1p)
    url=$(printf '%s\n' "$picked" | sed -n 2p)
    digest=$(printf '%s\n' "$picked" | sed -n 3p)
    [ -n "$tag" ] && [ -n "$url" ] || fail "No release of $REPO has an x86_64 AppImage yet."
    digest=${digest#sha256:}
    case "$digest" in
      *[!0-9a-f]*|"") fail "GitHub reports no SHA-256 for the $tag AppImage. Nothing was installed." ;;
    esac
    [ ${#digest} -eq 64 ] || fail "GitHub reports no SHA-256 for the $tag AppImage. Nothing was installed."

    say "Downloading Orivon $tag ..."
    package=$TMP_DIR/Orivon.AppImage
    curl -fL --progress-bar -o "$package" "$url" || fail "The download failed."
    local actual
    actual=$(sha256_of "$package")
    if [ "$actual" != "$digest" ]; then
      rm -f "$package"
      fail "The download does not match the SHA-256 GitHub reports for it. Nothing was installed."
    fi
    say "Checked the SHA-256."
  fi

  # A running Orivon keeps its old file open: the new one takes the name with one rename.
  say "Installing into $lib_dir ..."
  cp "$package" "$lib_dir/Orivon.AppImage.new" || fail "Copying Orivon failed."
  chmod 755 "$lib_dir/Orivon.AppImage.new"
  mv -f "$lib_dir/Orivon.AppImage.new" "$lib_dir/Orivon.AppImage"
  install_icon "$lib_dir/Orivon.AppImage" "$tag" "$icon_dir"
  write_launcher "$lib_dir/orivon.new"
  mv -f "$lib_dir/orivon.new" "$lib_dir/orivon"

  write_desktop_entry "$apps_dir/orivon.desktop.new" "$lib_dir/orivon"
  mv -f "$apps_dir/orivon.desktop.new" "$apps_dir/orivon.desktop"
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$apps_dir" >/dev/null 2>&1 || true
  command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -t "$HOME/.local/share/icons/hicolor" >/dev/null 2>&1 || true

  # A command on the path only when ~/.local/bin is on it already, and never over a file that is not ours.
  local on_path=0
  case ":${PATH:-}:" in *":$bin_dir:"*) on_path=1 ;; esac
  if [ "$on_path" = "1" ]; then
    mkdir -p "$bin_dir"
    if [ ! -e "$bin_dir/orivon" ] && [ ! -L "$bin_dir/orivon" ] || [ "$(readlink "$bin_dir/orivon" 2>/dev/null || true)" = "$lib_dir/orivon" ]; then
      ln -sfn "$lib_dir/orivon" "$bin_dir/orivon"
    else
      say "$bin_dir/orivon exists and is not Orivon's launcher; left alone."
      on_path=0
    fi
  fi

  say "Installed Orivon${tag:+ $tag} at $lib_dir/Orivon.AppImage"
  say "It is in your application menu as Orivon Browser, and a desktop's default-browser choice can list it."
  if [ "$on_path" = "1" ]; then
    say "Start it from a terminal with: orivon"
  else
    say "Start it from a terminal with: $lib_dir/orivon"
  fi
  say "Run this command again at any time to update Orivon."
  if [ "$no_launch" = "1" ]; then
    [ -z "$app_id" ] || say "The app id $app_id is used by a launch from this command only; Orivon was not started."
    return 0
  fi
  local flavour=()
  [ -z "$app_id" ] || flavour=("--orivon-flavour=$app_id")
  # Detached, so Orivon outlives this shell and the pipe that fed it.
  if command -v setsid >/dev/null 2>&1; then
    setsid "$lib_dir/orivon" ${flavour[@]+"${flavour[@]}"} >/dev/null 2>&1 </dev/null &
  else
    nohup "$lib_dir/orivon" ${flavour[@]+"${flavour[@]}"} >/dev/null 2>&1 </dev/null &
  fi
}

main "$@"
