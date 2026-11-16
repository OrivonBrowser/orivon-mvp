#!/usr/bin/env bash
# Keeps the IPNS records of a pinning node's keys alive (docs/development/packaging.md section Keeping the names alive).
#
#   ipns-republish.sh run   run by a timer: for every key of the node's Kubo except SKIP_KEYS, reads the record the
#                           node holds and puts it on the network again. A record with fewer than RENEW_DAYS days
#                           left is first signed anew, for the same value, to last LIFETIME. One line per key; exit 0
#                           when every key was handled, 1 when one failed, 2 on a usage or configuration error.
#
# Kubo's own republisher publishes the keys one after another under a context with no deadline, so one lookup that
# never ends (seen on Kubo 0.43.1) stops every key, and the 48 hours `ipfs name publish` signs for by default then
# run out. Here each key has a timeout of its own and several run at once. A DHT keeps a record for 36 to 48 hours
# only, so even a record valid for years is put again on every run.
#
# Needs bash 4.3 or later, jq, timeout (coreutils), GNU date and Kubo's `ipfs`. Settings come from the environment, below.
set -euo pipefail

IPFS_API=${IPFS_API:-/ip4/127.0.0.1/tcp/5001}
SKIP_KEYS=${SKIP_KEYS:-self}              # key names left alone, separated by commas
LIFETIME=${LIFETIME:-87672h}              # 3653 days: ten calendar years whatever the leap days
RENEW_DAYS=${RENEW_DAYS:-30}              # a record with fewer days left is signed anew
TIMEOUT=${TIMEOUT:-300}                   # seconds for each key
PARALLEL=${PARALLEL:-8}                   # keys handled at once
PINNER_UNIT=${PINNER_UNIT:-orivon-release-pinner.service}
PINNER_WAIT=${PINNER_WAIT:-3600}          # seconds to wait for the pinner before giving up
DRY_RUN=${DRY_RUN:-0}

IPFS=(ipfs ${IPFS_API:+--api "$IPFS_API"})

log () { echo "[ipns-republish] $*"; }
# A oneshot unit such as the pinner reports "activating" while it runs, never "active".
pinner_running () { case $(systemctl is-active "$PINNER_UNIT" 2>/dev/null) in active|activating|reloading) return 0 ;; esac; return 1; }

# The pinner moves latest-release, so a record signed anew while it runs could carry the value it is replacing.
wait_for_pinner () {
  local waited=0
  if pinner_running; then log "waiting for $PINNER_UNIT to finish"; fi
  while pinner_running; do
    if [ "$waited" -ge "$PINNER_WAIT" ]; then log "$PINNER_UNIT still runs after ${PINNER_WAIT}s: nothing was done"; exit 1; fi
    sleep 10
    waited=$(( waited + 10 ))
  done
}

# Runs `ipfs <args>` for at most TIMEOUT seconds. A failure leaves why in WHY: a client that gives up on a lookup that
# never ends has still stored a record signed here, and the next run puts it again.
ipfs_try () {
  local err code=0
  err=$(timeout "$TIMEOUT" "${IPFS[@]}" "$@" 2>&1 >/dev/null) || code=$?
  if [ "$code" = 0 ]; then return 0; fi
  if [ "$code" = 124 ]; then WHY="no answer in ${TIMEOUT}s"; else WHY=$(tail -n 1 <<<"$err"); WHY=${WHY:-"exit status $code"}; fi
  return 1
}

