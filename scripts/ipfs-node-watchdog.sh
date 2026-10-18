#!/usr/bin/env bash
# Keeps a pinning node's Kubo reachable (docs/development/packaging.md section On IPFS).
#
#   ipfs-node-watchdog.sh check    run by a timer as a user that may restart Kubo: restarts it when its
#                                  inbound connection budget has filled up with connections that no longer
#                                  exist, or when its API stops answering. Otherwise does nothing.
#   ipfs-node-watchdog.sh status   prints the numbers `check` decides on, and changes nothing.
#
# Kubo's resource manager never releases a connection whose handshake failed, so its inbound count climbs
# above the connections that are really open until the system limit is reached; from then on every new
# dial is refused and the node cannot serve what only it holds. A restart resets the count.
#
# Needs bash, curl, jq, systemctl and Kubo's `ipfs`. Settings come from the environment, below.
set -euo pipefail

IPFS_API=${IPFS_API:-/ip4/127.0.0.1/tcp/5001}
IPFS_UNIT=${IPFS_UNIT:-ipfs.service}
PINNER_UNIT=${PINNER_UNIT:-orivon-release-pinner.service}
LEAK_PCT=${LEAK_PCT:-75}       # restart when the count is at least this share of the limit ...
GAP_PCT=${GAP_PCT:-50}         # ... and exceeds the real connections by at least this share of it
MIN_INTERVAL=${MIN_INTERVAL:-3600}
API_FAILS=${API_FAILS:-3}      # runs in a row without an answer before a restart
STATE_FILE=${STATE_FILE:-${WORK:-${TMPDIR:-/tmp}/orivon-ipfs-watchdog}/watchdog.json}
DRY_RUN=${DRY_RUN:-0}

ipfs () { command ipfs ${IPFS_API:+--api "$IPFS_API"} "$@"; }
log () {
  echo "[ipfs-node-watchdog] $*"
}
note () {
  log "$*"
  if [ -n "${SUMMARY_LOG:-}" ]; then echo "- $(date -u +%F): $*" >> "$SUMMARY_LOG"; fi
}
now () { date -u +%Y-%m-%dT%H:%M:%SZ; }

# host:port of the RPC API, from its multiaddr; the metrics answer a GET there.
api_http () {
  awk -F/ '{ h = $3; if ($2 == "ip6") h = "[" h "]"; if (h == "0.0.0.0") h = "127.0.0.1"; if (h == "[::]") h = "[::1]"; print h ":" $5 }' <<<"$IPFS_API"
}

