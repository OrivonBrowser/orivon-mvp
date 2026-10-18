#!/usr/bin/env bash
# One page that shows what a pinning node serves: every IPNS page it publishes, the ipfs:// of each
# GitHub release, the .eth name each should be attached to, and whether each part is active
# (docs/development/packaging.md section On IPFS).
#
#   ipfs-status.sh collect   asks the node, IPNS, ENS, gateways and GitHub, and writes $OUT_DIR/status.json.
#                            No single failed check stops the run: it shows up as "unknown" or "failed".
#   ipfs-status.sh render    turns status.json into $OUT_DIR/index.html and $OUT_DIR/STATUS.md.
#   ipfs-status.sh run       collect, then render. The page is meant to be served privately (it names
#                            every key and the node's health); nothing here publishes it.
#
# Needs bash, curl, jq, openssl 3.2 or later (for keccak-256), xxd and Kubo's `ipfs`. Settings come from the environment, below.
# NAMES_FILE has one line per IPNS key: `<key> <name.eth> [<name.eth> ...]`, `#` starts a comment. A key
# without a line has no expected .eth name; a line whose key is not in the keystore is an error.
# LATEST_KEY names the key pin-releases.sh points at the newest release it pinned, when it does.
#
# No `set -e`: a check that fails must leave the others running.
set -uo pipefail

