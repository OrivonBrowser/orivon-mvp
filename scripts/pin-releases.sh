#!/usr/bin/env bash
# Puts Orivon's GitHub releases on IPFS (docs/development/packaging.md §On IPFS).
#
#   pin-releases.sh manifest <dir>   prints the ipfs.json the release workflow attaches: the CID of
#                                    <dir> and each file's name and SHA-256. Hashes only; stores nothing.
#   pin-releases.sh sync             run by a pinning node on a timer: adds the files of the newest KEEP
#                                    releases, refuses one whose CID differs from its ipfs.json, pins it
#                                    under MFS_DIR, unpins older ones, and publishes MFS_DIR under IPNS_KEY.
#
# Needs bash, curl, jq, sha256sum and Kubo's `ipfs`. Settings come from the environment, below.
set -euo pipefail

# The CID is reproducible only with these flags and Kubo's default import settings. The workflow and
# every pinning node must use the same ones: a change here changes every CID from the next release on.
ADD_FLAGS=(--cid-version=1 --raw-leaves --chunker=size-262144 --hash=sha2-256)

REPO=${ORIVON_REPO:-OrivonBrowser/orivon-mvp}
RELEASES_URL=${RELEASES_URL:-https://api.github.com/repos/$REPO/releases?per_page=30}
KEEP=${KEEP:-3}
IPNS_KEY=${IPNS_KEY:-orivon-releases}
MFS_DIR=${MFS_DIR:-/orivon-releases}
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
  (cd "$dir" && sha256sum -- *) | jq -R -s --arg cid "$cid" --arg flags "${ADD_FLAGS[*]}" '{
    cid: $cid,
    add: ("ipfs add -r " + $flags),
    files: [split("\n")[] | select(length > 0) | capture("^(?<sha256>[0-9a-f]{64}) [ *](?<name>.+)$") | {name, sha256}]
  }'
}

# Downloads one release's files, checks each against its ipfs.json, adds and pins them, and puts the
# release at MFS_DIR/<tag>. Returns non-zero, having logged why, when the release cannot be kept.
keep_release () {
  local tag=$1 cid=$2 manifest=$3 release=$4 dir name sha url got
  if [ "$(ipfs files stat --hash "$MFS_DIR/$tag" 2>/dev/null)" = "$cid" ]; then return 0; fi
  dir="$WORK/$tag"
  rm -rf "$dir" && mkdir -p "$dir"
  while IFS=$'\t' read -r name sha; do
    if ! safe_name "$name"; then log "release $tag: refused file name '$name'"; return 1; fi
    url=$(jq -r --arg n "$name" '.assets[] | select(.name == $n) | .browser_download_url' <<<"$release")
    if [ -z "$url" ]; then log "release $tag: $name is listed in ipfs.json but not attached"; return 1; fi
    if ! curl -fsSL --retry 3 -o "$dir/$name" "$url"; then log "release $tag: could not download $name"; return 1; fi
    if ! echo "$sha  $dir/$name" | sha256sum -c --quiet - >/dev/null 2>&1; then
      log "release $tag: $name does not match its SHA-256 in ipfs.json"; return 1
    fi
  done < <(jq -r '.files[] | [.name, .sha256] | @tsv' <<<"$manifest")
  got=$(ipfs add -r -Q --pin=true "${ADD_FLAGS[@]}" "$dir")
  rm -rf "$dir"
  if [ "$got" != "$cid" ]; then
    ipfs pin rm "$got" >/dev/null 2>&1 || true
    log "release $tag: the files add up to $got, not the $cid its ipfs.json names; not pinned"
    return 1
  fi
  ipfs files rm -r "$MFS_DIR/$tag" >/dev/null 2>&1 || true
  if ! ipfs files cp "/ipfs/$cid" "$MFS_DIR/$tag"; then log "release $tag: pinned, but could not be listed under $MFS_DIR"; return 1; fi
  log "release $tag pinned as ipfs://$cid"
}

