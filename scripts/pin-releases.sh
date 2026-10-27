#!/usr/bin/env bash
# Puts Orivon's GitHub releases on IPFS (docs/development/packaging.md section On IPFS).
#
#   pin-releases.sh manifest <dir>   prints the ipfs.json the release workflow attaches: the CID of
#                                    <dir> and each file's name and SHA-256. Hashes only; stores nothing.
#   pin-releases.sh sync             run by a pinning node on a timer: adds the files of the newest KEEP
#                                    releases, refuses one whose CID differs from its ipfs.json, pins it as
#                                    orivon-release-<tag>, and unpins the older releases it pinned. With
#                                    LATEST_KEY set, points that IPNS key at the newest release it keeps,
#                                    with a start page that downloads the package for the visitor's system.
#
# Needs bash, curl, jq, sha256sum and Kubo's `ipfs`. Settings come from the environment, below.
set -euo pipefail

# Every layout choice that changes a CID, spelled out (the values are Kubo's long-standing defaults), so
# a node's own Import config cannot change it. The workflow and every pinning node use these: a change
# here changes every CID from the next release on.
ADD_FLAGS=(--cid-version=1 --raw-leaves --chunker=size-262144 --hash=sha2-256 --trickle=false --max-file-links=174 --inline=false)

REPO=${ORIVON_REPO:-OrivonBrowser/orivon-mvp}
RELEASES_URL=${RELEASES_URL:-https://api.github.com/repos/$REPO/releases?per_page=30}
KEEP=${KEEP:-3}
PIN_PREFIX=${PIN_PREFIX:-orivon-release-}
# The folder LATEST_KEY opens is pinned under LATEST_PIN, which must not start with PIN_PREFIX, and composed at
# LATEST_DRAFT in the node's MFS.
LATEST_PIN=${LATEST_PIN:-orivon-latest-release}
LATEST_DRAFT=${LATEST_DRAFT:-/.orivon-latest-release}
WORK=${WORK:-${TMPDIR:-/tmp}/orivon-release-pinner}

ipfs () { command ipfs ${IPFS_API:+--api "$IPFS_API"} "$@"; }
log () {
  echo "[pin-releases] $*"
  if [ -n "${SUMMARY_LOG:-}" ]; then echo "- $(date -u +%F): $*" >> "$SUMMARY_LOG"; fi
}

# A tag or file name becomes a path; anything else is refused rather than escaped.
safe_name () { [[ $1 =~ ^[A-Za-z0-9][A-Za-z0-9._+-]*$ ]]; }

manifest () {
  local dir=$1 cid
  cid=$(ipfs add -r -Q --only-hash "${ADD_FLAGS[@]}" "$dir")
  (cd "$dir" && sha256sum -- *) | jq -R -s --arg cid "$cid" --arg flags "${ADD_FLAGS[*]}" --arg kubo "$(ipfs version --number)" '{
    cid: $cid,
    add: ("ipfs add -r " + $flags),
    kubo: $kubo,
    files: [split("\n")[] | select(length > 0) | capture("^(?<sha256>[0-9a-f]{64}) [ *](?<name>.+)$") | {name, sha256}]
  }'
}

# A release refused for what it holds, as "<tag> <cid>": not downloaded again until its ipfs.json
# names another CID. A name starting with a dot can never be a tag's folder.
refused () { grep -qxF "$1 $2" "$WORK/.refused" 2>/dev/null; }
refuse () { echo "$1 $2" >> "$WORK/.refused"; log "release $1: $3; not pinned, and not retried for this CID"; }