IPFS_API=${IPFS_API:-/ip4/127.0.0.1/tcp/5001}
OUT_DIR=${OUT_DIR:-}
NAMES_FILE=${NAMES_FILE:-}
ETH_RPCS=${ETH_RPCS:-https://ethereum-rpc.publicnode.com https://eth.drpc.org https://rpc.mevblocker.io}
GATEWAYS=${GATEWAYS:-https://ipfs.orbitor.dev https://ipfs.filebase.io}
ROUTING=${ROUTING:-https://delegated-ipfs.dev}
REPO=${ORIVON_REPO:-OrivonBrowser/orivon-mvp}
RELEASES_URL=${RELEASES_URL:-https://api.github.com/repos/$REPO/releases?per_page=30}
KEEP=${KEEP:-3}
PIN_PREFIX=${PIN_PREFIX:-orivon-release-}
PINNER_UNIT=${PINNER_UNIT:-orivon-release-pinner.service}
IPFS_UNIT=${IPFS_UNIT:-ipfs.service}
WATCHDOG_STATE=${WATCHDOG_STATE:-}
LEAK_PCT=${LEAK_PCT:-75}
INTERVAL_MINUTES=${INTERVAL_MINUTES:-15}
TIMEOUT=${TIMEOUT:-30}
LATEST_KEY=${LATEST_KEY:-}
ETH_LIMO=${ETH_LIMO:-1}

ENS_REGISTRY=0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e

ipfs () { command ipfs ${IPFS_API:+--api "$IPFS_API"} "$@"; }
log () { echo "[ipfs-status] $*" >&2; }
now () { date -u +%Y-%m-%dT%H:%M:%SZ; }
epoch () { date -u -d "$1" +%s 2>/dev/null || echo 0; }

# ---------------------------------------------------------------- collect

problem () { jq -nc --arg s "$1" --arg t "$2" '{severity: $s, text: $t}' >> "$T/problems"; }
# Raises the state of the item being checked and records the problem; "error" outranks "warn".
flag () {
  problem "$1" "$2"
  if [ "$1" = error ] || [ "$ST" = ok ]; then ST=$1; fi
}
tf () { case "$1" in 1) echo true ;; 0) echo false ;; *) echo null ;; esac; }

api_http () {
  awk -F/ '{ h = $3; if ($2 == "ip6") h = "[" h "]"; if (h == "0.0.0.0") h = "127.0.0.1"; if (h == "[::]") h = "[::1]"; print h ":" $5 }' <<<"$IPFS_API"
}

# "<counted> <real> <refused>", as the watchdog reads them (see ipfs-node-watchdog.sh).
sample_metrics () {
  curl -fsS -m "$TIMEOUT" "http://$(api_http)/debug/metrics/prometheus" | awk '
    /^libp2p_rcmgr_connections\{/ && /dir="inbound"/ && /scope="system"/ { counted = $NF + 0 }
    /^libp2p_swarm_connections_opened_total\{/ && /dir="inbound"/ { opened += $NF }
    /^libp2p_swarm_connections_closed_total\{/ && /dir="inbound"/ { closed += $NF }
    /^libp2p_rcmgr_blocked_resources\{/ && /dir="inbound"/ && /resource="connection"/ && /scope="system"/ { refused = $NF + 0 }
    END { printf "%.0f %.0f %.0f\n", counted, opened - closed, refused }'
}

systemd_time () {
  local v
  v=$(systemctl show -p "$1" --value "$2" 2>/dev/null) || return 0
  if [ -n "$v" ] && [ "$v" != n/a ] && [ "$(epoch "$v")" -gt 0 ]; then date -u -d "$v" +%Y-%m-%dT%H:%M:%SZ; fi
}

collect_node () {
  local sample counted=null real=null refused=null limit=null v stat started pinner_run pinner_result pinner_log wd=null
  PEER_ID=$(ipfs --timeout="${TIMEOUT}s" id -f '<id>' 2>/dev/null)
  if sample=$(sample_metrics 2>/dev/null); then read -r counted real refused <<<"$sample"; fi
  v=$(ipfs --timeout="${TIMEOUT}s" swarm resources 2>/dev/null | awk -F'\t+' '$1 == "system" && $2 == "ConnsInbound" { print $3; exit }')
  if [[ ${v:-} =~ ^[0-9]+$ ]]; then limit=$v; fi
  stat=$(ipfs --timeout="${TIMEOUT}s" repo stat --size-only --enc=json 2>/dev/null) || stat='{}'
  started=''; pinner_run=''; pinner_result=''; pinner_log=''
  if command -v systemctl >/dev/null; then
    started=$(systemd_time ActiveEnterTimestamp "$IPFS_UNIT")
    pinner_run=$(systemd_time ExecMainExitTimestamp "$PINNER_UNIT")
    pinner_result=$(systemctl show -p Result --value "$PINNER_UNIT" 2>/dev/null || true)
  fi
  if command -v journalctl >/dev/null; then
    pinner_log=$(journalctl -u "$PINNER_UNIT" -n 1 -o short-iso --no-pager 2>/dev/null | grep -v '^-- ' | tail -n 1 | sed 's/^[^ ]* [^ ]* //')
  fi
  if [ -n "$WATCHDOG_STATE" ] && [ -r "$WATCHDOG_STATE" ]; then wd=$(jq -c . "$WATCHDOG_STATE" 2>/dev/null || echo null); fi
  NODE=$(jq -nc --arg version "$(ipfs version --number 2>/dev/null)" --arg peer "$PEER_ID" \
    --argjson peers "$(ipfs --timeout="${TIMEOUT}s" swarm peers 2>/dev/null | grep -c . || true)" \
    --argjson counted "$counted" --argjson real "$real" --argjson limit "$limit" --argjson refused "$refused" \
    --argjson stat "$stat" --arg started "$started" --arg run "$pinner_run" --arg result "$pinner_result" --arg plog "$pinner_log" \
    --argjson wd "$wd" '{
      version: $version, peer_id: $peer, peers: $peers,
      inbound: {counted: $counted, real: $real, limit: $limit, refused: $refused},
      repo_size: ($stat.RepoSize // null), storage_max: ($stat.StorageMax // null),
      started_at: (if $started == "" then null else $started end),
      pinner: {last_run: (if $run == "" then null else $run end), result: (if $result == "" then null else $result end),
               last_log: (if $plog == "" then null else $plog end)},
      watchdog: $wd}')
  if [ "$limit" != null ] && [ "$counted" != null ] && [ $(( counted * 100 )) -ge $(( LEAK_PCT * limit )) ] && [ "$refused" -gt 0 ]; then
    problem error "The node refused $refused inbound connections since it started: its inbound budget is full (the watchdog restarts it)"
  fi
  local size max
  size=$(jq -r '.repo_size // 0' <<<"$NODE"); max=$(jq -r '.storage_max // 0' <<<"$NODE")
  if [ "$max" -gt 0 ] && [ $(( size * 100 )) -gt $(( max * 90 )) ]; then
    problem warn "The repository is above 90% of StorageMax: the node will start cleaning up unpinned data, and pinning more may stop working"
  fi
  if [ -n "$pinner_run" ] && [ $(( $(date -u +%s) - $(epoch "$pinner_run") )) -gt 3600 ]; then
    problem error "The release pinner has not run for over an hour (last run $pinner_run)"
  fi
  if [ -n "$pinner_result" ] && [ "$pinner_result" != success ]; then
    problem warn "The release pinner's last run did not succeed ($pinner_result); it tries again by itself"
  fi
}

# Looks a name up in NAMES_FILE: the .eth names that should point at the key.
names_for () {
  [ -r "$NAMES_FILE" ] || return 0
  sed 's/#.*//' "$NAMES_FILE" | awk -v k="$1" '$1 == k { for (i = 2; i <= NF; i++) print $i }'
}

# ---- ENS

keccak () { openssl dgst -keccak-256 -r | awk '{ print $1 }'; }
namehash () {
  local node labels i
  node=$(printf '0%.0s' {1..64})
  IFS=. read -ra labels <<<"$1"
  for (( i = ${#labels[@]} - 1; i >= 0; i-- )); do
    node=$(printf '%s%s' "$node" "$(printf '%s' "${labels[i]}" | keccak)" | xxd -r -p | keccak)
  done
  echo "$node"
}
# eth_call <to> <data>: the hex result from the first RPC that answers one.
eth_call () {
  local rpc out res
  for rpc in $ETH_RPCS; do
    out=$(curl -s -m "$TIMEOUT" -H 'Content-Type: application/json' "$rpc" --data "$(jq -nc --arg to "$1" --arg d "$2" \
      '{jsonrpc: "2.0", id: 1, method: "eth_call", params: [{to: $to, data: $d}, "latest"]}')") || continue
    res=$(jq -r '.result // empty' <<<"$out" 2>/dev/null) || continue
    if [[ $res == 0x* ]]; then echo "$res"; return 0; fi
  done
  return 1
}
# The ABI-encoded `bytes` of contenthash(), as ipns://, ipfs:// or other:<hex>; nothing when it is empty.
decode_contenthash () {
  local h=${1#0x} off len data
  [ ${#h} -ge 128 ] || return 0
  off=$(( 16#${h:48:16} )); len=$(( 16#${h:$(( off * 2 + 48 )):16} ))
  data=${h:$(( off * 2 + 64 )):$(( len * 2 ))}
  case $data in
    '') ;;
    e501*) echo "ipns://$(ipfs cid format -b base36 "f${data:4}" 2>/dev/null)" ;;
    e301*) echo "ipfs://$(ipfs cid format -v 1 -b base32 "f${data:4}" 2>/dev/null)" ;;
    *) echo "other:0x$data" ;;
  esac
}
# Sets ENS_STATE (ok, wrong, none, no-resolver, unknown) and ENS_ACTUAL for <name> expected to hold <ipns://id>.
ens_check () {
  local node r c resolver
  ENS_STATE=unknown; ENS_ACTUAL=''
  [ "$KECCAK" = 1 ] || return 0
  node=$(namehash "$1")
  r=$(eth_call "$ENS_REGISTRY" "0x0178b8bf$node") || return 0
  resolver=${r: -40}
  if [[ $resolver =~ ^0+$ ]]; then ENS_STATE=no-resolver; return 0; fi
  c=$(eth_call "0x$resolver" "0xbc1c58d1$node") || return 0
  ENS_ACTUAL=$(decode_contenthash "$c")
  if [ -z "$ENS_ACTUAL" ]; then ENS_STATE=none
  elif [ "$ENS_ACTUAL" = "$2" ]; then ENS_STATE=ok
  else ENS_STATE=wrong; fi
}

# ---- network checks

# "<code> <seconds>" of a GET; code 0 when nothing answered.
timed_get () {
  local out
  out=$(curl -s -o /dev/null -m "$TIMEOUT" ${2:+-H "$2"} -w '%{http_code} %{time_total}' "$1" 2>/dev/null) || true
  awk -v o="${out:-000 0}" 'BEGIN { split(o, a, " "); printf "%d %.2f\n", a[1], a[2] }'
}
# Sets GW_JSON: how each gateway answers for <cid>. A gateway that did not answer three times in a row
# is skipped for the rest of the run, so a dead one cannot stretch it.
check_gateways () {
  local gw code secs json=() n dead
  for gw in $GATEWAYS; do
    dead="$T/dead.$(printf '%s' "$gw" | tr -c 'A-Za-z0-9' _)"
    n=$(cat "$dead" 2>/dev/null || echo 0)
    if [ "$n" -ge 3 ]; then code=0; secs=0.00
    else
      read -r code secs < <(timed_get "$gw/ipfs/$1?format=raw" 'Accept: application/vnd.ipld.raw')
      if [ "$code" = 0 ]; then echo $(( n + 1 )) > "$dead"; else echo 0 > "$dead"; fi
    fi
    json+=("$(jq -nc --arg u "$gw" --argjson c "$code" --argjson s "$secs" '{url: $u, code: $c, seconds: $s}')")
  done
  GW_JSON=$(printf '%s\n' "${json[@]}" | jq -sc . 2>/dev/null || echo '[]')
}
# Sets PROVIDED: 1 when this node is among the providers the routing server lists for <cid>, 0 when not, "" unknown.
# The server sometimes answers before it has heard from every provider, so a "not listed" is asked once more.
check_provided () {
  local out try
  PROVIDED=''
  [ -n "$PEER_ID" ] || return 0
  for try in 1 2; do
    out=$(curl -s -m "$TIMEOUT" -w '\n%{http_code}' "$ROUTING/routing/v1/providers/$1") || continue
    case ${out##*$'\n'} in
      200) if jq -e --arg p "$PEER_ID" 'any(.Providers[]?; .ID == $p)' <<<"${out%$'\n'*}" >/dev/null 2>&1; then PROVIDED=1; return 0; fi
           PROVIDED=0 ;;
      404) PROVIDED=0 ;;
    esac
  done
}
# Sets REC_FOUND (1, 0 or ""), REC_VALUE and REC_EXPIRES from the IPNS record the routing server holds for <id>.
fetch_record() {
  local code insp
  REC_FOUND=''; REC_VALUE=''; REC_EXPIRES=''
  code=$(curl -s -m "$TIMEOUT" -o "$T/record" -w '%{http_code}' -H 'Accept: application/vnd.ipfs.ipns-record' "$ROUTING/routing/v1/ipns/$1") || code=000
  case $code in
    200)
      insp=$(ipfs name inspect --enc=json < "$T/record" 2>/dev/null) || return 0
      REC_VALUE=$(jq -r '.Entry.Value // empty' <<<"$insp")
      REC_EXPIRES=$(jq -r '.Entry.Validity // empty' <<<"$insp")
      [ -n "$REC_VALUE" ] && REC_FOUND=1 ;;
    404) REC_FOUND=0 ;;
  esac
}
cid_of () { local v=${1#/ipfs/}; [ "$v" != "$1" ] && echo "${v%%/*}"; }

# Gateways, provider and problems for a build (a site's or a release's); sets ST.
check_build () {
  local label=$1 cid=$2 ok n
  check_provided "$cid"; PROV_J=$(tf "$PROVIDED")
  check_gateways "$cid"
  ok=$(jq '[.[] | select(.code == 200)] | length' <<<"$GW_JSON"); n=$(jq length <<<"$GW_JSON")
  # One gateway failing while another serves is common and shows in the table; only none serving is a problem.
  if [ "$n" -gt 0 ] && [ "$ok" = 0 ]; then flag error "No gateway could fetch $label"; fi
  if [ "$PROVIDED" = 0 ]; then flag warn "The node does not announce $label to the network yet, so other nodes cannot find it; it announces on its own"; fi
}

collect_site () {
  local key=$1 id=$2 ipns="ipns://$2" lv target name matches pinned_j=null expires_left
  local names_file="$T/names.$key" gw=[] prov=null
  ST=ok; : > "$names_file"
  lv=$(ipfs --timeout="${TIMEOUT}s" name resolve --offline "/ipns/$id" 2>/dev/null) || lv=''
  fetch_record "$id"
  target=$(cid_of "$lv"); [ -n "$target" ] || target=$(cid_of "$REC_VALUE")
  matches=null
  if [ -n "$lv" ] && [ -n "$REC_VALUE" ]; then if [ "$lv" = "$REC_VALUE" ]; then matches=true; else matches=false; fi; fi

  if [ -z "$target" ]; then
    flag error "Nothing is published under the key $key"
  else
    if ipfs --timeout="${TIMEOUT}s" pin ls "$target" >/dev/null 2>&1; then pinned_j=true; else
      pinned_j=false; flag error "The current build of $key (ipfs://$target) is not pinned on the node: it can be lost when the node cleans up its storage"; fi
    check_build "the current build of $key (ipfs://$target)" "$target"; gw=$GW_JSON; prov=$PROV_J
  fi
  case $REC_FOUND in
    0) flag error "The IPNS record of $key is not on the network: nobody can find the page by its ipns:// address until it is published again" ;;
    '') [ -n "$target" ] && flag warn "Could not check the IPNS record of $key on the network (the routing server did not answer)" ;;
  esac
  if [ "$matches" = false ]; then flag warn "The network still serves an older IPNS record for $key than the node holds; the node republishes it on its own"; fi
  if [ -n "$REC_EXPIRES" ]; then
    expires_left=$(( $(epoch "$REC_EXPIRES") - $(date -u +%s) ))
    if [ "$expires_left" -lt 0 ]; then flag error "The IPNS record of $key has expired: publish it again"
    elif [ "$expires_left" -lt 43200 ]; then flag warn "The IPNS record of $key expires in under 12 hours; the node renews it when it republishes"; fi
  fi

  for name in $(names_for "$key"); do
    ens_check "$name" "$ipns"
    local limo=null
    case $ENS_STATE in
      wrong) flag error "$name points at ${ENS_ACTUAL}, not at its key $ipns: set its contenthash to $ipns" ;;
      none) flag error "$name has no contenthash: set it to $ipns" ;;
      no-resolver) flag error "$name has no resolver: set one, then set its contenthash to $ipns" ;;
      unknown) [ "$KECCAK" = 1 ] && flag warn "Could not read the ENS record of $name (no Ethereum RPC answered)" ;;
    esac
    if [ "$ETH_LIMO" = 1 ]; then
      local code secs
      read -r code secs < <(timed_get "https://$name.limo/")
      limo=$(jq -nc --argjson c "$code" --argjson s "$secs" '{code: $c, seconds: $s}')
      # A name already reported as unset cannot load; saying so again is noise.
      if { [ "$code" -lt 200 ] || [ "$code" -ge 400 ]; } && [ "$ENS_STATE" != none ] && [ "$ENS_STATE" != no-resolver ]; then
        flag warn "$name.limo did not load (HTTP code $code)"
      fi
    fi
    jq -nc --arg n "$name" --arg a "$ENS_ACTUAL" --arg s "$ENS_STATE" --argjson l "$limo" '{name: $n, actual: $a, state: $s, limo: $l}' >> "$names_file"
  done

  jq -nc --arg key "$key" --arg id "$id" --arg ipns "$ipns" --arg target "$target" --argjson found "$(tf "$REC_FOUND")" \
    --arg value "$REC_VALUE" --argjson matches "$matches" --arg expires "$REC_EXPIRES" --argjson pinned "$pinned_j" \
    --argjson provided "$prov" --argjson gateways "$gw" --argjson names "$(jq -sc . "$names_file")" --arg state "$ST" '{
      key: $key, id: $id, ipns: $ipns, target: (if $target == "" then null else $target end),
      record: {found: $found, value: (if $value == "" then null else $value end), matches: $matches,
               expires_at: (if $expires == "" then null else $expires end)},
      pinned: $pinned, provided: $provided, gateways: $gateways, names: $names, state: $state}' >> "$T/sites"
}

collect_sites () {
  local keys id key known=' '
  keys=$(ipfs --timeout="${TIMEOUT}s" key list -l --ipns-base=base36 2>/dev/null) || keys=''
  while read -r id key <&3; do
    [ -n "$key" ] && [ "$key" != self ] || continue
    known+="$key "
    log "site $key"
    collect_site "$key" "$id"
  done 3<<<"$keys"
  if [ -r "$NAMES_FILE" ]; then
    while read -r key; do
      [ -n "$key" ] && [[ $known != *" $key "* ]] || continue
      flag error "Key missing: the names file lists the key $key, but the node has no such key"
      jq -nc --arg key "$key" '{key: $key, id: null, ipns: null, target: null, record: {found: null, value: null, matches: null, expires_at: null},
        pinned: null, provided: null, gateways: [], names: [], state: "error", note: "key missing"}' >> "$T/sites"
    done < <(sed 's/#.*//' "$NAMES_FILE" | awk 'NF { print $1 }' | sort -u)
  fi
}

collect_releases () {
  local list kept='' seen=0 pins r tag cid manifest note should pinned_j age
  list=$(curl -fsSL -m "$TIMEOUT" --retry 2 "$RELEASES_URL" 2>/dev/null | jq -c '[.[] | select(.draft | not)] | sort_by(.published_at) | reverse
    | map({tag: .tag_name, name: (.name // .tag_name), published_at, url: .html_url, prerelease,
           manifest: ([.assets[] | select(.name == "ipfs.json") | .browser_download_url][0])})' 2>/dev/null) || list=''
  if [ -z "$list" ]; then problem warn "Could not read the list of GitHub releases, so the releases below are not checked"; echo '[]' > "$T/releases.list"; return; fi
  kept=$(jq -r --argjson k "$KEEP" '[.[] | select(.manifest != null) | .tag][:$k][]' <<<"$list")
  pins=$(ipfs --timeout="${TIMEOUT}s" pin ls --type=recursive --names 2>/dev/null) || pins=''
  while read -r r <&3; do
    [ -n "$r" ] || continue
    tag=$(jq -r .tag <<<"$r"); manifest=$(jq -r '.manifest // empty' <<<"$r")
    log "release $tag"
    ST=ok; cid=''; note=''; should=0; pinned_j=null; PROV_J=null; GW_JSON='[]'
    if [ -z "$manifest" ]; then
      note="no packages"
      if [ "$seen" = 0 ]; then flag warn "Release $tag has no packages yet: its Release workflow failed or is still running, and it cannot be pinned until it has"; fi
    else
      seen=1
      cid=$(curl -fsSL -m "$TIMEOUT" --retry 2 "$manifest" 2>/dev/null | jq -r '.cid // empty' 2>/dev/null) || cid=''
      if grep -qxF "$tag" <<<"$kept"; then should=1; fi
      if [ -n "$cid" ] && awk -v n="$PIN_PREFIX$tag" -v c="$cid" '$3 == n && $1 == c { f = 1 } END { exit !f }' <<<"$pins"; then pinned_j=true; else pinned_j=false; fi
      if [ -z "$cid" ]; then flag warn "Could not read the ipfs.json of release $tag"
      elif [ "$should" = 1 ]; then
        note="kept"
        if [ "$pinned_j" = false ]; then
          age=$(( $(date -u +%s) - $(epoch "$(jq -r .published_at <<<"$r")") ))
          if [ "$age" -lt 3600 ]; then flag warn "Release $tag should be pinned but is not yet (the pinner retries every 15 minutes)"
          else flag error "Release $tag should be pinned but is not (the pinner retries every 15 minutes; check its log if this stays)"; fi
        fi
      else note="not kept"; fi
      if [ -n "$cid" ] && { [ "$should" = 1 ] || [ "$pinned_j" = true ]; }; then check_build "release $tag (ipfs://$cid)" "$cid"; fi
    fi
    jq -nc --argjson r "$r" --arg cid "$cid" --arg note "$note" --argjson should "$(tf "$should")" --argjson pinned "$pinned_j" \
      --argjson provided "$PROV_J" --argjson gateways "$GW_JSON" --arg state "$ST" '{
        tag: $r.tag, name: $r.name, published_at: $r.published_at, url: $r.url, prerelease: $r.prerelease,
        cid: (if $cid == "" then null else $cid end), should_be_pinned: $should, pinned: $pinned, provided: $provided,
        gateways: $gateways, note: $note, state: $state}' >> "$T/releases"
  done 3< <(jq -c '.[:10][]' <<<"$list")
}

# Sets LATEST: which release the LATEST_KEY points at, and a problem when that is not the newest pinned one.
collect_latest () {
  local site newest
  LATEST=null
  [ -n "$LATEST_KEY" ] || return 0
  site=$(jq -sc --arg k "$LATEST_KEY" 'map(select(.key == $k and .id != null))[0] // empty' "$T/sites")
  newest=$(jq -sc 'map(select(.pinned == true))[0] // empty' "$T/releases")
  LATEST=$(jq -nc --arg k "$LATEST_KEY" --argjson s "${site:-null}" --argjson n "${newest:-null}" --slurpfile r "$T/releases" '{
    key: $k, ipns: $s.ipns, names: [($s.names // [])[].name], target: $s.target,
    tag: ([$r[] | select(.cid != null and .cid == $s.target)][0].tag // null), newest: $n.tag}')
  if [ -z "$site" ]; then
    # A key the names file lists is already reported missing.
    if ! jq -se --arg k "$LATEST_KEY" 'any(.[]; .key == $k)' "$T/sites" >/dev/null; then
      problem error "The key $LATEST_KEY, which names the newest release, is missing from the node: create it with ipfs key gen"
    fi
  elif [ -n "$newest" ] && [ "$(jq -r .target <<<"$site")" != "$(jq -r .cid <<<"$newest")" ]; then
    problem warn "The newest-release key $LATEST_KEY does not point at $(jq -r .tag <<<"$newest") yet; the release pinner moves it on its next run"
  fi
}

collect () {
  local started
  [ -n "$OUT_DIR" ] || { echo "ipfs-status.sh: set OUT_DIR" >&2; exit 2; }
  T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
  mkdir -p "$OUT_DIR"
  : > "$T/problems"; : > "$T/sites"; : > "$T/releases"
  started=$(date +%s)
  KECCAK=1
  if ! printf '' | openssl dgst -keccak-256 >/dev/null 2>&1; then
    KECCAK=0
    problem warn "This server's openssl has no keccak-256 (it needs 3.2 or later), so no .eth name is checked"
  fi
  log "node"
  collect_node
  collect_sites
  collect_releases
  collect_latest
  jq -n --arg at "$(now)" --argjson interval "$INTERVAL_MINUTES" --argjson node "$NODE" --argjson latest "$LATEST" \
    --slurpfile sites "$T/sites" --slurpfile releases "$T/releases" --slurpfile problems "$T/problems" '{
      generated_at: $at, interval_minutes: $interval, node: $node, sites: $sites, releases: $releases, latest: $latest,
      problems: ($problems | sort_by(if .severity == "error" then 0 else 1 end))}' > "$OUT_DIR/status.json.tmp" \
    && mv "$OUT_DIR/status.json.tmp" "$OUT_DIR/status.json"
  log "collected in $(( $(date +%s) - started )) s"
}

# ---------------------------------------------------------------- render

HTML_JQ=$(cat <<'JQ'
def h: (. // "") | tostring | @html;
def tm: if . == null or . == "" then "never" else (.[0:16] | sub("T"; " ")) + " UTC" end;
def mark: if . == true then "<span class='ok' title='yes'>✓</span>" elif . == false then "<span class='bad' title='no'>✗</span>" else "<span class='unk' title='could not check'>?</span>" end;
def short: if . == null or . == "" then "<span class='muted'>none</span>" else "<a class='mono' href='ipfs://" + (. | h) + "' title='ipfs://" + (. | h) + "'>ipfs://" + ((if length > 24 then .[0:14] + "…" + .[-6:] else . end) | h) + "</a>" end;
def host: sub("^https?://"; "");
def gws: (.gateways // []) | if length == 0 then "<span class='muted'>not checked</span>" else map(
    "<div class='" + (if .code == 200 then "ok" else "bad" end) + "'>" + (.url | host | h) + " "
    + (if .code == 200 then "✓ " + (.seconds | tostring) + " s" elif .code == 0 then "✗ no answer" else "✗ HTTP " + (.code | tostring) end) + "</div>") | join("") end;
def badge: "<span class='badge " + (.state | h) + "'>" + ({ok: "OK", warn: "Check", error: "Broken"}[.state] // .state | h) + "</span>";
def bytes: if . == null then "unknown" else (. / 1e9 * 100 | round / 100 | tostring) + " GB" end;
def dur: if . == null then "unknown" else
  (if . >= 86400 then ((. / 86400 | floor | tostring) + " d " + ((. % 86400) / 3600 | floor | tostring) + " h")
   elif . >= 3600 then ((. / 3600 | floor | tostring) + " h " + ((. % 3600) / 60 | floor | tostring) + " min")
   else ((. / 60 | floor | tostring) + " min") end) end;
def namecell: (.names // []) | if length == 0 then "<span class='muted'>none expected</span>" else map(
    "<div>" + (if .state == "ok" then true elif .state == "unknown" then null else false end | mark) + " " + (.name | h)
    + (if .state == "wrong" then " <small class='bad'>points at " + (.actual | h) + "</small>"
       elif .state == "none" then " <small class='bad'>has no contenthash</small>"
       elif .state == "no-resolver" then " <small class='bad'>has no resolver</small>"
       elif .state == "unknown" then " <small class='muted'>could not be read</small>" else "" end)
    + (if .limo != null then " <small><a class='" + (if .limo.code >= 200 and .limo.code < 400 then "ok" else "bad" end) + "' href='https://" + (.name | h) + ".limo/'>.limo " + (if .limo.code == 0 then "no answer" else (.limo.code | tostring) end) + "</a></small>" else "" end)
    + "</div>") | join("") end;
def td($l): "<td data-label='" + $l + "'>" + . + "</td>";
def tile($v; $l): "<div class='tile'><b>" + ($v | tostring | h) + "</b><span>" + $l + "</span></div>";
def net: "record " + (.record.found | mark) + (if .record.expires_at then " <small class='muted'>until " + (.record.expires_at | tm) + "</small>" else "" end) + "<br>provided " + (.provided | mark);

(.generated_at) as $gen | (.interval_minutes) as $iv | (.problems // []) as $p |
"<!doctype html>
<html lang='en'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width, initial-scale=1'>
<meta http-equiv='refresh' content='300'><meta name='robots' content='noindex'>
<title>Orivon IPFS status</title>
<style>
:root { --bg: #f6f7f9; --fg: #1b1f24; --muted: #667085; --card: #fff; --line: #dde1e7; --ok: #137a3c; --okbg: #dcf5e4; --warn: #8a5a00; --warnbg: #fdf0cc; --bad: #b42318; --badbg: #fde0dd; }
@media (prefers-color-scheme: dark) { :root { --bg: #14171b; --fg: #e6e8eb; --muted: #98a2b3; --card: #1d2228; --line: #2e353d; --ok: #5fd68a; --okbg: #12331f; --warn: #f0c35a; --warnbg: #3a2e0e; --bad: #ff8a80; --badbg: #3d1a17; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 16px; background: var(--bg); color: var(--fg); font: 15px/1.45 system-ui, sans-serif; }
main { max-width: 1200px; margin: 0 auto; }
h1 { font-size: 1.4rem; margin: 0 0 12px; } h2 { font-size: 1.1rem; margin: 28px 0 8px; }
[hidden] { display: none; }
.banner { padding: 12px 16px; border-radius: 8px; margin-bottom: 8px; font-weight: 600; }
.banner ul { margin: 6px 0 0; padding-left: 20px; font-weight: 400; }
.banner li { overflow-wrap: anywhere; }
.banner.good { background: var(--okbg); color: var(--ok); } .banner.warn { background: var(--warnbg); color: var(--warn); } .banner.bad { background: var(--badbg); color: var(--bad); }
.wrap { overflow-x: auto; background: var(--card); border: 1px solid var(--line); border-radius: 8px; }
table { border-collapse: collapse; width: 100%; min-width: 760px; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: .8rem; text-transform: uppercase; letter-spacing: .03em; color: var(--muted); } tr:last-child td { border-bottom: 0; }
code, .mono { font-family: ui-monospace, monospace; font-size: .85rem; word-break: break-all; user-select: all; }
.ok { color: var(--ok); } .bad { color: var(--bad); } .unk, .muted { color: var(--muted); } small { font-size: .8rem; }
.badge { display: inline-block; padding: 1px 9px; border-radius: 99px; font-size: .8rem; font-weight: 600; }
.badge.ok { background: var(--okbg); color: var(--ok); } .badge.warn { background: var(--warnbg); color: var(--warn); } .badge.error { background: var(--badbg); color: var(--bad); }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px 16px; margin: 0; }
dt { color: var(--muted); } dd { margin: 0; }
a { color: inherit; }
td code { display: inline-block; min-width: 24ch; } .narrow { display: none; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; margin: 8px 0; }
.tile { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
.tile b { display: block; font-size: 1.25rem; } .tile span { color: var(--muted); font-size: .8rem; }
@media (max-width: 720px) {
  table { min-width: 0; } thead { display: none; }
  tr, td { display: block; } tr { border-bottom: 1px solid var(--line); padding: 6px 0; } tr:last-child { border-bottom: 0; }
  td { border: 0; padding: 3px 12px; display: grid; grid-template-columns: 7.5rem minmax(0, 1fr); gap: 8px; }
  td[data-label]::before { content: attr(data-label); font-size: .72rem; text-transform: uppercase; letter-spacing: .03em; color: var(--muted); padding-top: 2px; }
  td[data-label='Name'] { display: block; } td[data-label='Name']::before { content: none; } .sites td[data-label='State'] { display: none; } .narrow { display: inline; }
  td code { min-width: 0; } dl { grid-template-columns: 1fr; } dd { margin-bottom: 6px; }
}
</style></head>
<body data-generated='" + ($gen | h) + "' data-interval='" + ($iv | h) + "'><main>
<h1>Orivon IPFS status</h1>
<div id='stale' class='banner bad' hidden>This page is stale: the status job has stopped.</div>"
+ (if ($p | length) == 0 then "<div class='banner good'>Everything is served</div>"
   else "<div class='banner " + (if any($p[]; .severity == "error") then "bad" else "warn" end) + "'>"
     + (if any($p[]; .severity == "error") then "Something is not being served" else "Needs a look, nothing is broken yet" end)
     + "<ul>" + ($p | map("<li>" + (.text | h) + "</li>") | join("")) + "</ul></div>" end)
+ "<p class='muted'>Generated " + ($gen | tm | h) + " · refreshed every " + ($iv | h) + " minutes</p>"
+ (([.sites[] | .names[]?]) as $names | ([.releases[] | select(.should_be_pinned == true)]) as $kept | (.node.inbound // {}) as $i
   | "<div class='tiles'>"
   + tile(([.sites[] | select(.state != "error")] | length | tostring) + " / " + (.sites | length | tostring); "sites and apps served")
   + tile(([$names[] | select(.state == "ok")] | length | tostring) + " / " + ($names | length | tostring); ".eth names pointing right")
   + tile(([$kept[] | select(.pinned == true)] | length | tostring) + " / " + ($kept | length | tostring); "releases kept and pinned")
   + tile(.latest.tag // "none"; "newest release by name")
   + tile(if $i.counted != null and $i.limit != null then ((($i.counted * 100 / $i.limit) | floor | tostring) + "%") else "?" end; "inbound budget used")
   + "</div>")
+ "<h2>Sites and apps (IPNS)</h2>
<div class='wrap'><table class='sites'><thead><tr><th>Name</th><th>.eth name</th><th>ipns://</th><th>Current build</th><th>Pinned</th><th>On the network</th><th>Gateways</th><th>State</th></tr></thead><tbody>"
+ (.sites | map("<tr>" + ("<b>" + (.key | h) + "</b> <span class='narrow'>" + badge + "</span>" | td("Name")) + (namecell | td(".eth name"))
    + ((if .ipns then "<code>" + (.ipns | h) + "</code>" else "<span class='bad'>key missing</span>" end) | td("ipns://"))
    + (.target | short | td("Current build")) + (.pinned | mark | td("Pinned")) + ((if .id then net else "" end) | td("On the network"))
    + (gws | td("Gateways")) + (badge | td("State")) + "</tr>") | join(""))
+ "</tbody></table></div>
<h2>Releases</h2>"
+ (if .latest == null then "" else (.latest as $l | "<p>Newest release by name: " + (if ($l.names | length) > 0 then ($l.names | map(h) | join(", ")) + " → " else "" end)
    + (if $l.ipns then "<code>" + ($l.ipns | h) + "</code>" else "<span class='bad'>key " + ($l.key | h) + " missing</span>" end)
    + " → " + (if $l.tag then "<b>" + ($l.tag | h) + "</b>" elif $l.target then ($l.target | short) else "<span class='muted'>nothing yet</span>" end)
    + (if $l.newest != null and $l.tag != $l.newest then " <span class='bad'>(newest pinned is " + ($l.newest | h) + ")</span>" else "" end) + "</p>") end)
+ "<div class='wrap'><table><thead><tr><th>Tag</th><th>Published</th><th>ipfs://</th><th>Kept here</th><th>Pinned</th><th>Gateways</th><th>State</th></tr></thead><tbody>"
+ (.releases | map("<tr>" + ("<a href='" + (.url | h) + "'>" + (.tag | h) + "</a>" | td("Tag")) + (.published_at | tm | h | td("Published")) + (.cid | short | td("ipfs://"))
    + ((if .note == "no packages" then "<span class='muted'>no packages</span>" elif .should_be_pinned == true then "yes" elif .should_be_pinned == false then "<span class='muted'>not kept</span>" else "?" end) | td("Kept here"))
    + ((if .cid == null or .note == "not kept" then "<span class='muted'>–</span>" else (.pinned | mark) end) | td("Pinned")) + (gws | td("Gateways")) + (badge | td("State")) + "</tr>") | join(""))
+ "</tbody></table></div>
<h2>Node</h2>
<dl>"
+ (.node as $n | ($n.inbound // {}) as $i
   | [["Kubo version", $n.version],
      ["Running for", (if $n.started_at then ((($gen | fromdateiso8601) - ($n.started_at | fromdateiso8601)) | dur) else "unknown" end)],
      ["Peers connected", $n.peers],
      ["Inbound connections", (if $i.counted == null then "unknown" else "counted " + ($i.counted | tostring) + ", really open " + ($i.real | tostring) + ", limit " + ($i.limit // "none" | tostring) + ", refused since start " + ($i.refused | tostring) end)],
      ["Repository", (($n.repo_size | bytes) + " of " + ($n.storage_max | bytes))],
      ["Release pinner last ran", (($n.pinner.last_run | tm) + (if $n.pinner.result then " (" + $n.pinner.result + ")" else "" end))],
      ["Watchdog last check", ($n.watchdog.checked_at | tm)],
      ["Watchdog last restart", (if $n.watchdog == null then "no watchdog data" elif $n.watchdog.last_restart_at then (($n.watchdog.last_restart_at | tm) + ": " + $n.watchdog.last_restart_reason) else "never" end)]]
   | map("<dt>" + (.[0] | h) + "</dt><dd>" + (.[1] | h) + "</dd>") | join(""))
+ "</dl>
</main>
<script>(function(){var b=document.body,g=Date.parse(b.dataset.generated),i=+b.dataset.interval;if(g&&i&&Date.now()-g>3*i*60000){document.getElementById('stale').hidden=false;}})();</script>
</body></html>
"
JQ
)

MD_JQ=$(cat <<'JQ'
def c: (. // "") | tostring | gsub("\\|"; "\\|") | gsub("\n"; " ");
def tm: if . == null or . == "" then "never" else (.[0:16] | sub("T"; " ")) + " UTC" end;
def yn: if . == true then "yes" elif . == false then "NO" else "?" end;
def short: if . == null then "none" elif length > 24 then "ipfs://" + .[0:14] + "..." + .[-6:] else "ipfs://" + . end;
def host: sub("^https?://"; "");
def gws: (.gateways // []) | map((.url | host) + " " + (if .code == 200 then "ok" elif .code == 0 then "no answer" else "HTTP " + (.code | tostring) end)) | join(", ");
def names: (.names // []) | if length == 0 then "none expected" else map(.name + " " + (if .state == "ok" then "ok" elif .state == "wrong" then "POINTS AT " + .actual elif .state == "none" then "NO CONTENTHASH" elif .state == "no-resolver" then "NO RESOLVER" else "unknown" end)) | join("<br>") end;
(.problems // []) as $p |
"# Orivon IPFS status\n\nGenerated " + (.generated_at | tm) + ", refreshed every " + (.interval_minutes | tostring) + " minutes.\n\n"
+ (if ($p | length) == 0 then "**Everything is served.**\n" else "**Needs attention:**\n\n" + ($p | map("- " + .severity + ": " + .text) | join("\n")) + "\n" end)
+ "\n## Sites and apps (IPNS)\n\n| Name | .eth name | ipns:// | Current build | Pinned | Record on network | Provided | Gateways | State |\n|---|---|---|---|---|---|---|---|---|\n"
+ (.sites | map("| " + (.key | c) + " | " + (names | c) + " | " + (if .ipns then "`" + .ipns + "`" else "key missing" end) + " | " + (.target | short | c) + " | " + (.pinned | yn) + " | " + (.record.found | yn) + " | " + (.provided | yn) + " | " + (gws | c) + " | " + .state + " |") | join("\n"))
+ "\n\n## Releases\n\n"
+ (if .latest == null then "" else "Newest release by name: " + ((.latest.names // []) | join(", ")) + " -> `" + (.latest.ipns // "key missing") + "` -> " + (.latest.tag // .latest.target // "nothing yet") + "\n\n" end)
+ "| Tag | Published | ipfs:// | Kept here | Pinned | Gateways | State |\n|---|---|---|---|---|---|---|\n"
+ (.releases | map("| [" + (.tag | c) + "](" + .url + ") | " + (.published_at | tm) + " | " + (.cid | short | c) + " | " + (if .note == "no packages" then "no packages" elif .should_be_pinned then "yes" else "not kept" end) + " | " + (if .cid == null or .note == "not kept" then "-" else (.pinned | yn) end) + " | " + (gws | c) + " | " + .state + " |") | join("\n"))
+ "\n\n## Node\n\n"
+ (.node as $n | ($n.inbound // {}) as $i | [
    "- Kubo " + ($n.version // "unknown") + ", " + ($n.peers | tostring) + " peers",
    "- Inbound connections: counted " + ($i.counted | tostring) + ", really open " + ($i.real | tostring) + ", limit " + ($i.limit // "none" | tostring) + ", refused since start " + ($i.refused | tostring),
    "- Repository: " + ($n.repo_size | tostring) + " of " + ($n.storage_max | tostring) + " bytes",
    "- Release pinner last ran: " + ($n.pinner.last_run | tm),
    "- Watchdog last check: " + ($n.watchdog.checked_at | tm) + ", last restart: " + ($n.watchdog.last_restart_at | tm)] | join("\n"))
+ "\n"
JQ
)

render () {
  [ -n "$OUT_DIR" ] && [ -r "$OUT_DIR/status.json" ] || { echo "ipfs-status.sh: no status.json in OUT_DIR; run collect first" >&2; exit 2; }
  jq -r "$HTML_JQ" "$OUT_DIR/status.json" > "$OUT_DIR/index.html.tmp" && mv "$OUT_DIR/index.html.tmp" "$OUT_DIR/index.html" || exit 1
  jq -r "$MD_JQ" "$OUT_DIR/status.json" > "$OUT_DIR/STATUS.md.tmp" && mv "$OUT_DIR/STATUS.md.tmp" "$OUT_DIR/STATUS.md" || exit 1
}

case "${1:-}" in
  collect) collect ;;
  render) render ;;
  run) collect; render ;;
  *) echo "usage: ipfs-status.sh collect | render | run" >&2; exit 2 ;;
esac