# Writes the node's own record of key <id> to <file> and sets VALUE (what it points at), UNTIL (the day it ends) and
# UNTIL_EPOCH. Fails for a key whose record the node does not hold, which includes an expired one.
read_record () {
  local id=$1 file=$2 inspected validity
  timeout "$TIMEOUT" "${IPFS[@]}" routing get --offline "/ipns/$id" > "$file" 2>/dev/null || return 1
  inspected=$(timeout "$TIMEOUT" "${IPFS[@]}" name inspect --enc=json < "$file" 2>/dev/null) || return 1
  VALUE=$(jq -r '.Entry.Value // empty' <<<"$inspected")
  validity=$(jq -r '.Entry.Validity // empty' <<<"$inspected")
  [ -n "$VALUE" ] && [ -n "$validity" ] || return 1
  UNTIL_EPOCH=$(date -u -d "$validity" +%s 2>/dev/null) || return 1
  UNTIL=$(date -u -d "@$UNTIL_EPOCH" +%F)
}

# One key, one line. Runs in the background, so it never exits the script; its status says whether the key was handled.
republish_key () {
  local name=$1 id=$2 file="$WORK/$2" tag="$1 $2"
  if ! read_record "$id" "$file"; then
    log "$tag: failed: the node holds no valid record for it (expired, or never published); publish it by hand with ipfs name publish --key=$name --lifetime=$LIFETIME /ipfs/<its CID>"
    return 1
  fi
  if [ $(( UNTIL_EPOCH - $(date -u +%s) )) -ge $(( RENEW_DAYS * 86400 )) ]; then
    # Put exactly as signed: no new value, so it cannot race another publisher of this key.
    if [ "$DRY_RUN" = 1 ]; then log "$tag: DRY RUN: would re-announce its record, valid until $UNTIL"; return 0; fi
    if ipfs_try routing put "/ipns/$id" "$file"; then log "$tag: re-announced"; else log "$tag: failed: re-announcing: $WHY"; return 1; fi
  else
    if [ "$DRY_RUN" = 1 ]; then log "$tag: DRY RUN: would re-sign $VALUE for $LIFETIME, its record ends $UNTIL"; return 0; fi
    if ! ipfs_try name publish --key="$name" --lifetime="$LIFETIME" --resolve=false "$VALUE"; then log "$tag: failed: re-signing: $WHY"; return 1; fi
    if ! read_record "$id" "$file"; then log "$tag: failed: re-signed, but the node's record cannot be read back"; return 1; fi
    log "$tag: re-signed until $UNTIL"
  fi
}

run () {
  local keys id name failed=0 running=0 var
  for var in RENEW_DAYS TIMEOUT PARALLEL PINNER_WAIT; do
    [[ ${!var} =~ ^[0-9]+$ ]] || { echo "$var must be a whole number, not '${!var}'" >&2; exit 2; }
  done
  [ "$PARALLEL" -ge 1 ] || { echo "PARALLEL must be at least 1" >&2; exit 2; }
  [[ $LIFETIME =~ ^([0-9]+(ns|us|ms|s|m|h))+$ ]] || { echo "LIFETIME must be a duration such as 87672h, not '$LIFETIME'" >&2; exit 2; }
  for var in jq timeout; do command -v "$var" >/dev/null || { echo "$var is not installed" >&2; exit 2; }; done

  if ! keys=$(timeout "$TIMEOUT" "${IPFS[@]}" key list -l --ipns-base=base36 2>/dev/null); then log "failed: could not list the keys of the node at $IPFS_API"; exit 1; fi
  if [ "$DRY_RUN" != 1 ]; then wait_for_pinner; fi
  WORK=$(mktemp -d)
  trap 'rm -rf "$WORK"' EXIT

  while read -r id name; do
    [ -n "$name" ] || continue
    case ",$SKIP_KEYS," in *",$name,"*) continue ;; esac
    while [ "$running" -ge "$PARALLEL" ]; do wait -n || failed=1; running=$(( running - 1 )); done
    republish_key "$name" "$id" &
    running=$(( running + 1 ))
  done <<<"$keys"
  while [ "$running" -gt 0 ]; do wait -n || failed=1; running=$(( running - 1 )); done
  [ "$failed" = 0 ]
}

case "${1:-}" in
  run) run ;;
  *) echo "usage: ipns-republish.sh run" >&2; exit 2 ;;
esac