# "<counted> <real> <refused>": the resource manager's inbound system gauge; the swarm's own opened minus
# closed inbound connections, which stay balanced when the gauge leaks; and the dials the system limit
# refused. awk does the arithmetic because the metrics print values like 1.976728e+06.
sample_metrics () {
  curl -fsS -m 30 "http://$(api_http)/debug/metrics/prometheus" | awk '
    /^libp2p_rcmgr_connections\{/ && /dir="inbound"/ && /scope="system"/ { counted = $NF + 0 }
    /^libp2p_swarm_connections_opened_total\{/ && /dir="inbound"/ { opened += $NF }
    /^libp2p_swarm_connections_closed_total\{/ && /dir="inbound"/ { closed += $NF }
    /^libp2p_rcmgr_blocked_resources\{/ && /dir="inbound"/ && /resource="connection"/ && /scope="system"/ { refused = $NF + 0 }
    END { printf "%.0f %.0f %.0f\n", counted, opened - closed, refused }'
}

# The system ConnsInbound limit: a number, or empty when there is none (unlimited, blockAll) or unknown.
inbound_limit () {
  local v
  v=$(ipfs --timeout=30s swarm resources 2>/dev/null | awk -F'\t+' '$1 == "system" && $2 == "ConnsInbound" { print $3; exit }') || true
  if [[ $v =~ ^[0-9]+$ ]]; then echo "$v"; fi
}

STATE=$(jq -c . "$STATE_FILE" 2>/dev/null || true)
[ -n "$STATE" ] || STATE='{}'
update_state () { STATE=$(jq -c "$@" <<<"$STATE"); }
# Atomic, and readable by the status page's user.
save_state () {
  local tmp
  mkdir -p "$(dirname "$STATE_FILE")"
  tmp=$(mktemp "$STATE_FILE.XXXXXX")
  echo "$STATE" | jq . > "$tmp"
  chmod 644 "$tmp"
  mv "$tmp" "$STATE_FILE"
}

# Prints why a restart must wait, or nothing when it may go ahead. A release add in progress would be
# lost by a restart, so a leak waits for the pinner; a hung API is restarted regardless, since the
# pinner cannot be working against it.
restart_blocker () {
  local leak=$1 last
  if [ "$leak" = 1 ] && systemctl is-active --quiet "$PINNER_UNIT"; then
    echo "the release pinner is running"
    return
  fi
  last=$(jq -r '.last_restart_at // empty' <<<"$STATE")
  if [ -n "$last" ] && [ $(( $(date -u +%s) - $(date -u -d "$last" +%s) )) -lt "$MIN_INTERVAL" ]; then
    echo "the last restart was at $last, less than ${MIN_INTERVAL}s ago"
  fi
}

restart_ipfs () {
  local reason=$1 at
  if [ "$DRY_RUN" = 1 ]; then log "DRY RUN: would restart $IPFS_UNIT: $reason"; return; fi
  systemctl restart "$IPFS_UNIT"
  at=$(now)
  update_state --arg at "$at" --arg reason "$reason" \
    '.last_restart_at = $at | .last_restart_reason = $reason | .restarts = ((.restarts // []) + [{at: $at, reason: $reason}])[-10:]'
  note "restarted $IPFS_UNIT: $reason"
}

check () {
  local sample counted real refused limit fails leak=0 blocker pct
  fails=$(jq -r '.api_fails // 0' <<<"$STATE")
  if ! sample=$(sample_metrics 2>/dev/null); then
    fails=$(( fails + 1 ))
    update_state --arg at "$(now)" --argjson fails "$fails" '.checked_at = $at | .api_fails = $fails'
    if [ "$fails" -lt "$API_FAILS" ]; then
      log "the API of $IPFS_UNIT did not answer ($fails of $API_FAILS runs in a row)"
    elif blocker=$(restart_blocker 0) && [ -z "$blocker" ]; then
      restart_ipfs "the API did not answer for $fails runs in a row"
      update_state '.api_fails = 0'
    else
      log "the API did not answer for $fails runs in a row; restart waits: $blocker"
    fi
    save_state
    return
  fi
  read -r counted real refused <<<"$sample"
  limit=$(inbound_limit)
  update_state --arg at "$(now)" --argjson counted "$counted" --argjson real "$real" --argjson refused "$refused" \
    --arg limit "${limit:-}" \
    '.checked_at = $at | .api_fails = 0 | .counted = $counted | .real = $real | .refused = $refused
     | .limit = (try ($limit | tonumber) catch null)'

  if [ -z "$limit" ]; then
    log "ok: counted $counted inbound connections for $real real ones; no inbound limit to fill"
  else
    pct=$(( counted * 100 / limit ))
    if [ $(( counted * 100 )) -ge $(( LEAK_PCT * limit )) ] && [ $(( (counted - real) * 100 )) -ge $(( GAP_PCT * limit )) ]; then leak=1; fi
    if [ "$leak" = 0 ]; then
      log "ok: counted $counted inbound connections for $real real ones (limit $limit, $pct%); $refused refused since start"
    else
      blocker=$(restart_blocker 1)
      if [ -n "$blocker" ]; then
        log "inbound budget leaking (counted $counted for $real real, limit $limit); restart waits: $blocker"
      else
        restart_ipfs "counted $counted inbound connections for $real real ones (limit $limit); $refused dials refused"
      fi
    fi
  fi
  save_state
}

status () {
  local sample counted real refused limit
  if ! sample=$(sample_metrics); then echo "the API of $IPFS_UNIT did not answer at $(api_http)" >&2; exit 1; fi
  read -r counted real refused <<<"$sample"
  limit=$(inbound_limit)
  echo "inbound connections counted: $counted"
  echo "inbound connections really open: $real"
  echo "inbound limit: ${limit:-none}"
  echo "inbound dials refused since start: $refused"
  echo "failed API checks in a row: $(jq -r '.api_fails // 0' <<<"$STATE")"
  echo "last check: $(jq -r '.checked_at // "never"' <<<"$STATE")"
  echo "last restart: $(jq -r '(.last_restart_at // "never") + (if .last_restart_reason then " (" + .last_restart_reason + ")" else "" end)' <<<"$STATE")"
  if systemctl is-active --quiet "$PINNER_UNIT" 2>/dev/null; then echo "release pinner: running"; else echo "release pinner: idle"; fi
}

case "${1:-check}" in
  check) check ;;
  status) status ;;
  *) echo "usage: ipfs-node-watchdog.sh [check | status]" >&2; exit 2 ;;
esac
