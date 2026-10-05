#!/usr/bin/env bash
# Puts Orivon's GitHub releases on IPFS (docs/development/packaging.md §On IPFS).
#
#   pin-releases.sh manifest <dir>   prints the ipfs.json the release workflow attaches: the CID of
#                                    <dir> and each file's name and SHA-256. Hashes only; stores nothing.
#   pin-releases.sh sync             run by a pinning node on a timer: adds the files of the newest KEEP
#                                    releases, refuses one whose CID differs from its ipfs.json, pins it as
#                                    orivon-release-<tag>, and unpins the older releases it pinned.
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
  local releases kept='' tag cid manifest_url manifest name
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
    if keep_release "$tag" "$cid" "$manifest" "$release"; then kept+="$cid"$'\n'; fi
  done <<<"$releases"

  # Only the newest KEEP releases stay pinned. A pin this script did not name is never touched.
  while read -r cid _ name; do
    [[ ${name:-} == "$PIN_PREFIX"* ]] || continue
    if ! grep -qxF "$cid" <<<"$kept"; then
      ipfs pin rm "$cid" >/dev/null
      log "release ${name#"$PIN_PREFIX"} unpinned (ipfs://$cid): only the newest $KEEP stay pinned"
    fi
  done < <(ipfs pin ls --type=recursive --names)
}

case "${1:-}" in
  manifest) manifest "${2:?usage: pin-releases.sh manifest <dir>}" ;;
  sync) sync ;;
  *) echo "usage: pin-releases.sh manifest <dir> | pin-releases.sh sync" >&2; exit 2 ;;
esac