# Downloads one release's files, checks each against its ipfs.json, and adds and pins them. Returns
# non-zero when the release cannot be kept; a download that fails is retried on the next run.
keep_release () {
  local tag=$1 cid=$2 manifest=$3 release=$4 dir name sha url got
  if ipfs pin ls --type=recursive "$cid" >/dev/null 2>&1; then return 0; fi
  if refused "$tag" "$cid"; then return 1; fi
  dir="$WORK/$tag"
  rm -rf "$dir" && mkdir -p "$dir"
  while IFS=$'\t' read -r name sha; do
    if ! safe_name "$name"; then refuse "$tag" "$cid" "file name '$name' refused"; return 1; fi
    url=$(jq -r --arg n "$name" '.assets[] | select(.name == $n) | .browser_download_url' <<<"$release")
    if [ -z "$url" ]; then log "release $tag: $name is listed in ipfs.json but not attached yet"; return 1; fi
    if ! curl -fsSL --retry 3 -o "$dir/$name" "$url"; then log "release $tag: could not download $name"; return 1; fi
    if ! echo "$sha  $dir/$name" | sha256sum -c --quiet - >/dev/null 2>&1; then
      rm -rf "$dir"; refuse "$tag" "$cid" "$name does not match its SHA-256 in ipfs.json"; return 1
    fi
  done < <(jq -r '.files[] | [.name, .sha256] | @tsv' <<<"$manifest")
  got=$(ipfs add -r -Q --pin=true --pin-name="$PIN_PREFIX$tag" "${ADD_FLAGS[@]}" "$dir")
  rm -rf "$dir"
  if [ "$got" != "$cid" ]; then
    ipfs pin rm "$got" >/dev/null 2>&1 || true
    refuse "$tag" "$cid" "the files add up to $got, not the $cid its ipfs.json names"
    return 1
  fi
  log "release $tag pinned as ipfs://$cid"
}

sync () {
  local releases kept='' newest_tag='' tag cid manifest_url manifest name
  mkdir -p "$WORK"
  # Newest first; a release counts once the workflow has attached its ipfs.json.
  releases=$(curl -fsSL --retry 3 "$RELEASES_URL" | jq -c '[.[] | select(.draft | not)
    | select(any(.assets[]; .name == "ipfs.json"))] | sort_by(.published_at) | reverse | .[]')
  # An empty answer is never a reason to unpin: stop before anything below can.
  if [ -z "$releases" ]; then echo "[pin-releases] no release carries an ipfs.json yet"; return 0; fi
  while read -r release; do
    [ -n "$release" ] && [ "$(grep -c . <<<"$kept")" -lt "$KEEP" ] || continue
    tag=$(jq -r .tag_name <<<"$release")
    if ! safe_name "$tag"; then log "release '$tag': refused tag name"; continue; fi
    manifest_url=$(jq -r '.assets[] | select(.name == "ipfs.json") | .browser_download_url' <<<"$release")
    manifest=$(curl -fsSL --retry 3 "$manifest_url")
    cid=$(jq -r .cid <<<"$manifest")
    if keep_release "$tag" "$cid" "$manifest" "$release"; then kept+="$cid"$'\n'; newest_tag=${newest_tag:-$tag}; fi
  done <<<"$releases"

  # Only the newest KEEP releases stay pinned. A pin this script did not name is never touched.
  while read -r cid _ name; do
    [[ ${name:-} == "$PIN_PREFIX"* ]] || continue
    if ! grep -qxF "$cid" <<<"$kept"; then
      ipfs pin rm "$cid" >/dev/null
      log "release ${name#"$PIN_PREFIX"} unpinned (ipfs://$cid): only the newest $KEEP stay pinned"
    fi
  done < <(ipfs pin ls --type=recursive --names)

  if [ -n "${LATEST_KEY:-}" ] && [ -n "$kept" ]; then point_latest "$(head -n 1 <<<"$kept")" "$newest_tag"; fi
}