sync () {
  local releases index='[]' kept='' tag cid at manifest_url manifest entry root key_id published listing
  mkdir -p "$WORK"
  ipfs files mkdir -p --cid-version=1 "$MFS_DIR"
  # Newest first; a release counts once the workflow has attached its ipfs.json.
  releases=$(curl -fsSL --retry 3 "$RELEASES_URL" | jq -c '[.[] | select(.draft | not)
    | select(any(.assets[]; .name == "ipfs.json"))] | sort_by(.published_at) | reverse | .[]')
  # An empty answer is never a reason to unpin: stop before anything below can.
  if [ -z "$releases" ]; then echo "[pin-releases] no release carries an ipfs.json yet"; return 0; fi
  while read -r release; do
    [ -n "$release" ] || continue
    tag=$(jq -r .tag_name <<<"$release")
    at=$(jq -r .published_at <<<"$release")
    if ! safe_name "$tag"; then log "release '$tag': refused tag name"; continue; fi
    manifest_url=$(jq -r '.assets[] | select(.name == "ipfs.json") | .browser_download_url' <<<"$release")
    manifest=$(curl -fsSL --retry 3 "$manifest_url")
    cid=$(jq -r .cid <<<"$manifest")
    if [ "$(grep -c . <<<"$kept")" -lt "$KEEP" ] && keep_release "$tag" "$cid" "$manifest" "$release"; then
      kept+="$tag"$'\n'
    fi
    index=$(jq -c --arg tag "$tag" --arg cid "$cid" --arg at "$at" '. + [{tag: $tag, cid: $cid, published_at: $at}]' <<<"$index")
  done <<<"$releases"

  # Only the newest KEEP releases stay pinned; releases.json still lists every one by CID.
  while read -r entry; do
    [ -n "$entry" ] && [ "$entry" != releases.json ] || continue
    if ! grep -qxF "$entry" <<<"$kept"; then
      cid=$(ipfs files stat --hash "$MFS_DIR/$entry")
      ipfs files rm -r "$MFS_DIR/$entry"
      ipfs pin rm "$cid" >/dev/null 2>&1 || true
      log "release $entry unpinned: only the newest $KEEP stay pinned"
    fi
  done < <(ipfs files ls "$MFS_DIR")
  listing=$(jq --arg kept "$kept" '[.[] | . as $r | . + {pinned: (($kept | split("\n")) | index($r.tag) != null)}]' <<<"$index")
  # Rewriting an unchanged file still gives it a new CID, which would republish the name every run.
  if [ "$(ipfs files read "$MFS_DIR/releases.json" 2>/dev/null)" != "$listing" ]; then
    ipfs files rm "$MFS_DIR/releases.json" >/dev/null 2>&1 || true
    printf '%s\n' "$listing" | ipfs files write --create --cid-version=1 "$MFS_DIR/releases.json"
  fi

  if ! ipfs key list | grep -qxF "$IPNS_KEY"; then ipfs key gen "$IPNS_KEY" >/dev/null; fi
  key_id=$(ipfs key list -l | awk -v k="$IPNS_KEY" '$2 == k { print $1 }')
  root=$(ipfs files stat --hash "$MFS_DIR")
  published=$(ipfs name resolve --offline "/ipns/$key_id" 2>/dev/null || true)
  if [ "$published" != "/ipfs/$root" ]; then
    ipfs name publish --key="$IPNS_KEY" --quieter "/ipfs/$root" >/dev/null
    log "release index ipns://$key_id now points at ipfs://$root"
  fi
}

case "${1:-}" in
  manifest) manifest "${2:?usage: pin-releases.sh manifest <dir>}" ;;
  sync) sync ;;
  *) echo "usage: pin-releases.sh manifest <dir> | pin-releases.sh sync" >&2; exit 2 ;;
esac
