#!/usr/bin/env bash
# Sends one notification to the owner. Used by the autonomous build loop.
#
#   usage: notify.sh <urgency> <message>
#   urgency: blocking | review | failure | idle
#
# CREDENTIALS ARE NEVER IN THIS REPOSITORY. They live in
# ~/.config/orivon/notify.env (mode 600) because this repo is public, and a
# token pushed to a public repo is scraped and used within minutes.
# scripts/check-no-secrets.mjs enforces that this stays true.
#
# EXITS 0 WHEN UNCONFIGURED, ON PURPOSE. A missing or broken notifier must
# never fail a build cycle -- the work matters more than the message about the
# work, and a loop that dies because Telegram is down is worse than a silent
# one. Failures are reported on stderr and swallowed.
set -u

CONFIG="${ORIVON_NOTIFY_CONFIG:-$HOME/.config/orivon/notify.env}"

urgency="${1:-idle}"
shift 2>/dev/null || true
message="${*:-}"

[ -z "$message" ] && { echo "notify.sh: no message given" >&2; exit 0; }

if [ ! -r "$CONFIG" ]; then
  echo "notify.sh: no config at $CONFIG -- not notifying" >&2
  exit 0
fi

# shellcheck disable=SC1090
. "$CONFIG"

backend="${ORIVON_NOTIFY_BACKEND:-none}"

# One line, under 200 chars: mobile notifications truncate, and the useful part
# must survive. Lead with what the owner would act on.
prefix="[orivon]"
case "$urgency" in
  blocking) prefix="[orivon] BLOCKED:" ;;
  review)   prefix="[orivon] review:" ;;
  failure)  prefix="[orivon] FAILED:" ;;
  idle)     prefix="[orivon] idle:" ;;
esac
text="$prefix $message"
text="$(printf '%.200s' "$text")"

case "$backend" in
  telegram)
    if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_CHAT_ID:-}" ]; then
      echo "notify.sh: telegram backend selected but not configured" >&2
      exit 0
    fi
    # --max-time bounds a hung network call: this runs inside a cron cycle.
    # Output is discarded rather than logged, because the API echoes the
    # request URL on some errors, and that URL contains the bot token.
    if ! curl -sS --max-time 15 -o /dev/null \
        -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
        -d "chat_id=${TELEGRAM_CHAT_ID}" \
        --data-urlencode "text=${text}" 2>/dev/null; then
      echo "notify.sh: telegram send failed (network or API); continuing" >&2
    fi
    ;;

  ntfy)
    topic="${NTFY_TOPIC:-}"
    [ -z "$topic" ] && { echo "notify.sh: ntfy backend selected but NTFY_TOPIC unset" >&2; exit 0; }
    curl -sS --max-time 15 -o /dev/null \
      -d "$text" "${NTFY_SERVER:-https://ntfy.sh}/${topic}" 2>/dev/null \
      || echo "notify.sh: ntfy send failed; continuing" >&2
    ;;

  none|"")
    echo "notify.sh: backend 'none' -- would have sent: $text" >&2
    ;;

  *)
    echo "notify.sh: unknown backend '$backend'" >&2
    ;;
esac

exit 0