# The index.html of the newest-release folder: starts the download of the package for the visitor's system and
# lists every file. Takes the tag, and "<size> <name>" lines on stdin; the names have passed safe_name, so none
# needs escaping. Without JavaScript, or on a system with no package, it is the list.
start_page () {
  local version=${1#v} size name
  cat <<EOF
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Orivon $version</title>
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<style>
  :root { --bg: #f4f8fc; --ink: #14183a; --muted: #4a5078; --link: #4a2fc4; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0b1030; --ink: #e9ecff; --muted: #a9b0d6; --link: #b9a8ff; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--ink); font: 17px/1.5 system-ui, sans-serif; }
  main { max-width: 36rem; padding: 0 16px; overflow-wrap: anywhere; }
  a { color: var(--link); font-weight: 600; }
  li span { color: var(--muted); }
</style>
</head>
<body>
<main>
<h1>Orivon $version</h1>
<p id="msg">Choose the package for your system:</p>
<ul>
EOF
  while read -r size name; do
    echo "<li><a href=\"./$name\" download>$name</a> <span>$(( (size + 500000) / 1000000 )) MB</span></li>"
  done
  cat <<'EOF'
</ul>
<p>Windows: the <code>.exe</code>. macOS: the <code>.dmg</code>, <code>arm64</code> for Apple silicon. Linux: the <code>.deb</code> or the <code>.AppImage</code>.</p>
</main>
<script>
  (function () {
    var nav = navigator, ua = nav.userAgent || '', plat = '', touch = nav.maxTouchPoints || 0;
    try { plat = (nav.userAgentData && nav.userAgentData.platform) || nav.platform || ''; } catch (e) {}
    var both = plat + ' ' + ua;
    var os = /Android|iPhone|iPad|iPod/i.test(ua) || (/Mac/.test(plat) && touch > 1) ? ''
      : /Win/.test(both) ? 'win' : /Mac/.test(both) ? 'mac'
      : /Linux|X11|CrOS/.test(both) && !/aarch64|armv\d/i.test(both) ? 'linux' : '';
    var want = { win: /^Orivon-Setup-.+-x64\.exe$/, mac: /^Orivon-.+-arm64\.dmg$/, linux: /^orivon_.+_amd64\.deb$/ }[os];
    function start (re) {
      var links = document.querySelectorAll('li a');
      for (var i = 0; re && i < links.length; i++) {
        if (!re.test(links[i].textContent)) continue;
        document.getElementById('msg').textContent = 'Your download of ' + links[i].textContent + ' is starting. If it does not, choose the package for your system:';
        links[i].click();
        return;
      }
    }
    // Apple silicon or Intel: only Chromium-based browsers tell; the others get the Apple silicon package.
    var arch = Promise.resolve('');
    try { if (os === 'mac' && nav.userAgentData && nav.userAgentData.getHighEntropyValues) arch = nav.userAgentData.getHighEntropyValues(['architecture']).then(function (v) { return v.architecture; }, function () { return ''; }); } catch (e) {}
    arch.then(function (a) { start(os === 'mac' && a === 'x86' ? /^Orivon-.+-x64\.dmg$/ : want); });
  })();
</script>
</body>
</html>
EOF
}

# One ipns:// address (and the .eth name set to it) that always opens the newest release this node keeps: the
# release's files, the same blocks, plus a start page (start_page). The folder is composed in MFS and pinned as
# LATEST_PIN; the folder it replaces is unpinned once the key has moved.
point_latest () {
  local cid=$1 tag=$2 id listing target old size name
  id=$(ipfs key list -l --ipns-base=base36 | awk -v k="$LATEST_KEY" '$2 == k { print $1 }') || true
  if [ -z "$id" ]; then echo "[pin-releases] no IPNS key named $LATEST_KEY; create it with ipfs key gen" >&2; return 0; fi
  listing=$(ipfs ls --resolve-type=false "$cid" | awk '{ size = $2; sub(/^[^ \t]+[ \t]+[^ \t]+[ \t]+/, ""); print size, $0 }')
  while read -r size name; do
    if ! safe_name "$name" || [ "$name" = index.html ]; then log "release $tag: file name '$name' refused for the start page"; return 0; fi
  done <<<"$listing"
  ipfs files rm -r --force "$LATEST_DRAFT" >/dev/null 2>&1 || true
  ipfs files cp "/ipfs/$cid" "$LATEST_DRAFT"
  start_page "$tag" <<<"$listing" | ipfs files write --create --truncate --cid-version=1 --raw-leaves "$LATEST_DRAFT/index.html"
  target=$(ipfs files stat --hash "$LATEST_DRAFT")
  ipfs files rm -r "$LATEST_DRAFT"
  ipfs pin add --name="$LATEST_PIN" "$target" >/dev/null
  if [ "$(ipfs name resolve --offline "/ipns/$id" 2>/dev/null || true)" != "/ipfs/$target" ]; then
    if ! ipfs --timeout=5m name publish --key="$LATEST_KEY" "/ipfs/$target" >/dev/null; then
      log "could not point $LATEST_KEY at ipfs://$target; retried on the next run"
      return 0
    fi
    log "ipns://$id ($LATEST_KEY) now opens ipfs://$target: release $tag (ipfs://$cid) with its start page"
  fi
  while read -r old _ name; do
    if [ "${name:-}" = "$LATEST_PIN" ] && [ "$old" != "$target" ]; then ipfs pin rm "$old" >/dev/null; fi
  done < <(ipfs pin ls --type=recursive --names)
}

case "${1:-}" in
  manifest) manifest "${2:?usage: pin-releases.sh manifest <dir>}" ;;
  sync) sync ;;
  *) echo "usage: pin-releases.sh manifest <dir> | pin-releases.sh sync" >&2; exit 2 ;;
esac
